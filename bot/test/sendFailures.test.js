import test from 'node:test';
import assert from 'node:assert/strict';

import { isPermanentSendFailure } from '../src/sendFailures.js';

/**
 * Shaped like what grammY throws: the message it builds, plus Telegram's own
 * code and description. The wordings below are the ones the live API returned
 * when probed with @snookerPlayBot, not invented examples.
 */
const grammyError = (code, description) => Object.assign(
  new Error(`Call to 'sendMessage' failed! (${code}: ${description})`),
  { error_code: code, description, method: 'sendMessage', ok: false },
);

test('a user who blocked the bot is permanent', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(403, 'Forbidden: bot was blocked by the user')),
    true,
  );
});

test('a send aimed at another bot is permanent', () => {
  // What a player row carrying a bot's own telegram id produces. Retrying it
  // forever would block nothing else, but it would log a warning every time.
  assert.equal(
    isPermanentSendFailure(grammyError(403, "Forbidden: the bot can't send messages to the bot")),
    true,
  );
});

test('a chat that does not exist is permanent', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(400, 'Bad Request: chat not found')),
    true,
  );
});

test('a deactivated account is permanent', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(403, 'Forbidden: user is deactivated')),
    true,
  );
});

test('any 403 is permanent, whatever the wording turns out to be', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(403, 'Forbidden: something new Telegram added')),
    true,
  );
});

test('the wording alone is enough when the code did not survive', () => {
  // A re-thrown or wrapped error can arrive with the message and nothing else.
  assert.equal(
    isPermanentSendFailure(new Error('Forbidden: bot was blocked by the user')),
    true,
  );
});

test('rate limiting is not permanent', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(429, 'Too Many Requests: retry after 30')),
    false,
  );
});

test('a Telegram outage is not permanent', () => {
  assert.equal(
    isPermanentSendFailure(grammyError(500, 'Internal Server Error')),
    false,
  );
});

test('a network failure is not permanent', () => {
  assert.equal(isPermanentSendFailure(new Error('fetch failed')), false);
});

test('nothing at all is not permanent', () => {
  assert.equal(isPermanentSendFailure(undefined), false);
  assert.equal(isPermanentSendFailure(null), false);
});
