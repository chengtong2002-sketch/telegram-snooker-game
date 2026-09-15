import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('concurrency');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.SHOT_CLOCK_SECONDS = '25';

// Stand-in for the bot: records every notification the backend pushes.
const notifications = [];
const botStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { notifications.push(JSON.parse(body)); res.end('{}'); });
});
await new Promise((resolve) => { botStub.listen(0, '127.0.0.1', resolve); });
process.env.BOT_NOTIFY_URL = `http://127.0.0.1:${botStub.address().port}/internal/notify`;

const {
  closeDb, migrate, getDb, toJson, fromJson,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { sweepShotClocks, applyShot, concede } = await import('../src/services/matchService.js');
const { Router } = await import('../src/asyncRouter.js');

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  botStub.close();
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

let nextId = 7000;
/** A fresh active match; returns its id and the two seats' user ids. */
async function newMatch() {
  const tokens = [];
  for (let i = 0; i < 2; i += 1) {
    const id = nextId++;
    const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
    tokens.push(res.body.token);
  }
  await call('/api/match/queue', { method: 'POST', token: tokens[0] });
  const { body } = await call('/api/match/queue', { method: 'POST', token: tokens[1] });
  const row = await getDb()('matches').where({ id: body.matchId }).first();
  return { matchId: body.matchId, seats: [row.player_a, row.player_b] };
}

const BREAK_SHOT = { angle: 0, power: 0.4 };

// These call the service directly under Promise.all. Over HTTP the requests
// arrive one after another (a shot's simulation is synchronous), so the race
// rarely opens in a test; here every call loads the match before any writes.

test('two different shots fired at once for the same turn: only one is applied', async () => {
  const { matchId, seats } = await newMatch();
  const results = await Promise.all(['race-a', 'race-b', 'race-c'].map((resultId) => applyShot({
    matchId, userId: seats[0], resultId, shot: BREAK_SHOT,
  })));

  assert.equal(results.filter((r) => r.status === 'ok').length, 1, JSON.stringify(results.map((r) => r.status)));
  for (const r of results.filter((x) => x.status !== 'ok')) assert.equal(r.code, 409);
  const shots = await getDb()('shots').where({ match_id: matchId });
  assert.equal(shots.length, 1, 'the losing calls leave no shot row behind');
});

test('the same resultId sent twice at once is one shot, and the replay says duplicate', async () => {
  const { matchId, seats } = await newMatch();
  const shoot = () => applyShot({
    matchId, userId: seats[0], resultId: `same-${matchId}`, shot: BREAK_SHOT,
  });
  const results = await Promise.all([shoot(), shoot()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['duplicate', 'ok'], JSON.stringify(results));
  assert.equal((await getDb()('shots').where({ match_id: matchId })).length, 1);
});

test('both players conceding at once completes the match exactly once', async () => {
  const { matchId, seats } = await newMatch();
  const knex = getDb();
  const row = await knex('matches').where({ id: matchId }).first();
  const state = fromJson(row.state);
  state.highBreaks = [20, 0];
  await knex('matches').where({ id: matchId }).update({ state: toJson(state) });

  const results = await Promise.all(seats.map((userId) => concede({ matchId, userId })));
  assert.deepEqual(results.map((r) => r.status).sort(), ['error', 'ok']);
  assert.equal(results.find((r) => r.status === 'error').code, 409);

  const owner = await knex('users').where({ id: seats[0] }).first();
  assert.equal(Number(owner.lifetime_eligible_points), 20, 'the break is credited once, not per call');
});

test('two sweepers (two replicas) expiring the same shot clock charge it once', async () => {
  const { matchId } = await newMatch();
  await getDb()('matches').where({ id: matchId }).update({ shot_deadline: new Date(Date.now() - 1000) });

  await Promise.all([sweepShotClocks(), sweepShotClocks()]);
  const state = fromJson((await getDb()('matches').where({ id: matchId }).first()).state);
  assert.equal(state.frame.turn, 1);
  assert.deepEqual(state.frame.scores, [0, 4]);
  // Both sweepers compute the same state from the same stale row, so the state
  // alone cannot show the double write. The side effects can.
  const pings = notifications.filter((n) => n.matchId === matchId && n.type === 'your-turn');
  assert.equal(pings.length, 1, 'the next player is told once');
});

test('an async route that throws answers 500 instead of crashing the process', async () => {
  const app = express();
  const router = Router();
  router.get('/boom', async () => { throw new Error('db went away'); });
  app.use(router);
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  const s = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'db went away' });
  } finally {
    s.close();
  }
});
