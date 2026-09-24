import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Fire-and-forget push to the bot process, which turns it into a Telegram
 * message. Deliberately non-blocking: a notification failure must never fail
 * the shot that triggered it.
 */
export async function notifyBot(event) {
  try {
    const res = await fetch(config.botNotifyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': config.internalApiKey,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, event: event.type }, 'bot notify rejected');
    }
  } catch (err) {
    logger.warn({ err: err.message, event: event.type }, 'bot notify failed');
  }
}

export const notifyYourTurn = (match, userId, extra = {}) =>
  notifyBot({ type: 'your-turn', matchId: match.id, userId, ...extra });

export const notifyMatchOver = (match, userId, extra = {}) =>
  notifyBot({ type: 'match-over', matchId: match.id, userId, ...extra });

/** Both players let the shot clock run out in turn: no winner, no reward. */
export const notifyMatchAbandoned = (match, userId, extra = {}) =>
  notifyBot({ type: 'match-abandoned', matchId: match.id, userId, ...extra });

export const notifyFrameCheckpoint = (match, userId, extra = {}) =>
  notifyBot({ type: 'frame-checkpoint', matchId: match.id, userId, ...extra });

/** The payout wallet was linked, changed or unlinked. Not tied to a match. */
export const notifyWalletChanged = (userId, extra = {}) =>
  notifyBot({ type: 'wallet-changed', userId, ...extra });

export const notifyMatched = (match, userId, extra = {}) =>
  notifyBot({ type: 'matched', matchId: match.id, userId, ...extra });
