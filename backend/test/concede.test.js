import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('concede');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.SHOT_CLOCK_SECONDS = '25';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb, toJson, fromJson } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { sweepShotClocks, CHECKPOINT_MS } = await import('../src/services/matchService.js');
const { POCKETS, ballById } = await import('@snooker/sim');

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

let nextId = 5000;
async function newMatchPair() {
  const login = async () => {
    const id = nextId++;
    const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
    return res.body.token;
  };
  const tokens = [await login(), await login()];
  await call('/api/match/queue', { method: 'POST', token: tokens[0] });
  const { body } = await call('/api/match/queue', { method: 'POST', token: tokens[1] });
  // Seat 0 is whoever was queued first (tokens[0]).
  return { matchId: body.matchId, tokens };
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
  return state;
}

/** Only the black left, lined up for seat 0 to pot it and end the frame. */
const lastBlackFor = (scores) => (state) => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  const f = state.frame;
  f.balls.forEach((b) => { b.potted = true; });
  Object.assign(ballById(f, 'black'), black, { potted: false });
  Object.assign(ballById(f, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(f, { phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn: 0, scores });
};
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };

test('a frame ending 1-0 opens a checkpoint for the trailing player and blocks shots', async () => {
  const { matchId, tokens } = await newMatchPair();
  await setState(matchId, lastBlackFor([40, 30]));

  const shot = await call(`/api/match/${matchId}/shot`, { method: 'POST', token: tokens[0], body: { resultId: `${matchId}-b`, shot: POT_BLACK } });
  assert.equal(shot.status, 200, JSON.stringify(shot.body));
  assert.equal(shot.body.outcome.frameEnded, true, 'setup must actually end the frame');
  const { match } = shot.body;
  assert.deepEqual(match.framesWon, [1, 0]);
  assert.equal(match.checkpoint.frame, 1);
  assert.equal(match.checkpoint.trailing, 1);

  const row = await getDb()('matches').where({ id: matchId }).first();
  const window = new Date(row.shot_deadline).getTime() - Date.now();
  assert.ok(window > CHECKPOINT_MS - 5000 && window <= CHECKPOINT_MS, `deadline is the decision window (${window}ms)`);

  // Frame 2's breaker is the loser (seat 1), but nobody shoots until it is decided.
  for (const token of tokens) {
    const blocked = await call(`/api/match/${matchId}/shot`, { method: 'POST', token, body: { resultId: `${matchId}-x-${token.slice(-6)}`, shot: { angle: 0, power: 0.5 } } });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /between-frame/);
  }

  // The leader's Continue is only an acknowledgement.
  const lead = await call(`/api/match/${matchId}/continue`, { method: 'POST', token: tokens[0] });
  assert.equal(lead.body.started, false);
  assert.ok(lead.body.match.checkpoint);

  // The trailing player's Continue starts frame 2.
  const trail = await call(`/api/match/${matchId}/continue`, { method: 'POST', token: tokens[1] });
  assert.equal(trail.body.started, true);
  assert.equal(trail.body.match.checkpoint, null);
  assert.equal(trail.body.match.frame.frame, 2);
  assert.equal(trail.body.match.frame.turn, 1, 'loser of frame 1 breaks frame 2');
  assert.equal(trail.body.match.ended, false);
});

test('conceding at the checkpoint ends the match at 1-0, no further frames', async () => {
  const { matchId, tokens } = await newMatchPair();
  await setState(matchId, lastBlackFor([40, 30]));
  await call(`/api/match/${matchId}/shot`, { method: 'POST', token: tokens[0], body: { resultId: `${matchId}-b`, shot: POT_BLACK } });

  const res = await call(`/api/match/${matchId}/concede`, { method: 'POST', token: tokens[1], body: { via: 'checkpoint' } });
  assert.equal(res.status, 200);
  const { match } = res.body;
  assert.equal(match.ended, true);
  assert.equal(match.winner, 0);
  assert.equal(match.concededBy, 1);
  assert.deepEqual(match.framesWon, [1, 0], 'the score stays as it was — no frames handed over');
  assert.equal(match.checkpoint, null);

  const row = await getDb()('matches').where({ id: matchId }).first();
  assert.equal(row.status, 'completed');
  assert.equal(row.shot_deadline, null);
});

test('a frame ending level at 1-1 goes straight into the decider', async () => {
  const { matchId, tokens } = await newMatchPair();
  await setState(matchId, (s) => { s.framesWon = [0, 1]; lastBlackFor([40, 30])(s); s.frame.frame = 2; });
  const shot = await call(`/api/match/${matchId}/shot`, { method: 'POST', token: tokens[0], body: { resultId: `${matchId}-b`, shot: POT_BLACK } });
  assert.deepEqual(shot.body.match.framesWon, [1, 1]);
  assert.equal(shot.body.match.checkpoint, null);
  assert.equal(shot.body.match.frame.frame, 3);
});

test('conceding mid-frame keeps the conceder\'s break reward-eligible', async () => {
  const { matchId, tokens } = await newMatchPair();
  // Seat 1 made a 35 earlier in this unfinished frame, then fell hopelessly behind.
  await setState(matchId, (s) => { s.frame.highBreaks = [20, 35]; s.frame.scores = [90, 35]; });

  const res = await call(`/api/match/${matchId}/concede`, { method: 'POST', token: tokens[1], body: { via: 'unrecoverable' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.match.highBreaks, [20, 35], 'the unfinished frame\'s breaks are kept');
  assert.deepEqual(res.body.match.framesWon, [0, 0]);
  assert.equal(res.body.match.winner, 0);

  const knex = getDb();
  const seat1 = res.body.match.players[1];
  const eligible = await knex('eligible_breaks').where({ match_id: matchId }).first();
  assert.ok(eligible, 'the match still records its eligible break');
  assert.equal(Number(eligible.user_id), Number(seat1), 'it belongs to the player who conceded');
  assert.equal(eligible.break_value, 35);
  const row = await knex('matches').where({ id: matchId }).first();
  assert.equal(row.high_break_b, 35);
});

test('an unanswered checkpoint starts the next frame — it never concedes for the player', async () => {
  const { matchId, tokens } = await newMatchPair();
  await setState(matchId, lastBlackFor([40, 30]));
  await call(`/api/match/${matchId}/shot`, { method: 'POST', token: tokens[0], body: { resultId: `${matchId}-b`, shot: POT_BLACK } });

  // Let the decision window lapse.
  const knex = getDb();
  await knex('matches').where({ id: matchId }).update({ shot_deadline: new Date(Date.now() - 1000) });
  await sweepShotClocks();

  const { body } = await call(`/api/match/${matchId}`, { token: tokens[1] });
  assert.equal(body.match.ended, false);
  assert.equal(body.match.checkpoint, null);
  assert.equal(body.match.frame.frame, 2);
  assert.deepEqual(body.match.frame.scores, [0, 0], 'no shot-clock foul was charged for the checkpoint');
  const row = await knex('matches').where({ id: matchId }).first();
  assert.ok(new Date(row.shot_deadline).getTime() > Date.now(), 'the normal shot clock is running again');
});
