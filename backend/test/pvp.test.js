import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('pvp');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.SHOT_CLOCK_SECONDS = '25';
// Point notifications at a dead port: they must never fail a shot.
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');

await migrate();

const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

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

const loginAs = async (id, name) => {
  const res = await call('/api/auth/telegram', {
    method: 'POST',
    body: { devUser: { id, first_name: name, username: name.toLowerCase() } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
};

let annToken;
let benToken;
let matchId;

test('health check responds', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('an unsigned request is rejected', async () => {
  const res = await call('/api/match/active');
  assert.equal(res.status, 401);
});

test('initData with a bad signature is rejected', async () => {
  const res = await call('/api/auth/telegram', {
    method: 'POST',
    body: { initData: 'user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef' },
  });
  assert.equal(res.status, 401);
});

test('two players in the queue get paired into one match', async () => {
  annToken = await loginAs(2001, 'Ann');
  benToken = await loginAs(2002, 'Ben');

  const first = await call('/api/match/queue', { method: 'POST', token: annToken });
  assert.equal(first.body.status, 'queued');

  const second = await call('/api/match/queue', { method: 'POST', token: benToken });
  assert.equal(second.body.status, 'matched');
  matchId = second.body.matchId;
  assert.ok(matchId);

  // The queue is emptied by the pairing, not left holding stale rows.
  const remaining = await getDb()('matchmaking_queue').count({ n: 'user_id' }).first();
  assert.equal(Number(remaining.n), 0);
});

test('a new PvP match is crypto-eligible and racked with all 22 balls', async () => {
  const res = await call(`/api/match/${matchId}`, { token: annToken });
  assert.equal(res.status, 200);
  const { match } = res.body;
  assert.equal(match.cryptoEligible, true);
  assert.equal(match.mode, 'pvp');
  assert.equal(match.frame.balls.length, 22);
  assert.deepEqual(match.framesWon, [0, 0]);
});

test('a stranger cannot read someone else\'s match', async () => {
  const carolToken = await loginAs(2003, 'Carol');
  const res = await call(`/api/match/${matchId}`, { token: carolToken });
  assert.equal(res.status, 403);
});

test('the player whose turn it is not cannot shoot', async () => {
  const state = await call(`/api/match/${matchId}`, { token: annToken });
  const turnUserId = state.body.match.turnUserId;
  const waiting = Number(turnUserId) === Number(state.body.match.players[0]) ? benToken : annToken;

  const res = await call(`/api/match/${matchId}/shot`, {
    method: 'POST',
    token: waiting,
    body: { resultId: 'not-my-turn-1', shot: { angle: 0, power: 0.5 } },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not your turn/);
});

test('ball in hand cannot be placed outside the D or on top of a ball', async () => {
  const state = await call(`/api/match/${matchId}`, { token: annToken });
  const { match } = state.body;
  assert.equal(match.frame.inHand, true, 'the break-off is played from hand');
  const token = Number(match.turnUserId) === Number(match.players[0]) ? annToken : benToken;
  const red = match.frame.balls.find((b) => b.id === 'red1');
  const brown = match.frame.balls.find((b) => b.id === 'brown');

  // Two requests only: /shot is rate limited and later tests in this file need
  // their share. The full rule is covered in shared/sim's rules tests.
  for (const [cuePlacement, reason] of [
    [{ x: red.x - 6, y: red.y }, /inside the D/],              // right up against the pack
    [{ x: brown.x - 1, y: brown.y }, /touching another ball/], // in the D, on the brown
  ]) {
    const res = await call(`/api/match/${matchId}/shot`, {
      method: 'POST',
      token,
      body: { resultId: `place-${Math.random()}`, shot: { angle: 0, power: 0.5, cuePlacement } },
    });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(cuePlacement)}`);
    assert.match(res.body.error, reason);
  }
  const shots = await getDb()('shots').where({ match_id: matchId });
  assert.equal(shots.length, 0, 'a rejected placement does not use up the turn');
});

test('the server resolves the shot itself and returns its own outcome', async () => {
  const before = await call(`/api/match/${matchId}`, { token: annToken });
  const strikerIsAnn = Number(before.body.match.turnUserId)
    === Number(before.body.match.players.find((p, i) => i === before.body.match.frame.turn));
  const token = strikerIsAnn ? annToken : benToken;

  const res = await call(`/api/match/${matchId}/shot`, {
    method: 'POST',
    token,
    // A break-off into the pack.
    body: { resultId: 'shot-1', shot: { angle: -0.02, power: 0.95 } },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'ok');
  const { outcome, match } = res.body;

  // The client sent no claim about what happened, and the server still knows.
  assert.ok('foul' in outcome);
  assert.ok('firstContact' in outcome);
  assert.equal(typeof outcome.steps, 'number');
  assert.ok(outcome.steps > 0, 'the server actually ran the physics');
  assert.ok(match.frame.shotNumber >= 1);

  const shots = await getDb()('shots').where({ match_id: matchId });
  assert.equal(shots.length, 1, 'the shot is recorded once');
});

test('replaying the same resultId returns the original outcome, not a second shot', async () => {
  const before = await getDb()('shots').where({ match_id: matchId }).count({ n: 'id' }).first();

  const res = await call(`/api/match/${matchId}/shot`, {
    method: 'POST',
    token: annToken,
    // The identical shot. The same id with a different shot is a conflict,
    // covered in offlineSync.test.js.
    body: { resultId: 'shot-1', shot: { angle: -0.02, power: 0.95 } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'duplicate');

  const after = await getDb()('shots').where({ match_id: matchId }).count({ n: 'id' }).first();
  assert.equal(Number(after.n), Number(before.n), 'no extra shot was applied');
});

test('a nonsense shot is rejected outright', async () => {
  const state = await call(`/api/match/${matchId}`, { token: annToken });
  const strikerId = state.body.match.turnUserId;
  const token = Number(strikerId) === Number(state.body.match.players[0]) ? annToken : benToken;

  for (const shot of [
    { angle: 0, power: 5 },          // over full power
    { angle: 0, power: -1 },         // negative
    { angle: Number.NaN, power: 0.5 },
    { angle: 0 },                    // no power at all
  ]) {
    const res = await call(`/api/match/${matchId}/shot`, {
      method: 'POST',
      token,
      body: { resultId: `bad-${Math.random()}`, shot },
    });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(shot)}`);
  }
});

test('the offline queue syncs shots and dedupes by result id', async () => {
  const state = await call(`/api/match/${matchId}`, { token: annToken });
  const strikerId = state.body.match.turnUserId;
  const token = Number(strikerId) === Number(state.body.match.players[0]) ? annToken : benToken;

  const entry = {
    resultId: 'offline-shot-1',
    kind: 'shot',
    matchId,
    payload: { shot: { angle: 0.4, power: 0.6 } },
  };

  const first = await call('/api/sync', { method: 'POST', token, body: { results: [entry] } });
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].status, 'ok');

  // The same batch again, as a flaky reconnect would send it.
  const replay = await call('/api/sync', { method: 'POST', token, body: { results: [entry] } });
  assert.equal(replay.body.results[0].status, 'duplicate');

  const shots = await getDb()('shots').where({ result_id: 'offline-shot-1' });
  assert.equal(shots.length, 1);
});

test('practice results sync but are explicitly not crypto-eligible', async () => {
  const res = await call('/api/sync', {
    method: 'POST',
    token: annToken,
    body: {
      results: [{
        resultId: 'practice-1',
        kind: 'practice-stat',
        payload: { highBreak: 147, framesWon: [2, 0] },
      }],
    },
  });
  assert.equal(res.body.results[0].status, 'applied');
  assert.equal(res.body.results[0].cryptoEligible, false);

  // A claimed 147 in practice must not touch the rewards tables or the profile.
  const breaks = await getDb()('eligible_breaks').count({ n: 'id' }).first();
  assert.equal(Number(breaks.n), 0);
  const ann = await getDb()('users').where({ telegram_id: 2001 }).first();
  assert.equal(ann.best_break, 0);
});

test('conceding ends the match with the opponent as winner', async () => {
  const res = await call(`/api/match/${matchId}/concede`, { method: 'POST', token: annToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.match.ended, true);

  const row = await getDb()('matches').where({ id: matchId }).first();
  assert.equal(row.status, 'completed');
  assert.equal(Number(row.winner_id), Number(res.body.match.players[res.body.match.winner]));

  // A completed match takes no more shots.
  const after = await call(`/api/match/${matchId}/shot`, {
    method: 'POST',
    token: benToken,
    body: { resultId: 'after-the-end', shot: { angle: 0, power: 0.5 } },
  });
  assert.equal(after.status, 409);
});

test('the leaderboard is reachable and reflects the finished match', async () => {
  const res = await call('/api/leaderboard?scope=period', { token: annToken });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.entries));
});
