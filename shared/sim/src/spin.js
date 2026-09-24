/**
 * Cue ball spin: follow/draw (top/back) and side.
 *
 * Matter.js only knows rotation in the table's plane, so spin is modelled
 * here, next to it, for the cue ball only:
 *
 *   roll `r`  the speed the ball's surface would carry it at if it rolled
 *             (cm/s, a vector on the table). A ball with r = v is rolling
 *             naturally; r ≠ v means it is sliding, and cloth friction pulls v
 *             and r together (v by μg·dt, r by 5/2 of that — a solid sphere)
 *             until it rolls. Hit below centre and r starts backwards: the
 *             cue ball stops dead on the object ball, then the leftover
 *             backspin pulls it back (draw). Above centre: it runs on (follow).
 *             A collision changes v, never r, which is exactly what makes both.
 *   side `w`  spin about the vertical (cm/s at the ball's equator). It does
 *             nothing on the cloth but wear off; at a cushion the cushion
 *             grips the spinning ball and pushes it sideways, and uses up
 *             some of the side. No throw, no swerve, no squirt (decided Sep 24).
 *
 * Spin is {x, y} on the cue ball's face, as the player sees it: x right,
 * y up, each in [-1, 1] and at most MAX_OFFSET from the centre. y > 0 follow,
 * y < 0 draw, x > 0 right-hand side.
 *
 * A shot with no spin, or spin {0, 0}, never creates any of this, so it plays
 * exactly as it did before spin existed (test/zeroSpin.test.js).
 */

export const SPIN = {
  /** Furthest the tip may land from the centre, as a fraction of the widget's radius. */
  maxOffset: 0.8,
  /**
   * Roll speed at strike, per unit of spin.y, as a fraction of the strike
   * speed. Tuned Sep 24 (scratchpad spintune/grid): max draw at full power,
   * object ball 50cm away, brings the cue ball back ~89cm; ~69cm from 150cm.
   */
  topGain: 1.0,
  /** Extra factor on follow only (y > 0), to tune follow by feel apart from draw. */
  followScale: 1.0,
  /** Side speed at strike, per unit of spin.x, as a fraction of the strike speed. */
  sideGain: 1.25,
  /** Cloth sliding friction μg (cm/s²). Sets how soon a sliding ball starts to roll. */
  slipDecel: 90,
  /** Below this slip (cm/s) the ball is rolling: r just follows v. */
  rollEps: 0.5,
  /** Side lost on the cloth, per second (exponential). */
  sideDecay: 0.35,
  /** At a cushion: the share of the side speed turned into sideways speed. */
  cushionGrip: 0.18,
  /** …and the share of the side the cushion uses up. */
  cushionSideLoss: 0.5,
};

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The spin to play, or null for none. Out-of-range spin is pulled back to
 * the edge (the server rejects it before it gets here; this is the backstop).
 */
export function normaliseSpin(spin) {
  if (!spin || !finite(spin.x) || !finite(spin.y)) return null;
  if (spin.x === 0 && spin.y === 0) return null;
  const len = Math.hypot(spin.x, spin.y);
  const k = len > SPIN.maxOffset ? SPIN.maxOffset / len : 1;
  return { x: spin.x * k, y: spin.y * k };
}

/**
 * Spin state for one cue ball, from the strike.
 * @param {{x:number,y:number}} spin  normalised (normaliseSpin)
 * @param {number} angle              shot direction
 * @param {number} speed              strike speed, cm/s
 */
export function createSpin(spin, angle, speed) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const roll = spin.y * SPIN.topGain * (spin.y > 0 ? SPIN.followScale : 1) * speed;
  return {
    rx: ux * roll,
    ry: uy * roll,
    w: spin.x * SPIN.sideGain * speed,
    cushion: null, // a cushion normal seen this step, applied after the solve
  };
}

/** Is the ball still sliding, i.e. is there spin left to turn into motion? */
export const sliding = (s, vx, vy) => Math.hypot(vx - s.rx, vy - s.ry) > SPIN.rollEps;

/**
 * One step on the cloth, after Matter has moved and collided the ball.
 * @param {object} s  spin state (mutated)
 * @param {number} vx cm/s
 * @param {number} vy cm/s
 * @param {number} dt seconds
 * @returns {[number, number]} the new velocity, cm/s
 */
export function clothStep(s, vx, vy, dt) {
  // A cushion hit this step: side grips and kicks the ball along the cushion,
  // and the roll bounces with the ball (its component into the cushion flips).
  if (s.cushion) {
    const { nx, ny } = s.cushion; // unit, from the cushion towards the ball
    s.cushion = null;
    // perp(n) = (-ny, nx): with y down the screen, positive w (right-hand side)
    // pushes the ball to the shooter's left on a straight-in hit, as it should.
    const kick = SPIN.cushionGrip * s.w;
    vx += -ny * kick;
    vy += nx * kick;
    s.w *= 1 - SPIN.cushionSideLoss;
    const into = s.rx * nx + s.ry * ny;
    if (into < 0) {
      s.rx -= 2 * into * nx;
      s.ry -= 2 * into * ny;
    }
  }

  s.w *= Math.exp(-SPIN.sideDecay * dt);

  const sx = vx - s.rx;
  const sy = vy - s.ry;
  const slip = Math.hypot(sx, sy);
  if (slip <= SPIN.rollEps) {
    s.rx = vx;
    s.ry = vy;
    return [vx, vy];
  }
  // Friction against the slip: v loses dv, r gains 5/2 dv, so the slip closes
  // by 7/2 dv. Never past zero: that is rolling, and the next step locks it.
  const dv = Math.min(SPIN.slipDecel * dt, (slip * 2) / 7);
  const ex = sx / slip;
  const ey = sy / slip;
  s.rx += ex * dv * 2.5;
  s.ry += ey * dv * 2.5;
  return [vx - ex * dv, vy - ey * dv];
}
