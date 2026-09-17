import {
  getDb, activeWallet, userById, toBool, isPostgres,
} from '@snooker/db';
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
export async function isLimitExempt(userId, db = getDb()) {
  const exempt = config.rewards.limitExemptTelegramIds;
  if (exempt.size === 0) return false;
  const user = await db('users').where({ id: userId }).first();
  return Boolean(user) && exempt.has(String(user.telegram_id));
}

/**
 * Why `userId`'s break against `opponentId` cannot be awarded on `day`, or
 * null if it can. Only matches that actually awarded a break count toward
 * either limit: the player's own awarded breaks for the daily cap, and every
 * awarded break between the two of them (whoever made it) for the pairing cap.
 */
export async function dailyLimitReason(userId, opponentId, day, db = getDb()) {
  if (await isLimitExempt(userId, db)) return null;
  const knex = db;
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

export async function currentPeriod(now = new Date(), db = getDb()) {
  const kind = config.rewards.periodKind;
  const { starts_at, ends_at } = periodWindow(kind, now);
  const existing = await db('reward_periods').where({ kind, starts_at }).first();
  if (existing) return existing;
  await db('reward_periods').insert({
    kind, starts_at, ends_at, budget_tokens: config.rewards.budgetTokens,
  }).onConflict(['kind', 'starts_at']).ignore();
  return db('reward_periods').where({ kind, starts_at }).first();
}

/**
 * Lock a reward period row for the rest of transaction `trx`. Awarding a break
 * and storing a period's rate both take this lock, so they cannot interleave.
 * SQLite has no row locks and needs none: its single connection already runs
 * one transaction at a time.
 */
const lockPeriod = (trx, where) => {
  const q = trx('reward_periods').where(where);
  return (isPostgres() ? q.forUpdate() : q).first();
};

/**
 * THE TIMESTAMP RULE. A result belongs to the reward period containing the
 * server's time when the result is recorded (the write that completes the
 * match) — not when the match started, not when a shot was played or queued on
 * the client, whose clock is not trusted. A match that straddles a period
 * boundary counts in the period it finishes in.
 *
 * One exception keeps a stored rate true: if that period's rate has already been
 * stored (another replica's clock ran slightly ahead, or this write computed its
 * time just before close and lands just after), the result goes to the next
 * period whose rate is not stored yet. A closed period never gains points.
 *
 * Returns that period, locked for `trx`.
 */
async function openPeriodForResult(trx, now) {
  let at = now;
  for (let hop = 0; hop < 4; hop += 1) {
    const period = await currentPeriod(at, trx);
    const locked = await lockPeriod(trx, { id: period.id });
    if (!toBool(locked.finalized)) return locked;
    at = new Date(locked.ends_at);
  }
  throw new Error('no reward period is open for this result');
}

const floor9 = (x) => Math.floor(x * 1e9 + 1e-6) / 1e9;

/**
 * Store a closed period's rate and total, once. From then on every quote and
 * claim for the period uses the stored numbers, and no result can be added to it
 * (see openPeriodForResult). Returns the period row, or null if the period does
 * not exist or has not ended by `now`.
 *
 * The rate is rounded down to 9 decimals so that every player's share, summed,
 * never comes to more than the budget.
 */
export async function finalizePeriod(periodId, { now = new Date() } = {}) {
  return getDb().transaction(async (trx) => {
    const period = await lockPeriod(trx, { id: periodId });
    if (!period) return null;
    if (toBool(period.finalized)) return period;
    if (new Date(period.ends_at).getTime() > now.getTime()) return null;
    // Summed after taking the lock: a result that was mid-write when this began
    // has committed by now, so it is counted rather than missed.
    const row = await trx('eligible_breaks').where({ period_id: periodId })
      .sum({ points: 'break_value' }).first();
    const total = Number(row?.points ?? 0);
    const rate = total > 0 ? floor9(Number(period.budget_tokens) / total) : 0;
    await trx('reward_periods').where({ id: periodId, finalized: false }).update({
      finalized: true,
      total_eligible_points: total,
      rate: rate.toFixed(9),
    });
    return trx('reward_periods').where({ id: periodId }).first();
  });
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

  // The period row stays locked until this commits, so a close cannot store a
  // rate that misses this break, and this break cannot land after one has been.
  // The daily limits count inside the same transaction. (Count-then-insert
  // needs no lock of its own: a player is only ever in one active match, since
  // joinQueue refuses otherwise, so their results cannot race each other.)
  return knex.transaction(async (trx) => {
    const period = await openPeriodForResult(trx, now);
    // Moved forward past a stored period: count the day that period starts on.
    const day = utcDay(new Date(Math.max(now.getTime(), new Date(period.starts_at).getTime())));
    const reason = await dailyLimitReason(userId, opponentId, day, trx);
    if (reason) {
      await trx('matches').where({ id: matchRow.id }).update({ ineligible_reason: reason });
      return { userId, breakValue: 0, blockedBreak: best, ineligibleReason: reason };
    }

    await trx('eligible_breaks').insert({
      match_id: matchRow.id,
      user_id: userId,
      opponent_id: opponentId,
      period_id: period.id,
      break_value: best,
      award_day: day,
    }).onConflict('match_id').ignore();

    await trx('users').where({ id: userId })
      .increment('lifetime_eligible_points', best)
      .update({ updated_at: knex.fn.now() });
    await trx('users').where({ id: userId }).where('best_break', '<', best)
      .update({ best_break: best });

    return { userId, breakValue: best, periodId: period.id };
  });
}

/**
 * A period's budget, points and rate. For a period that has ended these are the
 * stored numbers (stored on first read if nobody has yet), so every claim for it
 * uses the same rate however late it comes. For an open period they are live
 * and provisional: the rate falls as more eligible points are earned.
 */
export async function periodTotals(periodId, { now = new Date() } = {}) {
  const knex = getDb();
  let period = await knex('reward_periods').where({ id: periodId }).first();
  if (!period) return null;
  if (!toBool(period.finalized) && new Date(period.ends_at).getTime() <= now.getTime()) {
    period = await finalizePeriod(periodId, { now });
  }
  const budget = Number(period.budget_tokens);
  if (toBool(period.finalized)) {
    return {
      period, totalPoints: Number(period.total_eligible_points), budget, rate: Number(period.rate), final: true,
    };
  }
  const row = await knex('eligible_breaks').where({ period_id: periodId })
    .sum({ points: 'break_value' }).first();
  const totalPoints = Number(row?.points ?? 0);
  // The core payout formula: the budget is fixed, so the per-point rate falls
  // as more eligible points are earned. The budget can never be overspent.
  const rate = totalPoints > 0 ? budget / totalPoints : 0;
  return { period, totalPoints, budget, rate, final: false };
}

export async function userPeriodPoints(userId, periodId) {
  const row = await getDb()('eligible_breaks')
    .where({ period_id: periodId, user_id: userId })
    .sum({ points: 'break_value' }).first();
  return Number(row?.points ?? 0);
}

export async function quote(userId, periodId, { now = new Date() } = {}) {
  const totals = await periodTotals(periodId, { now });
  if (!totals) return null;
  const points = await userPeriodPoints(userId, periodId);
  const uncapped = points * totals.rate;
  const cap = totals.budget * config.rewards.maxShare;
  const tokens = Math.min(uncapped, cap);
  return {
    periodId,
    kind: totals.period.kind,
    endsAt: totals.period.ends_at,
    closed: new Date(totals.period.ends_at).getTime() <= now.getTime(),
    points,
    totalPoints: totals.totalPoints,
    budget: totals.budget,
    rate: totals.rate,
    // Rounded down, like the stored rate: rounding up could overspend the budget.
    tokens: floor9(tokens),
    capped: uncapped > cap,
    minPoints: config.rewards.minPointsToRedeem,
  };
}

/** Days after a period closes that its reward can still be claimed (REWARD_CLAIM_WINDOW_DAYS). */
export const CLAIM_WINDOW_DAYS = () => config.rewards.claimWindowDays;

/**
 * Time left to claim after a wallet-change cooldown ends, when that cooldown ran
 * into a period's deadline. Extending only to the end of the cooldown would
 * unlock the claim at the very moment it expired.
 */
export const CLAIM_GRACE_AFTER_COOLDOWN_MS = DAY_MS;

/** When the wallet-change cooldown lifts, in ms, or null if it does not apply. */
function cooldownEndsAt(user, exempt) {
  if (exempt || !user?.wallet_changed_at) return null;
  return new Date(user.wallet_changed_at).getTime() + WALLET_CLAIM_COOLDOWN_MS;
}

/**
 * Last moment (ms, exclusive) `user` can claim `period`: CLAIM_WINDOW_DAYS after
 * it closed. A period must not expire during the player's wallet cooldown, when
 * they cannot claim at all, so a cooldown that began before the deadline pushes
 * the deadline out to a day after the cooldown ends. A wallet change after the
 * deadline revives nothing.
 */
export function claimDeadline(period, user, { exempt = false } = {}) {
  const raw = new Date(period.ends_at ?? period.endsAt).getTime() + CLAIM_WINDOW_DAYS() * DAY_MS;
  const cooldownEnd = cooldownEndsAt(user, exempt);
  if (cooldownEnd === null || new Date(user.wallet_changed_at).getTime() > raw) return raw;
  return Math.max(raw, cooldownEnd + CLAIM_GRACE_AFTER_COOLDOWN_MS);
}

/**
 * Every closed period `userId` has unclaimed points in and can still claim,
 * oldest first. Periods below the minimum stay listed with `claimable: false` so
 * the player can see why; claimed and expired periods are left out.
 */
export async function claimablePeriods(userId, { now = new Date() } = {}) {
  const knex = getDb();
  const user = await knex('users').where({ id: userId }).first();
  const exempt = await isLimitExempt(userId);
  // A deadline can move out by at most the cooldown plus the grace day.
  const oldest = new Date(now.getTime() - CLAIM_WINDOW_DAYS() * DAY_MS - WALLET_CLAIM_COOLDOWN_MS - CLAIM_GRACE_AFTER_COOLDOWN_MS);

  const earnedIn = (await knex('eligible_breaks').where({ user_id: userId }).distinct('period_id'))
    .map((r) => r.period_id);
  if (earnedIn.length === 0) return { windowDays: CLAIM_WINDOW_DAYS(), periods: [], totalTokens: 0 };
  const periods = await knex('reward_periods').whereIn('id', earnedIn)
    .where('ends_at', '<=', now).where('ends_at', '>', oldest)
    .orderBy('ends_at', 'asc');
  const claimed = new Set((await knex('redemptions').where({ user_id: userId }).whereIn('period_id', earnedIn)
    .select('period_id')).map((r) => String(r.period_id)));

  const out = [];
  for (const period of periods) {
    if (claimed.has(String(period.id))) continue;
    const expiresAt = claimDeadline(period, user, { exempt });
    if (now.getTime() >= expiresAt) continue;
    const q = await quote(userId, period.id, { now });
    const enough = q.points >= q.minPoints && q.tokens > 0;
    out.push({
      periodId: period.id,
      kind: period.kind,
      startsAt: new Date(period.starts_at).toISOString(),
      endsAt: new Date(period.ends_at).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      points: q.points,
      totalPoints: q.totalPoints,
      rate: q.rate,
      tokens: q.tokens,
      capped: q.capped,
      minPoints: q.minPoints,
      claimable: enough,
      reason: enough ? null : 'below-minimum',
    });
  }
  const totalTokens = floor9(out.filter((p) => p.claimable).reduce((sum, p) => sum + p.tokens, 0));
  return { windowDays: CLAIM_WINDOW_DAYS(), periods: out, totalTokens };
}

const publicRedemption = (r) => ({
  id: r.id,
  periodId: r.period_id,
  points: Number(r.points),
  tokens: Number(r.tokens),
  status: r.status,
});

/**
 * Claim every claimable period at once: one redemption per period, each at that
 * period's stored rate, so the payout script's per-period budget check is
 * unchanged. Each row's request_id is `<requestId>:<periodId>`; replaying the
 * same requestId returns what it queued the first time.
 */
export async function redeemClaimable({ userId, requestId, now = new Date() }) {
  const knex = getDb();
  const prefix = `${requestId}:`;
  const replay = await knex('redemptions').where({ user_id: userId })
    .whereRaw('substr(request_id, 1, ?) = ?', [prefix.length, prefix]).orderBy('period_id');
  if (replay.length) return { status: 'duplicate', redemptions: replay.map(publicRedemption), skipped: [] };

  const wallet = await activeWallet(userId);
  if (!wallet) return { status: 'error', reason: 'no wallet linked — use /wallet first' };

  const user = await userById(userId);
  const unlocksAt = cooldownEndsAt(user, await isLimitExempt(userId));
  if (unlocksAt !== null && now.getTime() < unlocksAt) {
    const when = new Date(unlocksAt).toISOString();
    return {
      status: 'error',
      reason: `your payout wallet changed recently — claims unlock at ${when}`,
      unlocksAt: when,
    };
  }

  const { periods } = await claimablePeriods(userId, { now });
  const redemptions = [];
  const quotes = [];
  const skipped = [];
  for (const p of periods) {
    if (!p.claimable) {
      skipped.push({
        periodId: p.periodId, reason: p.reason, points: p.points, minPoints: p.minPoints,
      });
      continue;
    }
    const res = await redeem({
      userId, periodId: p.periodId, requestId: `${prefix}${p.periodId}`, now,
    });
    if (res.status === 'queued') {
      redemptions.push(publicRedemption(res.redemption));
      quotes.push(res.quote);
    } else {
      skipped.push({ periodId: p.periodId, reason: res.reason ?? res.status });
    }
  }
  return {
    status: redemptions.length ? 'queued' : 'nothing', redemptions, quotes, skipped,
  };
}

/**
 * Queue a redemption for one period. Only for a closed period, so the rate is
 * final (paying out mid-period would let the last players in the window be
 * underfunded), and only within its claim window. Idempotent on request_id,
 * and one redemption per player per period.
 */
export async function redeem({
  userId, periodId, requestId, now = new Date(),
}) {
  const knex = getDb();

  const existingByRequest = await knex('redemptions').where({ request_id: requestId }).first();
  if (existingByRequest) return { status: 'duplicate', redemption: existingByRequest };

  const q = await quote(userId, periodId, { now });
  if (!q) return { status: 'error', reason: 'unknown period' };
  if (!q.closed) return { status: 'error', reason: 'period still open' };

  const user = await userById(userId);
  const exempt = await isLimitExempt(userId);
  if (now.getTime() >= claimDeadline({ ends_at: q.endsAt }, user, { exempt })) {
    return { status: 'error', reason: 'the claim window for this period has closed' };
  }
  if (q.points < q.minPoints) {
    return { status: 'error', reason: `need at least ${q.minPoints} eligible points` };
  }

  const wallet = await activeWallet(userId);
  if (!wallet) return { status: 'error', reason: 'no wallet linked — use /wallet first' };

  const already = await knex('redemptions').where({ user_id: userId, period_id: periodId }).first();
  if (already) return { status: 'duplicate', redemption: already };

  // A freshly changed wallet cannot receive a claim yet, so whoever changed it
  // on a stolen session cannot cash out before the player sees the bot's notice.
  const unlocksAt = cooldownEndsAt(user, exempt);
  if (unlocksAt !== null && now.getTime() < unlocksAt) {
    return {
      status: 'error',
      reason: `your payout wallet changed recently — claims unlock at ${new Date(unlocksAt).toISOString()}`,
    };
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
