import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newFrame, newMatch, resolveShot, advanceMatch, respotColour, ballById, chooseShot,
  defaultCuePlacement, cuePlacementProblem,
  POCKETS, COLOURS, TABLE, BALL_RADIUS, BALL_DIAMETER, CENTRE_Y,
} from '../src/index.js';

/** Only the listed balls on the table, cue ball not in hand. */
function sparseFrame(placements, patch = {}) {
  const frame = newFrame();
  frame.balls = frame.balls.map((b) => ({ ...b, potted: true }));
  for (const [id, pos] of Object.entries(placements)) {
    Object.assign(ballById(frame, id), pos, { potted: false });
  }
  frame.inHand = false;
  return { ...frame, ...patch, redsRemaining: frame.balls.filter((b) => b.color === 'red' && !b.potted).length };
}

const spotOf = (colour) => COLOURS.find((c) => c.color === colour).spot;
const BR = POCKETS.find((p) => p.id === 'br');

/** No two balls on the table overlap. */
function assertNoOverlap(frame) {
  const up = frame.balls.filter((b) => !b.potted);
  for (let i = 0; i < up.length; i += 1) {
    for (let j = i + 1; j < up.length; j += 1) {
      const d = Math.hypot(up[i].x - up[j].x, up[i].y - up[j].y);
      assert.ok(d >= BALL_DIAMETER - 1e-9, `${up[i].id} overlaps ${up[j].id} (${d.toFixed(2)} apart)`);
    }
  }
}

// --- Compound fouls ---------------------------------------------------------
// The layouts below were found by searching the deterministic simulator. Each
// test first asserts the shot really did what it is meant to, so a physics
// change fails here loudly instead of silently testing something else.

/**
 * Cue ball clips `obj` thinly, is deflected 50°, and runs into the top-left pocket.
 *
 * Built from the contact geometry (after a thin hit the cue ball leaves at right
 * angles to the line between the centres), then checked in the simulator: aimed
 * anywhere from -86.25° to -85.35° (±0.45° around the -85.8° used), at every power
 * from 0.30 to 0.60, both yellow and black give exactly these two fouls.
 * The old layout, a clip along the cue ball's own path to the pocket, only worked
 * while ball contacts pushed along polygon faces instead of the centre line.
 * Anchored to the table corner, not a pocket's fall point.
 */
function clipIntoPocket(obj) {
  return sparseFrame({
    cue: { x: 18.067, y: 65.528 },
    [obj]: { x: 25, y: 25 },
    red1: { x: 250, y: 150 },
  }, { ballOn: 'red' });
}
const CLIP_SHOT = { angle: (-85.8 * Math.PI) / 180, power: 0.45 };

test('compound foul, wrong ball first (yellow) + cue ball potted: 4 once, not 8', () => {
  const { state, outcome } = resolveShot(clipIntoPocket('yellow'), CLIP_SHOT);
  assert.equal(outcome.firstContact, 'yellow');
  assert.equal(outcome.cuePotted, true);
  assert.deepEqual([...outcome.foulReasons].sort(), ['cue-ball-potted', 'wrong-ball-first']);
  assert.equal(outcome.penalty, 4);
  assert.deepEqual(state.scores, [0, 4]);
  assert.equal(state.turn, 1);
  assert.equal(state.inHand, true, 'opponent plays from the D');
});

test('compound foul, wrong ball first (black) + cue ball potted: 7 once, not 11', () => {
  const { state, outcome } = resolveShot(clipIntoPocket('black'), CLIP_SHOT);
  assert.equal(outcome.firstContact, 'black');
  assert.equal(outcome.cuePotted, true);
  assert.deepEqual([...outcome.foulReasons].sort(), ['cue-ball-potted', 'wrong-ball-first']);
  assert.equal(outcome.penalty, 7);
  assert.deepEqual(state.scores, [0, 7]);
});

test('compound foul, black hit first AND potted with a red on: 7 once, black respotted', () => {
  const black = { x: BR.x - 60, y: BR.y - 60 };
  const frame = sparseFrame({
    cue: { x: black.x - 40, y: black.y - 40 },
    black,
    red1: { x: 120, y: 30 },
  }, { ballOn: 'red' });
  const { state, outcome } = resolveShot(frame, { angle: Math.PI / 4, power: 0.55 });
  assert.equal(outcome.firstContact, 'black');
  assert.deepEqual(outcome.illegallyPotted, ['black']);
  assert.deepEqual([...outcome.foulReasons].sort(), ['wrong-ball-first', 'wrong-ball-potted']);
  assert.equal(outcome.penalty, 7);
  assert.equal(outcome.pointsScored, 0, 'a foul pot scores nothing for the striker');
  assert.deepEqual(state.scores, [0, 7]);
  const respotted = ballById(state, 'black');
  assert.equal(respotted.potted, false);
  assert.deepEqual({ x: respotted.x, y: respotted.y }, spotOf('black'));
});

// --- max(correct ball, ball hit), minimum 4 ----------------------------------

/** Cue ball straight at `obj`, nothing else near. */
function straightAt(obj, patch) {
  const others = Object.fromEntries(Object.entries(patch.extra ?? {}));
  const { extra, ...rest } = patch;
  return sparseFrame({
    cue: { x: 100, y: CENTRE_Y },
    [obj]: { x: 180, y: CENTRE_Y },
    ...others,
  }, rest);
}
const STRAIGHT = { angle: 0, power: 0.3 };

const wrongBallCases = [
  // [ball hit first, frame patch, expected penalty, why]
  ['yellow', { ballOn: 'red', extra: { red1: { x: 300, y: 20 } } }, 4, 'max(red 1, yellow 2) = 2, raised to the minimum 4'],
  ['pink', { ballOn: 'red', extra: { red1: { x: 300, y: 20 } } }, 6, 'max(red 1, pink 6) = 6'],
  ['green', { ballOn: 'red', extra: { red1: { x: 300, y: 20 } } }, 4, 'max(red 1, green 3) = 3, raised to 4'],
  ['brown', { ballOn: 'red', extra: { red1: { x: 300, y: 20 } } }, 4, 'max(red 1, brown 4) = 4'],
  ['blue', { ballOn: 'red', extra: { red1: { x: 300, y: 20 } } }, 5, 'max(red 1, blue 5) = 5'],
  ['red1', { ballOn: 'colour', extra: { pink: { x: 300, y: 20 } } }, 4, 'colour on, not nominated: lenient minimum, not black'],
  ['pink', { phase: 'colours', ballOn: 'yellow', extra: { yellow: { x: 300, y: 20 } } }, 6, 'max(yellow 2, pink 6) = 6'],
  ['black', { phase: 'colours', ballOn: 'pink', extra: { pink: { x: 300, y: 20 } } }, 7, 'max(pink 6, black 7) = 7'],
];

for (const [hit, patch, expected, why] of wrongBallCases) {
  test(`wrong ball first: ${hit} with ${patch.ballOn} on costs ${expected} (${why})`, () => {
    const { state, outcome } = resolveShot(straightAt(hit, patch), STRAIGHT);
    assert.equal(outcome.firstContact, hit);
    assert.ok(outcome.foulReasons.includes('wrong-ball-first'), `reasons: ${outcome.foulReasons}`);
    assert.equal(outcome.penalty, expected);
    assert.deepEqual(state.scores, [0, expected]);
    assert.equal(state.turn, 1);
  });
}

// --- Respotting onto an occupied spot ---------------------------------------

test('respot: a potted colour goes back on its own spot when it is free', () => {
  const frame = newFrame();
  Object.assign(ballById(frame, 'blue'), { potted: true, x: 0, y: 0 });
  respotColour(frame, 'blue');
  assert.deepEqual(
    { x: ballById(frame, 'blue').x, y: ballById(frame, 'blue').y, potted: false },
    { ...spotOf('blue'), potted: false },
  );
});

test('respot: own spot occupied → the highest-value free spot', () => {
  const frame = newFrame();
  // Black and pink are down; a red sits on the black spot.
  Object.assign(ballById(frame, 'black'), { potted: true });
  Object.assign(ballById(frame, 'pink'), { potted: true });
  Object.assign(ballById(frame, 'red1'), spotOf('black'));
  respotColour(frame, 'black');
  const black = ballById(frame, 'black');
  assert.deepEqual({ x: black.x, y: black.y }, spotOf('pink'), 'pink (6) is the highest free spot');
  assertNoOverlap(frame);
});

test('respot: a low colour takes the black spot if that is the highest free one', () => {
  const frame = newFrame();
  Object.assign(ballById(frame, 'yellow'), { potted: true });
  Object.assign(ballById(frame, 'black'), { potted: true });
  Object.assign(ballById(frame, 'red1'), spotOf('yellow'));
  respotColour(frame, 'yellow');
  const yellow = ballById(frame, 'yellow');
  assert.deepEqual({ x: yellow.x, y: yellow.y }, spotOf('black'));
  assertNoOverlap(frame);
});

test('respot: every spot taken → as near its own spot as possible, toward the top cushion', () => {
  const frame = newFrame();
  Object.assign(ballById(frame, 'black'), { potted: true });
  // All six spots occupied: the other five colours on theirs, a red on black's.
  Object.assign(ballById(frame, 'red1'), spotOf('black'));
  respotColour(frame, 'black');
  const black = ballById(frame, 'black');
  assert.equal(black.y, spotOf('black').y, 'stays on the centre line');
  assert.ok(black.x > spotOf('black').x, 'toward the top cushion');
  assert.ok(black.x - spotOf('black').x <= BALL_DIAMETER + BALL_RADIUS, 'as near as possible');
  assertNoOverlap(frame);
});

test('respot: spots and the line to the top cushion all blocked → below the spot, never overlapping', () => {
  const frame = newFrame();
  Object.assign(ballById(frame, 'black'), { potted: true });
  const spot = spotOf('black');
  // Line the reds up from the black spot to the top cushion.
  let x = spot.x;
  for (let n = 1; n <= 15 && x < TABLE.width - BALL_RADIUS; n += 1, x += BALL_DIAMETER) {
    Object.assign(ballById(frame, `red${n}`), { x, y: spot.y });
  }
  respotColour(frame, 'black');
  const black = ballById(frame, 'black');
  assert.equal(black.potted, false);
  assert.equal(black.y, spot.y);
  assert.ok(black.x < spot.x, `expected toward baulk, got x=${black.x}`);
  assertNoOverlap(frame);
});

test('respot through a real shot: legally potted black with a red on its spot goes to the pink spot', () => {
  const black = { x: BR.x - 60, y: BR.y - 60 };
  const frame = sparseFrame({
    cue: { x: black.x - 40, y: black.y - 40 },
    black,
    red1: { x: 120, y: 30 },
    red2: spotOf('black'),
  }, { ballOn: 'colour' });
  const { state, outcome } = resolveShot(frame, { angle: Math.PI / 4, power: 0.55 });
  assert.equal(outcome.foul, false, `unexpected foul: ${outcome.foulReasons}`);
  assert.deepEqual(outcome.potted, ['black']);
  const respotted = ballById(state, 'black');
  assert.deepEqual({ x: respotted.x, y: respotted.y }, spotOf('pink'));
  assertNoOverlap(state);
});

// --- Best of 3 frame transitions --------------------------------------------

/** Last black lined up for `turn` to pot and end the frame. */
function lastBlack(frameNumber, turn, scores) {
  const black = { x: BR.x - 60, y: BR.y - 60 };
  return sparseFrame({ cue: { x: black.x - 40, y: black.y - 40 }, black }, {
    frame: frameNumber, phase: 'colours', ballOn: 'black', turn, scores, highBreaks: [30, 12],
  });
}
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };

/** Play the frame-ending shot for real and fold it into the match. */
function finishFrame(match, turn, scores) {
  const { state } = resolveShot(lastBlack(match.frame.frame, turn, scores), POT_BLACK);
  assert.equal(state.ended, true, 'the black must end the frame');
  return advanceMatch(match, state);
}

test('frame 1 → 2: fresh rack, scores and breaks reset, seat 1 breaks', () => {
  let match = newMatch([10, 20]);
  match = finishFrame(match, 0, [60, 20]); // seat 0 pots the black: 67-20

  assert.equal(match.ended, false);
  assert.deepEqual(match.framesWon, [1, 0]);
  assert.deepEqual(match.frameHistory.map((h) => [h.frame, h.winner, h.scores]), [[1, 0, [67, 20]]]);

  const f = match.frame;
  assert.equal(f.frame, 2);
  assert.deepEqual(f.scores, [0, 0]);
  assert.equal(f.currentBreak, 0);
  assert.deepEqual(f.highBreaks, [0, 0], 'per-frame breaks start again');
  assert.equal(f.phase, 'reds');
  assert.equal(f.ballOn, 'red');
  assert.equal(f.balls.filter((b) => !b.potted).length, 22, 'a full rack');
  assert.equal(f.inHand, true);
  assert.equal(f.ended, false);
  assert.equal(f.winner, null);
  assert.equal(f.turn, 1, 'seat 0 broke frame 1, so seat 1 breaks frame 2');
  assert.deepEqual(match.highBreaks, [30, 12], 'the frame\'s high breaks are folded into the match');
});

test('breaks alternate whoever wins: the frame 1 winner still breaks frame 2 if it is their turn to', () => {
  let match = newMatch([10, 20]);
  match = finishFrame(match, 1, [20, 60]); // seat 1 wins frame 1
  assert.deepEqual(match.framesWon, [0, 1]);
  assert.equal(match.frame.frame, 2);
  assert.equal(match.frame.turn, 1, 'seat 1 breaks frame 2 as the alternation says, not seat 0 the loser');
});

test('1-1 goes to a deciding third frame, broken by seat 0 again', () => {
  let match = newMatch([10, 20]);
  match = finishFrame(match, 1, [20, 60]); // seat 1 takes frame 1
  assert.equal(match.frame.turn, 1);
  match = finishFrame(match, 0, [50, 10]); // seat 0 takes frame 2
  assert.deepEqual(match.framesWon, [1, 1]);
  assert.equal(match.ended, false);
  assert.equal(match.frame.frame, 3);
  assert.equal(match.frame.turn, 0, 'frames 1 and 3 are broken by seat 0; the loser of frame 2 (seat 1) does not');

  match = finishFrame(match, 1, [0, 40]);
  assert.equal(match.ended, true);
  assert.equal(match.winner, 1);
  assert.deepEqual(match.framesWon, [1, 2]);
});

test('2-0 ends the match: the third frame is never racked', () => {
  let match = newMatch([10, 20]);
  match = finishFrame(match, 0, [60, 20]);
  match = finishFrame(match, 0, [70, 0]);

  assert.equal(match.ended, true);
  assert.equal(match.winner, 0);
  assert.deepEqual(match.framesWon, [2, 0]);
  assert.equal(match.frameHistory.length, 2);
  assert.equal(match.frame.frame, 2, 'the finished frame 2 stays current; no frame 3');
  assert.equal(match.frame.ended, true);
});

test('a finished match cannot be advanced into a third frame', () => {
  let match = newMatch([10, 20]);
  match = finishFrame(match, 0, [60, 20]);
  match = finishFrame(match, 0, [70, 0]);

  const stray = { ...newFrame(3, 1), ended: true, winner: 1, scores: [0, 50] };
  const after = advanceMatch(match, stray);
  assert.deepEqual(after.framesWon, [2, 0]);
  assert.equal(after.frameHistory.length, 2);
  assert.equal(after.winner, 0);
  assert.equal(after.frame.frame, 2);
});

// --- Ball in hand: the cue ball's spot must be legal, placed or not ----------

/** A frame with the cue ball in hand at its park spot and `blocker` resting on that spot. */
function inHandWithParkBlocked() {
  const frame = newFrame();
  frame.inHand = true;
  const cue = ballById(frame, 'cue');
  // Everything else off the table except one red, which rolled onto the park spot.
  frame.balls.forEach((b) => { if (b.id !== 'cue') b.potted = true; });
  Object.assign(ballById(frame, 'red1'), { x: cue.x + 1, y: cue.y, potted: false });
  Object.assign(ballById(frame, 'red2'), { x: 250, y: 60, potted: false });
  return { ...frame, redsRemaining: 2 };
}

test('ball in hand with no placement plays from the park spot when it is clear', () => {
  const frame = newFrame(); // opening break: in hand, park spot clear
  assert.doesNotThrow(() => resolveShot(frame, { angle: -0.02, power: 0.9 }));
});

test('ball in hand with no placement is refused when a ball rests on the park spot', () => {
  const frame = inHandWithParkBlocked();
  assert.throws(() => resolveShot(frame, { angle: 0, power: 0.5 }), /touching another ball/);
});

test('ball in hand: a legal placement still plays even when the park spot is blocked', () => {
  const frame = inHandWithParkBlocked();
  const spot = defaultCuePlacement(frame);
  assert.ok(spot, 'there is room in the D');
  assert.equal(cuePlacementProblem(frame, spot), null);
  assert.doesNotThrow(() => resolveShot(frame, { angle: 0, power: 0.5, cuePlacement: spot }));
});

test('defaultCuePlacement: the park spot when it is clear, else the nearest clear spot in the D', () => {
  const clear = newFrame();
  const park = ballById(clear, 'cue');
  assert.deepEqual(defaultCuePlacement(clear), { x: park.x, y: park.y });

  const blocked = inHandWithParkBlocked();
  const spot = defaultCuePlacement(blocked);
  assert.equal(cuePlacementProblem(blocked, spot), null);
  assert.ok(Math.hypot(spot.x - park.x, spot.y - park.y) <= BALL_DIAMETER * 2, 'close to the park spot');
});

test('the practice AI places the cue ball legally when the park spot is blocked', () => {
  const frame = inHandWithParkBlocked();
  const shot = chooseShot(frame, { rng: () => 0.5 });
  assert.ok(shot.cuePlacement, 'the AI sends a placement when in hand');
  assert.equal(cuePlacementProblem(frame, shot.cuePlacement), null);
  assert.doesNotThrow(() => resolveShot(frame, shot));
});

test('the practice AI does not send a placement when the cue ball is not in hand', () => {
  const frame = sparseFrame({ cue: { x: 100, y: CENTRE_Y }, red1: { x: 180, y: CENTRE_Y } }, { ballOn: 'red' });
  assert.equal(chooseShot(frame, { rng: () => 0.5 }).cuePlacement, undefined);
});
