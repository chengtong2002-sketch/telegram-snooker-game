import { newFrame } from './state.js';
import { FRAMES_TO_WIN, MAX_BREAK } from './constants.js';

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

/** Highest break either player made across the whole match, capped at 147. */
export function matchHighBreak(match) {
  return Math.min(MAX_BREAK, Math.max(match.highBreaks[0], match.highBreaks[1]));
}
