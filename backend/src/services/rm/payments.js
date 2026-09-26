/**
 * Coin top-ups paid in MYR through Revenue Monster (docs/rm-payments-plan.md).
 * Behind PAYMENTS_RM_ENABLED (off by default); sandbox unless RM_ENV=production.
 *
 *   1. createRmOrder: an order row, then an RM checkout (POST /v3/payment/online).
 *      Started from the Mini App's store (routes/payments.js; the user's call on
 *      Sep 26, knowing Telegram asks for Stars for digital goods in Mini Apps)
 *      or from the web top-up page (docs/topup-web-plan.md). WEB_PAYMENT on a
 *      computer (RM shows the TNG QR), MOBILE_PAYMENT on a phone (RM opens TNG).
 *   2. RM sends the player back where they started: into the Mini App's store
 *      (RM_RETURN_APP_URL?startapp=store_<orderId>) or the page's done screen
 *      (RM_WEB_RETURN_URL?order=<orderId>). Whatever status that trip carries
 *      is for display only: nothing here reads it.
 *   3. **Coins are credited by exactly two things, both RM speaking for itself:**
 *      - RM's webhook, when its signature verifies against RM's server key;
 *      - the reconciler's own signed query to RM's API (server to server).
 *      Either way only when RM says SUCCESS and the amount and currency are the
 *      order's; otherwise the order is disputed and no coins move. Both credit
 *      through creditOrderInTrx with ledger ref `rm:<transactionId>`, which is
 *      UNIQUE: a webhook after the reconciler (or the other way round, or RM
 *      replaying itself) credits once.
 *   4. RM sends no webhook for failure, cancellation, expiry or refunds, so the
 *      reconciler asks RM about open and recently paid orders: it credits a
 *      payment whose webhook never came, closes failed and expired orders, and
 *      takes refunded coins back.
 */
import { randomBytes } from 'node:crypto';
import { getDb, isPostgres } from '@snooker/db';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { balanceOf, recordEntry } from '../coins.js';
import { notifyBot } from '../notify.js';
import { logEvent, orderLimitReason } from '../paymentOrders.js';
import { createRmClient, verifyCallback, RmApiError } from './client.js';

/** How long a checkout is ours to wait on before the order counts as expired. */
export const RM_ORDER_TTL_MS = 60 * 60 * 1000;
/** Grace after that: a payment RM took at the last second may still be on its way. */
const EXPIRE_GRACE_MS = 10 * 60 * 1000;

/** Our order ids: `rm` + 22 hex = 24 characters, RM's order.id limit. */
export const RM_ORDER_ID = /^rm[0-9a-f]{22}$/;
const newOrderId = () => `rm${randomBytes(11).toString('hex')}`;

let fetchImpl = (...args) => globalThis.fetch(...args);
let client = null;
const rm = () => {
  client ??= createRmClient({ ...config.rm, fetch: (...args) => fetchImpl(...args) });
  return client;
};

/** Tests only: send RM calls to a fake (and drop the client, so a changed config.rm.live is picked up). */
export function useRmFetch(fn) {
  fetchImpl = fn;
  client = null;
}

const packFor = (packId) => config.store.packs.find((p) => p.id === packId && p.myrSen > 0) ?? null;
export const notifyUrl = () => `${config.rm.publicBackendUrl}/webhooks/rm`;
/**
 * Where RM sends the player after paying, on this order: back into the Mini
 * App's store ('app'), or the web top-up page's done screen ('web').
 */
export const redirectUrl = (orderId, from = 'web') => (from === 'app'
  ? `${config.rm.returnAppUrl}?startapp=store_${orderId}`
  : `${config.rm.webReturnUrl}?order=${orderId}`);

/** RM's code for card payments ("Card (Online)"); RM offers it on WEB_PAYMENT only. */
export const CARD_METHOD = 'MASTERCARD_MY';

/**
 * How RM shows the checkout. The page says which device it is on; that only
 * changes the checkout's layout, never the price, the coins or the account, so
 * it is safe to take from the client. Only a phone paying without a card gets
 * MOBILE_PAYMENT (it opens the TNG app); everything else RM's web page (a TNG QR
 * on a computer, the card form anywhere).
 */
export const checkoutType = (device, method = null) => (
  device === 'mobile' && method !== CARD_METHOD ? 'MOBILE_PAYMENT' : 'WEB_PAYMENT');

/**
 * The methods to offer RM for this order: the one the player picked, when it is
 * one we offer, else all of them (RM's page then lets them choose). null means
 * the pick is not one we offer.
 */
export function methodsFor(method) {
  if (method === undefined || method === null || method === '') return [...config.rm.webMethods];
  return config.rm.webMethods.includes(method) ? [method] : null;
}

/**
 * Start an order and its RM checkout. Returns { status, ... }:
 *   created         { orderId, url, coins, myrSen }
 *   disabled        RM payments are switched off
 *   unknown_pack    no such pack, or it has no MYR price
 *   unknown_method  a payment method we do not offer
 *   too_many_open | daily_limit
 *   provider_error  RM refused or did not answer; the order is marked failed
 */
export async function createRmOrder(userId, packId, { device = null, from = 'web', method = null } = {}) {
  if (!config.rm.enabled) return { status: 'disabled' };
  const pack = packFor(packId);
  if (!pack) return { status: 'unknown_pack' };
  const methods = methodsFor(method);
  if (!methods) return { status: 'unknown_method' };
  const type = checkoutType(device, methods.length === 1 ? methods[0] : null);
  const limit = await orderLimitReason(userId, 'rm');
  if (limit) return { status: limit };

  const db = getDb();
  const orderId = newOrderId();
  await db('payment_orders').insert({
    id: orderId,
    user_id: userId,
    provider: 'rm',
    pack_id: pack.id,
    coins: pack.coins,
    amount: pack.myrSen,
    currency: 'MYR',
    status: 'created',
    expires_at: new Date(Date.now() + RM_ORDER_TTL_MS),
  });

  let checkout;
  try {
    checkout = await rm().createCheckout({
      storeId: config.rm.storeId,
      type,
      layoutVersion: 'v4',
      method: methods,
      redirectUrl: redirectUrl(orderId, from),
      notifyUrl: notifyUrl(),
      order: {
        id: orderId,
        title: `${pack.coins.toLocaleString('en')} coins`, // RM: at most 32 characters
        detail: 'Coins for the Snooker store. They buy cues and cue balls, nothing else.',
        additionalData: orderId,
        amount: pack.myrSen, // sen: RM counts in cents
        currencyType: 'MYR',
      },
    });
    if (typeof checkout?.url !== 'string' || !/^https:\/\//.test(checkout.url)) {
      throw new RmApiError('checkout', 'NO_URL', 'the answer had no checkout url');
    }
  } catch (err) {
    const reason = err instanceof RmApiError ? err.message : 'unexpected error';
    await db('payment_orders').where({ id: orderId }).update({ status: 'failed', failure_reason: reason.slice(0, 200) });
    await logEvent({ orderId, source: 'api', event: 'checkout', outcome: 'provider_error', payload: { reason } });
    logger.warn({ orderId, reason }, 'rm checkout could not be created');
    return { status: 'provider_error' };
  }

  await db('payment_orders').where({ id: orderId }).update({
    status: 'pending', provider_checkout_id: String(checkout.checkoutId ?? '').slice(0, 128) || null,
  });
  await logEvent({
    orderId, source: 'api', event: 'checkout', outcome: 'pending', payload: {
      packId: pack.id, myrSen: pack.myrSen, type, methods, from, live: config.rm.live,
    },
  });
  return {
    status: 'created', orderId, url: checkout.url, coins: pack.coins, myrSen: pack.myrSen,
  };
}

/** The order row, locked for the transaction on Postgres. */
const lockOrder = (trx, id) => {
  const q = trx('payment_orders').where({ id });
  return (isPostgres() ? q.forUpdate() : q).first();
};

/**
 * The one place an RM payment turns into coins, for the webhook and the
 * reconciler alike. Ref `rm:<transactionId>` is UNIQUE, so whichever comes
 * second gets 'duplicate'. The first payment is the order's; a late one for an
 * expired order still counts (the money was taken); a second payment is
 * credited but leaves the order as it is.
 */
async function creditOrderInTrx(trx, order, transactionId, actor) {
  const { status } = await recordEntry({
    userId: order.user_id,
    delta: order.coins,
    reason: 'purchase',
    ref: `rm:${transactionId}`,
    actor,
    note: `${order.pack_id} (${order.amount} sen)`,
  }, trx);
  await trx('payment_orders').where({ id: order.id }).whereNull('provider_txn_id').update({
    status: 'paid', provider_txn_id: transactionId, paid_at: trx.fn.now(), failure_reason: null,
  });
  return status === 'recorded' ? 'credited' : 'duplicate';
}

/** After a credit has committed: log it and tell the player. */
async function announceCredit(order, source) {
  const balance = await balanceOf(order.user_id);
  logger.info({
    orderId: order.id, userId: order.user_id, coins: order.coins, source,
  }, 'rm payment credited');
  notifyBot({
    type: 'coins-added', userId: order.user_id, coins: order.coins, balance,
  });
}

/** RM paid us something other than this order's price: no coins, the order is disputed. */
async function disputeInTrx(trx, order, why) {
  if (order.status === 'disputed' || order.status === 'paid') return;
  await trx('payment_orders').where({ id: order.id }).update({ status: 'disputed', failure_reason: why.slice(0, 200) });
}

/* ---------- the webhook ---------- */

/**
 * POST /webhooks/rm. Returns { http, body }.
 *   401  the signature is not RM's: nothing else happens
 *   200  credited, already credited, or nothing to credit (so RM stops retrying)
 *   500  (thrown) the database failed: RM retries
 */
export async function handleRmWebhook({ rawBody, headers }) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Judged by the signature check below, which fails on this too.
  }
  const data = parsed?.data ?? {};
  const claimed = typeof data.order?.id === 'string' ? data.order.id.slice(0, 64) : null;
  const notice = {
    orderId: claimed,
    eventType: parsed?.eventType ?? null,
    status: typeof data.status === 'string' ? data.status.toUpperCase() : null,
    transactionId: typeof data.transactionId === 'string' ? data.transactionId.slice(0, 100) : null,
    amount: Number(data.order?.amount),
    currency: data.currencyType ?? data.order?.currencyType ?? null,
  };

  const signatureOk = verifyCallback({
    publicKey: config.rm.serverPublicKey, rawBody, headers, notifyUrl: notifyUrl(),
  });
  if (!signatureOk) {
    await logEvent({
      source: 'webhook', event: 'notify', signatureOk: false, outcome: 'bad_signature', payload: notice,
    });
    logger.warn(notice, 'rm webhook with a bad signature ignored');
    return { http: 401, body: { error: 'bad signature' } };
  }

  const db = getDb();
  const known = claimed && RM_ORDER_ID.test(claimed)
    ? await db('payment_orders').where({ id: claimed, provider: 'rm' }).first()
    : null;
  if (!known) {
    await logEvent({
      source: 'webhook', event: 'notify', signatureOk: true, outcome: 'unknown_order', payload: notice,
    });
    logger.error(notice, 'rm webhook for an order we do not have: check the RM portal');
    return { http: 200, body: { ok: true } };
  }

  const result = await db.transaction(async (trx) => {
    const order = await lockOrder(trx, known.id);
    let outcome;
    if (notice.status !== 'SUCCESS') {
      outcome = 'not_success';
    } else if (!notice.transactionId) {
      outcome = 'no_transaction_id';
    } else if (notice.amount !== Number(order.amount) || notice.currency !== order.currency) {
      // Signed by RM, but not what we asked for: no coins, a person decides.
      outcome = 'disputed';
      await disputeInTrx(trx, order, `webhook said ${notice.amount} ${notice.currency}, order is ${order.amount} ${order.currency}`);
    } else {
      outcome = await creditOrderInTrx(trx, order, notice.transactionId, 'webhook');
    }
    await logEvent({
      orderId: order.id, source: 'webhook', event: 'notify', signatureOk: true, outcome, payload: notice,
    }, trx);
    return { outcome, order };
  });

  const { outcome, order } = result;
  if (outcome === 'credited') {
    await announceCredit(order, 'webhook');
  } else if (outcome === 'disputed' || outcome === 'no_transaction_id') {
    logger.error({ orderId: order.id, outcome, notice }, 'rm payment needs a person: see payment_events');
  }
  return { http: 200, body: { ok: true } };
}

/* ---------- the player's view of an order ---------- */

/** One of this player's coin orders, for the store's waiting sheet or the top-up page's done screen. Read-only: it never asks RM. */
export async function orderForUser(userId, orderId) {
  if (typeof orderId !== 'string' || orderId.length > 24) return null;
  const order = await getDb()('payment_orders').where({ id: orderId, user_id: userId }).first();
  if (!order) return null;
  return {
    orderId: order.id,
    provider: order.provider,
    status: order.status,
    coins: order.coins,
    amount: Number(order.amount),
    currency: order.currency,
    balance: await balanceOf(userId),
  };
}

/* ---------- reconciler: RM's API answers, server to server ---------- */

/** Coins taken back for `refundedSen` of an order: all of them for a full refund, rounded up otherwise. */
export const coinsForRefund = (order, refundedSen) => (refundedSen >= Number(order.amount)
  ? order.coins
  : Math.ceil((order.coins * refundedSen) / Number(order.amount)));

/**
 * How much of the order RM says has been refunded, in sen, or null when the
 * answer doesn't say (then a person looks). Phase 0 confirms the field names.
 */
function refundedSen(order, txn, status) {
  if (status === 'FULL_REFUNDED' || status === 'REVERSED') return Number(order.amount);
  const direct = Number(txn.refundedAmount ?? txn.refundAmount);
  if (Number.isSafeInteger(direct) && direct > 0) return Math.min(direct, Number(order.amount));
  const balance = Number(txn.balanceAmount);
  if (Number.isSafeInteger(balance) && balance >= 0 && balance < Number(order.amount)) return Number(order.amount) - balance;
  return null;
}

/**
 * Take back the coins for `total` sen refunded so far, less what earlier
 * refunds of this payment already took. Each refund total has its own ref, so
 * seeing the same total twice debits once.
 */
async function debitRefundInTrx(trx, order, transactionId, total, actor) {
  const prior = await trx('coin_ledger')
    .where('ref', 'like', `rm-refund:${transactionId}:%`)
    .sum({ taken: 'delta' }).first();
  const alreadyTaken = -Number(prior?.taken ?? 0);
  const owed = coinsForRefund(order, total) - alreadyTaken;
  let outcome = 'refund_seen';
  if (owed > 0) {
    const { status } = await recordEntry({
      userId: order.user_id,
      delta: -owed,
      reason: 'refund',
      ref: `rm-refund:${transactionId}:${total}`,
      actor,
      note: `refund of ${order.id} (${total} of ${order.amount} sen)`,
    }, trx);
    outcome = status === 'recorded' ? 'debited' : 'duplicate';
  }
  await trx('payment_orders').where({ id: order.id }).update({
    status: total >= Number(order.amount) ? 'refunded' : 'partially_refunded',
    refunded_amount: Math.max(total, Number(order.refunded_amount ?? 0)),
  });
  return outcome;
}

const OPEN = new Set(['created', 'pending', 'expired']);

/**
 * Bring one order in line with RM's answer to our signed query (`txn`, null
 * when RM has no payment for it).
 */
async function applyRmAnswer(orderId, txn, source) {
  const db = getDb();
  const result = await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    const now = new Date();
    const status = String(txn?.status ?? '').toUpperCase();
    const transactionId = txn?.transactionId ? String(txn.transactionId).slice(0, 100) : null;
    const amount = Number(txn?.order?.amount);
    const currency = txn?.currencyType ?? txn?.order?.currencyType ?? null;
    const credited = transactionId ? await trx('coin_ledger').where({ ref: `rm:${transactionId}` }).first() : null;
    let outcome;

    if (!txn) {
      outcome = 'no_payment';
    } else if (status === 'SUCCESS') {
      if (!transactionId || txn.order?.id !== order.id) {
        outcome = 'disputed';
        await disputeInTrx(trx, order, `RM answered for order ${txn.order?.id} / transaction ${transactionId}`);
      } else if (amount !== Number(order.amount) || currency !== order.currency) {
        outcome = 'disputed';
        await disputeInTrx(trx, order, `RM says ${amount} ${currency}, order is ${order.amount} ${order.currency}`);
      } else {
        // Paid, and RM itself says so for our price: credit, unless the webhook already has.
        outcome = await creditOrderInTrx(trx, order, transactionId, source);
      }
    } else if (['FULL_REFUNDED', 'PARTIAL_REFUNDED', 'REVERSED'].includes(status)) {
      const total = refundedSen(order, txn, status);
      if (total === null) {
        outcome = 'refund_unknown';
      } else if (!credited) {
        // Paid and handed back before any coins went out: nothing to take.
        await trx('payment_orders').where({ id: order.id }).update({
          status: total >= Number(order.amount) ? 'refunded' : 'partially_refunded',
          provider_txn_id: order.provider_txn_id ?? transactionId,
          refunded_amount: total,
        });
        outcome = 'refunded_uncredited';
      } else {
        outcome = await debitRefundInTrx(trx, order, transactionId, total, source);
      }
    } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(status) && OPEN.has(order.status)) {
      outcome = status.toLowerCase();
      await trx('payment_orders').where({ id: order.id }).update({ status: outcome, failure_reason: `RM: ${status}` });
    } else {
      outcome = 'waiting';
    }

    // Nothing paid and past its time: the order is over. (A payment that lands
    // later still credits, by webhook or reconciler: the money was taken.)
    if ((outcome === 'no_payment' || outcome === 'waiting')
        && ['created', 'pending'].includes(order.status)
        && new Date(order.expires_at).getTime() + EXPIRE_GRACE_MS < now.getTime()) {
      outcome = 'expired';
      await trx('payment_orders').where({ id: order.id }).update({ status: 'expired' });
    }

    await trx('payment_orders').where({ id: order.id }).update({ last_checked_at: now });
    await logEvent({
      orderId: order.id,
      source,
      event: 'check',
      outcome,
      payload: txn ? {
        status, transactionId, amount, currency, balanceAmount: txn.balanceAmount,
      } : null,
    }, trx);
    return { outcome, order };
  });

  const { outcome, order } = result;
  if (outcome === 'credited') {
    logger.warn({ orderId: order.id }, 'rm payment credited by the reconciler (no webhook had arrived)');
    await announceCredit(order, source);
  } else if (outcome === 'disputed' || outcome === 'refund_unknown') {
    logger.error({ orderId: order.id, outcome, txn }, 'rm payment needs a person: see payment_events');
  }
  return outcome;
}

/** Ask RM about one of our orders (a signed server-to-server query) and act on the answer. */
export async function checkRmOrder(orderId, source) {
  const db = getDb();
  const order = await db('payment_orders').where({ id: orderId, provider: 'rm' }).first();
  if (!order) return { status: 'unknown_order' };
  let txn;
  try {
    txn = await rm().queryOrder(order.id);
  } catch (err) {
    await db('payment_orders').where({ id: order.id }).update({ last_checked_at: new Date() });
    await logEvent({
      orderId: order.id, source, event: 'check', outcome: 'provider_error', payload: { reason: err.message },
    });
    logger.warn({ orderId: order.id, reason: err.message }, 'rm order query failed');
    return { status: 'provider_error' };
  }
  return { status: await applyRmAnswer(order.id, txn, source) };
}

/**
 * What RM never tells us on its own. Every minute from index.js:
 *   open orders older than 2 min         → asked (paid with no webhook / failed / cancelled / expired)
 *   expired orders from the last day     → asked every 30 min (a payment that landed late)
 *   paid orders from the last 30 days    → asked once a day (refunds made in RM's portal)
 */
export async function reconcileRm({ now = Date.now() } = {}) {
  if (!config.rm.enabled) return { checked: 0 };
  const db = getDb();
  const ago = (ms) => new Date(now - ms);
  const notAskedSince = (ms) => (q) => q.whereNull('last_checked_at').orWhere('last_checked_at', '<', ago(ms));

  const ids = new Set();
  const collect = async (query) => {
    for (const row of await query.select('id').limit(50)) ids.add(row.id);
  };
  await collect(db('payment_orders').where({ provider: 'rm' }).whereIn('status', ['created', 'pending'])
    .where('created_at', '<', ago(2 * 60_000)).where(notAskedSince(60_000)));
  await collect(db('payment_orders').where({ provider: 'rm', status: 'expired' })
    .where('created_at', '>', ago(24 * 3600_000)).where(notAskedSince(30 * 60_000)));
  await collect(db('payment_orders').where({ provider: 'rm' }).whereIn('status', ['paid', 'partially_refunded'])
    .where('paid_at', '>', ago(30 * 24 * 3600_000)).where(notAskedSince(24 * 3600_000)));

  const outcomes = {};
  for (const id of ids) {
    const { status } = await checkRmOrder(id, 'reconcile');
    outcomes[status] = (outcomes[status] ?? 0) + 1;
  }
  return { checked: ids.size, outcomes };
}

/**
 * Refund a paid RM order, in full or `amountSen` of it: RM first, then the
 * ledger. Owner-only: called from scripts/refund-rm.js, never over HTTP.
 */
export async function refundRmOrder(orderId, { actor, amountSen = null, reason = 'Refund' }) {
  const db = getDb();
  const order = await db('payment_orders').where({ id: orderId, provider: 'rm' }).first();
  if (!order) return { status: 'unknown_order' };
  if (!order.provider_txn_id || !['paid', 'partially_refunded'].includes(order.status)) return { status: 'not_refundable', order };
  const remaining = Number(order.amount) - Number(order.refunded_amount ?? 0);
  const amount = amountSen ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) return { status: 'bad_amount', remaining, order };

  try {
    await rm().refund({
      transactionId: order.provider_txn_id,
      amount,
      full: amount === Number(order.amount),
      reason: String(reason).slice(0, 100),
    });
  } catch (err) {
    await logEvent({
      orderId, source: 'admin', event: 'refund', outcome: 'provider_error', payload: { reason: err.message, amount },
    });
    return { status: 'provider_error', reason: err.message, order };
  }

  const total = Number(order.refunded_amount ?? 0) + amount;
  const outcome = await db.transaction(async (trx) => {
    const locked = await lockOrder(trx, order.id);
    const result = await debitRefundInTrx(trx, locked, order.provider_txn_id, total, actor);
    await logEvent({
      orderId, source: 'admin', event: 'refund', outcome: result, payload: { amount, total, actor },
    }, trx);
    return result;
  });
  return {
    status: outcome, order, total, balance: await balanceOf(order.user_id),
  };
}
