import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('periodboundary');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.SHOT_CLOCK_SECONDS = '25';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';
process.env.REWARD_PERIOD_KIND = 'daily';
process.env.REWARD_BUDGET_TOKENS = '1000';
process.env.REWARD_MAX_SHARE = '0.25';
process.env.REWARD_MIN_POINTS = '1';

const {
  closeDb, migrate, getDb, toJson, fromJson, toBool, isPostgres,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const {
  currentPeriod, recordEligibleBreak, finalizePeriod, periodTotals, quote,
} = await import('../src/services/rewards.js');
const { newMatch, POCKETS, ballById } = await import('@snooker/sim');

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let nextTelegramId = 9800;
async function login() {
  const id = nextTelegramId++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
  return { token: res.body.token, userId: res.body.user.id };
}

let matchSeq = 0;
/** A finished PvP match row where seat 0 made `breakValue`, for recordEligibleBreak. */
async function finishedMatch(breakValue, { createdAt } = {}) {
  const a = await login();
  const b = await login();
  const id = `pb-${matchSeq += 1}`;
  await getDb()('matches').insert({
    id, mode: 'pvp', player_a: a.userId, player_b: b.userId, status: 'completed',
    state: '{}', crypto_eligible: true, ...(createdAt ? { created_at: createdAt } : {}),
  });
  const state = { ...newMatch([a.userId, b.userId]), ended: true, winner: 0, highBreaks: [breakValue, 0] };
  return { row: { id }, state, userId: a.userId };
}

const at = (iso) => new Date(iso);
const breaksIn = async (periodId) => Number((await getDb()('eligible_breaks')
  .where({ period_id: periodId }).sum({ n: 'break_value' }).first())?.n ?? 0);
const periodStarting = (iso) => getDb()('reward_periods').where({ kind: 'daily' })
  .andWhere('starts_at', at(iso)).first();

// --- The timestamp rule -----------------------------------------------------

test('a result belongs to the period containing the server time it is recorded', async () => {
  const m = await finishedMatch(30);
  const result = await recordEligibleBreak(m.row, m.state, { now: at('2026-09-01T12:00:00Z') });
  const period = await periodStarting('2026-09-01T00:00:00Z');
  assert.equal(Number(result.periodId), Number(period.id));
});

test('a match that starts before midnight and finishes after counts in the period it finishes in', async () => {
  const m = await finishedMatch(25, { createdAt: at('2026-09-02T23:50:00Z') });
  const result = await recordEligibleBreak(m.row, m.state, { now: at('2026-09-03T00:04:00Z') });
  const sept3 = await periodStarting('2026-09-03T00:00:00Z');
  assert.equal(Number(result.periodId), Number(sept3.id));
  const sept2 = await periodStarting('2026-09-02T00:00:00Z');
  assert.equal(sept2 ? await breaksIn(sept2.id) : 0, 0);
});

// --- Storing the rate at close ---------------------------------------------

test('finalizing refuses a period that has not ended yet', async () => {
  const m = await finishedMatch(10);
  const r = await recordEligibleBreak(m.row, m.state, { now: at('2026-09-04T09:00:00Z') });
  assert.equal(await finalizePeriod(r.periodId, { now: at('2026-09-04T23:59:59Z') }), null);
  const row = await getDb()('reward_periods').where({ id: r.periodId }).first();
  assert.equal(toBool(row.finalized), false);
});

test('closing stores the rate once; later reads and re-finalizing return the stored values', async () => {
  const a = await finishedMatch(40);
  const b = await finishedMatch(60);
  const ra = await recordEligibleBreak(a.row, a.state, { now: at('2026-09-05T08:00:00Z') });
  await recordEligibleBreak(b.row, b.state, { now: at('2026-09-05T20:00:00Z') });

  const stored = await finalizePeriod(ra.periodId, { now: at('2026-09-06T00:00:01Z') });
  assert.equal(toBool(stored.finalized), true);
  assert.equal(Number(stored.total_eligible_points), 100);
  assert.equal(Number(stored.rate), 10);

  // Force a row into the closed period behind the service's back (a bug, a
  // manual insert): the stored rate is what counts from here on.
  const rogue = await finishedMatch(900);
  await getDb()('eligible_breaks').insert({
    match_id: rogue.row.id, user_id: rogue.userId, period_id: ra.periodId, break_value: 900, award_day: '2026-09-05',
  });
  const again = await finalizePeriod(ra.periodId, { now: at('2026-09-07T00:00:00Z') });
  assert.equal(Number(again.rate), 10);
  assert.equal(Number(again.total_eligible_points), 100);

  const totals = await periodTotals(ra.periodId);
  assert.equal(totals.rate, 10);
  assert.equal(totals.totalPoints, 100);
  const q = await quote(a.userId, ra.periodId);
  assert.equal(q.rate, 10);
  assert.equal(q.tokens, 250, '40 × 10 = 400, capped at 25% of 1000');
});

test('reading a closed period stores its rate even if nobody finalized it explicitly', async () => {
  const m = await finishedMatch(20);
  const r = await recordEligibleBreak(m.row, m.state, { now: at('2026-09-08T10:00:00Z') });
  const q = await quote(m.userId, r.periodId); // 2026-09-08 is in the past: closed
  assert.equal(q.closed, true);
  assert.equal(q.rate, 50);
  const row = await getDb()('reward_periods').where({ id: r.periodId }).first();
  assert.equal(toBool(row.finalized), true);
  assert.equal(Number(row.rate), 50);
});

test('a result computed just before close but written after the rate was stored goes to the next period', async () => {
  const early = await finishedMatch(50);
  const r = await recordEligibleBreak(early.row, early.state, { now: at('2026-09-09T12:00:00Z') });
  // A fast-clocked replica closes the period a moment early.
  await finalizePeriod(r.periodId, { now: at('2026-09-10T00:00:01Z') });

  // This writer's clock still says 23:59:59 on the 9th.
  const late = await finishedMatch(70);
  const lr = await recordEligibleBreak(late.row, late.state, { now: at('2026-09-09T23:59:59.900Z') });
  const sept10 = await periodStarting('2026-09-10T00:00:00Z');
  assert.equal(Number(lr.periodId), Number(sept10.id), 'moved to the next open period');

  const closed = await getDb()('reward_periods').where({ id: r.periodId }).first();
  assert.equal(Number(closed.total_eligible_points), 50);
  assert.equal(Number(closed.rate), 20);
  assert.equal(await breaksIn(r.periodId), 50, 'nothing was added to the closed period');
});

test('closing and a late write racing: the stored total always matches what is in the period', async () => {
  const first = await finishedMatch(30);
  const r = await recordEligibleBreak(first.row, first.state, { now: at('2026-09-11T06:00:00Z') });
  const late = await finishedMatch(45);

  const [, lr] = await Promise.all([
    finalizePeriod(r.periodId, { now: at('2026-09-12T00:00:00.500Z') }),
    recordEligibleBreak(late.row, late.state, { now: at('2026-09-11T23:59:59.990Z') }),
  ]);
  const closed = await getDb()('reward_periods').where({ id: r.periodId }).first();
  assert.equal(Number(closed.total_eligible_points), await breaksIn(r.periodId),
    `stored ${closed.total_eligible_points}, late break went to period ${lr.periodId}`);
  assert.equal(Number(closed.rate), Math.floor((1000 / Number(closed.total_eligible_points)) * 1e9) / 1e9);
});

test('the stored rate is rounded down, so every share summed stays within the budget', async () => {
  const shares = [3, 3, 1];
  let periodId;
  const users = [];
  for (const [i, pts] of shares.entries()) {
    const m = await finishedMatch(pts);
    users.push(m.userId);
    const res = await recordEligibleBreak(m.row, m.state, { now: at(`2026-09-20T0${i + 1}:00:00Z`) });
    periodId = res.periodId;
  }
  const stored = await finalizePeriod(periodId, { now: at('2026-09-21T00:00:00Z') });
  assert.equal(Number(stored.rate), 142.857142857, '1000 / 7, floored to 9 decimals');
  let paid = 0;
  for (const u of users) paid += (await quote(u, periodId)).tokens;
  assert.ok(paid <= 1000, `paid ${paid}`);
});

// --- A queued result arriving after its period closed ------------------------

test('a queued match-winning shot played yesterday but arriving today lands in today\'s period', async () => {
  const now = new Date();
  const yesterdayNoon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12));
  const prior = await finishedMatch(50);
  const yr = await recordEligibleBreak(prior.row, prior.state, { now: yesterdayNoon });
  const yesterday = await finalizePeriod(yr.periodId); // real clock: yesterday has ended
  assert.equal(toBool(yesterday.finalized), true);

  // A live match that went quiet just before midnight with Ann on the last black.
  const ann = await login();
  const ben = await login();
  await call('/api/match/queue', { method: 'POST', token: ann.token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: ben.token });
  const matchId = body.matchId;
  await getDb()('matches').where({ id: matchId }).update({ created_at: new Date(yesterdayNoon.getTime() + 11.8 * 3600e3) });
  const row = await getDb()('matches').where({ id: matchId }).first();
  const state = fromJson(row.state);
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  state.frame.balls.forEach((b) => { b.potted = true; });
  Object.assign(ballById(state.frame, 'black'), black, { potted: false });
  Object.assign(ballById(state.frame, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(state.frame, {
    phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn: 0, scores: [40, 10], highBreaks: [26, 0],
  });
  state.framesWon = [1, 0];
  await getDb()('matches').where({ id: matchId }).update({
    state: toJson(state), turn_user_id: ann.userId, shot_deadline: new Date(Date.now() + 25_000),
  });

  // The client stamps the entry with yesterday's time. The server ignores it.
  const playedAt = new Date(yesterdayNoon.getTime() + 11.99 * 3600e3).getTime();
  const res = await call('/api/sync', {
    method: 'POST',
    token: ann.token,
    body: {
      results: [{
        resultId: `queued-${matchId}`, kind: 'shot', matchId, createdAt: playedAt, playedAt,
        payload: { shot: { angle: Math.PI / 4, power: 0.55 }, playedAt },
      }],
    },
  });
  assert.equal(res.body.results[0].match?.ended, true, JSON.stringify(res.body.results[0]));

  const award = await getDb()('eligible_breaks').where({ match_id: matchId }).first();
  const today = await currentPeriod();
  assert.equal(Number(award.period_id), Number(today.id), 'recorded in the period containing the server time');
  assert.equal(award.award_day, today.starts_at instanceof Date
    ? today.starts_at.toISOString().slice(0, 10) : new Date(today.starts_at).toISOString().slice(0, 10));

  const after = await getDb()('reward_periods').where({ id: yr.periodId }).first();
  assert.equal(Number(after.total_eligible_points), 50);
  assert.equal(Number(after.rate), 20);
  assert.equal(await breaksIn(yr.periodId), 50);
});

// --- The row lock, made deterministic (Postgres only) -------------------------
// The race test above passes with or without the lock: whichever side wins, the
// timing rarely lets them overlap. These hold one side's transaction open so the
// other side has to wait for it. SQLite runs one transaction at a time on a
// single connection, so there is nothing to interleave there.

const onPostgres = { skip: isPostgres() ? false : 'needs Postgres (TEST_POSTGRES_URL)' };
const settledWithin = (promise, ms) => Promise.race([
  promise.then(() => true, () => true),
  new Promise((resolve) => { setTimeout(() => resolve(false), ms); }),
]);

test('closing waits for a break that is mid-write, and counts it', onPostgres, async () => {
  const seed = await finishedMatch(10);
  const { periodId } = await recordEligibleBreak(seed.row, seed.state, { now: at('2026-09-22T10:00:00Z') });
  const writer = await finishedMatch(90);

  const trx = await getDb().transaction();
  await trx('reward_periods').where({ id: periodId }).forUpdate().first();
  await trx('eligible_breaks').insert({
    match_id: writer.row.id, user_id: writer.userId, period_id: periodId, break_value: 90, award_day: '2026-09-22',
  });

  const closing = finalizePeriod(periodId, { now: at('2026-09-23T00:00:01Z') });
  assert.equal(await settledWithin(closing, 400), false, 'closing must wait for the open write');
  await trx.commit();

  const stored = await closing;
  assert.equal(Number(stored.total_eligible_points), 100, 'the break that was mid-write is in the stored total');
  assert.equal(Number(stored.rate), 10);
});

test('a break waits for a close that is mid-write, then goes to the next period', onPostgres, async () => {
  const seed = await finishedMatch(20);
  const { periodId } = await recordEligibleBreak(seed.row, seed.state, { now: at('2026-09-24T10:00:00Z') });
  const late = await finishedMatch(80);

  // Another replica is closing the period and has not committed yet.
  const trx = await getDb().transaction();
  await trx('reward_periods').where({ id: periodId }).forUpdate().first();
  await trx('reward_periods').where({ id: periodId }).update({ finalized: true, total_eligible_points: 20, rate: '50.000000000' });

  const writing = recordEligibleBreak(late.row, late.state, { now: at('2026-09-24T23:59:59.500Z') });
  assert.equal(await settledWithin(writing, 400), false, 'the break must wait for the close');
  await trx.commit();

  const result = await writing;
  const next = await periodStarting('2026-09-25T00:00:00Z');
  assert.equal(Number(result.periodId), Number(next.id));
  assert.equal(await breaksIn(periodId), 20, 'the closed period gained nothing');
});
