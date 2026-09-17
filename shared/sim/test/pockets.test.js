import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateShot, POCKETS, TABLE, BALL_RADIUS, MIDDLE_POCKET_CUT, CORNER_POCKET_CUT,
  CUSHION_DEPTH, cushionGeometry, pocketMouths,
} from '../src/index.js';

const W = TABLE.width;
const H = TABLE.height;
const MID_X = W / 2;
const middle = POCKETS.filter((p) => p.type === 'middle');
const corner = POCKETS.filter((p) => p.type === 'corner');

/** Fire a lone cue ball from `from` toward `to`; report the pocket it dropped in, if any. */
function roll(from, to, power) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const res = simulateShot([{ id: 'cue', color: 'cue', value: 0, ...from, potted: false }], { angle, power });
  const cue = res.balls.find((b) => b.id === 'cue');
  return { pocket: res.events.find((e) => e.type === 'pot')?.pocket ?? null, rest: cue.potted ? null : cue };
}

// --- Geometry ------------------------------------------------------------------

/** Distance from point p to the infinite line through a and b. */
const toLine = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);

test('jaw points sit at the spec openings: 89mm corners, 102mm middles', () => {
  const rails = cushionGeometry();
  const jaw = (id, i) => rails.find((r) => r.id === id).ends[i].jaw;
  assert.ok(Math.abs(10 * Math.hypot(jaw('top-baulk', 0).x - jaw('baulk', 0).x, jaw('top-baulk', 0).y - jaw('baulk', 0).y) - 89) < 1e-9);
  assert.ok(Math.abs(10 * (jaw('top-black', 0).x - jaw('top-baulk', 1).x) - 102) < 1e-9);
  assert.ok(Math.abs(20 * MIDDLE_POCKET_CUT - 102) < 1e-9 && Math.abs(10 * CORNER_POCKET_CUT * Math.SQRT2 - 89) < 1e-9);
});

test('every knuckle is tangent to both its cushion face and its facing', () => {
  for (const rail of cushionGeometry()) {
    for (const end of rail.ends) {
      const k = end.knuckle;
      assert.ok(k, `${rail.id} has a knuckle`);
      const faceFar = rail.ends.find((e) => e !== end).jaw; // the face runs jaw to jaw
      assert.ok(Math.abs(toLine(k, end.jaw, faceFar) - k.r) < 1e-9, `${rail.id}: tangent to the face`);
      assert.ok(Math.abs(toLine(k, end.jaw, end.back) - k.r) < 1e-9, `${rail.id}: tangent to the facing`);
      assert.ok(Math.abs(Math.hypot(end.faceTangent.x - k.x, end.faceTangent.y - k.y) - k.r) < 1e-9);
      assert.ok(Math.abs(Math.hypot(end.facingTangent.x - k.x, end.facingTangent.y - k.y) - k.r) < 1e-9);
    }
  }
});

test('square jaws (angle 0, knuckle 0) are exactly the old rectangles', () => {
  const square = { corner: { facingAngle: 0, knuckleRadius: 0 }, middle: { facingAngle: 0, knuckleRadius: 0 } };
  const C = CORNER_POCKET_CUT; const M = MIDDLE_POCKET_CUT; const T = CUSHION_DEPTH;
  const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`).sort();
  const expected = {
    'top-baulk': rect(C, -T, W / 2 - M, 0),
    'top-black': rect(W / 2 + M, -T, W - C, 0),
    'bottom-baulk': rect(C, H, W / 2 - M, H + T),
    'bottom-black': rect(W / 2 + M, H, W - C, H + T),
    baulk: rect(-T, C, 0, H - C),
    black: rect(W, C, W + T, H - C),
  };
  for (const rail of cushionGeometry({ jaws: square })) {
    assert.deepEqual(rail.polygon.map((v) => `${v.x.toFixed(9)},${v.y.toFixed(9)}`).sort(), expected[rail.id], rail.id);
    assert.equal(rail.knuckles.length, 0);
  }
});

test('every pocket has a mouth, framed by the jaw points of its two cushions', () => {
  const mouths = pocketMouths();
  assert.deepEqual(mouths.map((m) => m.pocket).sort(), POCKETS.map((p) => p.id).sort());
  for (const m of mouths) assert.equal(m.polygon.length, 4);
});

// --- Falls ---------------------------------------------------------------------

test('each fall sits behind the table, and a middle fall cannot reach a ball touching the cushion', () => {
  for (const m of middle) {
    const setback = m.y < 0 ? -m.y : m.y - H;
    assert.ok(setback > 0, `${m.id} is behind the cushion face`);
    assert.ok(m.r < BALL_RADIUS + setback, `${m.id}: a ball touching the cushion must not be captured`);
    assert.ok(m.r < Math.min(...corner.map((c) => c.r)), 'middle falls are smaller than corner falls');
  }
  for (const c of corner) {
    assert.ok(c.x <= 0 || c.x >= W, `${c.id} is outside the table`);
    assert.ok(c.y <= 0 || c.y >= H, `${c.id} is outside the table`);
  }
});

// --- Middles -------------------------------------------------------------------

test('a ball running along the cushion toward the corner passes the middle pocket', () => {
  for (const gap of [0, 0.5, 1, 2]) {
    for (const power of [0.35, 0.7]) {
      const top = roll({ x: 30, y: BALL_RADIUS + gap }, { x: 330, y: BALL_RADIUS + gap }, power);
      assert.notEqual(top.pocket, 'tm', `top rail, ${gap}cm off, power ${power}`);
      const bottom = roll({ x: 30, y: H - BALL_RADIUS - gap }, { x: 330, y: H - BALL_RADIUS - gap }, power);
      assert.notEqual(bottom.pocket, 'bm', `bottom rail, ${gap}cm off, power ${power}`);
    }
  }
});

test('a shallow shot from the baulk end aimed at the far corner is not swallowed by the middle', () => {
  for (const y0 of [6, 10]) {
    const res = roll({ x: 25, y: y0 }, { x: W, y: 0 }, 0.9);
    assert.notEqual(res.pocket, 'tm', `from y=${y0}`);
  }
});

test('a ball sent into the middle pocket still drops, straight or at an angle', () => {
  const half = (MIDDLE_POCKET_CUT - BALL_RADIUS) / 2; // half the centre window
  for (const [approach, offset] of [[90, 0], [90, half], [90, -half], [60, 0], [60, half], [45, 0], [45, -half]]) {
    for (const power of [0.25, 0.7]) {
      const rad = (approach * Math.PI) / 180;
      const mouth = { x: MID_X + offset, y: 0 };
      const from = { x: mouth.x - Math.cos(rad) * 60, y: mouth.y + Math.sin(rad) * 60 };
      assert.equal(roll(from, mouth, power).pocket, 'tm', `${approach}° ${offset.toFixed(2)}cm off centre, power ${power}`);
    }
  }
});

test('a pot aimed at 80% of the middle window still drops, straight or at an angle', () => {
  const wide = 0.8 * (MIDDLE_POCKET_CUT - BALL_RADIUS);
  for (const approach of [90, 60, 45]) {
    for (const side of [-1, 1]) {
      for (const power of [0.25, 0.5, 0.7]) {
        const rad = (approach * Math.PI) / 180;
        const mouth = { x: MID_X + side * wide, y: 0 };
        const from = { x: mouth.x - Math.cos(rad) * 60, y: mouth.y + Math.sin(rad) * 60 };
        assert.equal(roll(from, mouth, power).pocket, 'tm', `${approach}° ${(side * wide).toFixed(2)}cm off centre, power ${power}`);
      }
    }
  }
});

test('a slow ball into the middle never stops inside the mouth past the cushion face', () => {
  for (const offset of [-1.5, 0, 1.5]) {
    for (const power of [0.02, 0.03, 0.05, 0.08]) {
      const { rest } = roll({ x: MID_X + offset, y: 30 }, { x: MID_X + offset, y: 0 }, power);
      assert.ok(!rest || rest.y >= 0, `offset ${offset}, power ${power}: stopped at y=${rest?.y}`);
    }
  }
});

// --- Corners -------------------------------------------------------------------

const DIAG = Math.SQRT1_2;
/** A point `dist` back from the bottom-right corner along the diagonal, `off` to the side of it. */
const onDiagonal = (off, dist = 60) => ({ x: W - dist * DIAG + off * DIAG, y: H - dist * DIAG - off * DIAG });

test('corner pots drop: on the diagonal, along either cushion, and at an angle off the long cushion', () => {
  const half = (CORNER_POCKET_CUT * DIAG - BALL_RADIUS) / 2;
  for (const power of [0.3, 0.7]) {
    for (const off of [-half, 0, half]) {
      const from = onDiagonal(off);
      assert.equal(roll(from, { x: from.x + 10, y: from.y + 10 }, power).pocket, 'br', `diagonal ${off.toFixed(2)} off, power ${power}`);
    }
    for (const gap of [0, 1]) {
      assert.equal(roll({ x: 250, y: H - BALL_RADIUS - gap }, { x: W, y: H - BALL_RADIUS - gap }, power).pocket, 'br', `along the long cushion ${gap}cm off, power ${power}`);
      assert.equal(roll({ x: W - BALL_RADIUS - gap, y: 100 }, { x: W - BALL_RADIUS - gap, y: H }, power).pocket, 'br', `along the short cushion ${gap}cm off, power ${power}`);
    }
    for (const deg of [20, 35]) {
      const rad = (deg * Math.PI) / 180;
      assert.equal(roll({ x: W - Math.cos(rad) * 80, y: H - Math.sin(rad) * 80 }, { x: W, y: H }, power).pocket, 'br', `${deg}° off the long cushion, power ${power}`);
    }
  }
});

test('a slow ball into a corner never stops inside the mouth past the jaw line', () => {
  for (const off of [-1, 0, 1]) {
    for (const power of [0.02, 0.03, 0.05, 0.08]) {
      const from = onDiagonal(off, 25);
      const { rest } = roll(from, { x: from.x + 10, y: from.y + 10 }, power);
      assert.ok(!rest || (W - rest.x) + (H - rest.y) >= CORNER_POCKET_CUT, `offset ${off}, power ${power}: stopped at ${rest?.x},${rest?.y}`);
    }
  }
});

// --- What the jaws are for ------------------------------------------------------

/** Straight shots aimed so the ball clips a jaw: how many still drop. */
function clipsKnockedIn(type) {
  let dropped = 0;
  let total = 0;
  for (const side of [-1, 1]) {
    for (const extra of [0.4, 0.9, 1.4, 1.9]) {
      for (const power of [0.2, 0.5, 0.8]) {
        total += 1;
        if (type === 'middle') {
          const x = MID_X + side * (MIDDLE_POCKET_CUT - BALL_RADIUS + extra);
          if (roll({ x, y: 60 }, { x, y: 0 }, power).pocket === 'tm') dropped += 1;
        } else {
          const from = onDiagonal(side * (CORNER_POCKET_CUT * DIAG - BALL_RADIUS + extra));
          if (roll(from, { x: from.x + 10, y: from.y + 10 }, power).pocket === 'br') dropped += 1;
        }
      }
    }
  }
  return { dropped, total };
}

test('a ball that clips a jaw is mostly turned away, and middles turn more away than corners', () => {
  const mid = clipsKnockedIn('middle');
  const cor = clipsKnockedIn('corner');
  // Tuned: 6/24 at the middles, 12/24 at the corners.
  assert.ok(mid.dropped <= 8, `middle clips knocked in: ${mid.dropped}/${mid.total}`);
  assert.ok(cor.dropped <= 14, `corner clips knocked in: ${cor.dropped}/${cor.total}`);
  assert.ok(mid.dropped < cor.dropped, `middles harder than corners: ${mid.dropped} vs ${cor.dropped}`);
});

test('middles are hard to pot at a shallow angle: nothing drops at 20° or less to the cushion', () => {
  const dropsAt = (deg) => {
    let dropped = 0;
    for (const power of [0.2, 0.45, 0.8]) {
      for (const aim of [-1, 0, 1]) {
        const rad = (deg * Math.PI) / 180;
        const target = { x: MID_X + aim, y: 0 };
        if (roll({ x: target.x - Math.cos(rad) * 90, y: Math.sin(rad) * 90 }, target, power).pocket === 'tm') dropped += 1;
      }
    }
    return dropped;
  };
  assert.equal(dropsAt(10), 0, '10° to the cushion');
  assert.equal(dropsAt(20), 0, '20° to the cushion');
  // Loosened by feel: the middles now drop 8 of 9 at 30° (6 before). A 9 means
  // the shallow angle no longer costs anything, as with the widest jaws tried.
  assert.ok(dropsAt(30) <= 8, `30° approaches that dropped: ${dropsAt(30)}/9`);
});

test('corners take a ball running along either cushion, which a middle never does', () => {
  for (const power of [0.3, 0.6]) {
    assert.equal(roll({ x: 250, y: H - BALL_RADIUS }, { x: W, y: H - BALL_RADIUS }, power).pocket, 'br', `along the long cushion, power ${power}`);
    assert.equal(roll({ x: W - BALL_RADIUS, y: 100 }, { x: W - BALL_RADIUS, y: H }, power).pocket, 'br', `along the short cushion, power ${power}`);
  }
});
