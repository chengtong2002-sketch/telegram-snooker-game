import { POCKETS, BALL_DIAMETER, TABLE } from './constants.js';
import { cueBall, nextColourOn } from './state.js';
import { defaultCuePlacement } from './rules.js';

const isRed = (id) => id.startsWith('red');

/** Balls the AI is allowed to strike first, given the current ball-on. */
export function legalTargets(state) {
  const live = state.balls.filter((b) => !b.potted && b.id !== 'cue');
  if (state.phase === 'respotted-black') return live.filter((b) => b.id === 'black');
  if (state.phase === 'colours') {
    const on = nextColourOn(state);
    return live.filter((b) => b.id === on);
  }
  if (state.ballOn === 'red') return live.filter((b) => isRed(b.id));
  return live.filter((b) => !isRed(b.id));
}

function pathBlocked(state, from, to, ignoreIds) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return state.balls.some((b) => {
    if (b.potted || ignoreIds.includes(b.id)) return false;
    const t = (b.x - from.x) * ux + (b.y - from.y) * uy;
    if (t <= 0 || t >= len) return false;
    const perp = Math.abs((b.x - from.x) * -uy + (b.y - from.y) * ux);
    return perp < BALL_DIAMETER * 0.95;
  });
}

/**
 * Practice-mode opponent: pick the nearest legal ball, aim it at the best
 * pocket, then miss a bit. Deliberately simple — this is not a snooker engine,
 * and practice results are never crypto-eligible.
 *
 * With the ball in hand the AI takes the legal spot defaultCuePlacement picks,
 * aims from there, and sends it as the placement.
 *
 * @param {object} state    frame state
 * @param {{difficulty?:'easy'|'normal'|'hard', rng?:() => number}} [opts]
 * @returns {{angle:number, power:number, target:string|null, pocket:string|null, cuePlacement?:{x,y}}}
 */
export function chooseShot(state, opts = {}) {
  const difficulty = opts.difficulty ?? 'normal';
  const rng = opts.rng ?? Math.random;
  const spread = { easy: 0.075, normal: 0.038, hard: 0.016 }[difficulty] ?? 0.038;

  const placement = state.inHand ? defaultCuePlacement(state) : null;
  const cue = placement ?? cueBall(state);
  const placed = (shot) => (placement ? { ...shot, cuePlacement: placement } : shot);
  const targets = legalTargets(state);

  if (targets.length === 0) {
    return placed({ angle: rng() * Math.PI * 2, power: 0.4, target: null, pocket: null });
  }

  const sorted = [...targets].sort(
    (a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y),
  );

  let best = null;
  // Only consider the few nearest balls; the AI is not supposed to find the
  // clever long pot across the table.
  for (const ball of sorted.slice(0, 4)) {
    for (const pocket of POCKETS) {
      const px = pocket.x;
      const py = pocket.y;
      const toPocket = Math.hypot(px - ball.x, py - ball.y);
      const ux = (px - ball.x) / toPocket;
      const uy = (py - ball.y) / toPocket;
      const ghost = { x: ball.x - ux * BALL_DIAMETER, y: ball.y - uy * BALL_DIAMETER };

      const toGhost = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
      if (toGhost < 1) continue;

      // Cut angle: 1 is a straight pot, 0 is a right-angle cut (impossible).
      const cut = ((ghost.x - cue.x) / toGhost) * ux + ((ghost.y - cue.y) / toGhost) * uy;
      if (cut <= 0.12) continue;
      if (pathBlocked(state, cue, ghost, ['cue', ball.id])) continue;
      if (pathBlocked(state, ball, { x: px, y: py }, [ball.id, 'cue'])) continue;

      const score = cut * 2 - (toGhost + toPocket) / (TABLE.width * 2);
      if (!best || score > best.score) {
        best = { score, angle: Math.atan2(ghost.y - cue.y, ghost.x - cue.x), dist: toGhost + toPocket, target: ball.id, pocket: pocket.id };
      }
    }
  }

  if (!best) {
    // Nothing on: play a safe-ish nudge at the nearest legal ball.
    const ball = sorted[0];
    const angle = Math.atan2(ball.y - cue.y, ball.x - cue.x) + (rng() - 0.5) * spread * 2;
    return placed({ angle, power: 0.35, target: ball.id, pocket: null });
  }

  const angle = best.angle + (rng() - 0.5) * 2 * spread;
  const power = Math.min(0.95, 0.34 + best.dist / (TABLE.width * 1.6));
  return placed({ angle, power, target: best.target, pocket: best.pocket });
}
