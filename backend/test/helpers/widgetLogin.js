/**
 * Telegram Login Widget data, signed the way Telegram signs it
 * (core.telegram.org/widgets/login-legacy), for tests of the web top-up login.
 */
import crypto from 'node:crypto';

export function signWidget(fields, botToken) {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  return { ...fields, hash: crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex') };
}

/** A realistic login for telegram id `id`, signed now (or `authDate`). */
export const widgetLoginFor = (id, botToken, { authDate = Math.floor(Date.now() / 1000), ...extra } = {}) => signWidget({
  id: String(id),
  first_name: `W${id}`,
  username: `user_${id}`,
  photo_url: 'https://t.me/i/userpic/320/abc.jpg',
  auth_date: String(authDate),
  ...extra,
}, botToken);
