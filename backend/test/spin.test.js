import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('spin');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb, fromJson, toJson } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { createPvpMatch, applyShot } = await import('../src/services/matchService.js');
const { resolveShot, SPIN } = await import('@snooker/sim');

await migrate();
const knex = getDb();

const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

// Each test sets the flag it needs; put the process's own back afterwards.
const startingSpin = { ...config.spin };
test.afterEach(() => { config.spin = { ...startingSpin }; });

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let nextTg = 8100;
async function newPlayer() {
  const tg = nextTg++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `P${tg}` } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.token, id: res.body.user.id, tg: String(tg) };
}

/** A fresh match between two new players, under the given spin settings. */
async function newMatch({ enabled, testers = [] }) {
  const a = await newPlayer();
  const b = await newPlayer();
  config.spin = { enabled, testTelegramIds: new Set(testers.map((p) => (typeof p === 'string' ? p : p.tg))) };
  const { row, state } = await createPvpMatch(a.id, b.id);
  return { a, b, id: row.id, frame: state.frame, spinAllowed: state.spinAllowed };
}

/** A firm break straight at the nearest red: enough for spin to move the cue ball. */
function breakAim(frame) {
  const cue = frame.balls.find((ball) => ball.id === 'cue');
  const reds = frame.balls.filter((ball) => ball.id.startsWith('red'));
  const near = reds.reduce((best, r) => (Math.hypot(r.x - cue.x, r.y - cue.y)
    < Math.hypot(best.x - cue.x, best.y - cue.y) ? r : best));
  return { angle: Math.atan2(near.y - cue.y, near.x - cue.x), power: 0.6 };
}

let resultSeq = 0;
// Straight to the service: the route only adds its 10-shots-per-10s limiter,
// which this file would trip. status is the HTTP code the route would send.
async function shoot(m, shot, resultId = `spin-${resultSeq++}`) {
  const result = await applyShot({ matchId: m.id, userId: m.a.id, resultId, shot });
  return { status: result.status === 'error' ? result.code : 200, body: result, resultId };
}

const storedShot = async (resultId) => fromJson((await knex('shots').where({ result_id: resultId }).first()).shot);
const cueAt = (balls) => {
  const cue = balls.find((ball) => ball.id === 'cue');
  return { x: cue.x, y: cue.y, potted: cue.potted };
};

const DRAW = { x: 0, y: -0.8 };

test('SPIN_ENABLED on: the match allows spin, and says so to both players', async () => {
  const m = await newMatch({ enabled: true });
  assert.equal(m.spinAllowed, true);
  for (const p of [m.a, m.b]) {
    const res = await call(`/api/match/${m.id}`, { token: p.token });
    assert.equal(res.body.match.spinAllowed, true);
  }
});

test('a spin shot is played with its spin, and stored with it', async () => {
  const m = await newMatch({ enabled: true });
  const shot = { ...breakAim(m.frame), spin: DRAW };
  const res = await shoot(m, shot);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const withSpin = resolveShot(m.frame, shot).state;
  const without = resolveShot(m.frame, { angle: shot.angle, power: shot.power }).state;
  assert.notDeepEqual(cueAt(withSpin.balls), cueAt(without.balls), 'this shot must be one spin changes');
  assert.deepEqual(cueAt(res.body.match.frame.balls), cueAt(withSpin.balls));
  assert.deepEqual((await storedShot(res.resultId)).spin, DRAW);
});

test('spin past the edge, or malformed, is refused and the turn is not used', async () => {
  const m = await newMatch({ enabled: true });
  const aim = breakAim(m.frame);
  const bad = [
    { x: 0, y: -(SPIN.maxOffset + 0.01) },
    { x: 0.7, y: 0.7 },
    { x: '0.1', y: 0 },
    { x: 0.1 },
    { x: Number.NaN, y: 0 },
    'draw',
  ];
  for (const spin of bad) {
    const res = await shoot(m, { ...aim, spin });
    assert.equal(res.status, 400, `spin ${JSON.stringify(spin)} → ${JSON.stringify(res.body)}`);
  }
  assert.equal(await knex('shots').where({ match_id: m.id }).count({ n: '*' }).first().then((r) => Number(r.n)), 0);
  const edge = { x: 0, y: -SPIN.maxOffset };
  assert.equal((await shoot(m, { ...aim, spin: edge })).status, 200, 'exactly on the edge is fine');
});

test('centre spin is no spin: stored without it, and a replay without spin is the same shot', async () => {
  const m = await newMatch({ enabled: true });
  const aim = breakAim(m.frame);
  const res = await shoot(m, { ...aim, spin: { x: 0, y: 0 } });
  assert.equal(res.status, 200);
  assert.equal((await storedShot(res.resultId)).spin, undefined);
  const again = await shoot(m, aim, res.resultId);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'duplicate');
});

test('dedupe: the same spin replays as a duplicate; different spin under the same id is a conflict', async () => {
  const m = await newMatch({ enabled: true });
  const shot = { ...breakAim(m.frame), spin: DRAW };
  const first = await shoot(m, shot);
  assert.equal(first.status, 200);

  const replay = await shoot(m, shot, first.resultId);
  assert.equal(replay.body.status, 'duplicate');

  for (const other of [{ ...shot, spin: { x: 0, y: 0.8 } }, { angle: shot.angle, power: shot.power }]) {
    const res = await shoot(m, other, first.resultId);
    assert.equal(res.status, 409, JSON.stringify(other));
    assert.equal(res.body.conflict, true);
  }
});

test('SPIN_ENABLED off: spin sent is played as none — not refused, not stored', async () => {
  const m = await newMatch({ enabled: false });
  assert.equal(m.spinAllowed, false);
  assert.equal((await call(`/api/match/${m.id}`, { token: m.a.token })).body.match.spinAllowed, false);

  const aim = breakAim(m.frame);
  const res = await shoot(m, { ...aim, spin: DRAW });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(cueAt(res.body.match.frame.balls), cueAt(resolveShot(m.frame, aim).state.balls));
  assert.equal((await storedShot(res.resultId)).spin, undefined);

  // Nothing about spin can make a replay differ here, or make a shot a 400.
  const replay = await shoot(m, { ...aim, spin: { x: 0.5, y: 0 } }, res.resultId);
  assert.equal(replay.body.status, 'duplicate');
});

test('SPIN_ENABLED off: out-of-range spin is ignored, not a 400', async () => {
  const m = await newMatch({ enabled: false });
  const res = await shoot(m, { ...breakAim(m.frame), spin: { x: 5, y: 'x' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('test list: spin only when BOTH players are on it', async () => {
  const a = await newPlayer();
  const b = await newPlayer();
  const c = await newPlayer();
  config.spin = { enabled: false, testTelegramIds: new Set([a.tg, b.tg]) };
  assert.equal((await createPvpMatch(a.id, b.id)).state.spinAllowed, true);
  assert.equal((await createPvpMatch(a.id, c.id)).state.spinAllowed, false);
  assert.equal((await createPvpMatch(c.id, b.id)).state.spinAllowed, false);
});

test('the decision is kept with the match: turning the flag off later does not take spin away', async () => {
  const m = await newMatch({ enabled: true });
  config.spin = { enabled: false, testTelegramIds: new Set() };
  const shot = { ...breakAim(m.frame), spin: DRAW };
  const res = await shoot(m, shot);
  assert.equal(res.status, 200);
  assert.deepEqual((await storedShot(res.resultId)).spin, DRAW);
});

test('a match stored before spin existed has none', async () => {
  const m = await newMatch({ enabled: true });
  const row = await knex('matches').where({ id: m.id }).first();
  const state = fromJson(row.state);
  delete state.spinAllowed;
  await knex('matches').where({ id: m.id }).update({ state: toJson(state) });

  const aim = breakAim(m.frame);
  const res = await shoot(m, { ...aim, spin: DRAW });
  assert.equal(res.status, 200);
  assert.equal(res.body.match.spinAllowed, false);
  assert.equal((await storedShot(res.resultId)).spin, undefined);
});
