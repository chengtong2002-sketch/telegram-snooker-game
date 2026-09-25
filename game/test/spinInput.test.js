import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPIN, normaliseSpin } from '@snooker/sim';
import {
  CENTRE, SPIN_STEP, SHIFT_PX_PER_RADIUS,
  clampSpin, isCentre, spinFromOffset, nudgeSpin, stepSpin, spinLabel, spinForShot, dotPosition,
} from '../src/spinInput.js';

test('clampSpin keeps the tip inside the reachable circle and drops junk', () => {
  assert.deepEqual(clampSpin({ x: 0.3, y: -0.4 }), { x: 0.3, y: -0.4 });
  const edge = clampSpin({ x: 3, y: 4 });
  assert.ok(Math.abs(Math.hypot(edge.x, edge.y) - SPIN.maxOffset) < 0.01);
  assert.deepEqual(edge, { x: 0.48, y: 0.64 });
  assert.deepEqual(clampSpin({ x: NaN, y: 0 }), CENTRE);
  assert.deepEqual(clampSpin(null), CENTRE);
  assert.ok(Object.is(clampSpin({ x: -0.001, y: 0 }).x, 0), 'no -0');
});

test('a spin the control produces is one the sim plays unchanged', () => {
  for (const s of [{ x: 0.8, y: 0 }, { x: 0, y: -0.8 }, clampSpin({ x: 1, y: 1 }), { x: -0.25, y: 0.5 }]) {
    const played = normaliseSpin(s);
    assert.ok(Math.abs(played.x - s.x) < 1e-9 && Math.abs(played.y - s.y) < 1e-9, JSON.stringify(s));
  }
});

test('a point on the drawn ball maps to spin with y up, clamped', () => {
  assert.deepEqual(spinFromOffset(0, 0, 100), CENTRE);
  assert.deepEqual(spinFromOffset(0, 60, 100), { x: 0, y: -0.6 }, 'below centre is draw');
  assert.deepEqual(spinFromOffset(-50, -20, 100), { x: -0.5, y: 0.2 });
  assert.deepEqual(spinFromOffset(0, 500, 100), { x: 0, y: -0.8 }, 'outside the ball stops at the limit');
  assert.deepEqual(spinFromOffset(10, 10, 0), CENTRE);
});

test('Shift + mouse moves the dot by travel, not position', () => {
  const s = nudgeSpin({ x: 0, y: 0 }, SHIFT_PX_PER_RADIUS / 2, 0);
  assert.deepEqual(s, { x: 0.5, y: 0 });
  assert.deepEqual(nudgeSpin(s, 0, SHIFT_PX_PER_RADIUS / 4), { x: 0.5, y: -0.25 }, 'mouse down is draw');
  const far = nudgeSpin(s, 10_000, 0);
  assert.equal(far.x, SPIN.maxOffset);
});

test('arrow keys step 0.1 without float dust, and stop at the edge', () => {
  let s = CENTRE;
  for (let i = 0; i < 3; i += 1) s = stepSpin(s, 'ArrowDown');
  assert.deepEqual(s, { x: 0, y: -0.3 });
  s = stepSpin(s, 'ArrowRight');
  assert.deepEqual(s, { x: SPIN_STEP, y: -0.3 });
  let up = CENTRE;
  for (let i = 0; i < 20; i += 1) up = stepSpin(up, 'ArrowUp');
  assert.deepEqual(up, { x: 0, y: SPIN.maxOffset });
  assert.equal(stepSpin(CENTRE, 'w'), null);
});

test('labels name what the player chose', () => {
  assert.equal(spinLabel(CENTRE), 'Centre');
  assert.equal(spinLabel({ x: 0, y: 0.8 }), 'Top');
  assert.equal(spinLabel({ x: 0, y: -0.5 }), 'Draw');
  assert.equal(spinLabel({ x: -0.6, y: 0 }), 'Left side');
  assert.equal(spinLabel({ x: 0.4, y: -0.4 }), 'Draw + right');
  assert.equal(spinLabel({ x: 0.02, y: 0 }), 'Nearly centre');
});

test('centre puts nothing on the shot, so it plays exactly as before spin', () => {
  assert.equal(spinForShot(CENTRE), undefined);
  assert.equal(spinForShot({ x: 0, y: 0 }), undefined);
  assert.deepEqual(spinForShot({ x: 0, y: -0.8 }), { x: 0, y: -0.8 });
  assert.ok(isCentre({ x: 0, y: 0 }));
});

test('the dot sits where the spin is on the drawn ball', () => {
  assert.deepEqual(dotPosition(CENTRE), { left: '50%', top: '50%' });
  assert.deepEqual(dotPosition({ x: 0.5, y: -0.8 }), { left: '75%', top: '90%' });
});
