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
 * 102mm, measured jaw point to jaw point at the cushion face. Middles are wider
 * than corners on a real table; they play harder because of the shape of their
 * jaws, which these square-ended cushions do not model yet.
 *
 *   CUT    how far back from the pocket point each cushion ends (the jaw).
 *          Corner opening = CUT·√2 (across the corner); middle = 2·CUT.
 *   r      capture radius — a ball whose centre comes within r of the pocket
 *          point has dropped
 *
 * Each r sits between two bounds:
 *
 * Corner (point at the corner itself; jaw line x + y = CUT):
 *   above hypot(CUT/√2, CUT/√2 - BALL_RADIUS) ≈ 4.81, so any ball whose centre
 *     has crossed the jaw line drops rather than hanging in the mouth;
 *   below CUT/√2 + BALL_RADIUS ≈ 7.07, so nothing is captured before it
 *     reaches the mouth. r = 8.0 caught balls ~3.5cm short of the jaws.
 *   r = 7.0. A ball on the rail at the cushion end, hypot(CUT, BALL_RADIUS) ≈ 6.8
 *   from the point, is still inside it, so it drops rather than wedging.
 *
 * Middle (point 2.0 behind the rail line):
 *   above hypot(MIDDLE_POCKET_CUT - BALL_RADIUS, 2.0) ≈ 3.18, so any ball whose
 *     centre has crossed into the mouth drops rather than hanging there;
 *   below BALL_RADIUS + 2.0 = 4.625, so a ball rolling along the cushion past
 *     the middle runs on toward the corner instead of being swallowed.
 *   r = 4.0. It was 7.4, which reached 5.4 onto the table and took
 *   rail-runners and balls up to ~2cm off the cushion.
 */
export const CORNER_POCKET_CUT = 8.9 / Math.SQRT2; // 89mm opening, ≈ 6.293
export const MIDDLE_POCKET_CUT = 10.2 / 2;         // 102mm opening

export const POCKETS = [
  { id: 'tl', x: 0,                y: 0,                  r: 7.0, type: 'corner' },
  { id: 'tm', x: TABLE.width / 2,  y: -2.0,               r: 4.0, type: 'middle' },
  { id: 'tr', x: TABLE.width,      y: 0,                  r: 7.0, type: 'corner' },
  { id: 'bl', x: 0,                y: TABLE.height,       r: 7.0, type: 'corner' },
  { id: 'bm', x: TABLE.width / 2,  y: TABLE.height + 2.0, r: 4.0, type: 'middle' },
  { id: 'br', x: TABLE.width,      y: TABLE.height,       r: 7.0, type: 'corner' },
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
// 2. The resolver only applies restitution when the approach speed exceeds
//    `Resolver._restingThresh * (dt / BASE_DELTA)` = 2 * 0.2 = 0.4 here, i.e.
//    about 24 cm/s. Below that, contacts are treated as resting and balls
//    nudge each other instead of transferring momentum. That is fine for balls
//    that are all but stopped; it is why the timestep is not made any coarser.
export const BASE_DELTA = 1000 / 60;

export const PHYSICS = {
  dt: 1000 / 300,          // ms per step: 1.13cm of travel at full power, under one radius
  maxSteps: 300 * 25,      // hard stop after 25 simulated seconds
  restSpeed: 3,            // cm/s below which a ball is parked
  frictionAir: 0.009,      // cloth drag, per base delta
  ballRestitution: 0.94,
  cushionRestitution: 0.84,
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
