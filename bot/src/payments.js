/**
 * Telegram Stars: the three updates Telegram sends the bot about a payment.
 *
 * The bot decides nothing itself. Each update goes to the backend, which owns
 * the orders and the coin ledger (backend/src/services/stars.js); the bot only
 * relays and answers. Handlers take their dependencies so tests need no bot.
 */
import * as backend from './api.js';
import { coinsAddedMessage } from './messages.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shown by Telegram when the backend cannot be asked in time. */
export const CHECK_UNAVAILABLE = 'The store is not answering right now. Please try again in a minute.';

/**
 * pre_checkout_query. Telegram waits 10 s for the answer, and an unanswered
 * query fails the payment, so a backend that cannot be reached is a refusal.
 */
export async function onPreCheckout(ctx, { api = backend } = {}) {
  const q = ctx.preCheckoutQuery;
  let verdict;
  try {
    verdict = await api.starsCheck({
      orderId: q.invoice_payload,
      telegramId: q.from.id,
      currency: q.currency,
      totalAmount: q.total_amount,
    });
  } catch {
    verdict = { ok: false, error: CHECK_UNAVAILABLE };
  }
  if (verdict.ok) return ctx.answerPreCheckoutQuery(true);
  return ctx.answerPreCheckoutQuery(false, { error_message: verdict.error || CHECK_UNAVAILABLE });
}

/**
 * successful_payment. Telegram sends it once and never again, so it is retried
 * here; if every try fails, the backend's reconciler still finds the payment in
 * getStarTransactions and credits it (same charge id, so never twice).
 */
export async function onSuccessfulPayment(ctx, { api = backend, wait = sleep, delays = [1_000, 4_000, 15_000] } = {}) {
  const p = ctx.message.successful_payment;
  const report = {
    orderId: p.invoice_payload,
    telegramId: ctx.from.id,
    currency: p.currency,
    totalAmount: p.total_amount,
    chargeId: p.telegram_payment_charge_id,
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await api.starsPaid(report);
      if (result.status === 'credited' || result.status === 'duplicate') {
        const { text, parse_mode } = coinsAddedMessage(result);
        return ctx.reply(text, { parse_mode });
      }
      console.error(`stars payment ${report.chargeId} not credited: ${result.status}`);
      return ctx.reply('Your payment arrived, but I could not match it to an order. Use /paysupport and we will sort it out.');
    } catch (err) {
      if (attempt >= delays.length) {
        console.error(`stars payment ${report.chargeId} not passed on after ${attempt + 1} tries: ${err.message}`);
        return ctx.reply('Payment received. Your coins will appear within a few minutes.');
      }
      await wait(delays[attempt]);
    }
  }
}

/** refunded_payment: Telegram reports a refund, however it was made. */
export async function onRefundedPayment(ctx, { api = backend } = {}) {
  const r = ctx.message.refunded_payment;
  try {
    await api.starsRefunded({ chargeId: r.telegram_payment_charge_id });
  } catch (err) {
    // The owner's refund script debits too; this path covers refunds made elsewhere.
    console.error(`stars refund ${r.telegram_payment_charge_id} not passed on: ${err.message}`);
  }
}

export function registerPayments(bot) {
  bot.on('pre_checkout_query', (ctx) => onPreCheckout(ctx));
  bot.on('message:successful_payment', (ctx) => onSuccessfulPayment(ctx));
  // Checked by hand rather than with a filter query, so an older grammY that
  // does not know refunded_payment cannot reject the filter at startup.
  bot.on('message', (ctx, next) => (ctx.message.refunded_payment ? onRefundedPayment(ctx) : next()));
}
