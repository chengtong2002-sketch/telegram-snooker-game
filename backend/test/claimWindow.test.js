import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('claimwindow');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';
process.env.REWARD_PERIOD_KIND = 'daily';
process.env.REWARD_BUDGET_TOKENS = '1000';
process.env.REWARD_MAX_SHARE = '0.25';
process.env.REWARD_MIN_POINTS = '10';
delete process.env.REWARD_CLAIM_WINDOW_DAYS; // the default, 30 days

const {
  closeDb, migrate, getDb, upsertUser, linkWallet,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const {
  claimablePeriods, redeemClaimable, redeem, CLAIM_WINDOW_DAYS,
} = await import('../src/services/rewards.js');

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;
const at = (iso) => new Date(iso);
let telegramSeq = 30_000;
let matchSeq = 0;

async function player({ wallet = true, walletChangedAt = null } = {}) {
  const user = await upsertUser({ id: telegramSeq += 1, first_name: `C${telegramSeq}` });
  if (wallet) {
    await linkWallet(user.id, { address: `EQclaim${user.id}${'x'.repeat(40)}`.slice(0, 48), network: 'testnet' });
  }
  if (walletChangedAt) await getDb()('users').where({ id: user.id }).update({ wallet_changed_at: walletChangedAt });
  return user;
}

/** A closed daily period starting at `dayIso`, with `points` credited to each user. */
async function seedPeriod(dayIso, awards) {
  const knex = getDb();
  const starts = at(`${dayIso}T00:00:00Z`);
  await knex('reward_periods').insert({
    kind: 'daily', starts_at: starts, ends_at: new Date(starts.getTime() + DAY), budget_tokens: 1000,
  });
  const period = await knex('reward_periods').where({ kind: 'daily', starts_at: starts }).first();
  for (const [user, points] of awards) {
    const opponent = await player({ wallet: false });
    const id = `cw-${matchSeq += 1}`;
    await knex('matches').insert({
      id, mode: 'pvp', player_a: user.id, player_b: opponent.id, status: 'completed', state: '{}', crypto_eligible: true,
    });
    await knex('eligible_breaks').insert({
      match_id: id, user_id: user.id, opponent_id: opponent.id, period_id: period.id, break_value: points, award_day: dayIso,
    });
  }
  return period;
}

const rowsFor = (user) => getDb()('redemptions').where({ user_id: user.id }).orderBy('period_id');

test('the window is 30 days by default', () => {
  assert.equal(CLAIM_WINDOW_DAYS(), 30);
});

test('the deadlock: a first link just before close no longer loses the reward', async () => {
  // 23:00 on July 1: first wallet link, cooldown until 23:00 on July 2.
  const me = await player({ walletChangedAt: at('2026-07-01T23:00:00Z') });
  const other = await player();
  const july1 = await seedPeriod('2026-07-01', [[me, 40], [other, 60]]);
  const july2 = await seedPeriod('2026-07-02', [[me, 20], [other, 80]]);

  const early = await redeemClaimable({ userId: me.id, requestId: 'dl-1', now: at('2026-07-02T10:00:00Z') });
  assert.equal(early.status, 'error');
  assert.match(early.reason, /wallet changed recently/);
  assert.equal(early.unlocksAt, '2026-07-02T23:00:00.000Z');
  assert.equal((await rowsFor(me)).length, 0);

  // Before this change only July 2 (the last closed period) could be claimed now.
  const later = await redeemClaimable({ userId: me.id, requestId: 'dl-2', now: at('2026-07-03T09:00:00Z') });
  assert.equal(later.status, 'queued', JSON.stringify(later));
  const rows = await rowsFor(me);
  assert.deepEqual(rows.map((r) => Number(r.period_id)), [Number(july1.id), Number(july2.id)]);
  assert.deepEqual(rows.map((r) => Number(r.tokens)), [250, 200], '40 × 10 capped at 250; 20 × 10');
});

test('claimable up to 30 days after close, not a second later', async () => {
  const onTime = await player();
  const tooLate = await player();
  const filler = await player();
  const period = await seedPeriod('2026-06-01', [[onTime, 50], [tooLate, 50], [filler, 100]]);
  const deadline = new Date(period.ends_at).getTime() + 30 * DAY;

  const listed = await claimablePeriods(onTime.id, { now: new Date(deadline - 1000) });
  assert.equal(listed.periods.length, 1);
  assert.equal(new Date(listed.periods[0].expiresAt).getTime(), deadline);
  assert.equal((await redeemClaimable({ userId: onTime.id, requestId: 'edge-ok', now: new Date(deadline - 1000) })).status, 'queued');

  assert.deepEqual((await claimablePeriods(tooLate.id, { now: new Date(deadline + 1000) })).periods, []);
  const late = await redeemClaimable({ userId: tooLate.id, requestId: 'edge-late', now: new Date(deadline + 1000) });
  assert.equal(late.status, 'nothing');
  const single = await redeem({ userId: tooLate.id, periodId: period.id, requestId: 'edge-late-1', now: new Date(deadline + 1000) });
  assert.equal(single.status, 'error');
  assert.match(single.reason, /claim window/);
  assert.equal((await rowsFor(tooLate)).length, 0, 'expired rewards are never queued, so never minted');
});

test('a cooldown running into the deadline extends it to a day after the cooldown ends', async () => {
  // Period ends June 11; raw deadline July 11 00:00. Wallet changed July 10 22:00,
  // so claims unlock July 11 22:00 and the deadline moves to July 12 22:00.
  const me = await player({ walletChangedAt: at('2026-07-10T22:00:00Z') });
  await seedPeriod('2026-06-10', [[me, 50], [await player(), 150]]);

  const blocked = await redeemClaimable({ userId: me.id, requestId: 'ext-1', now: at('2026-07-10T23:00:00Z') });
  assert.equal(blocked.status, 'error');
  const listing = await claimablePeriods(me.id, { now: at('2026-07-11T21:00:00Z') });
  assert.equal(listing.periods[0].expiresAt, '2026-07-12T22:00:00.000Z');
});

test('extension: claimable once the cooldown ends, expired a day after that', async () => {
  const me = await player({ walletChangedAt: at('2026-07-15T22:00:00Z') });
  const other = await player({ walletChangedAt: at('2026-07-15T22:00:00Z') });
  await seedPeriod('2026-06-15', [[me, 50], [other, 50], [await player(), 100]]);
  // Raw deadline July 16 00:00; cooldown ends July 16 22:00; extended to July 17 22:00.
  assert.equal((await redeemClaimable({ userId: me.id, requestId: 'ext-a', now: at('2026-07-16T21:59:00Z') })).status, 'error',
    'still inside the cooldown');
  assert.equal((await redeemClaimable({ userId: me.id, requestId: 'ext-b', now: at('2026-07-16T22:01:00Z') })).status, 'queued',
    'past the raw deadline, inside the extension');
  assert.equal((await redeemClaimable({ userId: other.id, requestId: 'ext-c', now: at('2026-07-17T22:00:01Z') })).status, 'nothing');
  assert.equal((await rowsFor(other)).length, 0);
});

test('a wallet change after the deadline does not bring an expired reward back', async () => {
  const me = await player({ walletChangedAt: at('2026-07-25T12:00:00Z') });
  await seedPeriod('2026-06-20', [[me, 50], [await player(), 150]]);
  // Deadline July 21 00:00 passed before the change on July 25.
  assert.deepEqual((await claimablePeriods(me.id, { now: at('2026-07-26T13:00:00Z') })).periods, []);
});

test('a late claim is paid at the same stored rate as an on-time one', async () => {
  const players = [];
  for (let i = 0; i < 5; i += 1) players.push(await player());
  await seedPeriod('2026-06-22', players.map((p) => [p, 100])); // 500 points: rate 2

  const first = await redeemClaimable({ userId: players[0].id, requestId: 'rate-1', now: at('2026-06-23T08:00:00Z') });
  const last = await redeemClaimable({ userId: players[4].id, requestId: 'rate-5', now: at('2026-07-21T08:00:00Z') });
  assert.equal(first.redemptions[0].tokens, 200);
  assert.equal(last.redemptions[0].tokens, 200);
  assert.equal(first.quotes[0].rate, last.quotes[0].rate);
});

test('the minimum applies per period: a small period is skipped, a big one is queued', async () => {
  const me = await player();
  const small = await seedPeriod('2026-06-25', [[me, 5], [await player(), 95]]);
  const big = await seedPeriod('2026-06-26', [[me, 30], [await player(), 70]]);
  const res = await redeemClaimable({ userId: me.id, requestId: 'min', now: at('2026-06-28T00:00:00Z') });
  assert.equal(res.status, 'queued');
  assert.deepEqual(res.redemptions.map((r) => Number(r.periodId)), [Number(big.id)]);
  assert.deepEqual(res.skipped, [{ periodId: small.id, reason: 'below-minimum', points: 5, minPoints: 10 }]);
  // The small period stays listed, marked not claimable, so the player sees why.
  const listing = await claimablePeriods(me.id, { now: at('2026-06-28T00:00:00Z') });
  assert.deepEqual(listing.periods.map((p) => [Number(p.periodId), p.claimable, p.reason]), [[Number(small.id), false, 'below-minimum']]);
  assert.equal(listing.totalTokens, 0);
});

test('claiming is idempotent: a replay changes nothing, and a claimed period is not listed again', async () => {
  const me = await player();
  await seedPeriod('2026-06-27', [[me, 40], [await player(), 60]]);
  await seedPeriod('2026-06-28', [[me, 40], [await player(), 60]]);
  const now = at('2026-06-30T00:00:00Z');

  assert.equal((await redeemClaimable({ userId: me.id, requestId: 'idem', now })).redemptions.length, 2);
  const replay = await redeemClaimable({ userId: me.id, requestId: 'idem', now });
  assert.equal(replay.status, 'duplicate');
  const fresh = await redeemClaimable({ userId: me.id, requestId: 'idem-2', now });
  assert.equal(fresh.status, 'nothing');
  assert.equal((await rowsFor(me)).length, 2);
  assert.deepEqual((await claimablePeriods(me.id, { now })).periods, []);
});

test('an open period is never claimable, and no wallet means no claim', async () => {
  const me = await player({ wallet: false });
  await seedPeriod('2026-06-29', [[me, 40], [await player(), 60]]);
  const insideIt = await claimablePeriods(me.id, { now: at('2026-06-29T18:00:00Z') });
  assert.deepEqual(insideIt.periods, [], 'still open');
  const res = await redeemClaimable({ userId: me.id, requestId: 'nowallet', now: at('2026-07-01T00:00:00Z') });
  assert.equal(res.status, 'error');
  assert.match(res.reason, /wallet/);
});

test('over HTTP: /rewards/claimable lists every claimable period, /rewards/redeem queues them all', async () => {
  const login = await fetch(`${base}/api/auth/telegram`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ devUser: { id: 39_001, first_name: 'Http' } }),
  }).then((r) => r.json());
  const token = login.token;
  const me = { id: login.user.id };
  await linkWallet(me.id, { address: `EQhttp${'y'.repeat(42)}`, network: 'testnet' });

  const today = new Date();
  const day = (offset) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset))
    .toISOString().slice(0, 10);
  await seedPeriod(day(-3), [[me, 40], [await player(), 60]]);
  await seedPeriod(day(-2), [[me, 20], [await player(), 80]]);
  await seedPeriod(day(-40), [[me, 90], [await player(), 10]]); // long expired

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const listing = await fetch(`${base}/api/rewards/claimable`, { headers }).then((r) => r.json());
  assert.equal(listing.windowDays, 30);
  assert.equal(listing.periods.length, 2, JSON.stringify(listing));
  assert.ok(listing.periods.every((p) => p.claimable && p.expiresAt));
  assert.equal(listing.totalTokens, 450);

  const tooLong = await fetch(`${base}/api/rewards/redeem`, {
    method: 'POST', headers, body: JSON.stringify({ requestId: 'x'.repeat(45) }),
  });
  assert.equal(tooLong.status, 400);

  const res = await fetch(`${base}/api/rewards/redeem`, {
    method: 'POST', headers, body: JSON.stringify({ requestId: 'http-claim' }),
  }).then((r) => r.json());
  assert.equal(res.status, 'queued', JSON.stringify(res));
  assert.equal(res.redemptions.length, 2);
  assert.equal((await rowsFor(me)).length, 2);
});
