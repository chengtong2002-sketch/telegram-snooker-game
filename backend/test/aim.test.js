import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('aim');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { AimRelay, shapeAim, aimRelay, AIM_RATE_PER_SEC, MAX_STREAMS_PER_USER } = await import('../src/services/aimRelay.js');
const { isAimPath } = await import('../src/routes/match.js');

await migrate();

const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const open = [];

test.after(async () => {
  for (const s of open) s.close();
  aimRelay.closeAll();
  server.closeAllConnections?.();
  server.close();
  await closeDb();
  await dropTestDatabase();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const loginAs = async (id, name) => (await call('/api/auth/telegram', {
  method: 'POST', body: { devUser: { id, first_name: name, username: name.toLowerCase() } },
})).body.token;

/** Open an aim stream the way the game does (fetch + Bearer), collecting its events. */
async function stream(matchId, token) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/match/${matchId}/aim-stream`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: ac.signal,
  });
  const s = { res, events: [], close: () => ac.abort() };
  if (res.status !== 200) return s;
  open.push(s);
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) s.events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  // Wait for the hello, so a publish right after cannot race the subscription.
  for (let t = 0; t < 100 && !s.events.some((e) => e.event === 'ready'); t += 1) await sleep(10);
  return s;
}

const aims = (s) => s.events.filter((e) => e.event === 'aim').map((e) => e.data);
const postAim = (matchId, token, body) => call(`/api/match/${matchId}/aim`, { method: 'POST', token, body });

let ann; let ben; let cat; let matchId;

test('setup: Ann (seat 0, to shoot) and Ben are paired', async () => {
  ann = await loginAs(3101, 'Ann');
  ben = await loginAs(3102, 'Ben');
  cat = await loginAs(3103, 'Cat');
  await call('/api/match/queue', { method: 'POST', token: ann });
  matchId = (await call('/api/match/queue', { method: 'POST', token: ben })).body.matchId;
  assert.ok(matchId);
  const { body } = await call(`/api/match/${matchId}`, { token: ann });
  assert.equal(body.match.frame.turn, 0);
});

test('the stream needs a session and a seat in the match', async () => {
  assert.equal((await stream(matchId, null)).res.status, 401);
  assert.equal((await stream(matchId, cat)).res.status, 403);
  assert.equal((await stream('no-such-match', ann)).res.status, 404);
});

test("the shooter's aim reaches the opponent only, with just the drawn fields", async () => {
  const annS = await stream(matchId, ann);
  const benS = await stream(matchId, ben);
  assert.equal(benS.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const res = await postAim(matchId, ann, {
    angle: 0.5, power: 0.42, seq: 7, cue: { x: 60, y: 90 }, outcome: 'pot the black', points: 147,
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('x-aim'), 'relayed');
  await sleep(80);

  assert.deepEqual(aims(benS), [{ angle: 0.5, power: 0.42, seq: 7, cue: { x: 60, y: 90 }, seat: 0 }]);
  assert.deepEqual(aims(annS), [], 'never echoed back to the shooter');
  annS.close();
  benS.close();
});

test('aim from the player who is not shooting is ignored', async () => {
  const annS = await stream(matchId, ann);
  const res = await postAim(matchId, ben, { angle: 1, power: 0.9 });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('x-aim'), 'ignored');
  await sleep(80);
  assert.deepEqual(aims(annS), []);
  annS.close();
});

test('an outsider cannot post aim, and garbage is a 400', async () => {
  assert.equal((await postAim(matchId, cat, { angle: 1, power: 0.5 })).status, 403);
  assert.equal((await postAim(matchId, ann, { angle: 'left', power: 0.5 })).status, 400);
  assert.equal((await postAim(matchId, ann, {})).status, 400);
});

test('aim is never stored and never moves the match', async () => {
  const db = getDb();
  const before = await db('matches').where({ id: matchId }).first('version', 'state');
  const shots = (await db('shots').count({ n: '*' }))[0].n;
  for (let i = 0; i < 5; i += 1) await postAim(matchId, ann, { angle: i / 10, power: 0.3 });
  const after = await db('matches').where({ id: matchId }).first('version', 'state');
  assert.equal(after.version, before.version);
  assert.equal(after.state, before.state);
  assert.equal((await db('shots').count({ n: '*' }))[0].n, shots);
});

test('the live-aim routes skip the app-wide limit and carry their own', async () => {
  assert.ok(isAimPath(`/match/${matchId}/aim`));
  assert.ok(isAimPath(`/match/${matchId}/aim-stream`));
  assert.ok(!isAimPath(`/match/${matchId}/shot`));
  assert.ok(!isAimPath('/match/active'));
  const other = await call('/api/match/active', { token: ann });
  assert.equal(other.headers.get('ratelimit-limit'), '240');
  await sleep(1100); // a fresh per-player window
  const aim = await postAim(matchId, ann, { angle: 0, power: 0.3 });
  assert.equal(aim.headers.get('ratelimit-limit'), '20');
});

test(`a player holds at most ${MAX_STREAMS_PER_USER} streams`, async () => {
  const held = [];
  for (let i = 0; i < MAX_STREAMS_PER_USER; i += 1) held.push(await stream(matchId, ben));
  assert.ok(held.every((s) => s.res.status === 200));
  assert.equal((await stream(matchId, ben)).res.status, 429);
  held[0].close();
  await sleep(80);
  const again = await stream(matchId, ben);
  assert.equal(again.res.status, 200, 'a closed stream frees its slot');
  for (const s of [...held, again]) s.close();
});

test('once the shot is taken the turn has passed: the old shooter is ignored at once', async () => {
  const annS = await stream(matchId, ann);
  const shot = await call(`/api/match/${matchId}/shot`, {
    method: 'POST', token: ann, body: { resultId: 'aim-test-shot-1', shot: { angle: 0, power: 0.6 } },
  });
  assert.equal(shot.status, 200, JSON.stringify(shot.body));
  const { body } = await call(`/api/match/${matchId}`, { token: ben });
  assert.equal(body.match.frame.turn, 1, 'a break-off pots nothing, so Ben is on');
  assert.ok(annS.events.some((e) => e.event === 'moved'), 'open tables hear that the match moved');

  assert.equal((await postAim(matchId, ann, { angle: 2, power: 1 })).headers.get('x-aim'), 'ignored');
  assert.equal((await postAim(matchId, ben, { angle: -1, power: 0.2, seq: 1 })).headers.get('x-aim'), 'relayed');
  await sleep(80);
  assert.deepEqual(aims(annS).map((a) => a.seat), [1]);
  annS.close();
});

// --- the relay alone, on a fake clock ------------------------------------

function fakeRes() {
  const r = {
    lines: [], handlers: {},
    status() { return r; }, set() { return r; }, flushHeaders() {},
    write(s) { r.lines.push(s); }, end() { r.ended = true; r.handlers.close?.(); },
    on(ev, fn) { r.handlers[ev] = fn; },
  };
  return r;
}
const fakeReq = () => ({ on() {} });

test(`the relay passes at most ${AIM_RATE_PER_SEC} a second per match and drops the rest`, async () => {
  let t = 0;
  const relay = new AimRelay({ now: () => t, loadTurn: async () => ({ players: [1, 2], shooter: 1, active: true }) });
  const res = fakeRes();
  await relay.subscribe('m', 2, fakeReq(), res);
  const statuses = [];
  for (let i = 0; i < 40; i += 1) statuses.push((await relay.publish('m', 1, { angle: i, power: 0.5 })).status);
  assert.equal(statuses.filter((s) => s === 'relayed').length, AIM_RATE_PER_SEC);
  assert.equal(statuses.filter((s) => s === 'limited').length, 40 - AIM_RATE_PER_SEC);
  t += 200; // refills a fifth of a second's worth
  let more = 0;
  for (let i = 0; i < 10; i += 1) if ((await relay.publish('m', 1, { angle: i, power: 0.5 })).status === 'relayed') more += 1;
  assert.equal(more, Math.floor(AIM_RATE_PER_SEC / 5));
  // Another match has its own allowance.
  assert.equal((await relay.publish('other', 1, { angle: 0, power: 0.5 })).status, 'relayed');
  relay.closeAll();
});

test('an idle stream gets a keepalive comment, and closing frees everything', async () => {
  const relay = new AimRelay({ keepaliveMs: 30, loadTurn: async () => ({ players: [1, 2], shooter: 1, active: true }) });
  const res = fakeRes();
  await relay.subscribe('m', 2, fakeReq(), res);
  await sleep(100);
  assert.ok(res.lines.filter((l) => l.startsWith(': keepalive')).length >= 2);
  assert.equal(relay.openStreams('m'), 1);
  relay.closeAll();
  assert.equal(res.ended, true);
  assert.equal(relay.openStreams(), 0);
  const n = res.lines.length;
  await sleep(80);
  assert.equal(res.lines.length, n, 'no keepalive after close');
});

test('a finished match gets no stream', async () => {
  const relay = new AimRelay({ loadTurn: async () => ({ players: [1, 2], shooter: null, active: false }) });
  const r = await relay.subscribe('m', 1, fakeReq(), fakeRes());
  assert.equal(r.code, 409);
});

test('shapeAim keeps numbers only, clamps power, drops everything else', () => {
  assert.deepEqual(shapeAim({ angle: 1.23456789, power: 3, seq: -4, spin: { top: 9 }, cue: { x: 'a', y: 1 } }),
    { angle: 1.2346, power: 1, seq: 0 });
  assert.equal(shapeAim({ angle: Infinity, power: 0.2 }), null);
  assert.equal(shapeAim(null), null);
});
