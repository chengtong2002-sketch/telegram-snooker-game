import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

// A throwaway SQLite file per run, wired up before anything imports the db.
const dropTestDatabase = await useTestDatabase('test');
process.env.REWARD_BUDGET_TOKENS = '1000';
process.env.REWARD_PERIOD_KIND = 'daily';
process.env.REWARD_MAX_SHARE = '0.25';
process.env.REWARD_MIN_POINTS = '10';
process.env.NODE_ENV = 'test';

const { getDb, closeDb, migrate, upsertUser, linkWallet, leaderboard } = await import('@snooker/db');
const {
  currentPeriod, recordEligibleBreak, periodTotals, quote, redeem,
} = await import('../src/services/rewards.js');
const { newMatch } = await import('@snooker/sim');

await migrate();

// Telegram ids and DB row ids are different numbers; everything below takes the
// DB id, so resolve the three players once here.
const ann = await upsertUser({ id: 1001, first_name: 'Ann' });
const ben = await upsertUser({ id: 1002, first_name: 'Ben' });
const cara = await upsertUser({ id: 1003, first_name: 'Cara' });

test.after(async () => {
  await closeDb();
  await dropTestDatabase();
});

const finishedMatch = (players, highBreaks) => ({
  ...newMatch(players),
  highBreaks,
  ended: true,
  winner: highBreaks[0] >= highBreaks[1] ? 0 : 1,
});

test('a practice match never produces an eligible break', async () => {
  const row = { id: 'practice-match-1', crypto_eligible: false };
  const result = await recordEligibleBreak(row, finishedMatch([ann.id, ben.id], [40, 10]));
  assert.equal(result, null);
  const rows = await getDb()('eligible_breaks').select('*');
  assert.equal(rows.length, 0, 'practice must not reach the rewards table at all');
});

test('a PvP match records exactly one eligible break: the highest in the match', async () => {
  const knex = getDb();
  await knex('matches').insert({
    id: 'm1', mode: 'pvp', player_a: ann.id, player_b: ben.id,
    status: 'completed', state: '{}', crypto_eligible: true,
  });

  const result = await recordEligibleBreak(
    { id: 'm1', crypto_eligible: true },
    finishedMatch([ann.id, ben.id], [32, 58]),
  );
  assert.equal(result.breakValue, 58);
  assert.equal(Number(result.userId), Number(ben.id));

  const rows = await knex('eligible_breaks').where({ match_id: 'm1' });
  assert.equal(rows.length, 1, 'one break per match, not one per player');
});

test('replaying the same match result does not double-count it', async () => {
  const knex = getDb();
  const before = await knex('eligible_breaks').where({ match_id: 'm1' }).count({ n: 'id' }).first();
  await recordEligibleBreak({ id: 'm1', crypto_eligible: true },
    finishedMatch([ann.id, ben.id], [32, 58]));
  const after = await knex('eligible_breaks').where({ match_id: 'm1' }).count({ n: 'id' }).first();
  assert.equal(Number(after.n), Number(before.n));
});

test('the rate is budget ÷ total eligible points, so the budget is never exceeded', async () => {
  const knex = getDb();
  const period = await currentPeriod();

  // Ben already has 58 on the board; add 42 more for a round 100.
  await knex('matches').insert({
    id: 'm2', mode: 'pvp', player_a: cara.id, player_b: ann.id, status: 'completed',
    state: '{}', crypto_eligible: true,
  });
  await recordEligibleBreak(
    { id: 'm2', crypto_eligible: true },
    finishedMatch([cara.id, ann.id], [42, 0]),
  );

  const totals = await periodTotals(period.id);
  assert.equal(totals.totalPoints, 100);
  assert.equal(totals.budget, 1000);
  assert.equal(totals.rate, 10, '1000 tokens over 100 points');

  // Every player's share summed cannot exceed the budget.
  const everyone = await knex('eligible_breaks').where({ period_id: period.id });
  const paidOut = everyone.reduce((sum, r) => sum + r.break_value * totals.rate, 0);
  assert.ok(paidOut <= totals.budget + 1e-9, `paid ${paidOut} against a ${totals.budget} budget`);
});

test('a single player cannot take more than the configured share of a period', async () => {
  const period = await currentPeriod();
  // Ben holds 58 of 100 points: 580 tokens uncapped, but the cap is 25% = 250.
  const q = await quote(ben.id, period.id);
  assert.equal(q.points, 58);
  assert.equal(q.tokens, 250);
  assert.equal(q.capped, true);
});

test('redemption is refused while the period is still open', async () => {
  const period = await currentPeriod();
  const result = await redeem({ userId: ben.id, periodId: period.id, requestId: 'req-open' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /still open/);
});

test('redemption needs a linked wallet, then queues exactly once', async () => {
  const knex = getDb();
  const period = await currentPeriod();
  // Close the period so the rate is final.
  await knex('reward_periods').where({ id: period.id }).update({ ends_at: new Date(Date.now() - 1000) });

  const noWallet = await redeem({ userId: ben.id, periodId: period.id, requestId: 'req-1' });
  assert.equal(noWallet.status, 'error');
  assert.match(noWallet.reason, /wallet/);

  await linkWallet(ben.id, { address: 'EQAtestaddressbenxxxxxxxxxxxxxxxxxxxxxxxxxxxx', network: 'testnet' });

  const first = await redeem({ userId: ben.id, periodId: period.id, requestId: 'req-2' });
  assert.equal(first.status, 'queued');
  assert.equal(Number(first.redemption.points), 58);
  assert.equal(Number(first.redemption.tokens), 250);

  // Same idempotency key: the offline queue replaying must not pay twice.
  const replay = await redeem({ userId: ben.id, periodId: period.id, requestId: 'req-2' });
  assert.equal(replay.status, 'duplicate');

  // Different key, same period: still only one payout.
  const second = await redeem({ userId: ben.id, periodId: period.id, requestId: 'req-3' });
  assert.equal(second.status, 'duplicate');

  const rows = await knex('redemptions').where({ user_id: ben.id, period_id: period.id });
  assert.equal(rows.length, 1);
});

test('the leaderboard ranks by highest break and only contains PvP breaks', async () => {
  const rows = await leaderboard({ limit: 10 });
  assert.ok(rows.length >= 2);
  assert.equal(Number(rows[0].best_break), 58);
  const totals = rows.reduce((sum, r) => sum + Number(r.total_points), 0);
  assert.equal(totals, 100, 'only the two PvP breaks, never the practice one');
});
