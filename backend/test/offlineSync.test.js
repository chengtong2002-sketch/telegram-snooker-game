import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('offlinesync');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const {
  closeDb, migrate, getDb, toJson, fromJson,
} = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { sweepShotClocks } = await import('../src/services/matchService.js');
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

let nextTelegramId = 9500;
async function login() {
  const id = nextTelegramId++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id, first_name: `P${id}` } } });
  return { token: res.body.token, userId: res.body.user.id };
}

async function newPvpMatch() {
  const a = await login();
  const b = await login();
  await call('/api/match/queue', { method: 'POST', token: a.token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: b.token });
  return { matchId: body.matchId, players: [a, b] };
}

const loadRow = (matchId) => getDb()('matches').where({ id: matchId }).first();

async function setState(matchId, mutate, { deadline = new Date(Date.now() + 25_000) } = {}) {
  const row = await loadRow(matchId);
  const state = fromJson(row.state);
  mutate(state);
  await getDb()('matches').where({ id: matchId }).update({
    state: toJson(state), turn_user_id: state.players[state.frame.turn], shot_deadline: deadline,
  });
}

/** Only the black left, lined up for `turn` to pot it. */
const lastBlackFor = (turn, scores, framesWon = null) => (state) => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  const f = state.frame;
  f.balls.forEach((b) => { b.potted = true; });
  Object.assign(ballById(f, 'black'), black, { potted: false });
  Object.assign(ballById(f, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(f, {
    phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn, scores, highBreaks: [33, 0],
  });
  if (framesWon) state.framesWon = framesWon;
};
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };
const SOFT_MISS = { angle: Math.PI, power: 0.05 };

const sync = (token, results) => call('/api/sync', { method: 'POST', token, body: { results } });
const shotEntry = (resultId, matchId, shot, extra = {}) => ({
  resultId, kind: 'shot', matchId, payload: { shot }, ...extra,
});

// --- Same resultId, different content ---------------------------------------

test('same resultId, different shot: the first stands, the second is rejected as a conflict', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]));
  const id = `conflict-${matchId}`;

  const first = await sync(ann.token, [shotEntry(id, matchId, SOFT_MISS)]);
  assert.equal(first.body.results[0].status, 'ok', JSON.stringify(first.body));
  const afterFirst = await loadRow(matchId);

  // Same id, but now the shot that would pot the black and win the frame.
  const second = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  const r = second.body.results[0];
  assert.equal(r.status, 'rejected');
  assert.equal(r.conflict, true);
  assert.match(r.reason, /different/);

  const afterSecond = await loadRow(matchId);
  assert.equal(afterSecond.state, afterFirst.state, 'the match did not move');
  assert.equal(afterSecond.version, afterFirst.version);
  const shots = await getDb()('shots').where({ result_id: id });
  assert.equal(shots.length, 1);
  assert.deepEqual(fromJson(shots[0].shot), SOFT_MISS, 'the stored shot is the first one');
  const stored = await getDb()('sync_results').where({ result_id: id }).first();
  assert.deepEqual(fromJson(stored.payload), { shot: SOFT_MISS });
});

test('same resultId sent online first, then replayed from the queue with a different shot: conflict', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]));
  const id = `online-then-queue-${matchId}`;

  const online = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: id, shot: SOFT_MISS },
  });
  assert.equal(online.status, 200);
  const before = await loadRow(matchId);

  const direct = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: id, shot: POT_BLACK },
  });
  assert.equal(direct.status, 409);
  assert.match(direct.body.error, /different/);

  const queued = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  assert.equal(queued.body.results[0].status, 'rejected');
  assert.equal(queued.body.results[0].conflict, true);

  assert.equal((await loadRow(matchId)).state, before.state);
  // The conflicting payload must not become the record for this id.
  assert.equal(await getDb()('sync_results').where({ result_id: id }).first(), undefined);
});

test('an exact replay is still a harmless duplicate that returns the original outcome', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]));
  const id = `replay-${matchId}`;
  const first = await sync(ann.token, [shotEntry(id, matchId, SOFT_MISS)]);
  const again = await sync(ann.token, [shotEntry(id, matchId, SOFT_MISS)]);
  assert.equal(again.body.results[0].status, 'duplicate');
  assert.equal(again.body.results[0].conflict, undefined);
  const direct = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann.token, body: { resultId: id, shot: SOFT_MISS },
  });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.status, 'duplicate');
  assert.deepEqual(direct.body.outcome.foulReasons, first.body.results[0].outcome.foulReasons);
});

test('a match-winning shot replayed with different content never credits the break twice', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [40, 20], [1, 0]));
  const id = `winner-${matchId}`;

  const win = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  assert.equal(win.body.results[0].match.ended, true, JSON.stringify(win.body));
  const credited = await getDb()('users').where({ id: ann.userId }).first();
  assert.equal(Number(credited.lifetime_eligible_points), 33, 'the match high break');

  const tampered = await sync(ann.token, [shotEntry(id, matchId, { ...POT_BLACK, power: 0.6 })]);
  assert.equal(tampered.body.results[0].conflict, true);
  const replay = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  assert.equal(replay.body.results[0].status, 'duplicate');

  const breaks = await getDb()('eligible_breaks').where({ match_id: matchId });
  assert.equal(breaks.length, 1);
  const after = await getDb()('users').where({ id: ann.userId }).first();
  assert.equal(Number(after.lifetime_eligible_points), 33);
  assert.equal(Number(after.frames_won), Number(credited.frames_won));
});

test('two queues flushing the same resultId with different shots at the same moment: exactly one applies', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]));
  const id = `race-${matchId}`;
  const before = await loadRow(matchId);

  const [a, b] = await Promise.all([
    sync(ann.token, [shotEntry(id, matchId, SOFT_MISS)]),
    sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]),
  ]);
  const results = [a.body.results[0], b.body.results[0]];
  assert.equal(results.filter((r) => r.status === 'ok').length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === 'rejected' && r.conflict).length, 1, JSON.stringify(results));
  assert.equal((await getDb()('shots').where({ result_id: id })).length, 1);
  assert.equal(Number((await loadRow(matchId)).version), Number(before.version) + 1, 'the match moved exactly once');
});

test('practice stats: same resultId with different scores keeps the first and rejects the second', async () => {
  const p = await login();
  const id = `practice-${p.userId}`;
  const first = await sync(p.token, [{ resultId: id, kind: 'practice-stat', payload: { highBreak: 40, framesWon: [2, 1] } }]);
  assert.equal(first.body.results[0].status, 'applied');
  const second = await sync(p.token, [{ resultId: id, kind: 'practice-stat', payload: { highBreak: 147, framesWon: [2, 0] } }]);
  assert.equal(second.body.results[0].status, 'rejected');
  assert.equal(second.body.results[0].conflict, true);
  const reordered = await sync(p.token, [{ resultId: id, kind: 'practice-stat', payload: { framesWon: [2, 1], highBreak: 40 } }]);
  assert.equal(reordered.body.results[0].status, 'duplicate', 'key order alone is not a different result');
  const stored = await getDb()('sync_results').where({ result_id: id }).first();
  assert.deepEqual(fromJson(stored.payload), { highBreak: 40, framesWon: [2, 1] });
});

// --- Queued while the shot clock resolved things server-side -----------------

test('queued shot arriving after its clock ran out (not yet swept) is scored as the timeout, not as the shot', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]), { deadline: new Date(Date.now() - 5_000) });

  const res = await sync(ann.token, [shotEntry(`late-${matchId}`, matchId, POT_BLACK, { createdAt: Date.now() - 60_000 })]);
  const r = res.body.results[0];
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.outcome.overdue, true);
  assert.equal(r.outcome.foul, true);
  assert.deepEqual(r.outcome.potted, [], 'the pot the client saw does not count');
  const state = fromJson((await loadRow(matchId)).state);
  assert.deepEqual(state.frame.scores, [20, 24]);
  assert.equal(ballById(state.frame, 'black').potted, false);
  assert.equal(state.frame.turn, 1);
});

test('queued shot arriving after the sweeper already charged the timeout: rejected, penalty not charged twice', async () => {
  const { matchId, players: [ann] } = await newPvpMatch();
  await setState(matchId, lastBlackFor(0, [20, 20]), { deadline: new Date(Date.now() - 5_000) });
  await sweepShotClocks();
  const swept = await loadRow(matchId);
  assert.deepEqual(fromJson(swept.state).frame.scores, [20, 24]);

  const id = `after-sweep-${matchId}`;
  const res = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  assert.equal(res.body.results[0].status, 'rejected');
  assert.match(res.body.results[0].reason, /not your turn/);

  const after = await loadRow(matchId);
  assert.equal(after.state, swept.state);
  assert.equal((await getDb()('shots').where({ result_id: id })).length, 0);

  // Replaying it keeps saying why, rather than a bare "duplicate".
  const replay = await sync(ann.token, [shotEntry(id, matchId, POT_BLACK)]);
  assert.equal(replay.body.results[0].status, 'rejected');
  assert.match(replay.body.results[0].reason, /not your turn/);
});

test('queued shot arriving after the match was decided server-side: rejected, no credit', async () => {
  const { matchId, players: [ann, ben] } = await newPvpMatch();
  // Ann's clock ran out while she was offline; the sweeper handed Ben the table
  // and Ben potted the last black to win the match 2-0.
  await setState(matchId, lastBlackFor(0, [20, 30], [0, 1]), { deadline: new Date(Date.now() - 5_000) });
  await sweepShotClocks();
  await setState(matchId, (s) => { lastBlackFor(1, s.frame.scores, [0, 1])(s); s.frame.highBreaks = [0, 12]; });
  const benWins = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ben.token, body: { resultId: `ben-${matchId}`, shot: POT_BLACK },
  });
  assert.equal(benWins.body.match.ended, true, JSON.stringify(benWins.body));
  const decided = await loadRow(matchId);

  const res = await sync(ann.token, [shotEntry(`ann-queued-${matchId}`, matchId, POT_BLACK, { createdAt: Date.now() - 120_000 })]);
  assert.equal(res.body.results[0].status, 'rejected');
  assert.match(res.body.results[0].reason, /not active/);

  const after = await loadRow(matchId);
  assert.equal(after.state, decided.state);
  assert.equal(Number(after.winner_id), Number(ben.userId));
  const breaks = await getDb()('eligible_breaks').where({ match_id: matchId });
  assert.equal(breaks.length, 1);
  assert.equal(Number(breaks[0].user_id), Number(ben.userId));
  assert.equal(Number((await getDb()('users').where({ id: ann.userId }).first()).lifetime_eligible_points), 0);
});
