/**
 * Telegram Login Widget, for the web top-up page (docs/topup-web-plan.md).
 *
 * Not the Mini App's initData check (auth.js): a different key and a different
 * shape, so data made for one never passes the other.
 *   secret = SHA256(bot_token)
 *   hash   = hex(HMAC_SHA256(secret, data_check_string))
 * data_check_string is every received field but `hash`, sorted, `key=value`
 * joined by "\n" (core.telegram.org/widgets/login-legacy).
 *
 * This file is the only thing to change if the page moves to Telegram's newer
 * OpenID Connect login.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

/** The page posts right after Telegram's redirect, so a login is only good for a few minutes. */
export const MAX_LOGIN_AGE_SEC = 10 * 60;
/** A little slack for a phone clock that runs ahead. */
const FUTURE_SLACK_SEC = 60;

/** The fields the widget sends. Anything else is refused, so nothing extra rides into the signed text. */
const FIELDS = new Set(['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']);

/**
 * @param {Record<string, unknown>} data the widget's fields, as Telegram sent them
 * @returns {{ok: true, telegramId: string, firstName: string, username: string|null}
 *   | {ok: false, reason: string}}
 */
export function verifyLoginWidget(data, { botToken = config.botToken, now = Date.now() } = {}) {
  if (!botToken) return { ok: false, reason: 'server has no BOT_TOKEN' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'no login data' };

  const entries = Object.entries(data);
  if (entries.some(([k, v]) => !FIELDS.has(k) || (typeof v !== 'string' && typeof v !== 'number'))) {
    return { ok: false, reason: 'unexpected login field' };
  }
  const hash = typeof data.hash === 'string' ? data.hash : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'missing hash' };

  const dataCheckString = entries
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad signature' };

  const authDate = Number(data.auth_date);
  const age = now / 1000 - authDate;
  if (!Number.isSafeInteger(authDate) || age > MAX_LOGIN_AGE_SEC || age < -FUTURE_SLACK_SEC) {
    return { ok: false, reason: 'login expired' };
  }
  const telegramId = String(data.id ?? '');
  if (!/^\d{1,20}$/.test(telegramId)) return { ok: false, reason: 'no user in login' };

  return {
    ok: true,
    telegramId,
    firstName: String(data.first_name ?? ''),
    username: data.username ? String(data.username) : null,
  };
}
