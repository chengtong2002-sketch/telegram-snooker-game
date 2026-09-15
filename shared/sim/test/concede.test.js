import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newFrame, newMatch, ballById, pointsRemaining, frameUnrecoverable, concedeMatch,
} from '../src/index.js';

const potReds = (frame, n) => {
  frame.balls.filter((b) => b.color === 'red').slice(0, n).forEach((b) => { b.potted = true; });
  return frame;
};

test('a fresh frame has 147 points available', () => {
  assert.equal(pointsRemaining(newFrame()), 15 * 8 + 27);
});

test('a colour on after a red adds a black to what remains', () => {
  const frame = potReds(newFrame(), 1);
  frame.ballOn = 'colour';
  assert.equal(pointsRemaining(frame), 14 * 8 + 7 + 27);
});

test('last red just potted: its colour plus all six colours remain', () => {
  const frame = potReds(newFrame(), 15);
  frame.ballOn = 'colour';
  assert.equal(pointsRemaining(frame), 7 + 27);
});

test('colours phase counts only the colours still on the table', () => {
  const frame = potReds(newFrame(), 15);
  frame.phase = 'colours';
  for (const c of ['yellow', 'green', 'brown']) ballById(frame, c).potted = true;
  frame.ballOn = 'blue';
  assert.equal(pointsRemaining(frame), 5 + 6 + 7);
});

test('unrecoverable only once the deficit is strictly greater than what remains', () => {
  const frame = potReds(newFrame(), 15);
  frame.phase = 'colours';
  for (const c of ['yellow', 'green', 'brown', 'blue', 'pink']) ballById(frame, c).potted = true;
  frame.ballOn = 'black'; // 7 left

  frame.scores = [50, 57]; // behind by exactly 7: black ties it, respotted black
  assert.equal(frameUnrecoverable(frame, 0), false);

  frame.scores = [50, 58]; // behind by 8 with 7 on the table
  assert.equal(frameUnrecoverable(frame, 0), true);
  assert.equal(frameUnrecoverable(frame, 1), false, 'the leader never gets the option');
});

test('early in a frame a big deficit is still recoverable', () => {
  const frame = newFrame();
  frame.scores = [0, 60];
  assert.equal(frameUnrecoverable(frame, 0), false);
});

test('conceding keeps the frame score and hands the match to the opponent', () => {
  const match = newMatch([1, 2]);
  match.framesWon = [1, 0];
  const done = concedeMatch(match, 0);
  assert.equal(done.ended, true);
  assert.equal(done.winner, 1);
  assert.equal(done.concededBy, 0);
  assert.deepEqual(done.framesWon, [1, 0], 'no frames are awarded for a concession');
});

test('conceding mid-frame keeps a break made in that frame, including the conceder\'s', () => {
  const match = newMatch([1, 2]);
  match.highBreaks = [12, 30];     // from earlier frames
  match.frame.highBreaks = [45, 8]; // this frame, not folded in yet
  const done = concedeMatch(match, 0);
  assert.deepEqual(done.highBreaks, [45, 30]);
});

test('conceding clears a pending checkpoint', () => {
  const match = newMatch([1, 2]);
  match.checkpoint = { frame: 1, trailing: 0, deadline: new Date().toISOString() };
  assert.equal('checkpoint' in concedeMatch(match, 0), false);
});
