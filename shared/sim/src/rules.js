import { simulateShot } from './simulate.js';
import {
  BALL_VALUES, COLOUR_ORDER, MIN_FOUL, MAX_BREAK, TABLE, BALL_RADIUS, BALL_DIAMETER, COLOURS,
  BAULK_LINE_X, D_RADIUS, CENTRE_Y,
} from './constants.js';
import {
  ballById, redsOnTable, nextColourOn, respotColour, respotCueBall,
} from './state.js';

/** Centre of the cue ball on or behind the baulk line, within the D's semicircle. */
export const inTheD = (x, y) => x <= BAULK_LINE_X && Math.hypot(x - BAULK_LINE_X, y - CENTRE_Y) <= D_RADIUS;

/**
 * Why a ball-in-hand placement is illegal, or null if it is fine: it must be
 * inside the D and not overlap a ball on the table. The client only offers
 * legal spots, but a PvP shot is a crafted request as far as the server knows,
 * so this is the rule — not a UI nicety.
 */
export function cuePlacementProblem(frameState, placement) {
  const { x, y } = placement ?? {};
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'cue ball placement must be numbers';
  if (!inTheD(x, y)) return 'cue ball must be placed inside the D';
  const overlaps = frameState.balls.some(
    (b) => b.id !== 'cue' && !b.potted && Math.hypot(b.x - x, b.y - y) < BALL_DIAMETER,
  );
  return overlaps ? 'cue ball cannot be placed touching another ball' : null;
}

const isRed = (id) => id.startsWith('red');
const valueOfBall = (id) => (isRed(id) ? 1 : (BALL_VALUES[id] ?? 0));

/**
 * Value used as "the correct ball" in the whichever-is-higher penalty.
 * When any colour is on (free choice after a red) nothing is nominated yet, so
 * the MVP uses the minimum — deliberately lenient rather than assuming black.
 */
function ballOnValue(state) {
  if (state.ballOn === 'red') return 1;
  if (state.ballOn === 'colour') return MIN_FOUL;
  return BALL_VALUES[state.ballOn] ?? MIN_FOUL;
}

function firstFreePointOnCentreLine(state, ignoreId) {
  const pink = COLOURS.find((c) => c.color === 'pink').spot;
  for (let x = pink.x; x < TABLE.width - BALL_RADIUS; x += BALL_RADIUS) {
    const clear = !state.balls.some(
      (b) => !b.potted && b.id !== ignoreId && Math.hypot(b.x - x, b.y - pink.y) < BALL_DIAMETER,
    );
    if (clear) return { x, y: pink.y };
  }
  return { x: pink.x, y: pink.y };
}

function respotBall(state, id) {
  const ball = ballById(state, id);
  if (!ball) return;
  ball.offTable = false;
  if (isRed(id)) {
    const spot = firstFreePointOnCentreLine(state, id);
    Object.assign(ball, spot, { potted: false });
    return;
  }
  respotColour(state, id);
}

function contactLegal(state, firstContact) {
  if (!firstContact) return false;
  if (state.phase === 'respotted-black') return firstContact === 'black';
  if (state.phase === 'colours') return firstContact === state.ballOn;
  if (state.ballOn === 'red') return isRed(firstContact);
  return !isRed(firstContact); // a colour is on: any colour is a legal contact
}

/**
 * Resolve one shot against a frame state. Pure: returns a new state, never
 * mutates the input. This is the single source of truth for PvP — the client
 * calls it for feel, the backend calls it for the record.
 *
 * @param {object} frameState
 * @param {{angle:number,power:number,cuePlacement?:{x,y},trace?:boolean}} shot
 * @returns {{state:object, outcome:object}}
 */
export function resolveShot(frameState, shot) {
  // Placement only means anything with the ball in hand; otherwise the cue ball
  // plays from where it lies. An illegal placement is a caller bug (the server
  // rejects it before getting here), so fail loudly rather than play it.
  if (shot.cuePlacement) {
    if (!frameState.inHand) {
      shot = { ...shot, cuePlacement: undefined };
    } else {
      const problem = cuePlacementProblem(frameState, shot.cuePlacement);
      if (problem) throw new Error(problem);
    }
  }
  const state = structuredClone(frameState);
  const sim = simulateShot(state.balls, shot, { trace: shot.trace === true });
  state.balls = sim.balls;
  state.shotNumber += 1;
  state.inHand = false;

  const striker = state.turn;
  const opponent = 1 - striker;

  const pottedIds = sim.events.filter((e) => e.type === 'pot').map((e) => e.ball);
  const offTableIds = sim.events.filter((e) => e.type === 'off-table').map((e) => e.ball);
  const cuePotted = pottedIds.includes('cue') || offTableIds.includes('cue');
  const potted = pottedIds.filter((id) => id !== 'cue');
  const offTable = offTableIds.filter((id) => id !== 'cue');

  const fouls = [];
  let penalty = 0;

  const noteFoul = (reason, value) => {
    fouls.push(reason);
    penalty = Math.max(penalty, Math.max(MIN_FOUL, value ?? 0));
  };

  // --- Foul detection, in the order of the locked rule table -----------------
  if (!sim.firstContact) {
    noteFoul('miss', ballOnValue(state));
  } else if (!contactLegal(state, sim.firstContact)) {
    noteFoul('wrong-ball-first', Math.max(ballOnValue(state), valueOfBall(sim.firstContact)));
  }
  if (cuePotted) noteFoul('cue-ball-potted', MIN_FOUL);
  for (const id of offTable) noteFoul('ball-off-table', Math.max(MIN_FOUL, valueOfBall(id)));

  // Which object balls this shot was allowed to pot.
  const legalTargets = new Set();
  if (state.phase === 'respotted-black') {
    legalTargets.add('black');
  } else if (state.phase === 'colours') {
    legalTargets.add(state.ballOn);
  } else if (state.ballOn === 'red') {
    state.balls.filter((b) => isRed(b.id)).forEach((b) => legalTargets.add(b.id));
  } else if (sim.firstContact && !isRed(sim.firstContact)) {
    legalTargets.add(sim.firstContact); // the nominated colour is the one first struck
  }

  const illegallyPotted = potted.filter((id) => !legalTargets.has(id) && !offTable.includes(id));
  for (const id of illegallyPotted) {
    noteFoul('wrong-ball-potted', Math.max(ballOnValue(state), valueOfBall(id)));
  }

  let legallyPotted = potted.filter((id) => legalTargets.has(id));

  // Potting two different colours in one shot is never legal.
  const legalColoursPotted = legallyPotted.filter((id) => !isRed(id));
  if (legalColoursPotted.length > 1) {
    noteFoul('multiple-colours-potted', Math.max(...legalColoursPotted.map(valueOfBall)));
  }

  const foul = fouls.length > 0;
  if (foul) legallyPotted = [];
  let pointsScored = 0;

  // --- Put back everything that has to come back up -------------------------
  // Real-rule detail kept: a red potted illegally stays down; colours always
  // return to a spot. Off-table balls are respotted per the locked rule table.
  for (const id of offTable) respotBall(state, id);
  if (foul) {
    for (const id of illegallyPotted) if (!isRed(id)) respotBall(state, id);
    for (const id of potted) if (!isRed(id) && legalTargets.has(id)) respotBall(state, id);
  }
  if (cuePotted) respotCueBall(state);

  // --- Scoring ---------------------------------------------------------------
  if (!foul && legallyPotted.length > 0) {
    pointsScored = legallyPotted.reduce((sum, id) => sum + valueOfBall(id), 0);
    state.scores[striker] += pointsScored;
    state.currentBreak = Math.min(MAX_BREAK, state.currentBreak + pointsScored);
    if (state.currentBreak > state.highBreaks[striker]) {
      state.highBreaks[striker] = state.currentBreak;
    }
  } else if (foul) {
    state.scores[opponent] += penalty;
  }

  const breakValue = state.currentBreak;
  const continuesBreak = !foul && legallyPotted.length > 0;
  let turnPassed = !continuesBreak;

  // --- Advance ball-on / phase ----------------------------------------------
  if (state.phase === 'respotted-black') {
    state.ended = true;
    state.winner = foul ? opponent : striker;
  } else if (continuesBreak) {
    if (state.phase === 'reds') {
      if (state.ballOn === 'red') {
        state.ballOn = 'colour';
      } else {
        // A colour was potted during the reds phase: respot it, a red is on again.
        for (const id of legallyPotted) if (!isRed(id)) respotBall(state, id);
        state.ballOn = 'red';
      }
      if (state.ballOn === 'red' && redsOnTable(state) === 0) {
        state.phase = 'colours';
        state.ballOn = nextColourOn(state) ?? 'black';
      }
    } else if (state.phase === 'colours') {
      const next = nextColourOn(state);
      if (next) state.ballOn = next;
      else state.ended = true; // all colours cleared
    }
  } else {
    state.currentBreak = 0;
    if (state.phase === 'reds') {
      if (redsOnTable(state) > 0) {
        state.ballOn = 'red';
      } else {
        state.phase = 'colours';
        state.ballOn = nextColourOn(state) ?? 'black';
      }
    } else if (state.phase === 'colours') {
      state.ballOn = nextColourOn(state) ?? 'black';
    }
  }

  state.redsRemaining = redsOnTable(state);

  if (turnPassed) {
    state.turn = opponent;
    state.currentBreak = 0;
  }

  // --- Frame end -------------------------------------------------------------
  if (!state.ended && state.phase === 'colours' && nextColourOn(state) === null) {
    state.ended = true;
  }
  if (state.ended && state.winner === null) {
    const [a, b] = state.scores;
    if (a === b) {
      // Respotted black: black comes back up, the non-striker plays from in hand.
      state.ended = false;
      state.phase = 'respotted-black';
      state.ballOn = 'black';
      respotBall(state, 'black');
      respotCueBall(state);
      state.turn = opponent;
      state.currentBreak = 0;
      turnPassed = true;
    } else {
      state.winner = a > b ? 0 : 1;
    }
  }

  return {
    state,
    outcome: {
      foul,
      foulReasons: fouls,
      penalty: foul ? penalty : 0,
      pointsScored,
      potted: legallyPotted,
      illegallyPotted,
      offTable,
      cuePotted,
      firstContact: sim.firstContact,
      turnPassed,
      breakEnded: turnPassed,
      breakValue,
      frameEnded: state.ended,
      frameWinner: state.winner,
      steps: sim.steps,
      events: sim.events,
      trace: sim.trace,
    },
  };
}

/** Shot clock expiry. Scored exactly like a miss: 4 to the opponent, turn passes. */
export function resolveTimeout(frameState) {
  const state = structuredClone(frameState);
  const striker = state.turn;
  const opponent = 1 - striker;
  state.scores[opponent] += MIN_FOUL;
  state.currentBreak = 0;
  state.turn = opponent;
  state.shotNumber += 1;
  return {
    state,
    outcome: {
      foul: true,
      foulReasons: ['shot-clock-expired'],
      penalty: MIN_FOUL,
      pointsScored: 0,
      potted: [],
      illegallyPotted: [],
      offTable: [],
      cuePotted: false,
      firstContact: null,
      turnPassed: true,
      breakEnded: true,
      breakValue: 0,
      frameEnded: false,
      frameWinner: null,
      events: [],
    },
  };
}

export { COLOUR_ORDER, MAX_BREAK };
