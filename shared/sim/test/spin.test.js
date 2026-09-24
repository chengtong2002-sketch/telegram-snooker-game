import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateShot, createSimulation, normaliseSpin, SPIN, CENTRE_Y, TABLE, POCKETS,
} from '../src/index.js';

/**
 * Straight shot along +x on the centre line, red `gap` cm ahead of the cue
 * ball. Returns how far the cue ball came back / ran on past the contact,
 * measured until the red returns from the far cushion.
 */
function straight({ gap = 50, power = 1, spin }) {
  const sim = createSimulation(
    [{ id: 'cue', x: 200 - gap, y: CENTRE_Y }, { id: 'red1', x: 200, y: CENTRE_Y }],
    { angle: 0, power, spin },
  );
  let at = null;
  let min = Infinity;
  let max = -Infinity;
  let redBack = false;
  while (!sim.done) {
    sim.step();
    const [cue, red] = sim.balls();
    if (at === null && sim.firstContact) at = cue.x;
    if (red.x > TABLE.width - 20) redBack = true;
    if (redBack && red.x < cue.x + 40) break;
    if (at !== null) {
      min = Math.min(min, cue.x);
      max = Math.max(max, cue.x);
    }
  }
  return { back: at - min, on: max - at };
}

/** Straight into the top cushion; the rebound's angle off straight back, degrees, + = towards +x. */
function rebound(x, power = 0.5) {
  const sim = createSimulation([{ id: 'cue', x: 120, y: 60 }], { angle: -Math.PI / 2, power, spin: { x, y: 0 } });
  let hit = null;
  let later = null;
  while (!sim.done && !later) {
    sim.step();
    const c = sim.balls()[0];
    if (!hit && sim.events.some((e) => e.type === 'cushion')) hit = { x: c.x, y: c.y };
    if (hit && c.y > hit.y + 30) later = { x: c.x, y: c.y };
  }
  return (Math.atan2(later.x - hit.x, later.y - hit.y) * 180) / Math.PI;
}

test('normaliseSpin: none for missing, zero or garbage; pulled back to the edge', () => {
  assert.equal(normaliseSpin(undefined), null);
  assert.equal(normaliseSpin({ x: 0, y: 0 }), null);
  assert.equal(normaliseSpin({ x: NaN, y: 0.2 }), null);
  assert.equal(normaliseSpin({ x: '0.3', y: 0 }), null);
  assert.deepEqual(normaliseSpin({ x: 0.3, y: -0.2 }), { x: 0.3, y: -0.2 });
  const edge = normaliseSpin({ x: 3, y: 4 });
  assert.ok(Math.abs(Math.hypot(edge.x, edge.y) - SPIN.maxOffset) < 1e-12);
  assert.ok(Math.abs(edge.x / edge.y - 0.75) < 1e-12, 'same direction');
});

test('spin shots are deterministic, stepped or drained', () => {
  const balls = [{ id: 'cue', x: 100, y: 70 }, { id: 'red1', x: 160, y: 80 }, { id: 'black', x: 300, y: 90 }];
  const shot = { angle: 0.12, power: 0.8, spin: { x: -0.35, y: -0.6 } };
  const a = simulateShot(balls, shot);
  const b = simulateShot(balls, shot);
  assert.deepStrictEqual(a, b);
  const sim = createSimulation(balls, shot);
  while (!sim.done) sim.step();
  assert.deepStrictEqual(sim.result(), a);
});

test('draw: the cue ball stops on the red, then comes back (targets: 60–90cm at full, red 50cm away)', () => {
  const stun = straight({});
  const draw = straight({ spin: { x: 0, y: -0.8 } });
  assert.ok(stun.back < 1, `a centre-ball hit does not come back (${stun.back})`);
  assert.ok(draw.back >= 60 && draw.back <= 90, `max draw came back ${draw.back.toFixed(1)}cm`);
  assert.ok(draw.on < 1, 'and never ran on first');
  const less = straight({ spin: { x: 0, y: -0.4 } }).back;
  assert.ok(less > 5 && less < draw.back, `less draw, less back (${less.toFixed(1)})`);
  const soft = straight({ power: 0.5, spin: { x: 0, y: -0.8 } }).back;
  assert.ok(soft > 5 && soft < draw.back, `softer, less back (${soft.toFixed(1)})`);
});

test('draw wears off with the distance to the object ball', () => {
  const near = straight({ gap: 50, spin: { x: 0, y: -0.8 } }).back;
  const far = straight({ gap: 150, spin: { x: 0, y: -0.8 } }).back;
  const veryFar = straight({ gap: 200, spin: { x: 0, y: -0.8 } }).back;
  assert.ok(far < near && veryFar < far, `${near.toFixed(1)} > ${far.toFixed(1)} > ${veryFar.toFixed(1)}`);
});

test('follow: the cue ball runs on after the red, more with more top', () => {
  // Pot towards a corner so the red does not come back into the measurement.
  const p = POCKETS.find((q) => q.id === 'tr');
  const dir = Math.atan2(p.y - CENTRE_Y, p.x - TABLE.width / 2);
  const run = (y, power = 0.6) => {
    const red = { id: 'red1', x: p.x - Math.cos(dir) * 120, y: p.y - Math.sin(dir) * 120 };
    const cue = { id: 'cue', x: red.x - Math.cos(dir) * 50, y: red.y - Math.sin(dir) * 50 };
    const sim = createSimulation([cue, red], { angle: dir, power, spin: y ? { x: 0, y } : undefined });
    let at = null;
    let far = 0;
    while (!sim.done) {
      sim.step();
      const c = sim.balls()[0];
      if (!at && sim.firstContact) at = { x: c.x, y: c.y };
      if (at) far = Math.max(far, (c.x - at.x) * Math.cos(dir) + (c.y - at.y) * Math.sin(dir));
    }
    return far;
  };
  const stun = run(0);
  const some = run(0.3);
  const lots = run(0.8);
  assert.ok(stun < 10, `stun ${stun.toFixed(1)}`);
  assert.ok(some > stun + 20 && lots > some, `${stun.toFixed(1)} < ${some.toFixed(1)} < ${lots.toFixed(1)}`);
});

test('side: left and right mirror each other at the cushion, none goes straight back', () => {
  const none = rebound(0);
  const right = rebound(0.8);
  const left = rebound(-0.8);
  assert.ok(Math.abs(none) < 0.01, `no side: ${none}`);
  // Right-hand side, straight up the table into the cushion, comes back to the shooter's left (−x).
  assert.ok(right < -8 && right > -25, `right side: ${right.toFixed(1)}°`);
  assert.ok(Math.abs(right + left) < 0.05, `mirror: ${right.toFixed(2)} / ${left.toFixed(2)}`);
  assert.ok(Math.abs(rebound(0.4)) < Math.abs(right), 'less side, less kick');
});

test('side does nothing before a cushion: the cue ball runs straight', () => {
  const sim = createSimulation([{ id: 'cue', x: 60, y: CENTRE_Y }], { angle: 0, power: 0.3, spin: { x: 0.8, y: 0 } });
  let hitCushion = false;
  while (!sim.done && !hitCushion) {
    sim.step();
    hitCushion = sim.events.some((e) => e.type === 'cushion');
    if (!hitCushion) assert.equal(sim.balls()[0].y, CENTRE_Y);
  }
});

test('a stunned cue ball with draw left is not parked: the shot runs until it has come back', () => {
  // Soft enough that the cue ball is nearly dead at contact.
  const res = straight({ power: 0.35, gap: 20, spin: { x: 0, y: -0.8 } });
  assert.ok(res.back > 3, `came back ${res.back.toFixed(1)}cm`);
});
