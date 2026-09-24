import { angleDelta } from './aimSync.js';

/**
 * The practice AI "lining up": before it shoots, its cue swings from where it
 * was to the angle it already chose, with a little overshoot and wobble, the
 * power bar fills, a short pause, then the shot.
 *
 * Purely a show. The shot is chosen first (chooseShot) and handed back
 * untouched; the plan's last pose is exactly its angle and power.
 */

export const MIN_AIM_MS = 1500;
export const MAX_AIM_MS = 2500;
const MIN_POWER = 0.02; // same floor as the meter

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (u) => u * u * (3 - 2 * u);           // ease in-out
const easeOut = (u) => 1 - (1 - u) ** 3;

/**
 * @param {{fromAngle:number, toAngle:number, fromPower:number, toPower:number, rng?:() => number}} o
 * @returns {{duration:number, rotateEnd:number, powerEnd:number, at:(ms:number) => {angle:number, power:number}}}
 */
export function planAiAim({ fromAngle, toAngle, fromPower, toPower, rng = Math.random }) {
  const duration = MIN_AIM_MS + rng() * (MAX_AIM_MS - MIN_AIM_MS);
  const appear = 120 + rng() * 120;                    // the cue shows, still
  const rotateEnd = duration * (0.55 + rng() * 0.1);   // swung round and settled
  const powerStart = duration * (0.3 + rng() * 0.1);
  const powerEnd = duration * (0.72 + rng() * 0.08);   // then the pause until `duration`

  const delta = angleDelta(fromAngle, toAngle);
  const dir = delta === 0 ? (rng() < 0.5 ? -1 : 1) : Math.sign(delta);
  // Past the target and back: more on a big swing, never a silly amount.
  const overshoot = dir * Math.min(0.09, 0.006 + Math.abs(delta) * (0.04 + rng() * 0.05));
  const wobbleAmp = 0.003 + rng() * 0.006;
  const wobbleHz = 2.2 + rng() * 1.6;
  const wobblePhase = rng() * Math.PI * 2;
  const powerJitter = (rng() - 0.5) * 0.04;

  const from = clamp(fromPower, MIN_POWER, 1);
  const to = toPower;

  function at(ms) {
    if (ms >= powerEnd && ms >= rotateEnd) return { angle: toAngle, power: toPower };

    let angle;
    if (ms <= appear) angle = fromAngle;
    else if (ms >= rotateEnd) angle = toAngle;
    else {
      const u = (ms - appear) / (rotateEnd - appear);
      // Main swing, plus a hump that carries it past the target late in the
      // swing and brings it back by u = 1, plus a hand tremor that dies away.
      const hump = Math.sin(Math.PI * u ** 1.6) * smooth(u);
      const tremor = wobbleAmp * Math.sin(wobblePhase + (ms / 1000) * wobbleHz * Math.PI * 2) * (1 - u) ** 2 * Math.sin(Math.PI * u);
      angle = fromAngle + delta * easeOut(u) + overshoot * hump + tremor;
    }

    let power;
    if (ms <= powerStart) power = from;
    else if (ms >= powerEnd) power = to;
    else {
      const u = (ms - powerStart) / (powerEnd - powerStart);
      // A slightly uneven pull: overshoots or undershoots a touch mid-fill, lands exactly.
      power = clamp(from + (to - from) * smooth(u) + powerJitter * Math.sin(Math.PI * u), MIN_POWER, 1);
    }
    return { angle, power };
  }

  return { duration, rotateEnd, powerEnd, at };
}

/**
 * Play the plan out, a display frame at a time, then hand back `shot` —
 * the very object that came in, never a copy or a tweak.
 *
 * @param {object} o
 * @param {{angle:number, power:number, cuePlacement?:{x:number,y:number}}} o.shot  the AI's decision
 * @param {(pose:{angle:number, power:number, cue:object|null}) => void} o.onPose
 * @returns {Promise<object>} `shot`
 */
export async function runAiAim({
  shot, fromAngle, fromPower, onPose, rng = Math.random,
  now = () => performance.now(),
  nextFrame = (cb) => requestAnimationFrame(cb),
  cancelled = () => false,
}) {
  const plan = planAiAim({ fromAngle, toAngle: shot.angle, fromPower, toPower: shot.power, rng });
  const cue = shot.cuePlacement ?? null;
  const start = now();
  for (;;) {
    if (cancelled()) return shot;
    const t = now() - start;
    onPose({ ...plan.at(Math.min(t, plan.duration)), cue });
    if (t >= plan.duration) return shot;
    await new Promise((r) => nextFrame(r));
  }
}
