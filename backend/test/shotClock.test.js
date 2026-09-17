import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('shotclock');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';
// A stale override, as the local .env and Railway had. It must be ignored.
process.env.SHOT_CLOCK_SECONDS = '25';

const {
  closeDb, migrate, getDb, toJson, fromJson,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { sweepShotClocks, applyShot } = await import('../src/services/matchService.js');
const {
  SHOT_CLOCK_MS, SHOT_CLOCK_GRACE_MS, localDeadline, POCKETS, ballById,
} = await import('@snooker/sim');

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

let nextTelegramId = 12_000;
async function newPvpMatch() {
  const players = [];
  for (let i = 0; i < 2; i += 1) {
    const id = nextTelegramId++;
    const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
    players.push({ token: res.body.token, userId: res.body.user.id });
  }
  await call('/api/match/queue', { method: 'POST', token: players[0].token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: players[1].token });
  return { matchId: body.matchId, players };
}

const setDeadline = (matchId, at) => getDb()('matches').where({ id: matchId }).update({ shot_deadline: at });
const loadState = async (matchId) => fromJson((await getDb()('matches').where({ id: matchId }).first()).state);

/** Only the black left, lined up for seat 0 to pot: a shot whose result shows whether it was played or timed out. */
async function lastBlack(matchId) {
  const row = await getDb()('matches').where({ id: matchId }).first();
  const state = fromJson(row.state);
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  state.frame.balls.forEach((b) => { b.potted = true; });
  Object.assign(ballById(state.frame, 'black'), black, { potted: false });
  Object.assign(ballById(state.frame, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(state.frame, {
    phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn: 0, scores: [20, 10],
  });
  await getDb()('matches').where({ id: matchId }).update({ state: toJson(state), turn_user_id: state.players[0] });
}
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };

// --- One value everywhere -----------------------------------------------------

test('the shot clock is a flat 30 seconds, from one shared constant', () => {
  assert.equal(SHOT_CLOCK_MS, 30_000);
  assert.equal(config.shotClockSeconds * 1000, SHOT_CLOCK_MS, 'server uses the value the client counts down');
  assert.equal(config.shotClockSeconds, 30, 'SHOT_CLOCK_SECONDS=25 in the environment is ignored');
});

test('a new match gives the first player 30 seconds, and the client payload says 30', async () => {
  const before = Date.now();
  const { matchId, players } = await newPvpMatch();
  const row = await getDb()('matches').where({ id: matchId }).first();
  const window = new Date(row.shot_deadline).getTime() - before;
  assert.ok(window >= SHOT_CLOCK_MS && window < SHOT_CLOCK_MS + 2000, `deadline ${window}ms after creation`);

  const { body } = await call(`/api/match/${matchId}`, { token: players[0].token });
  assert.equal(body.match.shotClockSeconds, 30);
  assert.ok(Math.abs(body.match.serverNow - Date.now()) < 2000, 'the payload carries the server time');
});

test('every new turn gets a fresh 30 seconds from when it starts', async () => {
  const { matchId, players } = await newPvpMatch();
  const shotAt = Date.now();
  const res = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: players[0].token, body: { resultId: `turn-${matchId}`, shot: { angle: Math.PI, power: 0.1 } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const window = new Date(res.body.match.shotDeadline).getTime() - shotAt;
  assert.ok(window >= SHOT_CLOCK_MS - 50 && window < SHOT_CLOCK_MS + 2000, `next deadline ${window}ms after the shot`);
});

// --- Client countdown vs server expiry ----------------------------------------

test('the client countdown uses server time, so a skewed phone clock still counts the real 30 seconds', async () => {
  const { matchId, players } = await newPvpMatch();
  const { body } = await call(`/api/match/${matchId}`, { token: players[0].token });
  const serverRemaining = new Date(body.match.shotDeadline).getTime() - body.match.serverNow;

  for (const skewMs of [0, 45_000, -45_000]) {
    const phoneNow = Date.now() + skewMs;
    const local = localDeadline(body.match.shotDeadline, body.match.serverNow, phoneNow);
    assert.equal(local - phoneNow, serverRemaining, `phone clock off by ${skewMs}ms`);
  }
  // Comparing the raw deadline with a phone 45s slow would have shown ~75s left.
  const naive = new Date(body.match.shotDeadline).getTime() - (Date.now() - 45_000);
  assert.ok(naive > SHOT_CLOCK_MS + 40_000);
});

test('a shot arriving within the grace after the countdown hits zero is played, not timed out', async () => {
  const { matchId, players } = await newPvpMatch();
  await lastBlack(matchId);
  await setDeadline(matchId, new Date(Date.now() - (SHOT_CLOCK_GRACE_MS - 800)));

  const res = await applyShot({ matchId, userId: players[0].userId, resultId: `grace-${matchId}`, shot: POT_BLACK });
  assert.equal(res.status, 'ok');
  assert.equal(res.outcome.overdue, false);
  assert.deepEqual(res.outcome.potted, ['black']);
});

test('a shot arriving after the grace is scored as the timeout', async () => {
  const { matchId, players } = await newPvpMatch();
  await lastBlack(matchId);
  await setDeadline(matchId, new Date(Date.now() - SHOT_CLOCK_GRACE_MS - 1000));

  const res = await applyShot({ matchId, userId: players[0].userId, resultId: `late-${matchId}`, shot: POT_BLACK });
  assert.equal(res.status, 'ok');
  assert.equal(res.outcome.overdue, true);
  assert.deepEqual(res.outcome.potted, []);
  assert.deepEqual((await loadState(matchId)).frame.scores, [20, 14]);
});

test('the sweeper never takes a turn while the player could still land a shot', async () => {
  const { matchId } = await newPvpMatch();

  await setDeadline(matchId, new Date(Date.now() + 5000));
  await sweepShotClocks();
  assert.equal((await loadState(matchId)).frame.turn, 0, 'countdown still running');

  await setDeadline(matchId, new Date(Date.now() - (SHOT_CLOCK_GRACE_MS - 800)));
  await sweepShotClocks();
  assert.equal((await loadState(matchId)).frame.turn, 0, 'countdown at zero, but a shot could still be arriving');

  await setDeadline(matchId, new Date(Date.now() - SHOT_CLOCK_GRACE_MS - 500));
  await sweepShotClocks();
  const state = await loadState(matchId);
  assert.equal(state.frame.turn, 1, 'grace over: the turn passes');
  assert.deepEqual(state.frame.scores, [0, 4]);
});

test('the sweeper and a late shot draw the same line: whichever runs, the turn is charged once', async () => {
  const { matchId, players } = await newPvpMatch();
  await lastBlack(matchId);
  await setDeadline(matchId, new Date(Date.now() - SHOT_CLOCK_GRACE_MS - 1000));

  const [shot] = await Promise.all([
    applyShot({ matchId, userId: players[0].userId, resultId: `line-${matchId}`, shot: POT_BLACK }),
    sweepShotClocks(),
  ]);
  const state = await loadState(matchId);
  assert.deepEqual(state.frame.scores, [20, 14], 'one 4-point timeout, never the pot and never two penalties');
  assert.ok(shot.status === 'ok' ? shot.outcome.overdue : shot.code === 409, JSON.stringify(shot));
});
