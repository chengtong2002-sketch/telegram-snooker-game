import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useTestDatabase } from '@snooker/db/testing';

// Capture what the backend sends the bot.
const botEvents = [];
const botStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    botEvents.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
}).listen(0);
await new Promise((r) => botStub.once('listening', r));

const dropTestDatabase = await useTestDatabase('idle');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = `http://127.0.0.1:${botStub.address().port}/internal/notify`;

const {
  closeDb, migrate, getDb, toJson, fromJson,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const {
  sweepShotClocks, applyShot, IDLE_FORFEIT_TIMEOUTS, IDLE_ABANDON_RUN,
} = await import('../src/services/matchService.js');

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

let nextTelegramId = 31_000;
/** Two signed-in players, paired; seat 0 breaks. */
async function newPvpMatch() {
  const players = [];
  for (let i = 0; i < 2; i += 1) {
    const id = nextTelegramId++;
    const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `I${id}` } } });
    players.push({ token: res.body.token, userId: res.body.user.id });
  }
  await call('/api/match/queue', { method: 'POST', token: players[0].token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: players[1].token });
  return { matchId: body.matchId, players };
}

const row = (matchId) => getDb()('matches').where({ id: matchId }).first();
const state = async (matchId) => fromJson((await row(matchId)).state);

/** Run the shot clock out for whoever is on, past the grace, and sweep. */
async function timeOut(matchId) {
  await getDb()('matches').where({ id: matchId })
    .update({ shot_deadline: new Date(Date.now() - config.shotClockGraceMs - 1000) });
  await sweepShotClocks();
}

let shotSeq = 0;
/**
 * A real shot that touches nothing: the cue ball barely moves, so it is a miss
 * (4 away, turn passes) — but the player was there and took it.
 */
async function nudge(matchId, player) {
  // Straight to the service: the HTTP route's rate limit is not what is under test.
  const res = await applyShot({
    matchId, userId: player.userId, resultId: `idle-${shotSeq++}`, shot: { angle: Math.PI, power: 0.01 },
  });
  assert.equal(res.status, 'ok', JSON.stringify(res.reason));
  assert.equal(res.outcome.turnPassed, true, 'the nudge passes the turn');
  return res;
}

const settle = () => new Promise((r) => setTimeout(r, 100));
const eventsTo = (player, type) => botEvents.filter((e) => e.type === type && Number(e.userId) === Number(player.userId));

test('two idle players: the timeout loop ends, abandoned, with no winner and nothing eligible', async () => {
  const { matchId, players } = await newPvpMatch();
  // A real break made earlier must not survive an abandon either.
  const s = await state(matchId);
  s.frame.highBreaks = [30, 0];
  await getDb()('matches').where({ id: matchId }).update({ state: toJson(s) });
  botEvents.length = 0;

  for (let i = 1; i < IDLE_ABANDON_RUN; i += 1) {
    await timeOut(matchId);
    assert.equal((await row(matchId)).status, 'active', `still on after ${i} timeouts`);
  }
  await timeOut(matchId);
  const done = await row(matchId);
  assert.equal(done.status, 'abandoned');
  assert.equal(done.winner_id, null);
  assert.equal(done.shot_deadline, null, 'the clock is stopped');
  assert.equal(done.ineligible_reason, 'abandoned-idle');
  assert.equal(Boolean(done.crypto_eligible), false);
  assert.equal(await getDb()('eligible_breaks').where({ match_id: matchId }).first(), undefined);
  assert.deepEqual(fromJson(done.state).frame.scores, [8, 8], 'two 4-point timeouts each, then it stopped');

  // Nothing more happens, however long the sweeper keeps running.
  const version = done.version;
  await timeOut(matchId);
  await sweepShotClocks();
  assert.equal((await row(matchId)).version, version);

  await settle();
  for (const p of players) {
    assert.equal(eventsTo(p, 'match-abandoned').length, 1, 'each player hears once');
    assert.equal(eventsTo(p, 'your-turn').length, 1, 'one "your shot" each, then held while they stay away');
    assert.equal(eventsTo(p, 'match-over').length, 0);
  }
  const users = await getDb()('users').whereIn('id', players.map((p) => p.userId));
  for (const u of users) {
    assert.equal(Number(u.lifetime_eligible_points), 0);
    assert.equal(Number(u.frames_played), 0, 'an abandoned match is not a played one');
  }

  const seen = await call(`/api/match/${matchId}`, { token: players[0].token });
  assert.equal(seen.body.match.abandoned, 'idle');
  assert.equal(seen.body.match.ended, true);
  assert.equal(seen.body.match.winner, null);
  const shot = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: players[1].token, body: { resultId: 'after-abandon', shot: { angle: 0, power: 0.5 } },
  });
  assert.equal(shot.status, 409, 'no shots on an abandoned match');
});

test('one idle player forfeits after 3 timeouts in a row; the one playing wins', async () => {
  const { matchId, players } = await newPvpMatch();
  const [present, idle] = players;
  botEvents.length = 0;

  for (let i = 1; i <= IDLE_FORFEIT_TIMEOUTS; i += 1) {
    if (i === 3) {
      // The idle player looks at the table once: the next "your shot" is sent again.
      await call(`/api/match/${matchId}`, { token: idle.token });
    }
    await nudge(matchId, present);
    await timeOut(matchId);
    if (i < IDLE_FORFEIT_TIMEOUTS) assert.equal((await row(matchId)).status, 'active', `still on after ${i}`);
  }

  const done = await row(matchId);
  assert.equal(done.status, 'completed');
  assert.equal(Number(done.winner_id), Number(present.userId));
  const s = fromJson(done.state);
  assert.equal(s.concededBy, 1, 'recorded as a concede by the idle seat');
  assert.equal(s.forfeit, 'idle');
  assert.deepEqual(s.highBreaks, [0, 0], 'timeout fouls never make a break');
  assert.equal(await getDb()('eligible_breaks').where({ match_id: matchId }).first(), undefined,
    'a match won on timeouts alone earns nothing');

  await settle();
  const toIdle = eventsTo(idle, 'your-turn');
  assert.equal(toIdle.length, 2, 'shot 1 sends, shot 2 is held, the idle player looks, shot 3 sends');
  const [overPresent] = eventsTo(present, 'match-over');
  const [overIdle] = eventsTo(idle, 'match-over');
  assert.equal(overPresent.won, true);
  assert.equal(overPresent.forfeit, 'idle');
  assert.equal(overIdle.youConceded, true);
  assert.equal(overPresent.eligibleBreak, 0);
});

test('a real shot resets the count: timeouts must be in a row to forfeit', async () => {
  const { matchId, players } = await newPvpMatch();
  const [a, b] = players;
  // b times out twice, plays once, then times out twice more: never 3 in a row.
  await nudge(matchId, a); await timeOut(matchId);
  await nudge(matchId, a); await timeOut(matchId);
  await nudge(matchId, a); await nudge(matchId, b);
  await nudge(matchId, a); await timeOut(matchId);
  await nudge(matchId, a); await timeOut(matchId);
  const s = await state(matchId);
  assert.equal((await row(matchId)).status, 'active');
  assert.deepEqual(s.idle.seats, [0, 2]);
  await nudge(matchId, a); await timeOut(matchId);
  assert.equal((await row(matchId)).status, 'completed', 'the third in a row forfeits');
});

test('a real break made before a forfeit still counts, exactly as with a concede', async () => {
  const { matchId, players } = await newPvpMatch();
  const [present, idle] = players;
  const s = await state(matchId);
  s.frame.highBreaks = [25, 0];
  await getDb()('matches').where({ id: matchId }).update({ state: toJson(s) });

  for (let i = 0; i < IDLE_FORFEIT_TIMEOUTS; i += 1) {
    await nudge(matchId, present);
    await timeOut(matchId);
  }
  const earned = await getDb()('eligible_breaks').where({ match_id: matchId }).first();
  assert.equal(earned?.break_value, 25, 'the break was made at the table; the timeouts add nothing to it');
  assert.equal(Number(earned.user_id), Number(present.userId));
  assert.notEqual(Number(earned.user_id), Number(idle.userId));
});
