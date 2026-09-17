// All lengths in centimetres, matching a full-size 12ft snooker table.
// The client renders these scaled to the canvas; the server never scales at all.

export const TABLE = {
  // Playing surface inside the cushions.
  width: 356.9,   // 11ft 8.5in, baulk end (x=0) to black end (x=width)
  height: 177.8,  // 5ft 10in
};

export const BALL_RADIUS = 2.625;   // 52.5mm diameter
export const BALL_DIAMETER = BALL_RADIUS * 2;

/**
 * Pocket geometry, to the snooker spec: corner opening 89mm and middle opening
 * 102mm, measured between the jaw points (where each facing meets the cushion
 * face). Middles are wider than corners on a real table but play harder, and
 * here that comes from the jaw shape and the depth of the fall.
 *
 *   CUT     how far along the face from the pocket each cushion's jaw point is.
 *           Corner opening = CUT·√2 (across the corner); middle = 2·CUT.
 *   JAWS    facing angle and knuckle radius per pocket type (see table.js).
 *   POCKETS the fall: a ball whose centre comes within r of the point drops.
 *
 * The falls sit behind the jaws, so a ball has to get past the facings to drop.
 * A ball that clips a knuckle and is pushed inward then meets the leaning facing
 * and is thrown back out, instead of dropping at the mouth. A ball that stops
 * short can rest on the shelf in front of the fall, as on a real table.
 *
 * Tuned against the simulator with real contact physics (bouncy cushions,
 * elastic ball contacts, exact circle contacts: see PHYSICS and contacts.js),
 * choosing values whose neighbours all keep the same guarantees:
 *   - every aimed pot drops, and so do pots aimed at 80% of the centre window
 *     (middles straight or at 45–90°; corners on the diagonal, along either
 *     cushion, and at 20–35° off the long cushion);
 *   - no ball rolling along a cushion drops into a middle pocket (the middle
 *     r must also stay below BALL_RADIUS + setback);
 *   - no slow ball is left inside the mouth past the cushion face.
 * Resulting feel, measured:
 *   - straight shots that clip a jaw: 6/24 knocked into a middle, 12/24 into a
 *     corner. Middles are wider but reject clips more.
 *   - middles take nothing arriving 70° or more off their centre line (20° or
 *     less to the cushion) and 8/9 at 60°; corners take balls running along
 *     either cushion.
 * Neighbours checked: middle facing 10–15°, knuckle 1.25–2.25 and fall 3–4
 * keep every aimed pot (a 4cm fall loses 2 of 18 wide pots, knuckle 2.5 loses
 * 1); every corner neighbour tried (facing 30–45°, knuckle 0.5–1.5, fall 1–3,
 * r 5–6) keeps all. One step looser, knuckle 2.25, drops 9/9 at 60° and
 * knocks in 10/24 clips.
 * History: under the old dead-cushion physics the middles were first tuned to
 * 17.5° / knuckle 1 / fall 3.75, felt too tight, and the fall moved to 3.5.
 * After the physics fix, 17.5° / knuckle 1 rattled out wide pots, hence
 * 12.5° / 1.75 / fall 3.5. Played, the middles still looked and felt small, so
 * they moved to the loose end: 10° / 2 / fall 3. The cushion-runner guarantee
 * holds while the middle r stays below BALL_RADIUS + MIDDLE_FALL_SETBACK.
 */
export const CORNER_POCKET_CUT = 8.9 / Math.SQRT2; // 89mm opening, ≈ 6.293
export const MIDDLE_POCKET_CUT = 10.2 / 2;         // 102mm opening

/** How far the cushion bodies extend behind the face. Balls never get that deep. */
export const CUSHION_DEPTH = 12;

/**
 * Jaw shape per pocket type (see table.js): the facing's lean toward the pocket
 * from square, in degrees, and the knuckle radius where the face turns into the
 * facing. Both 0 gives square-ended cushions.
 */
export const JAWS = {
  corner: { facingAngle: 37.5, knuckleRadius: 1 },
  middle: { facingAngle: 10, knuckleRadius: 2 },
};

/** How far each fall sits behind the table: middles straight back, corners along the diagonal. */
export const MIDDLE_FALL_SETBACK = 3;
export const CORNER_FALL_SETBACK = 2;
const CD = CORNER_FALL_SETBACK / Math.SQRT2;

export const POCKETS = [
  { id: 'tl', x: -CD,                y: -CD,                               r: 5.5, type: 'corner' },
  { id: 'tm', x: TABLE.width / 2,    y: -MIDDLE_FALL_SETBACK,              r: 3.0, type: 'middle' },
  { id: 'tr', x: TABLE.width + CD,   y: -CD,                               r: 5.5, type: 'corner' },
  { id: 'bl', x: -CD,                y: TABLE.height + CD,                 r: 5.5, type: 'corner' },
  { id: 'bm', x: TABLE.width / 2,    y: TABLE.height + MIDDLE_FALL_SETBACK, r: 3.0, type: 'middle' },
  { id: 'br', x: TABLE.width + CD,   y: TABLE.height + CD,                 r: 5.5, type: 'corner' },
];

export const BAULK_LINE_X = 73.7;
export const D_RADIUS = 29.2;
export const CENTRE_Y = TABLE.height / 2;

// Colour spots. Order here is also the clearing order in the colours phase.
export const COLOURS = [
  { color: 'yellow', value: 2, spot: { x: BAULK_LINE_X,           y: CENTRE_Y + D_RADIUS } },
  { color: 'green',  value: 3, spot: { x: BAULK_LINE_X,           y: CENTRE_Y - D_RADIUS } },
  { color: 'brown',  value: 4, spot: { x: BAULK_LINE_X,           y: CENTRE_Y } },
  { color: 'blue',   value: 5, spot: { x: TABLE.width / 2,        y: CENTRE_Y } },
  { color: 'pink',   value: 6, spot: { x: TABLE.width * 0.75,     y: CENTRE_Y } },
  { color: 'black',  value: 7, spot: { x: TABLE.width - 32.4,     y: CENTRE_Y } },
];

export const BALL_VALUES = {
  red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7,
};

export const COLOUR_ORDER = COLOURS.map((c) => c.color);

/** The real snooker maximum. Rewards are capped at this; nothing legal can exceed it. */
export const MAX_BREAK = 147;

/** Minimum penalty for any foul, per the locked MVP rule table. */
export const MIN_FOUL = 4;

// --- Physics tuning -------------------------------------------------------
//
// Two Matter.js facts drive every number here:
//
// 1. `body.velocity` is normalised to a 60fps base delta, NOT to the timestep
//    you pass to Engine.update. So a velocity of v moves the body
//    v * (dt / BASE_DELTA) units per step, and v is always "units per 1/60s".
//    Use cmPerSecToMatter/matterToCmPerSec rather than converting by hand.
//
// 2. The resolver treats a contact as resting, and cancels its approach speed
//    instead of bouncing it, when the approach is slower than
//    `Resolver._restingThresh * (dt / BASE_DELTA)` per step. That velocity is a
//    position change per actual step, so with Matter's default of 2 it was
//    2 * 0.2 = 0.4cm per 1/300s: 120 cm/s, not the ~24 once written here. Most
//    real contacts are slower than that, so cushions stopped balls dead (6% of
//    speed kept) and a ball striking a still ball left both moving at 49%.
//    PHYSICS.restingThresh sets it to about restSpeed instead.
//
// 3. A pair's restitution is the HIGHER of its two bodies', so a cushion could
//    never be less bouncy than a ball. simulate.js sets cushion contacts to
//    PHYSICS.cushionRestitution itself.
export const BASE_DELTA = 1000 / 60;

export const PHYSICS = {
  dt: 1000 / 300,          // ms per step: 1.13cm of travel at full power, under one radius
  maxSteps: 300 * 25,      // hard stop after 25 simulated seconds
  restSpeed: 3,            // cm/s below which a ball is parked
  frictionAir: 0.009,      // cloth drag, per base delta
  ballRestitution: 0.94,   // ball on ball: a straight hit leaves the object ball ~90% of the speed
  // Resolver._restingThresh: 0.05 → 0.05 * 0.2 = 0.01cm per step = 3 cm/s, the
  // speed below which balls are parked anyway. See (2) above.
  restingThresh: 0.05,
  cushionRestitution: 0.75, // a ball keeps ~71% of its speed straight into a cushion, ~83% at 45°
  ballFriction: 0.02,
};

/** cm/s at power = 1.0. Capped for tunnelling safety, see PHYSICS.dt. */
export const MAX_SHOT_SPEED = 340;

export const cmPerSecToMatter = (cmPerSec) => cmPerSec / 60;
export const matterToCmPerSec = (v) => v * 60;

/**
 * The shot clock: a flat 30 seconds per shot. This is the only place the value
 * lives. The backend derives its deadline and sweeper from it, the Mini App
 * counts it down, and the bot quotes it, so they cannot drift apart.
 */
export const SHOT_CLOCK_MS = 30_000;

/**
 * How late after the displayed deadline a PvP shot still counts, and how long
 * the sweeper waits before expiring a turn. The player sees the full 30s count
 * down to zero; this only absorbs the time between the tap and the request
 * reaching the server (and the clock-offset error, which is at most one
 * response's transit time). Without it a shot taken at 0.3s left on a slow
 * connection arrives late and is scored as a timeout.
 */
export const SHOT_CLOCK_GRACE_MS = 2_000;
export const FRAMES_TO_WIN = 2; // best of 3
