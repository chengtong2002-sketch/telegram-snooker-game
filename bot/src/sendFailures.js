/**
 * Telling "this message will never be deliverable" apart from "try again".
 *
 * It decides what /internal/notify answers with, which is not cosmetic: a
 * permanent failure has to be a 200, because there is nothing for the backend
 * to chase and a 500 would only log a warning about a delivery that was never
 * going to happen. Everything else — a timeout, a 429, a 5xx from Telegram —
 * stays a 500 so a real delivery problem still shows up as one.
 *
 * Kept apart from notifications.js so it can be tested without starting a bot,
 * a server or a database.
 */

/**
 * Telegram wordings that mean the send will never succeed. The 403s are also
 * caught by the status code below; they are listed because the error does not
 * always arrive as a GrammyError with a code (a wrapped or re-thrown one may
 * carry only the message).
 */
const PERMANENT_MESSAGES = [
  // 403 Forbidden
  /bot was blocked by the user/i,
  /can't send messages to the bot/i,
  /bot can't initiate conversation with a user/i,
  /bot was kicked from the/i,
  /user is deactivated/i,
  // 400 Bad Request
  /chat not found/i,
];

/**
 * @param {unknown} err  what sendMessage threw
 * @returns {boolean} true when retrying could never help
 */
export function isPermanentSendFailure(err) {
  // 403 is Telegram's "not happening": the user blocked the bot, the bot was
  // removed from the chat, or the target is itself a bot. A retry changes none
  // of them, whatever the wording turns out to be.
  if (err?.error_code === 403) return true;
  const message = String(err?.message ?? '');
  return PERMANENT_MESSAGES.some((re) => re.test(message));
}
