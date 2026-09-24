/**
 * Guard: the table geometry and the physics are exactly what they were.
 *
 * The game's look is tuned in the renderer and CSS alone. This test fails if
 * any such change reaches into @snooker/sim, where it would move where balls
 * go and what the server accepts. It compares against a recorded snapshot of
 *   - every constant the sim exports (table size, pockets, jaws, PHYSICS, ...)
 *   - the cushion and pocket-mouth geometry, at the physics depth and at the
 *     depth the renderer draws
 *   - where every ball comes to rest after one fixed break-off, which catches
 *     a change to the simulation code itself, not just to its numbers
 *   - the same for four spin shots (draw, follow, left and right side), added
 *     Sep 24 with spin. Zero-spin shots are also held bit-for-bit by
 *     shared/sim/test/zeroSpin.test.js, recorded before spin existed.
 *
 * If a physics or geometry change is intended, re-record deliberately:
 *   UPDATE_SIM_SNAPSHOT=1 npm test -w @snooker/game
 * and commit the new snapshot with the change that caused it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sim from '@snooker/sim';

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(here, 'fixtures', 'sim-snapshot.json');

// The depth renderer.js passes to cushionGeometry (CUSHION_DRAWN).
const RENDER_DEPTH = 3.6;

// Positions are rounded so the snapshot records the physics, not the last few
// bits of floating point.
const round = (v) => Math.round(v * 1e6) / 1e6;
const rounded = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'number' ? round(v) : v)));

function current() {
  const constants = {};
  for (const [name, value] of Object.entries(sim).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value !== 'function') constants[name] = value;
  }

  const breakOff = sim.simulateShot(sim.initialBalls(), {
    angle: 0.03, power: 0.9, cuePlacement: { x: 62, y: sim.CENTRE_Y + 6 },
  });

  // One shot each way: a straight red for draw and follow, and a ball sent
  // into a cushion with side, where side shows.
  const straightRed = [{ id: 'cue', x: 150, y: sim.CENTRE_Y }, { id: 'red1', x: 200, y: sim.CENTRE_Y }];
  const toCushion = [{ id: 'cue', x: 120, y: 60 }, { id: 'black', x: 300, y: 120 }];
  const spinShot = (balls, shot) => {
    const r = sim.simulateShot(balls, shot);
    return { steps: r.steps, balls: r.balls.map(({ id, x, y, potted }) => ({ id, x, y, potted })) };
  };
  const spinShots = {
    draw: spinShot(straightRed, { angle: 0, power: 0.9, spin: { x: 0, y: -0.7 } }),
    follow: spinShot(straightRed, { angle: 0, power: 0.6, spin: { x: 0, y: 0.7 } }),
    left: spinShot(toCushion, { angle: -1.2, power: 0.6, spin: { x: -0.7, y: 0.1 } }),
    right: spinShot(toCushion, { angle: -1.2, power: 0.6, spin: { x: 0.7, y: -0.1 } }),
  };

  return rounded({
    constants,
    cushions: sim.cushionGeometry(),
    cushionsAsDrawn: sim.cushionGeometry({ depth: RENDER_DEPTH }),
    pocketMouths: sim.pocketMouths(),
    breakOff: {
      steps: breakOff.steps,
      firstContact: breakOff.firstContact ?? null,
      balls: breakOff.balls.map(({ id, x, y, potted }) => ({ id, x, y, potted })),
    },
    spinShots,
  });
}

test('table geometry and physics match the recorded snapshot', () => {
  const now = current();
  if (process.env.UPDATE_SIM_SNAPSHOT === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  // Section by section, so a failure names what moved.
  for (const key of Object.keys(recorded)) {
    assert.deepEqual(now[key], recorded[key], `${key} changed — see the header of this file`);
  }
  assert.deepEqual(Object.keys(now), Object.keys(recorded));
});

test('the spin shots each end somewhere different', () => {
  // Otherwise the spin section would guard nothing.
  const { spinShots } = current();
  const cue = (k) => spinShots[k].balls.find((b) => b.id === 'cue');
  assert.ok(cue('follow').x - cue('draw').x > 30, 'follow ends well beyond draw');
  assert.ok(Math.abs(cue('left').x - cue('right').x) > 3 || Math.abs(cue('left').y - cue('right').y) > 3, 'left and right side part');
});

test('the break-off actually exercises the physics', () => {
  // A snapshot of a shot that never touched anything would guard nothing.
  const { breakOff } = current();
  assert.ok(breakOff.steps > 100, `only ${breakOff.steps} steps`);
  const start = new Map(sim.initialBalls().map((b) => [b.id, b]));
  const moved = breakOff.balls.filter((b) => b.id !== 'cue'
    && (b.potted || Math.hypot(b.x - start.get(b.id).x, b.y - start.get(b.id).y) > 1));
  assert.ok(moved.length >= 3, `only ${moved.length} object balls moved`);
});
