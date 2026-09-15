import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { verifyInitData } = await import('../src/auth.js');

const BOT_TOKEN = '123456:TEST-token';

/**
 * Build initData the way Telegram does: HMAC over every field except `hash`,
 * sorted, as raw (URL-decoded) values.
 */
function sign(fields, token = BOT_TOKEN) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

// Shaped like a current client's payload: a `signature` field, chat fields,
// and a user JSON with escaped slashes that must not be re-serialised.
const realistic = () => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  chat_instance: '-4938301284719',
  chat_type: 'private',
  query_id: 'AAHxZ2dJAAAAAPFnZ0kbGgQX',
  signature: 'Qf7Ht9n3kQm1lP0yZx8rVb2cWd6eFg4hJk5LmNo7pQr8sTu9vWx0yZ1aBc2dEf3gHi4jKl5mNo6pQr7sTu8vAw',
  user: '{"id":7625262769,"first_name":"Nicholas","language_code":"en","allows_write_to_pm":true,"photo_url":"https:\\/\\/t.me\\/i\\/userpic\\/320\\/abc.svg"}',
});

test('real-client initData with a signature field verifies', () => {
  const result = verifyInitData(sign(realistic()), BOT_TOKEN);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.user.id, 7625262769);
});

test('older initData without a signature field still verifies', () => {
  const { signature, ...fields } = realistic();
  assert.equal(verifyInitData(sign(fields), BOT_TOKEN).ok, true);
});

test('tampering with the signature field breaks the hash', () => {
  const params = new URLSearchParams(sign(realistic()));
  params.set('signature', 'forged');
  assert.deepEqual(verifyInitData(params.toString(), BOT_TOKEN), { ok: false, reason: 'bad signature' });
});

test('initData signed for a different bot is rejected', () => {
  const result = verifyInitData(sign(realistic(), '999:OTHER-bot'), BOT_TOKEN);
  assert.deepEqual(result, { ok: false, reason: 'bad signature' });
});

test('tampering with the user is rejected', () => {
  const params = new URLSearchParams(sign(realistic()));
  params.set('user', params.get('user').replace('7625262769', '1'));
  assert.equal(verifyInitData(params.toString(), BOT_TOKEN).ok, false);
});
