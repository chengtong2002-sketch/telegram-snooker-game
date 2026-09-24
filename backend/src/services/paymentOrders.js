/**
 * What every coin-pack provider shares: the per-player order limits and the
 * payment_events audit log (docs/rm-payments-plan.md, section 3).
 */
import { getDb } from '@snooker/db';

/** Unpaid orders one player can hold at once per provider, and orders a day in all. */
export const OPEN_ORDER_LIMIT = 3;
export const DAILY_ORDER_LIMIT = 20;

/** Append to payment_events, which is never updated or deleted. */
export async function logEvent({
  orderId = null, source, event, payload = null, outcome = null, signatureOk = null,
}, db = getDb()) {
  await db('payment_events').insert({
    order_id: orderId,
    source,
    event,
    signature_ok: signatureOk,
    payload: payload == null ? null : JSON.stringify(payload).slice(0, 4000),
    outcome,
  });
}

/** 'too_many_open' | 'daily_limit' when this player may not start another order, else null. */
export async function orderLimitReason(userId, provider, now = new Date()) {
  const db = getDb();
  const open = await db('payment_orders')
    .where({ user_id: userId, provider, status: 'pending' })
    .where('expires_at', '>', now)
    .count({ n: '*' }).first();
  if (Number(open.n) >= OPEN_ORDER_LIMIT) return 'too_many_open';
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daily = await db('payment_orders')
    .where({ user_id: userId }).where('created_at', '>=', today)
    .count({ n: '*' }).first();
  if (Number(daily.n) >= DAILY_ORDER_LIMIT) return 'daily_limit';
  return null;
}
