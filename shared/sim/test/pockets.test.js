import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateShot, POCKETS, TABLE, BALL_RADIUS, MIDDLE_POCKET_CUT,
} from '../src/index.js';

const MID_X = TABLE.width / 2;
const middle = POCKETS.filter((p) => p.type === 'middle');
const corner = POCKETS.filter((p) => p.type === 'corner');

/** Fire a lone cue ball from `from` toward `to`; report the pocket it dropped in, if any. */
function roll(from, to, power) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const res = simulateShot([{ id: 'cue', color: 'cue', value: 0, ...from, potted: false }], { angle, power });
  const cue = res.balls.find((b) => b.id === 'cue');
  return { pocket: res.events.find((e) => e.type === 'pot')?.pocket ?? null, rest: cue.potted ? null : cue };
}

test('middle pockets capture tighter than corners, within the bounds their geometry allows', () => {
  for (const m of middle) {
    const setback = Math.abs(m.y - (m.y < 0 ? 0 : TABLE.height));
    assert.ok(m.r < Math.min(...corner.map((c) => c.r)), 'tighter than every corner');
    assert.ok(m.r < BALL_RADIUS + setback, `${m.id}: a ball touching the cushion must not be captured`);
    assert.ok(m.r > Math.hypot(MIDDLE_POCKET_CUT - BALL_RADIUS, setback), `${m.id}: a ball inside the mouth must drop`);
  }
});

test('a ball running along the cushion toward the corner passes the middle pocket', () => {
  for (const gap of [0, 0.5, 1, 2]) {
    for (const power of [0.35, 0.7]) {
      const top = roll({ x: 30, y: BALL_RADIUS + gap }, { x: 330, y: BALL_RADIUS + gap }, power);
      assert.notEqual(top.pocket, 'tm', `top rail, ${gap}cm off, power ${power}`);
      const bottom = roll({ x: 30, y: TABLE.height - BALL_RADIUS - gap }, { x: 330, y: TABLE.height - BALL_RADIUS - gap }, power);
      assert.notEqual(bottom.pocket, 'bm', `bottom rail, ${gap}cm off, power ${power}`);
    }
  }
});

test('a shallow shot from the baulk end aimed at the far corner is not swallowed by the middle', () => {
  for (const y0 of [6, 10]) {
    const res = roll({ x: 25, y: y0 }, { x: TABLE.width, y: 0 }, 0.9);
    assert.notEqual(res.pocket, 'tm', `from y=${y0}`);
  }
});

test('a ball sent into the middle pocket still drops, straight or at an angle', () => {
  for (const [approach, offset] of [[90, 0], [90, 2.5], [90, -2.5], [60, 0], [45, 0], [35, 0]]) {
    for (const power of [0.25, 0.7]) {
      const rad = (approach * Math.PI) / 180;
      const mouth = { x: MID_X + offset, y: 0 };
      const from = { x: mouth.x - Math.cos(rad) * 60, y: mouth.y + Math.sin(rad) * 60 };
      assert.equal(roll(from, mouth, power).pocket, 'tm', `${approach}° ${offset}cm off centre, power ${power}`);
    }
  }
});

test('a slow ball into the middle never stops hanging inside the mouth', () => {
  for (const offset of [-2.5, -1.5, 0, 1.5, 2.5]) {
    for (const power of [0.02, 0.03, 0.05, 0.08]) {
      const { rest } = roll({ x: MID_X + offset, y: 30 }, { x: MID_X + offset, y: 0 }, power);
      assert.ok(!rest || rest.y >= 0, `offset ${offset}, power ${power}: stopped at y=${rest?.y}`);
    }
  }
});
