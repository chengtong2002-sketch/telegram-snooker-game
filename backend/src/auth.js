import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { upsertUser, userById } from '@snooker/db';

// Telegram issues fresh initData every time the Mini App opens, so a real
// client never needs old data. Short-lived means a leaked copy (logs, a
// screenshot, an extension) stops working within the hour.
export const MAX_INITDATA_AGE_SEC = 60 * 60;

/**
 * Verify a Telegram WebApp initData string.
 * secret = HMAC_SHA256("WebAppData", botToken); hash = HMAC_SHA256(secret, dataCheckString).
 *
 * @returns {{ok:true, user:object, authDate:number} | {ok:false, reason:string}}
 */
export function verifyInitData(initData, botToken = config.botToken) {
  if (!initData) return { ok: false, reason: 'missing initData' };
  if (!botToken) return { ok: false, reason: 'server has no BOT_TOKEN' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing hash' };
  // Only `hash` is left out. `signature` (Telegram's Ed25519 field, sent by
  // current clients) IS covered by the HMAC — it is excluded solely from the
  // separate third-party Ed25519 check. Dropping it here rejected every real
  // sign-in with "bad signature".
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > MAX_INITDATA_AGE_SEC) {
    return { ok: false, reason: 'initData expired' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    return { ok: false, reason: 'unparseable user' };
  }
  if (!user?.id) return { ok: false, reason: 'no user in initData' };

  return { ok: true, user, authDate };
}

export async function issueSession(telegramUser) {
  const user = await upsertUser(telegramUser);
  const token = jwt.sign(
    { sub: String(user.id), tg: String(user.telegram_id) },
    config.jwtSecret,
    { expiresIn: config.jwtTtl },
  );
  return { token, user };
}

/**
 * The web top-up page's session (docs/topup-web-plan.md, decision 4): 30
 * minutes, and scoped, so it opens the top-up routes and nothing else. A
 * leaked one cannot play, concede, link a wallet or claim rewards.
 */
export const TOPUP_SCOPE = 'topup';
export const TOPUP_SESSION_SEC = 30 * 60;

export function issueTopupSession(user) {
  const token = jwt.sign(
    { sub: String(user.id), tg: String(user.telegram_id), scope: TOPUP_SCOPE },
    config.jwtSecret,
    { expiresIn: TOPUP_SESSION_SEC },
  );
  return { token, expiresAt: new Date(Date.now() + TOPUP_SESSION_SEC * 1000).toISOString() };
}

/** A bearer guard for tokens of one scope (undefined = the Mini App's). Attaches req.user. */
const bearerGuard = (scope) => async (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.scope !== scope) return res.status(401).json({ error: 'this token is not for this route' });
    const user = await userById(Number(payload.sub));
    if (!user) return res.status(401).json({ error: 'unknown user' });
    if (user.banned) return res.status(403).json({ error: 'account suspended' });
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
};

/** Bearer-token guard for everything the Mini App calls. Refuses top-up tokens. */
export const requireAuth = bearerGuard(undefined);
/** The top-up page's routes only. Refuses the Mini App's tokens. */
export const requireTopupAuth = bearerGuard(TOPUP_SCOPE);

/** Shared-secret guard for bot -> backend calls. */
export function requireInternal(req, res, next) {
  const key = Buffer.from(req.get('x-internal-key') ?? '');
  const expected = Buffer.from(config.internalApiKey);
  // An empty INTERNAL_API_KEY must not let an empty header through.
  if (expected.length === 0 || key.length !== expected.length || !crypto.timingSafeEqual(key, expected)) {
    return res.status(401).json({ error: 'bad internal key' });
  }
  return next();
}
