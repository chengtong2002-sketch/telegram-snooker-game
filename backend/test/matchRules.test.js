import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('matchrules');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.SHOT_CLOCK_SECONDS = '25';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const {
  closeDb, migrate, getDb, toJson, fromJson,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { recordEligibleBreak } = await import('../src/services/rewards.js');
const { POCKETS, ballById, newMatch } = await import('@snooker/sim');

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

let nextTelegramId = 9100;
async function login() {
  const id = nextTelegramId++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
  return { token: res.body.token, userId: res.body.user.id, telegramId: id };
}

async function newPvpMatch() {
  const a = await login();
  const b = await login();
  await call('/api/match/queue', { method: 'POST', token: a.token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: b.token });
  return { matchId: body.matchId, players: [a, b] };
}

/** Rewrite a match's stored state, as if play had reached that point. */
async function setState(matchId, mutate) {
  const knex = getDb();
  const row = await knex('matches').where({ id: matchId }).first();
  const state = fromJson(row.state);
  mutate(state);
  await knex('matches').where({ id: matchId }).update({
    state: toJson(state),
    turn_user_id: state.players[state.frame.turn],
    shot_deadline: new Date(Date.now() + 25_000),
  });
}

/** Only the black left, lined up for `turn` to pot it and end the frame. */
const lastBlackFor = (turn, scores) => (state) => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  const f = state.frame;
  f.balls.forEach((b) => { b.potted = true; });
  Object.assign(ballById(f, 'black'), black, { potted: false });
  Object.assign(ballById(f, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(f, {
    phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn, scores,
  });
};
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };

// --- Best of 3 over the real API --------------------------------------------

test('2-0 over the API: frame 2 is racked for seat 1 to break, and winning it ends the match with no frame 3', async () => {
  const { matchId, players: [ann, ben] } = await newPvpMatch();

  await setState(matchId, lastBlackFor(0, [50, 20]));
  const frame1 = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: `${matchId}-f1`, shot: POT_BLACK },
  });
  assert.equal(frame1.status, 200, JSON.stringify(frame1.body));
  const m1 = frame1.body.match;
  assert.deepEqual(m1.framesWon, [1, 0]);
  // 1-0 opens the between-frame checkpoint; carry on as the trailing player.
  assert.equal(m1.checkpoint?.trailing, 1);
  const cont = await call(`/api/match/${matchId}/continue`, { method: 'POST', token: ben.token });
  const m2 = cont.body.match;
  assert.equal(m2.frame.frame, 2);
  assert.deepEqual(m2.frame.scores, [0, 0]);
  assert.equal(m2.frame.turn, 1, 'breaks alternate: seat 1 breaks frame 2');
  assert.equal(Number(m2.turnUserId), Number(ben.userId));
  assert.equal(m2.frame.inHand, true);

  await setState(matchId, lastBlackFor(0, [40, 30]));
  const frame2 = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: `${matchId}-f2`, shot: POT_BLACK },
  });
  assert.equal(frame2.status, 200, JSON.stringify(frame2.body));
  const done = frame2.body.match;
  assert.equal(done.ended, true);
  assert.deepEqual(done.framesWon, [2, 0]);
  assert.equal(done.frame.frame, 2, 'no third frame was racked');
  assert.equal(done.frameHistory.length, 2);
  assert.equal(done.checkpoint, null, '2-0 is decided: no checkpoint');

  const row = await getDb()('matches').where({ id: matchId }).first();
  assert.equal(row.status, 'completed');
  assert.equal(Number(row.winner_id), Number(ann.userId));
  assert.equal(fromJson(row.state).frame.frame, 2);

  const extra = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ben.token, body: { resultId: `${matchId}-f3`, shot: POT_BLACK },
  });
  assert.equal(extra.status, 409, 'a decided match takes no more shots');
});

// --- Practice can never become crypto-eligible -------------------------------

test('practice: a client-sent eligible flag and a claimed 147 award nothing', async () => {
  const p = await login();
  const res = await call('/api/sync', {
    method: 'POST',
    token: p.token,
    body: {
      results: [{
        resultId: `practice-flagged-${p.telegramId}`,
        kind: 'practice-stat',
        cryptoEligible: true,
        crypto_eligible: true,
        mode: 'pvp',
        payload: {
          cryptoEligible: true, eligible: true, mode: 'pvp', highBreak: 147, framesWon: [2, 0],
        },
      }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].status, 'applied');
  assert.equal(res.body.results[0].cryptoEligible, false);

  const knex = getDb();
  assert.equal(Number((await knex('eligible_breaks').where({ user_id: p.userId }).count({ n: 'id' }).first()).n), 0);
  const user = await knex('users').where({ id: p.userId }).first();
  assert.equal(Number(user.best_break), 0);
  assert.equal(Number(user.lifetime_eligible_points), 0);
  const stored = await knex('sync_results').where({ result_id: `practice-flagged-${p.telegramId}` }).first();
  assert.equal(stored.kind, 'practice-stat');
  assert.equal(stored.match_id, null);
});

test('practice: a practice result naming a live PvP match cannot touch that match', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  const before = await getDb()('matches').where({ id: matchId }).first();

  const res = await call('/api/sync', {
    method: 'POST',
    token: ann.token,
    body: {
      results: [{
        resultId: `practice-hijack-${matchId}`,
        kind: 'practice-stat',
        matchId,
        payload: { highBreak: 147, cryptoEligible: true },
      }],
    },
  });
  assert.equal(res.body.results[0].cryptoEligible, false);

  const after = await getDb()('matches').where({ id: matchId }).first();
  assert.equal(after.state, before.state);
  assert.equal(after.version, before.version);
  assert.equal(Number((await getDb()('eligible_breaks').where({ match_id: matchId }).count({ n: 'id' }).first()).n), 0);
  const stored = await getDb()('sync_results').where({ result_id: `practice-hijack-${matchId}` }).first();
  assert.equal(stored.match_id, null, 'the practice record is not attached to the match');
});

test('practice: a practice match row wrongly flagged eligible still awards nothing', async () => {
  // Defence in depth. No endpoint creates practice match rows, but if a bug or a
  // bad migration ever wrote one with crypto_eligible = true, the reward code
  // must still refuse it on mode alone.
  const a = await login();
  const b = await login();
  const knex = getDb();
  await knex('matches').insert({
    id: 'practice-flagged', mode: 'practice', player_a: a.userId, player_b: b.userId,
    status: 'completed', state: '{}', crypto_eligible: true,
  });
  const state = { ...newMatch([a.userId, b.userId]), ended: true, winner: 0, highBreaks: [147, 0] };

  const result = await recordEligibleBreak({ id: 'practice-flagged', crypto_eligible: true, mode: 'practice' }, state);
  assert.equal(result, null);
  assert.equal(Number((await knex('eligible_breaks').where({ match_id: 'practice-flagged' }).count({ n: 'id' }).first()).n), 0);
});

test('eligibility comes from the stored match, not the row object a caller passes in', async () => {
  const a = await login();
  const b = await login();
  const knex = getDb();
  await knex('matches').insert({
    id: 'practice-caller-lies', mode: 'practice', player_a: a.userId, player_b: b.userId,
    status: 'completed', state: '{}', crypto_eligible: false,
  });
  const state = { ...newMatch([a.userId, b.userId]), ended: true, winner: 0, highBreaks: [60, 0] };

  const result = await recordEligibleBreak({ id: 'practice-caller-lies', crypto_eligible: true, mode: 'pvp' }, state);
  assert.equal(result, null);
  assert.equal(Number((await knex('eligible_breaks').where({ match_id: 'practice-caller-lies' }).count({ n: 'id' }).first()).n), 0);
});

// --- Ball in hand over the API ------------------------------------------------

test('ball in hand, no placement, a ball resting on the park spot: 400 and the turn is not used', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, (state) => {
    const f = state.frame;
    const cue = ballById(f, 'cue');
    Object.assign(ballById(f, 'red1'), { x: cue.x + 1, y: cue.y }); // came to rest on the park spot
    f.inHand = true;
    f.turn = 0;
  });
  const before = await getDb()('matches').where({ id: matchId }).first();

  const noPlacement = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: `inhand-none-${matchId}`, shot: { angle: 0, power: 0.5 } },
  });
  assert.equal(noPlacement.status, 400);
  assert.match(noPlacement.body.error, /no placement sent: .*touching another ball/);
  const after = await getDb()('matches').where({ id: matchId }).first();
  assert.equal(after.state, before.state, 'nothing was played');
  assert.equal(Number(after.turn_user_id), Number(ann.userId), 'still her turn');

  const cue = ballById(fromJson(before.state).frame, 'cue');
  const placed = await call(`/api/match/${matchId}/shot`, {
    method: 'POST',
    token: ann.token,
    body: { resultId: `inhand-placed-${matchId}`, shot: { angle: 0, power: 0.5, cuePlacement: { x: cue.x - 6, y: cue.y } } },
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
});
