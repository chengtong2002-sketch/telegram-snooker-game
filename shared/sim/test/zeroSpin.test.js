/**
 * Zero-spin shots play exactly as they did before spin existed.
 *
 * fixtures/zero-spin-shots.json was recorded from the sim BEFORE any spin code
 * (main at 591f8ab): 300 shots — break-offs, pots near pockets, and random
 * layouts, some from hand — with where every ball stopped, the step count,
 * the first contact and a hash of every event. A shot with no spin, or with
 * spin {x: 0, y: 0}, must reproduce all of it bit for bit.
 *
 * The fixture holds its own inputs, so it never depends on this generator
 * again. Re-record only to add cases, and never to make a failure pass:
 *   UPDATE_ZERO_SPIN=1 npm test -w @snooker/sim
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulateShot, initialBalls, TABLE, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, CENTRE_Y, POCKETS,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'zero-spin-shots.json');

function rng(seed) {
  let s = Math.imul(seed, 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function inD(rand) {
  for (;;) {
    const x = BAULK_LINE_X - rand() * D_RADIUS;
    const y = CENTRE_Y + (rand() * 2 - 1) * D_RADIUS;
    if (Math.hypot(x - BAULK_LINE_X, y - CENTRE_Y) < D_RADIUS - BALL_RADIUS) return { x: r4(x), y: r4(y) };
  }
}

/** `n` balls (the cue ball first) at random, none overlapping, all on the cloth. */
function scatter(rand, n) {
  const ids = ['cue', 'black', 'pink', 'blue', 'brown', 'green', 'yellow', ...Array.from({ length: 15 }, (_, i) => `red${i + 1}`)];
  const placed = [];
  const m = BALL_RADIUS * 1.5;
  while (placed.length < n) {
    const x = r4(m + rand() * (TABLE.width - 2 * m));
    const y = r4(m + rand() * (TABLE.height - 2 * m));
    if (placed.some((b) => Math.hypot(b.x - x, b.y - y) < BALL_RADIUS * 2.05)) continue;
    if (POCKETS.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + BALL_RADIUS * 2)) continue;
    placed.push({ id: ids[placed.length], x, y });
  }
  return placed;
}

/** The shots, as plain data: balls [[id, x, y]] and the shot. */
function generate() {
  const cases = [];
  const rack = initialBalls().map((b) => [b.id, b.x, b.y]);
  // 60 break-offs from hand, at the pack, soft to full.
  for (let i = 0; i < 60; i += 1) {
    const rand = rng(1000 + i);
    const at = inD(rand);
    cases.push({ balls: rack, shot: { angle: r4((rand() - 0.5) * 0.3), power: r4(0.3 + rand() * 0.7), cuePlacement: at } });
  }
  // 90 pots: an object ball near a pocket, the cue ball behind it, straight to thin.
  for (let i = 0; i < 90; i += 1) {
    const rand = rng(2000 + i);
    const p = POCKETS[i % POCKETS.length];
    const toward = Math.atan2(CENTRE_Y - p.y, TABLE.width / 2 - p.x) + (rand() - 0.5) * 0.6;
    const dObj = 15 + rand() * 60;
    const obj = { x: r4(p.x + Math.cos(toward) * dObj), y: r4(p.y + Math.sin(toward) * dObj) };
    const cut = (rand() - 0.5) * 1.2;
    const dCue = 20 + rand() * 90;
    const cue = { x: r4(obj.x + Math.cos(toward + cut) * dCue), y: r4(obj.y + Math.sin(toward + cut) * dCue) };
    const clamp = (b) => ({ x: Math.min(TABLE.width - 4, Math.max(4, b.x)), y: Math.min(TABLE.height - 4, Math.max(4, b.y)) });
    const c = clamp(cue);
    const o = clamp(obj);
    // Aim at the ghost ball for the pot, then miss by a little.
    const potDir = Math.atan2(p.y - o.y, p.x - o.x);
    const ghost = { x: o.x - Math.cos(potDir) * BALL_RADIUS * 2, y: o.y - Math.sin(potDir) * BALL_RADIUS * 2 };
    const angle = Math.atan2(ghost.y - c.y, ghost.x - c.x) + (rand() - 0.5) * 0.02;
    cases.push({
      balls: [['cue', r4(c.x), r4(c.y)], ['red1', r4(o.x), r4(o.y)]],
      shot: { angle: r4(angle), power: r4(0.15 + rand() * 0.8) },
    });
  }
  // 150 random layouts, 2–22 balls, any direction, some from hand.
  for (let i = 0; i < 150; i += 1) {
    const rand = rng(3000 + i);
    const balls = scatter(rand, 2 + Math.floor(rand() * 21)).map((b) => [b.id, b.x, b.y]);
    const shot = { angle: r4((rand() * 2 - 1) * Math.PI), power: r4(0.05 + rand() * 0.95) };
    if (i % 5 === 0) shot.cuePlacement = inD(rand);
    cases.push({ balls, shot });
  }
  return cases;
}

const toBalls = (rows) => rows.map(([id, x, y]) => ({ id, x, y, potted: false }));

function play(c, extra = {}) {
  const res = simulateShot(toBalls(c.balls), { ...c.shot, ...extra });
  return {
    steps: res.steps,
    first: res.firstContact ?? null,
    events: res.events.length,
    eventsHash: crypto.createHash('sha256').update(JSON.stringify(res.events)).digest('hex').slice(0, 16),
    balls: res.balls.map((b) => [b.id, b.x, b.y, b.potted ? 1 : 0, b.offTable ? 1 : 0]),
  };
}

if (process.env.UPDATE_ZERO_SPIN) {
  const cases = generate().map((c) => ({ ...c, out: play(c) }));
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify({ recordedFrom: process.env.UPDATE_ZERO_SPIN, cases })}\n`);
  console.log(`recorded ${cases.length} zero-spin shots`);
}

const { cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test(`the fixture is a real spread of shots (${cases.length})`, () => {
  assert.equal(cases.length, 300);
  const pots = cases.filter((c) => c.out.balls.some((b) => b[3] && !b[4])).length;
  const cueHits = cases.filter((c) => c.out.first).length;
  assert.ok(pots > 40, `pots in ${pots}`);
  assert.ok(cueHits > 150, `contacts in ${cueHits}`);
});

test('a shot with no spin field plays exactly as recorded', () => {
  for (const [i, c] of cases.entries()) assert.deepStrictEqual(play(c), c.out, `case ${i}`);
});

test('spin {x: 0, y: 0} plays exactly as recorded', () => {
  for (const [i, c] of cases.entries()) assert.deepStrictEqual(play(c, { spin: { x: 0, y: 0 } }), c.out, `case ${i}`);
});
