import {
  TABLE, BALL_RADIUS, BALL_DIAMETER, COLOURS, COLOUR_ORDER, BALL_VALUES,
} from './constants.js';

const RED_COUNT = 15;

/** Reds racked in a triangle with the apex just behind the pink spot. */
function rackReds() {
  const pink = COLOURS.find((c) => c.color === 'pink').spot;
  const gap = 0.12;
  const rowStep = (BALL_DIAMETER + gap) * Math.cos(Math.PI / 6);
  const colStep = BALL_DIAMETER + gap;
  const apexX = pink.x + BALL_DIAMETER * 0.6;

  const reds = [];
  let n = 0;
  for (let row = 0; row < 5; row += 1) {
    for (let i = 0; i <= row; i += 1) {
      n += 1;
      reds.push({
        id: `red${n}`,
        color: 'red',
        value: 1,
        x: apexX + row * rowStep,
        y: pink.y + (i - row / 2) * colStep,
        potted: false,
      });
    }
  }
  return reds.slice(0, RED_COUNT);
}

/** Full 22-ball opening layout: 15 reds, 6 colours, cue ball in the D. */
export function initialBalls() {
  const colours = COLOURS.map((c) => ({
    id: c.color, color: c.color, value: c.value, x: c.spot.x, y: c.spot.y, potted: false,
  }));
  const cue = {
    id: 'cue', color: 'cue', value: 0,
    x: 66, y: TABLE.height / 2 + 12, potted: false,
  };
  return [cue, ...rackReds(), ...colours];
}

export function newFrame(frameNumber = 1, breakingPlayer = 0) {
  return {
    frame: frameNumber,
    balls: initialBalls(),
    turn: breakingPlayer,
    scores: [0, 0],
    currentBreak: 0,
    highBreaks: [0, 0],
    phase: 'reds',
    ballOn: 'red',
    redsRemaining: RED_COUNT,
    inHand: true,      // breaking player plays from the D
    shotNumber: 0,
    ended: false,
    winner: null,
  };
}

export function newMatch(playerIds) {
  return {
    players: playerIds,
    framesWon: [0, 0],
    frame: newFrame(1, 0),
    frameHistory: [],
    highBreaks: [0, 0],
    ended: false,
    winner: null,
  };
}

export const ballById = (state, id) => state.balls.find((b) => b.id === id);
export const activeBalls = (state) => state.balls.filter((b) => !b.potted);
export const cueBall = (state) => ballById(state, 'cue');

export function redsOnTable(state) {
  return state.balls.filter((b) => b.color === 'red' && !b.potted).length;
}

/** Lowest-value colour still off the table, i.e. the next one in the colours phase. */
export function nextColourOn(state) {
  return COLOUR_ORDER.find((c) => {
    const b = ballById(state, c);
    return b && b.potted === false;
  }) ?? null;
}

function spotFree(state, spot, ignoreId) {
  return !state.balls.some(
    (b) => !b.potted && b.id !== ignoreId
      && Math.hypot(b.x - spot.x, b.y - spot.y) < BALL_DIAMETER,
  );
}

/**
 * Put a potted colour back. Own spot first; if occupied, the highest-value free
 * spot; if every spot is taken, the nearest free point on its own spot's line
 * (see nearestFreeOnLine). It never lands on another ball.
 */
export function respotColour(state, colourId) {
  const ball = ballById(state, colourId);
  if (!ball) return;
  const own = COLOURS.find((c) => c.color === colourId).spot;

  if (spotFree(state, own, colourId)) {
    Object.assign(ball, { x: own.x, y: own.y, potted: false });
    return;
  }
  const byValueDesc = [...COLOURS].sort((a, b) => b.value - a.value);
  for (const c of byValueDesc) {
    if (spotFree(state, c.spot, colourId)) {
      Object.assign(ball, { x: c.spot.x, y: c.spot.y, potted: false });
      return;
    }
  }
  Object.assign(ball, nearestFreeOnLine(state, own, colourId), { potted: false });
}

/**
 * A red knocked off the table. There is no red spot, so it goes on the pink
 * spot if free, otherwise as near to it as possible on the centre line — the
 * same search a colour uses, so it never lands on another ball either.
 */
export function respotRed(state, redId) {
  const ball = ballById(state, redId);
  if (!ball) return;
  const pink = COLOURS.find((c) => c.color === 'pink').spot;
  Object.assign(ball, nearestFreeOnLine(state, pink, redId), { potted: false });
}

/**
 * The free point nearest `spot` on its line: from the spot toward the top
 * (black-end) cushion, then from the spot back toward baulk. Stopping at the
 * spot after the first pass used to drop the ball on whatever blocked it.
 */
function nearestFreeOnLine(state, spot, ignoreId) {
  for (let x = spot.x; x < TABLE.width - BALL_RADIUS; x += BALL_RADIUS) {
    if (spotFree(state, { x, y: spot.y }, ignoreId)) return { x, y: spot.y };
  }
  for (let x = spot.x - BALL_RADIUS; x > BALL_RADIUS; x -= BALL_RADIUS) {
    if (spotFree(state, { x, y: spot.y }, ignoreId)) return { x, y: spot.y };
  }
  return { x: spot.x, y: spot.y }; // unreachable with 22 balls
}

/** Cue ball back in hand, parked in the D until the player places it. */
export function respotCueBall(state) {
  const cue = cueBall(state);
  Object.assign(cue, { x: 66, y: TABLE.height / 2 + 12, potted: false });
  state.inHand = true;
}

export const valueOf = (colorOrId) => BALL_VALUES[colorOrId] ?? 0;
