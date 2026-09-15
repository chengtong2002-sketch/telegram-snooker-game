import { newFrame, redsOnTable, ballById } from './state.js';
import {
  FRAMES_TO_WIN, MAX_BREAK, BALL_VALUES, COLOUR_ORDER,
} from './constants.js';

/**
 * Fold a finished frame into the match: award the frame, record the high break,
 * then either rack the next frame or end the match (best of 3).
 */
export function advanceMatch(match, frameState) {
  const next = structuredClone(match);
  next.frame = frameState;

  if (!frameState.ended) return next;

  const winner = frameState.winner;
  next.framesWon[winner] += 1;
  for (const p of [0, 1]) {
    next.highBreaks[p] = Math.min(MAX_BREAK, Math.max(next.highBreaks[p], frameState.highBreaks[p]));
  }
  next.frameHistory.push({
    frame: frameState.frame,
    scores: frameState.scores,
    winner,
    highBreaks: frameState.highBreaks,
  });

  if (next.framesWon[winner] >= FRAMES_TO_WIN) {
    next.ended = true;
    next.winner = winner;
    return next;
  }

  // Loser of the previous frame breaks the next one.
  next.frame = newFrame(frameState.frame + 1, 1 - winner);
  return next;
}

/**
 * The most points still available from pots in this frame, assuming the best
 * case: black after every remaining red, then the colours in sequence.
 *
 *   reds phase:   reds × (1 + 7) + (7 if a colour is on right now) + colours on the table
 *   colours phase: sum of the colours still on the table
 */
export function pointsRemaining(frame) {
  if (frame.ended) return 0;
  if (frame.phase === 'respotted-black') return BALL_VALUES.black;
  const colours = COLOUR_ORDER
    .filter((c) => ballById(frame, c)?.potted === false)
    .reduce((sum, c) => sum + BALL_VALUES[c], 0);
  if (frame.phase === 'colours') return colours;
  const colourOn = frame.ballOn === 'colour' ? BALL_VALUES.black : 0;
  return redsOnTable(frame) * (BALL_VALUES.red + BALL_VALUES.black) + colourOn + colours;
}

/**
 * True when `playerIdx` is behind by more than everything left on the table,
 * i.e. they can no longer win the frame by potting alone. Strictly greater: a
 * deficit exactly equal to what remains can still be levelled into a respotted
 * black.
 */
export function frameUnrecoverable(frame, playerIdx) {
  if (frame.ended) return false;
  const deficit = frame.scores[1 - playerIdx] - frame.scores[playerIdx];
  return deficit > pointsRemaining(frame);
}

/**
 * End the match now because `conceder` gave up. The frame score stays exactly
 * as it is — no frames are awarded for the concession.
 *
 * Breaks are kept: the frame in progress has not been folded into the match
 * yet (advanceMatch only does that when a frame ends), so fold it here. A break
 * the conceding player already made must stay eligible for rewards.
 */
export function concedeMatch(match, conceder) {
  const next = structuredClone(match);
  for (const p of [0, 1]) {
    next.highBreaks[p] = Math.min(MAX_BREAK, Math.max(next.highBreaks[p], next.frame.highBreaks[p]));
  }
  next.ended = true;
  next.winner = 1 - conceder;
  next.concededBy = conceder;
  delete next.checkpoint;
  return next;
}

/** Highest break either player made across the whole match, capped at 147. */
export function matchHighBreak(match) {
  return Math.min(MAX_BREAK, Math.max(match.highBreaks[0], match.highBreaks[1]));
}
