import { getDb, activeWallet } from '@snooker/db';
import { MAX_BREAK } from '@snooker/sim';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC window for the configured period kind. */
export function periodWindow(kind = config.rewards.periodKind, now = new Date()) {
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0,
  ));
  if (kind === 'weekly') {
    // ISO weeks start Monday.
    const dow = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - dow);
    return { starts_at: start, ends_at: new Date(start.getTime() + 7 * DAY_MS) };
  }
  return { starts_at: start, ends_at: new Date(start.getTime() + DAY_MS) };
}

export async function currentPeriod(now = new Date()) {
  const knex = getDb();
  const kind = config.rewards.periodKind;
  const { starts_at, ends_at } = periodWindow(kind, now);
  const existing = await knex('reward_periods').where({ kind, starts_at }).first();
  if (existing) return existing;
  await knex('reward_periods').insert({
    kind, starts_at, ends_at, budget_tokens: config.rewards.budgetTokens,
  }).onConflict(['kind', 'starts_at']).ignore();
  return knex('reward_periods').where({ kind, starts_at }).first();
}

/**
 * Record the one crypto-eligible break for a finished PvP match.
 * Practice matches never reach here — the caller checks crypto_eligible, and
 * the unique index on match_id makes a replay a no-op.
 */
export async function recordEligibleBreak(matchRow, matchState) {
  if (!matchRow.crypto_eligible) return null;
  const knex = getDb();

  const [aBreak, bBreak] = matchState.highBreaks;
  const best = Math.min(MAX_BREAK, Math.max(aBreak, bBreak));
  if (best <= 0) return null;

  const winnerIdx = aBreak >= bBreak ? 0 : 1;
  const userId = matchState.players[winnerIdx];
  const period = await currentPeriod();

  await knex('eligible_breaks').insert({
    match_id: matchRow.id,
    user_id: userId,
    period_id: period.id,
    break_value: best,
  }).onConflict('match_id').ignore();

  await knex('users').where({ id: userId })
    .increment('lifetime_eligible_points', best)
    .update({ updated_at: knex.fn.now() });
  await knex('users').where({ id: userId }).where('best_break', '<', best)
    .update({ best_break: best });

  return { userId, breakValue: best, periodId: period.id };
}

export async function periodTotals(periodId) {
  const knex = getDb();
  const period = await knex('reward_periods').where({ id: periodId }).first();
  if (!period) return null;
  const row = await knex('eligible_breaks').where({ period_id: periodId })
    .sum({ points: 'break_value' }).first();
  const totalPoints = Number(row?.points ?? 0);
  const budget = Number(period.budget_tokens);
  // The core payout formula: the budget is fixed, so the per-point rate falls
  // as more eligible points are earned. The budget can never be overspent.
  const rate = totalPoints > 0 ? budget / totalPoints : 0;
  return { period, totalPoints, budget, rate };
}

export async function userPeriodPoints(userId, periodId) {
  const row = await getDb()('eligible_breaks')
    .where({ period_id: periodId, user_id: userId })
    .sum({ points: 'break_value' }).first();
  return Number(row?.points ?? 0);
}

export async function quote(userId, periodId) {
  const totals = await periodTotals(periodId);
  if (!totals) return null;
  const points = await userPeriodPoints(userId, periodId);
  const uncapped = points * totals.rate;
  const cap = totals.budget * config.rewards.maxShare;
  const tokens = Math.min(uncapped, cap);
  return {
    periodId,
    kind: totals.period.kind,
    endsAt: totals.period.ends_at,
    closed: new Date(totals.period.ends_at).getTime() <= Date.now(),
    points,
    totalPoints: totals.totalPoints,
    budget: totals.budget,
    rate: totals.rate,
    tokens: Number(tokens.toFixed(9)),
    capped: uncapped > cap,
    minPoints: config.rewards.minPointsToRedeem,
  };
}

/**
 * Queue a redemption. Only for a closed period, so the rate is final — paying
 * out mid-period would let the last players in the window be underfunded.
 * Idempotent on request_id, and one redemption per player per period.
 */
export async function redeem({ userId, periodId, requestId }) {
  const knex = getDb();

  const existingByRequest = await knex('redemptions').where({ request_id: requestId }).first();
  if (existingByRequest) return { status: 'duplicate', redemption: existingByRequest };

  const q = await quote(userId, periodId);
  if (!q) return { status: 'error', reason: 'unknown period' };
  if (!q.closed) return { status: 'error', reason: 'period still open' };
  if (q.points < q.minPoints) {
    return { status: 'error', reason: `need at least ${q.minPoints} eligible points` };
  }

  const wallet = await activeWallet(userId);
  if (!wallet) return { status: 'error', reason: 'no wallet linked — use /wallet first' };

  const already = await knex('redemptions').where({ user_id: userId, period_id: periodId }).first();
  if (already) return { status: 'duplicate', redemption: already };

  const [inserted] = await knex('redemptions').insert({
    request_id: requestId,
    user_id: userId,
    period_id: periodId,
    points: q.points,
    tokens: q.tokens,
    address: wallet.address,
    network: wallet.network,
    status: 'pending',
  }).returning('*');

  const redemption = inserted?.id
    ? inserted
    : await knex('redemptions').where({ request_id: requestId }).first();

  return { status: 'queued', redemption, quote: q };
}

/** Most recently closed period, which is the one players can redeem against. */
export async function lastClosedPeriod() {
  return getDb()('reward_periods')
    .where('ends_at', '<=', new Date())
    .orderBy('ends_at', 'desc')
    .first();
}
