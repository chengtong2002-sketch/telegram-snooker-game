import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newFrame, initialBalls, resolveShot, resolveTimeout, simulateShot,
  ballById, advanceMatch, newMatch, TABLE, POCKETS, BALL_RADIUS, MAX_BREAK,
} from '../src/index.js';

/** Put the cue ball and one object ball where we want them, clear the rest. */
function sparseFrame(placements, patch = {}) {
  const frame = newFrame();
  frame.balls = frame.balls.map((b) => ({ ...b, potted: true }));
  for (const [id, pos] of Object.entries(placements)) {
    const ball = ballById(frame, id);
    Object.assign(ball, pos, { potted: false });
  }
  frame.inHand = false;
  return { ...frame, ...patch, redsRemaining: frame.balls.filter((b) => b.color === 'red' && !b.potted).length };
}

test('opening layout is the full 22-ball snooker set', () => {
  const balls = initialBalls();
  assert.equal(balls.length, 22);
  assert.equal(balls.filter((b) => b.color === 'red').length, 15);
  assert.equal(balls.filter((b) => b.id === 'cue').length, 1);
  for (const colour of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) {
    assert.ok(balls.find((b) => b.id === colour), `${colour} is missing`);
  }
  // Every ball starts on the table and inside the cushions.
  for (const b of balls) {
    assert.equal(b.potted, false);
    assert.ok(b.x > 0 && b.x < TABLE.width, `${b.id} x out of bounds`);
    assert.ok(b.y > 0 && b.y < TABLE.height, `${b.id} y out of bounds`);
  }
});

test('physics is deterministic for the same inputs', () => {
  const shot = { angle: 0.03, power: 0.9 };
  const a = simulateShot(initialBalls(), shot);
  const b = simulateShot(initialBalls(), shot);
  assert.deepEqual(a.balls, b.balls);
  assert.equal(a.firstContact, b.firstContact);
  assert.equal(a.steps, b.steps);
});

test('break-off from the D contacts a red first', () => {
  const frame = newFrame();
  const { outcome } = resolveShot(frame, { angle: -0.02, power: 0.95 });
  assert.ok(outcome.firstContact?.startsWith('red'), `hit ${outcome.firstContact}`);
});

test('hitting nothing is a miss: 4 to the opponent and the turn passes', () => {
  // Cue ball alone, aimed down the table at nothing.
  const frame = sparseFrame({ cue: { x: 40, y: 30 } });
  frame.ballOn = 'red';
  const { state, outcome } = resolveShot(frame, { angle: 0, power: 0.3 });
  assert.equal(outcome.foul, true);
  assert.deepEqual(outcome.foulReasons, ['miss']);
  assert.equal(outcome.penalty, 4);
  assert.equal(state.scores[1], 4);
  assert.equal(state.turn, 1);
});

test('potting the cue ball is a foul and the cue ball comes back', () => {
  const pocket = POCKETS.find((p) => p.id === 'tl');
  const frame = sparseFrame({
    cue: { x: pocket.x + 25, y: pocket.y + 25 },
    red1: { x: 200, y: 150 },
  });
  frame.ballOn = 'red';
  const angle = Math.atan2(pocket.y - (pocket.y + 25), pocket.x - (pocket.x + 25));
  const { state, outcome } = resolveShot(frame, { angle, power: 0.5 });
  assert.equal(outcome.cuePotted, true);
  assert.equal(outcome.foul, true);
  assert.ok(outcome.foulReasons.includes('cue-ball-potted'));
  assert.equal(state.scores[1], 4);
  assert.equal(ballById(state, 'cue').potted, false, 'cue ball must be respotted');
  assert.equal(state.inHand, true);
});

test('hitting a colour when a red is on: penalty is the higher value, min 4', () => {
  const frame = sparseFrame({
    cue: { x: 100, y: 88.9 },
    black: { x: 180, y: 88.9 },
    red1: { x: 300, y: 20 },
  });
  frame.ballOn = 'red';
  const { state, outcome } = resolveShot(frame, { angle: 0, power: 0.45 });
  assert.equal(outcome.firstContact, 'black');
  assert.equal(outcome.foul, true);
  assert.ok(outcome.foulReasons.includes('wrong-ball-first'));
  assert.equal(outcome.penalty, 7, 'black is worth 7, which beats the minimum of 4');
  assert.equal(state.scores[1], 7);
});

test('potting a red scores 1, keeps the turn, and puts a colour on', () => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  // Line the red up straight at the bottom-right pocket.
  const red = { x: pocket.x - 60, y: pocket.y - 60 };
  const frame = sparseFrame({
    cue: { x: red.x - 40, y: red.y - 40 },
    red1: red,
  });
  frame.ballOn = 'red';
  const { state, outcome } = resolveShot(frame, { angle: Math.PI / 4, power: 0.55 });
  assert.equal(outcome.foul, false, `unexpected foul: ${outcome.foulReasons}`);
  assert.deepEqual(outcome.potted, ['red1']);
  assert.equal(outcome.pointsScored, 1);
  assert.equal(state.scores[0], 1);
  assert.equal(state.turn, 0, 'the striker keeps the table');
  assert.equal(state.ballOn, 'colour');
  assert.equal(state.currentBreak, 1);
});

test('a colour potted during the reds phase is respotted and a red is on again', () => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  const frame = sparseFrame({
    cue: { x: black.x - 40, y: black.y - 40 },
    black,
    red1: { x: 120, y: 30 },
  });
  frame.ballOn = 'colour';
  const { state, outcome } = resolveShot(frame, { angle: Math.PI / 4, power: 0.55 });
  assert.equal(outcome.foul, false, `unexpected foul: ${outcome.foulReasons}`);
  assert.equal(outcome.pointsScored, 7);
  assert.equal(state.scores[0], 7);
  assert.equal(ballById(state, 'black').potted, false, 'black must be respotted');
  assert.equal(state.ballOn, 'red');
});

test('shot clock expiry is scored exactly like a miss', () => {
  const frame = newFrame();
  const { state, outcome } = resolveTimeout(frame);
  assert.equal(outcome.foul, true);
  assert.deepEqual(outcome.foulReasons, ['shot-clock-expired']);
  assert.equal(state.scores[1], 4);
  assert.equal(state.turn, 1);
});

test('a break can never be recorded above the 147 maximum', () => {
  const frame = newFrame();
  frame.currentBreak = MAX_BREAK;
  frame.highBreaks = [MAX_BREAK, 0];
  const match = { ...newMatch([1, 2]), highBreaks: [200, 0] };
  const advanced = advanceMatch(match, { ...frame, ended: true, winner: 0, highBreaks: [200, 0] });
  assert.ok(advanced.highBreaks[0] <= MAX_BREAK);
});

test('best of 3: two frames ends the match', () => {
  let match = newMatch([10, 20]);
  const won = (winner) => ({ ...newFrame(match.frame.frame, 0), ended: true, winner, scores: winner === 0 ? [60, 10] : [10, 60], highBreaks: [20, 15] });
  match = advanceMatch(match, won(0));
  assert.equal(match.ended, false);
  assert.equal(match.frame.frame, 2, 'a new frame is racked');
  assert.equal(match.frame.balls.length, 22);
  match = advanceMatch(match, won(0));
  assert.equal(match.ended, true);
  assert.equal(match.winner, 0);
  assert.deepEqual(match.framesWon, [2, 0]);
});
