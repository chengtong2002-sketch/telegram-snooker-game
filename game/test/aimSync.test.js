import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AimSender, RemoteAim, sseParser, followAim, angleDelta,
  SEND_INTERVAL_MS, HEARTBEAT_MS, RENDER_DELAY_MS, STALE_MS,
} from '../src/aimSync.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('angleDelta takes the short way round', () => {
  assert.ok(close(angleDelta(0.1, 0.3), 0.2));
  assert.ok(close(angleDelta(3.0, -3.0), 2 * Math.PI - 6));
  assert.ok(close(angleDelta(-3.0, 3.0), 6 - 2 * Math.PI));
});

test('the sender goes at most every interval, and only when the aim changed', () => {
  const sent = [];
  const s = new AimSender((m) => { sent.push(m); });
  let t = 0;
  // A drag at 60fps for one second: ~10 sends, not 60.
  for (let f = 0; f < 60; f += 1, t += 1000 / 60) s.update({ angle: f * 0.01, power: 0.3 }, t);
  assert.ok(sent.length >= 9 && sent.length <= 11, `sent ${sent.length}`);
  for (let i = 1; i < sent.length; i += 1) assert.equal(sent[i].seq, sent[i - 1].seq + 1);

  // Held still: nothing until the heartbeat.
  const n = sent.length;
  const still = { angle: 5, power: 0.5 };
  s.update(still, t += SEND_INTERVAL_MS);
  assert.equal(sent.length, n + 1);
  for (let k = 0; k < 8; k += 1) s.update(still, t += SEND_INTERVAL_MS);
  assert.equal(sent.length, n + 1, 'no repeats of an unchanged aim');
  s.update(still, t += HEARTBEAT_MS);
  assert.equal(sent.length, n + 2, 'heartbeat');
});

test('the sender carries the cue ball only while it is in hand', () => {
  const sent = [];
  const s = new AimSender((m) => { sent.push(m); });
  s.update({ angle: 0, power: 0.3, cue: { x: 60, y: 90 } }, 0);
  s.update({ angle: 0, power: 0.3, cue: { x: 61, y: 90 } }, 200);
  s.update({ angle: 0, power: 0.3 }, 400);
  assert.deepEqual(sent.map((m) => m.cue ?? null), [{ x: 60, y: 90 }, { x: 61, y: 90 }, null]);
});

test('the sender skips rather than queues on a slow link', () => {
  let resolve;
  const s = new AimSender(() => new Promise((r) => { resolve = r; }), { maxInFlight: 1 });
  assert.equal(s.update({ angle: 0, power: 0.3 }, 0), true);
  assert.equal(s.update({ angle: 1, power: 0.3 }, 500), false);
  resolve();
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    assert.equal(s.update({ angle: 1, power: 0.3 }, 600), true);
  });
});

test('the opponent view interpolates between updates, behind by the render delay', () => {
  const r = new RemoteAim();
  assert.equal(r.pose(0), null);
  r.push({ angle: 0, power: 0.2, seq: 1 }, 1000);
  r.push({ angle: 1, power: 0.6, seq: 2 }, 1100);
  const mid = r.pose(1050 + RENDER_DELAY_MS);
  assert.ok(close(mid.angle, 0.5) && close(mid.power, 0.4), JSON.stringify(mid));
  assert.equal(mid.stale, false);
  // Past the newest: holds it (a freeze, not an extrapolation).
  const held = r.pose(1100 + RENDER_DELAY_MS + 800);
  assert.deepEqual([held.angle, held.power], [1, 0.6]);
});

test('interpolation crosses ±π the short way', () => {
  const r = new RemoteAim();
  r.push({ angle: 3.1, power: 0.5, seq: 1 }, 0);
  r.push({ angle: -3.1, power: 0.5, seq: 2 }, 100);
  const { angle } = r.pose(50 + RENDER_DELAY_MS);
  assert.ok(Math.abs(Math.abs(angle) - Math.PI) < 0.01, `swung the long way: ${angle}`);
});

test('a late, out-of-order update is dropped; a restarted shooter is not', () => {
  const r = new RemoteAim();
  r.push({ angle: 0.2, power: 0.5, seq: 10 }, 0);
  r.push({ angle: 0.1, power: 0.5, seq: 9 }, 50);
  assert.equal(r.samples.length, 1);
  r.push({ angle: 0.3, power: 0.5, seq: 200 }, 60);
  r.push({ angle: 0.4, power: 0.5, seq: 1 }, 70); // reloaded page, counting from 1 again
  assert.equal(r.samples.length, 3);
});

test('on lag the cue freezes where it was and is marked stale', () => {
  const r = new RemoteAim();
  r.push({ angle: 0.7, power: 0.4, seq: 1 }, 0);
  const p = r.pose(STALE_MS + 1);
  assert.deepEqual([p.angle, p.power, p.stale], [0.7, 0.4, true]);
  r.push({ angle: 0.8, power: 0.4, seq: 2 }, STALE_MS + 2);
  assert.equal(r.pose(STALE_MS + 3).stale, false, 'back to live on the next update');
});

test('the SSE parser splits events, joins chunks and skips keepalives', () => {
  const got = [];
  const feed = sseParser((m) => got.push(m));
  feed('retry: 2000\n\nevent: ready\ndata: {}\n\n: keepalive 1\n\nevent: ai');
  feed('m\ndata: {"angle":1}\n\n');
  feed('event: moved\r\ndata: {}\r\n\r\n');
  assert.deepEqual(got, [
    { event: 'ready', data: '{}' },
    { event: 'aim', data: '{"angle":1}' },
    { event: 'moved', data: '{}' },
  ]);
});

/** A Response-like stream fed by hand. */
function fakeStream(status = 200) {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  const enc = new TextEncoder();
  return { res: { status, body }, push: (s) => ctl.enqueue(enc.encode(s)), end: () => ctl.close() };
}

test('followAim delivers aim, reconnects after a drop, and stops on 409', async () => {
  const streams = [fakeStream(), fakeStream(), fakeStream(409)];
  let opened = 0;
  const aims = [];
  let moved = 0;
  const states = [];
  const feed = followAim(async () => streams[opened++].res, (a) => aims.push(a), {
    onMoved: () => { moved += 1; },
    onStateChange: (s) => states.push(s),
    sleep: () => Promise.resolve(),
  });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  streams[0].push('event: ready\ndata: {}\n\nevent: aim\ndata: {"angle":1,"power":0.5,"seat":1}\n\n');
  await tick();
  assert.deepEqual(aims, [{ angle: 1, power: 0.5, seat: 1 }]);
  assert.equal(feed.state(), 'open');
  streams[0].end(); // the proxy dropped it
  await tick();
  assert.equal(opened, 2);
  streams[1].push('event: ready\ndata: {}\n\nevent: moved\ndata: {}\n\n');
  await tick();
  assert.equal(moved, 1);
  streams[1].end();
  await tick();
  assert.equal(opened, 3);
  assert.equal(feed.state(), 'stopped', 'a finished match is not retried');
  assert.ok(states.includes('reconnecting'));
});
