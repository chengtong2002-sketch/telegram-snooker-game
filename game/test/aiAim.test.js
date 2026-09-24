import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseShot, newMatch } from '@snooker/sim';
import { planAiAim, runAiAim, MIN_AIM_MS, MAX_AIM_MS } from '../src/aiAim.js';

/** A small seeded generator, so every case below is repeatable. */
function rng(seed) {
  let s = Math.imul(seed, 2654435761) >>> 0; // spread small seeds apart
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Run the aim on a fake 60fps clock; returns the shot handed back and every pose shown. */
async function play(shot, { fromAngle = 0, fromPower = 0.02, seed = 1 } = {}) {
  let t = 0;
  const poses = [];
  const back = await runAiAim({
    shot, fromAngle, fromPower, rng: rng(seed),
    onPose: (p) => poses.push({ ...p, t }),
    now: () => t,
    nextFrame: (cb) => { t += 1000 / 60; cb(); },
  });
  return { back, poses, elapsed: t };
}

test("the AI's shot comes back exactly as chosen: same object, same values", async () => {
  const frame = newMatch([1, 'ai']).frame;
  for (let seed = 1; seed <= 25; seed += 1) {
    const shot = chooseShot(frame, { difficulty: 'normal' });
    const before = structuredClone(shot);
    Object.freeze(shot); // a write anywhere in the aim would throw
    if (shot.cuePlacement) Object.freeze(shot.cuePlacement);
    const { back, poses } = await play(shot, { fromAngle: seed - 12, seed });
    assert.equal(back, shot);
    assert.deepEqual(back, before);
    const last = poses.at(-1);
    assert.equal(last.angle, shot.angle, 'final angle is the decision, bit for bit');
    assert.equal(last.power, shot.power, 'final power is the decision, bit for bit');
    assert.deepEqual(last.cue, shot.cuePlacement ?? null);
  }
});

test('the aim takes 1.5–2.5 s, varies, and ends on a held pause', async () => {
  const durations = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    const plan = planAiAim({ fromAngle: 0, toAngle: 1, fromPower: 0.02, toPower: 0.7, rng: rng(seed) });
    assert.ok(plan.duration >= MIN_AIM_MS && plan.duration <= MAX_AIM_MS, `${plan.duration}`);
    durations.add(Math.round(plan.duration / 50));
    // The last stretch is still: at least a fifth of it.
    const settled = Math.max(plan.rotateEnd, plan.powerEnd);
    assert.ok(plan.duration - settled >= plan.duration * 0.19);
    for (let t = settled; t <= plan.duration; t += 25) assert.deepEqual(plan.at(t), { angle: 1, power: 0.7 });
  }
  assert.ok(durations.size > 10, 'randomised');
  const { elapsed } = await play({ angle: 1, power: 0.5 });
  assert.ok(elapsed >= MIN_AIM_MS && elapsed <= MAX_AIM_MS + 20);
});

test('the cue swings smoothly, overshoots a little, and the power fills', () => {
  let overshot = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    const plan = planAiAim({ fromAngle: 0, toAngle: 1.2, fromPower: 0.02, toPower: 0.8, rng: rng(seed) });
    let prev = plan.at(0);
    assert.equal(prev.angle, 0, 'starts from where the cue was');
    let max = 0;
    for (let t = 16; t <= plan.duration; t += 16) {
      const p = plan.at(t);
      assert.ok(Math.abs(p.angle - prev.angle) < 0.12, `jump at ${t}ms: ${prev.angle} → ${p.angle}`);
      assert.ok(p.power >= 0.02 && p.power <= 1);
      max = Math.max(max, p.angle);
      prev = p;
    }
    if (max > 1.2) overshot += 1;
    assert.ok(max < 1.2 + 0.1, 'overshoot stays small');
    assert.ok(plan.at(plan.duration * 0.2).power < 0.1, 'power fills later, not at once');
  }
  assert.ok(overshot >= 25, `overshoot on most swings (${overshot}/30)`);
});

test('the swing takes the short way round ±π', () => {
  const plan = planAiAim({ fromAngle: 3.0, toAngle: -3.0, fromPower: 0.02, toPower: 0.5, rng: rng(3) });
  for (let t = 0; t <= plan.duration; t += 16) {
    const { angle } = plan.at(t);
    assert.ok(angle > 2.8 || angle < -2.8, `went the long way: ${angle} at ${t}`);
  }
});

test('a cancelled aim still hands the shot back untouched', async () => {
  const shot = Object.freeze({ angle: 0.4, power: 0.3 });
  let t = 0;
  let frames = 0;
  const back = await runAiAim({
    shot, fromAngle: 0, fromPower: 0.02, rng: rng(9), onPose: () => {},
    now: () => t, nextFrame: (cb) => { t += 16; frames += 1; cb(); },
    cancelled: () => frames >= 5,
  });
  assert.equal(back, shot);
  assert.ok(t < 200);
});
