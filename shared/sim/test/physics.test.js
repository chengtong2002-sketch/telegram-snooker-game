import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSimulation, simulateShot, initialBalls, PHYSICS, MAX_SHOT_SPEED, BALL_RADIUS, TABLE,
} from '../src/index.js';

const STEP_S = PHYSICS.dt / 1000;

/** Step a simulation, keeping a copy of every ball's position after each step. */
function run(balls, shot, { stopAfter = 3000, until } = {}) {
  const sim = createSimulation(balls, shot);
  const frames = [];
  for (let i = 0; i < stopAfter && !sim.done; i += 1) {
    sim.step();
    frames.push(Object.fromEntries(sim.balls().map((b) => [b.id, { x: b.x, y: b.y, potted: b.potted }])));
    if (until?.(sim, i)) break;
  }
  return { sim, frames };
}
const speedAt = (frames, id, i) => {
  const a = frames[i - 1]?.[id];
  const b = frames[i]?.[id];
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) / STEP_S : 0;
};
const firstEvent = (sim, type) => sim.events.find((e) => e.type === type)?.step;

// --- Cushions -------------------------------------------------------------------

/** Fire straight or at 45° into the top cushion; fraction of speed kept 0.1s after contact. */
function cushionKeeps(speed, angleDeg) {
  const angle = (-angleDeg * Math.PI) / 180;
  const { sim, frames } = run([{ id: 'cue', color: 'cue', value: 0, x: 100, y: 12, potted: false }], { angle, power: speed / MAX_SHOT_SPEED });
  const hit = firstEvent(sim, 'cushion');
  assert.ok(hit !== undefined, `the ball reaches the cushion at ${speed}cm/s`);
  return speedAt(frames, 'cue', hit + 30) / speedAt(frames, 'cue', Math.max(1, hit - 3));
}

test('a ball rebounds off a cushion with most of its speed, however slow or fast', () => {
  // Real cushions give back roughly 70-80%. Before the resting threshold was
  // lowered, anything under 120cm/s kept 6% and stopped dead against the cushion.
  for (const speed of [30, 60, 100, 150, 250, 340]) {
    const straight = cushionKeeps(speed, 90);
    assert.ok(straight > 0.65 && straight < 0.78, `${speed}cm/s straight in kept ${(straight * 100).toFixed(0)}%`);
  }
  for (const speed of [60, 250]) {
    const angled = cushionKeeps(speed, 45);
    assert.ok(angled > 0.75 && angled < 0.9, `${speed}cm/s at 45° kept ${(angled * 100).toFixed(0)}%`);
  }
});

test('cushions are less bouncy than balls: the cushion restitution is not overridden by the ball\'s', () => {
  assert.ok(PHYSICS.cushionRestitution < PHYSICS.ballRestitution);
  const kept = cushionKeeps(100, 90);
  // At the ball's 0.94 it would keep about 89% (0.94 less 0.1s of cloth drag).
  assert.ok(kept < 0.8, `kept ${(kept * 100).toFixed(0)}%`);
});

// --- Ball on ball ----------------------------------------------------------------

test('a straight hit on a still ball passes almost all the speed on, at any speed', () => {
  for (const speed of [30, 60, 100, 250]) {
    const { sim, frames } = run([
      { id: 'cue', color: 'cue', value: 0, x: 100, y: 88.9, potted: false },
      { id: 'red1', color: 'red', value: 1, x: 115, y: 88.9, potted: false },
    ], { angle: 0, power: speed / MAX_SHOT_SPEED }, { stopAfter: 400 });
    const hit = firstEvent(sim, 'ball-hit');
    const before = speedAt(frames, 'cue', hit - 2);
    const cue = speedAt(frames, 'cue', hit + 15) / before;
    const red = speedAt(frames, 'red1', hit + 15) / before;
    // Before the threshold fix, slower hits left both balls moving at 49%.
    assert.ok(red > 0.88, `${speed}cm/s: object ball got ${(red * 100).toFixed(0)}%`);
    assert.ok(cue < 0.06, `${speed}cm/s: cue ball kept ${(cue * 100).toFixed(0)}%`);
  }
});

test('the object ball leaves along the line of centres at the moment of contact, for any cut', () => {
  // Before exact contacts, Matter pushed along a face of a 10-sided polygon: a
  // dead-straight hit sent the object ball 9° off line, and cuts up to 20°.
  const R = BALL_RADIUS;
  let worst = 0;
  for (let cut = 0; cut <= 60; cut += 5) {
    for (const rot of [0, 13, 29]) {
      const base = (rot * Math.PI) / 180;
      const contact = base + (cut * Math.PI) / 180;
      const obj = { x: 180, y: 88.9 };
      const ghost = { x: obj.x - Math.cos(contact) * 2 * R, y: obj.y - Math.sin(contact) * 2 * R };
      const cue = { x: ghost.x - Math.cos(base) * 40, y: ghost.y - Math.sin(base) * 40 };
      const { sim, frames } = run([
        { id: 'cue', color: 'cue', value: 0, ...cue, potted: false },
        { id: 'red1', color: 'red', value: 1, ...obj, potted: false },
      ], { angle: base, power: 0.4 }, { stopAfter: 1200 });
      const hit = firstEvent(sim, 'ball-hit');
      const a = frames[hit + 3].red1;
      const b = frames[hit + 30].red1;
      let err = Math.abs(((Math.atan2(b.y - a.y, b.x - a.x) - contact) * 180) / Math.PI);
      if (err > 180) err = 360 - err;
      worst = Math.max(worst, err);
    }
  }
  assert.ok(worst < 0.5, `worst direction error ${worst.toFixed(2)}°`);
});

test('balls at rest never overlap after a break-off', () => {
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 6; i += 1) {
    const { balls } = simulateShot(initialBalls(), {
      angle: -0.08 + rnd() * 0.16, power: 0.6 + rnd() * 0.4, cuePlacement: { x: 62, y: TABLE.height / 2 + (rnd() - 0.5) * 20 },
    });
    const up = balls.filter((b) => !b.potted);
    for (let j = 0; j < up.length; j += 1) {
      for (let k = j + 1; k < up.length; k += 1) {
        const d = Math.hypot(up[j].x - up[k].x, up[j].y - up[k].y);
        assert.ok(d > 2 * BALL_RADIUS - 0.05, `break ${i}: ${up[j].id} and ${up[k].id} overlap by ${(2 * BALL_RADIUS - d).toFixed(2)}cm`);
      }
    }
  }
});
