import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData, MAX_INITDATA_AGE_SEC } from '../src/auth.js';

const BOT_TOKEN = '123456:test-token';

/** initData signed the way Telegram does, issued `ageSec` seconds ago. */
function signedInitData(ageSec) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - ageSec),
    query_id: 'AAE',
    user: JSON.stringify({ id: 42, first_name: 'Age' }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

test('Telegram sign-in data is accepted for one hour, not a day', () => {
  assert.equal(MAX_INITDATA_AGE_SEC, 60 * 60);
  assert.equal(verifyInitData(signedInitData(0), BOT_TOKEN).ok, true);
  assert.equal(verifyInitData(signedInitData(59 * 60), BOT_TOKEN).ok, true);

  const stale = verifyInitData(signedInitData(61 * 60), BOT_TOKEN);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /expired/);
  assert.equal(verifyInitData(signedInitData(12 * 60 * 60), BOT_TOKEN).ok, false, 'the old 24h window is gone');
});
