import { getDb, activeWallet, userById, toBool } from '@snooker/db';
import { MAX_BREAK } from '@snooker/sim';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Most reward-eligible matches one player can be awarded per UTC calendar day.
 * A match over the limit is still played and still counts for frames and the
 * win; its break just earns nothing. Checked when the result is recorded
 * (recordEligibleBreak), never at matchmaking.
 */
export const DAILY_ELIGIBLE_MATCH_CAP = 15;

/** Most reward-eligible matches between the same two players per UTC calendar day. */
export const DAILY_PAIR_MATCH_CAP = 3;

/** After the payout wallet changes, claims wait this long. */
export const WALLET_CLAIM_COOLDOWN_MS = DAY_MS;

/** UTC calendar day as 'YYYY-MM-DD': the limits reset at 00:00 UTC. */
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Whitelisted test account (REWARD_LIMIT_EXEMPT_TELEGRAM_IDS)? Keyed by Telegram id. */
export async function isLimitExempt(userId) {
  const exempt = config.rewards.limitExemptTelegramIds;
  if (exempt.size === 0) return false;
  const user = await userById(userId);
  return Boolean(user) && exempt.has(String(user.telegram_id));
}

/**
 * Why `userId`'s break against `opponentId` cannot be awarded on `day`, or
 * null if it can. Only matches that actually awarded a break count toward
 * either limit: the player's own awarded breaks for the daily cap, and every
 * awarded break between the two of them (whoever made it) for the pairing cap.
 */
export async function dailyLimitReason(userId, opponentId, day) {
  if (await isLimitExempt(userId)) return null;
  const knex = getDb();
  const mine = await knex('eligible_breaks')
    .where({ user_id: userId, award_day: day })
    .count({ n: 'id' }).first();
  if (Number(mine?.n ?? 0) >= DAILY_ELIGIBLE_MATCH_CAP) return 'daily-match-cap';

  const pair = await knex('eligible_breaks')
    .where({ award_day: day })
    .andWhere((q) => q
      .where({ user_id: userId, opponent_id: opponentId })
      .orWhere({ user_id: opponentId, opponent_id: userId }))
    .count({ n: 'id' }).first();
  if (Number(pair?.n ?? 0) >= DAILY_PAIR_MATCH_CAP) return 'daily-pair-cap';
  return null;
}

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
 *
 * Eligibility is read from the stored match row, never from `matchRow`: the
 * match must exist, be mode 'pvp' and be flagged crypto_eligible. Practice is
 * refused on mode alone, even if a row were ever wrongly flagged. The unique
 * index on match_id makes a replay a no-op.
 *
 * This is where the daily limits apply: the match has already been played in
 * full. If the break's owner is over a limit, nothing is awarded and the
 * reason is kept on the match row.
 *
 * @returns {Promise<null
 *   | {userId, breakValue, periodId}
 *   | {userId, breakValue: 0, blockedBreak, ineligibleReason}>}
 */
export async function recordEligibleBreak(matchRow, matchState, { now = new Date() } = {}) {
  const knex = getDb();
  const match = await knex('matches').where({ id: matchRow.id }).first();
  if (!match || match.mode !== 'pvp' || !toBool(match.crypto_eligible)) return null;

  const [aBreak, bBreak] = matchState.highBreaks;
  const best = Math.min(MAX_BREAK, Math.max(aBreak, bBreak));
  if (best <= 0) return null;

  const winnerIdx = aBreak >= bBreak ? 0 : 1;
  const userId = matchState.players[winnerIdx];
  const opponentId = matchState.players[1 - winnerIdx];

  // Replays return the original decision. Re-checking the limits here would
  // count this match against itself and could flip an awarded break to capped.
  const existing = await knex('eligible_breaks').where({ match_id: matchRow.id }).first();
  if (existing) {
    return { userId: existing.user_id, breakValue: existing.break_value, periodId: existing.period_id };
  }
  if (match.ineligible_reason) {
    return { userId, breakValue: 0, blockedBreak: best, ineligibleReason: match.ineligible_reason };
  }

  // No lock around count-then-insert: a player can only be in one active match
  // at a time (joinQueue refuses otherwise), so their results cannot race.
  const day = utcDay(now);
  const reason = await dailyLimitReason(userId, opponentId, day);
  if (reason) {
    await knex('matches').where({ id: matchRow.id }).update({ ineligible_reason: reason });
    return { userId, breakValue: 0, blockedBreak: best, ineligibleReason: reason };
  }

  const period = await currentPeriod(now);
  await knex('eligible_breaks').insert({
    match_id: matchRow.id,
    user_id: userId,
    opponent_id: opponentId,
    period_id: period.id,
    break_value: best,
    award_day: day,
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

  // A freshly changed wallet cannot receive a claim yet, so whoever changed it
  // on a stolen session cannot cash out before the player sees the bot's notice.
  const user = await userById(userId);
  if (user?.wallet_changed_at && !(await isLimitExempt(userId))) {
    const unlocksAt = new Date(user.wallet_changed_at).getTime() + WALLET_CLAIM_COOLDOWN_MS;
    if (Date.now() < unlocksAt) {
      return {
        status: 'error',
        reason: `your payout wallet changed recently — claims unlock at ${new Date(unlocksAt).toISOString()}`,
      };
    }
  }

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
