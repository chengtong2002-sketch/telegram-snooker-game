/**
 * Coin packs bought with Telegram Stars (docs/store-plan.md, "API").
 *
 *   1. The Mini App asks for an invoice: an order row, then createInvoiceLink
 *      with our order id as the payload. The app opens it with openInvoice.
 *   2. Telegram asks the bot (pre_checkout_query) whether to take the payment;
 *      the bot asks checkPreCheckout here, and must answer within 10 s.
 *   3. Telegram sends the bot successful_payment; the bot hands it to
 *      recordStarsPayment, which credits the coins once per charge id.
 *   4. If step 3 never reached us (bot down, backend down), reconcileStars finds
 *      the payment in getStarTransactions and credits it through the same path.
 *
 * Coins are credited with ledger ref `stars:<telegram_payment_charge_id>`, and
 * coin_ledger.ref is UNIQUE, so the bot retrying, Telegram repeating itself and
 * the reconciler finding the same payment all end in one credit. A refund debits
 * once with `stars-refund:<chargeId>`, even into a negative balance.
 *
 * Every step is written to payment_events, which is never updated or deleted.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '@snooker/db';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { balanceOf, recordEntry } from './coins.js';
import { callBotApi, TelegramApiError } from './telegramApi.js';
import {
  logEvent, orderLimitReason, OPEN_ORDER_LIMIT, DAILY_ORDER_LIMIT,
} from './paymentOrders.js';

export { OPEN_ORDER_LIMIT, DAILY_ORDER_LIMIT };

/** How long an invoice can be paid for. After that pre-checkout refuses it. */
export const STARS_ORDER_TTL_MS = 60 * 60 * 1000;

const newOrderId = () => `st${randomBytes(11).toString('hex')}`; // 24 characters, RM's limit too

/** May this player buy with Stars? Everyone when switched on, else only the allowlist. */
export function starsEnabledFor(user) {
  if (config.store.starsEnabled) return true;
  return Boolean(user) && config.store.starsAllowTelegramIds.has(String(user.telegram_id));
}

/** Is Stars on for anyone at all (the reconciler has work to do)? */
const starsInUse = () => config.store.starsEnabled || config.store.starsAllowTelegramIds.size > 0;

const packFor = (packId) => config.store.packs.find((p) => p.id === packId && p.stars > 0) ?? null;

/**
 * Create an order and its invoice link. Returns { status, ... }:
 *   created         { orderId, invoiceLink, coins, stars }
 *   disabled        Stars payments are switched off
 *   unknown_pack    no such pack, or it has no Stars price
 *   too_many_open   OPEN_ORDER_LIMIT unpaid invoices already
 *   daily_limit     DAILY_ORDER_LIMIT orders today
 *   provider_error  Telegram refused or did not answer; the order is marked failed
 */
export async function createStarsInvoice(userId, packId) {
  const buyer = await getDb()('users').where({ id: userId }).first();
  if (!starsEnabledFor(buyer)) return { status: 'disabled' };
  const pack = packFor(packId);
  if (!pack) return { status: 'unknown_pack' };

  const limit = await orderLimitReason(userId, 'stars');
  if (limit) return { status: limit };

  const db = getDb();
  const now = new Date();

  const orderId = newOrderId();
  await db('payment_orders').insert({
    id: orderId,
    user_id: userId,
    provider: 'stars',
    pack_id: pack.id,
    coins: pack.coins,
    amount: pack.stars,
    currency: 'XTR',
    status: 'created',
    expires_at: new Date(now.getTime() + STARS_ORDER_TTL_MS),
  });

  const label = `${pack.coins.toLocaleString('en')} coins`;
  let invoiceLink;
  try {
    invoiceLink = await callBotApi('createInvoiceLink', {
      title: label,
      description: `${label} for the Snooker store. Coins buy cues and cue balls, nothing else.`,
      payload: orderId,
      currency: 'XTR',
      prices: [{ label, amount: pack.stars }],
    });
  } catch (err) {
    const reason = err instanceof TelegramApiError ? err.description : 'unexpected error';
    await db('payment_orders').where({ id: orderId }).update({ status: 'failed', failure_reason: reason.slice(0, 200) });
    await logEvent({ orderId, source: 'api', event: 'invoice', outcome: 'provider_error', payload: { reason } });
    logger.warn({ orderId, reason }, 'stars invoice could not be created');
    return { status: 'provider_error' };
  }

  await db('payment_orders').where({ id: orderId }).update({
    status: 'pending', provider_checkout_id: String(invoiceLink).slice(0, 128),
  });
  await logEvent({ orderId, source: 'api', event: 'invoice', outcome: 'pending', payload: { packId: pack.id, stars: pack.stars } });
  return {
    status: 'created', orderId, invoiceLink, coins: pack.coins, stars: pack.stars,
  };
}

/** The order behind a payload, and whether it belongs to this Telegram user. */
async function orderFor(orderId, telegramId) {
  if (typeof orderId !== 'string' || orderId.length > 24) return { order: null };
  const order = await getDb()('payment_orders').where({ id: orderId, provider: 'stars' }).first();
  if (!order) return { order: null };
  const user = await getDb()('users').where({ id: order.user_id }).first();
  return { order, user, sameUser: Boolean(user) && String(user.telegram_id) === String(telegramId) };
}

/**
 * pre_checkout_query: may Telegram take this payment? Returns { ok, error? }.
 * `error` is shown to the player by Telegram, so it is plain and short.
 */
export async function checkPreCheckout({
  orderId, telegramId, currency, totalAmount,
}) {
  const { order, sameUser } = await orderFor(orderId, telegramId);
  let error = null;
  if (!order) error = 'This order was not found. Open the store and try again.';
  else if (!sameUser) error = 'This invoice belongs to another player.';
  else if (order.status !== 'pending') error = 'This invoice has already been used. Open the store for a new one.';
  else if (new Date(order.expires_at).getTime() < Date.now()) error = 'This invoice has expired. Open the store for a new one.';
  else if (currency !== 'XTR' || Number(totalAmount) !== Number(order.amount)) error = 'The price has changed. Open the store and try again.';

  await logEvent({
    orderId: order ? order.id : null,
    source: 'bot',
    event: 'pre_checkout',
    outcome: error ? 'refused' : 'ok',
    payload: { orderId, currency, totalAmount, error },
  });
  return error ? { ok: false, error } : { ok: true };
}

/**
 * successful_payment (from the bot, or the reconciler): credit the coins once.
 * Returns { status, coins?, balance? }:
 *   credited | duplicate   the coins are on the account (now, or already)
 *   unknown_order          no Stars order with that payload: the Stars were
 *                          taken for nothing of ours — logged for a refund
 *   wrong_user             paid by someone other than the order's owner
 *   bad_request            no charge id
 *
 * Telegram has already taken the Stars by the time this runs, so a paid order
 * is credited even when it had expired or was paid twice: the player paid.
 */
export async function recordStarsPayment({
  orderId, telegramId, currency, totalAmount, chargeId, source = 'bot',
}) {
  if (typeof chargeId !== 'string' || !chargeId || chargeId.length > 100) return { status: 'bad_request' };
  const { order, user, sameUser } = await orderFor(orderId, telegramId);
  const payload = {
    orderId, telegramId, currency, totalAmount, chargeId,
  };
  if (!order || !sameUser) {
    const status = order ? 'wrong_user' : 'unknown_order';
    await logEvent({
      orderId: order ? order.id : null, source, event: 'paid', outcome: status, payload,
    });
    logger.error({ orderId, chargeId, status }, 'stars payment could not be matched to an order: refund it');
    return { status };
  }
  if (currency !== 'XTR' || Number(totalAmount) !== Number(order.amount)) {
    // pre_checkout refuses this, so it should never happen. The Stars were
    // taken for our invoice all the same: credit what the order promised.
    logger.error({ orderId, chargeId, currency, totalAmount }, 'stars payment amount differs from the order');
  }

  const db = getDb();
  const result = await db.transaction(async (trx) => {
    const { status } = await recordEntry({
      userId: order.user_id,
      delta: order.coins,
      reason: 'purchase',
      ref: `stars:${chargeId}`,
      actor: source,
      note: `${order.pack_id} (${order.amount} XTR)`,
    }, trx);
    if (status === 'recorded') {
      // The first charge for an order is the order's. A second charge on the
      // same invoice (paid twice) is credited but leaves the order as it is.
      await trx('payment_orders').where({ id: order.id }).whereNull('provider_txn_id').update({
        status: 'paid', provider_txn_id: chargeId, paid_at: trx.fn.now(),
      });
    }
    await logEvent({
      orderId: order.id, source, event: 'paid', outcome: status === 'recorded' ? 'credited' : 'duplicate', payload,
    }, trx);
    return status === 'recorded' ? 'credited' : 'duplicate';
  });

  if (result === 'credited') logger.info({ orderId: order.id, userId: user.id, coins: order.coins }, 'stars payment credited');
  return { status: result, coins: order.coins, balance: await balanceOf(order.user_id) };
}

/**
 * Take a refunded payment's coins back, once. Used by the refund script after
 * refundStarPayment, and by the bot when Telegram reports a refund made some
 * other way. Returns { status: 'debited' | 'duplicate' | 'unknown_charge', ... }.
 */
export async function recordStarsRefund({ chargeId, source = 'admin', actor = null }) {
  const db = getDb();
  const ledger = await db('coin_ledger').where({ ref: `stars:${chargeId}` }).first();
  if (!ledger) {
    await logEvent({ source, event: 'refund', outcome: 'unknown_charge', payload: { chargeId } });
    return { status: 'unknown_charge' };
  }
  const order = await db('payment_orders').where({ provider_txn_id: chargeId }).first();
  const result = await db.transaction(async (trx) => {
    const { status } = await recordEntry({
      userId: ledger.user_id,
      delta: -ledger.delta,
      reason: 'refund',
      ref: `stars-refund:${chargeId}`,
      actor: actor ?? source,
      note: order ? `refund of ${order.id}` : 'refund',
    }, trx);
    if (order && status === 'recorded') {
      await trx('payment_orders').where({ id: order.id }).update({ status: 'refunded', refunded_amount: order.amount });
    }
    await logEvent({
      orderId: order?.id ?? null, source, event: 'refund', outcome: status === 'recorded' ? 'debited' : 'duplicate', payload: { chargeId },
    }, trx);
    return status === 'recorded' ? 'debited' : 'duplicate';
  });
  return { status: result, coins: ledger.delta, balance: await balanceOf(ledger.user_id), userId: ledger.user_id };
}

/**
 * Refund a paid Stars order: Telegram first, then the ledger. If Telegram says
 * it was already refunded, the debit still happens (once). Owner-only: called
 * from scripts/refund-stars.js, never from an HTTP route.
 */
export async function refundStarsOrder(orderId, { actor }) {
  const db = getDb();
  const order = await db('payment_orders').where({ id: orderId, provider: 'stars' }).first();
  if (!order) return { status: 'unknown_order' };
  if (!order.provider_txn_id) return { status: 'not_paid', order };
  const user = await db('users').where({ id: order.user_id }).first();
  try {
    await callBotApi('refundStarPayment', {
      user_id: Number(user.telegram_id),
      telegram_payment_charge_id: order.provider_txn_id,
    });
  } catch (err) {
    const already = err instanceof TelegramApiError && /CHARGE_ALREADY_REFUNDED/i.test(err.description);
    if (!already) {
      await logEvent({ orderId, source: 'admin', event: 'refund', outcome: 'provider_error', payload: { reason: err.message } });
      return { status: 'provider_error', reason: err.message };
    }
  }
  return { ...(await recordStarsRefund({ chargeId: order.provider_txn_id, source: 'admin', actor })), order };
}

/**
 * Catch what the bot missed. Credits Stars payments to our orders that never
 * arrived as successful_payment, and marks unpaid invoices past their time as
 * expired. Telegram lists newest first; one page of 100 covers far more than
 * the gap between two runs.
 */
export async function reconcileStars() {
  if (!starsInUse()) return { credited: 0, expired: 0 };
  const db = getDb();
  let credited = 0;

  const { transactions = [] } = await callBotApi('getStarTransactions', { offset: 0, limit: 100 });
  for (const tx of transactions) {
    const payer = tx.source;
    if (payer?.type !== 'user' || typeof payer.invoice_payload !== 'string' || !payer.invoice_payload.startsWith('st')) continue;
    if (await db('coin_ledger').where({ ref: `stars:${tx.id}` }).first()) continue;
    const res = await recordStarsPayment({
      orderId: payer.invoice_payload,
      telegramId: payer.user?.id,
      currency: 'XTR',
      totalAmount: tx.amount,
      chargeId: tx.id,
      source: 'reconcile',
    });
    if (res.status === 'credited') {
      credited += 1;
      logger.warn({ orderId: payer.invoice_payload, chargeId: tx.id }, 'stars payment credited by the reconciler (the bot never passed it on)');
    }
  }

  // A little grace past the deadline: a payment Telegram accepted at the last
  // second may still be on its way.
  const expired = await db('payment_orders')
    .where({ provider: 'stars', status: 'pending' })
    .where('expires_at', '<', new Date(Date.now() - 10 * 60 * 1000))
    .update({ status: 'expired' });
  return { credited, expired };
}

