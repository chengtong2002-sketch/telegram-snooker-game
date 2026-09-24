/**
 * Revenue Monster Open API, over REST (docs/rm-payments-plan.md, section 2).
 *
 * Not the rm-api-sdk package: it pins axios 0.18 and has no webhook check. This
 * is node:crypto + fetch, and fetch is injected so tests run against a fake RM.
 *
 * SANDBOX ONLY. The two hosts below are constants on purpose: no setting can
 * point this at production, so going live is a code change with a review.
 *
 * Signing (RM "Signature Algorithm"): the body's keys sorted at every level,
 * compact JSON with < > & written as < > &, base64. Then
 *   data=<b64>&method=post&nonceStr=…&requestUrl=…&signType=sha256&timestamp=…
 * (data left out when there is no body, requestUrl left out on callbacks),
 * RSA-SHA256 with our private key, sent as `X-Signature: sha256 <base64>` with
 * X-Nonce-Str and X-Timestamp (UNIX seconds).
 */
import { createSign, createVerify, randomBytes } from 'node:crypto';

export const RM_OAUTH_URL = 'https://sb-oauth.revenuemonster.my/v1';
export const RM_OPEN_URL = 'https://sb-open.revenuemonster.my/v3';

/** An RM call that failed: RM's error code when it sent one, else HTTP or network. */
export class RmApiError extends Error {
  constructor(what, code, message, httpStatus = null) {
    super(`${what}: ${code}${message ? ` (${message})` : ''}`);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keys sorted at every depth; arrays keep their order. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

/** The exact JSON RM signs (and that we send, so the two can't differ). */
export const canonicalJson = (body) => JSON.stringify(sortKeys(body))
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

/** The plain text that is signed. `body` null/empty → no data part; `requestUrl` undefined → none. */
export function signingString({
  body = null, method, nonceStr, requestUrl, timestamp,
}) {
  const parts = [];
  if (isPlainObject(body) && Object.keys(body).length > 0) {
    parts.push(`data=${Buffer.from(canonicalJson(body)).toString('base64')}`);
  }
  parts.push(`method=${method.toLowerCase()}`, `nonceStr=${nonceStr}`);
  if (requestUrl !== undefined) parts.push(`requestUrl=${requestUrl}`);
  parts.push('signType=sha256', `timestamp=${timestamp}`);
  return parts.join('&');
}

export function sign(privateKey, parts) {
  return createSign('SHA256').update(signingString(parts)).sign(privateKey, 'base64');
}

export function verify(publicKey, parts, signature) {
  try {
    return createVerify('SHA256').update(signingString(parts)).verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * Check a callback RM sent us. The docs say requestUrl "can be" left out of a
 * callback's signature, so both forms are accepted — each is still RM's key
 * signing our exact body, nonce and time.
 *
 * Returns true only for a good signature. Nothing is credited on the strength
 * of it alone: the webhook then asks RM for the order (rmPayments.js).
 */
export function verifyCallback({
  publicKey, rawBody, headers, notifyUrl,
}) {
  const header = String(headers['x-signature'] ?? '');
  const nonceStr = String(headers['x-nonce-str'] ?? '');
  const timestamp = String(headers['x-timestamp'] ?? '');
  const match = /^sha256 (\S+)$/.exec(header);
  if (!match || !nonceStr || !timestamp) return false;
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (!isPlainObject(body)) return false;
  const base = {
    body, method: 'post', nonceStr, timestamp,
  };
  return verify(publicKey, base, match[1]) || verify(publicKey, { ...base, requestUrl: notifyUrl }, match[1]);
}

/**
 * When to fetch a new token: 80% of its life, or 10 minutes before it ends,
 * whichever is earlier. RM's docs disagree on the life (2 h vs 30 days); this
 * reads whatever expiresIn the answer carries.
 */
export const refreshAfterMs = (expiresInSec) => {
  const lifeMs = Math.max(0, Number(expiresInSec) || 0) * 1000;
  return Math.max(0, Math.min(lifeMs * 0.8, lifeMs - 10 * 60_000));
};

export function createRmClient({
  clientId, clientSecret, privateKey, fetch = globalThis.fetch, now = Date.now, timeoutMs = 15_000,
}) {
  let cached = null; // { token, refreshAt }
  let inflight = null;

  async function send(what, url, init) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new RmApiError(what, err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', null);
    }
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  async function fetchToken() {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const { res, body } = await send('token', `${RM_OAUTH_URL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${basic}` },
      body: JSON.stringify({ grantType: 'client_credentials' }),
    });
    if (!res.ok || !body?.accessToken) {
      throw new RmApiError('token', body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message, res.status);
    }
    cached = { token: body.accessToken, refreshAt: now() + refreshAfterMs(body.expiresIn) };
    return cached.token;
  }

  /** One token request however many callers ask at once. */
  function token() {
    if (cached && now() < cached.refreshAt) return Promise.resolve(cached.token);
    inflight ??= fetchToken().finally(() => { inflight = null; });
    return inflight;
  }

  async function call(what, method, path, body = null, { retried = false } = {}) {
    const requestUrl = `${RM_OPEN_URL}${path}`;
    const nonceStr = randomBytes(16).toString('hex'); // 32 characters
    const timestamp = String(Math.floor(now() / 1000));
    const signature = sign(privateKey, {
      body, method, nonceStr, requestUrl, timestamp,
    });
    const accessToken = await token();
    const { res, body: reply } = await send(what, requestUrl, {
      method: method.toUpperCase(),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-signature': `sha256 ${signature}`,
        'x-nonce-str': nonceStr,
        'x-timestamp': timestamp,
      },
      body: body ? canonicalJson(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      // A token RM no longer accepts (revoked, or its clock and ours disagree): once more with a new one.
      if (cached?.token === accessToken) cached = null;
      return call(what, method, path, body, { retried: true });
    }
    if (!res.ok || reply?.error || !reply) {
      throw new RmApiError(what, reply?.error?.code ?? `HTTP_${res.status}`, reply?.error?.message, res.status);
    }
    return reply.item ?? reply;
  }

  return {
    token,
    /** Hosted checkout → { checkoutId, url }. */
    createCheckout: (payload) => call('checkout', 'post', '/payment/online', payload),
    /**
     * The transaction for our order id, or null when RM has none (nobody has
     * paid yet, or the checkout was never opened).
     */
    async queryOrder(orderId) {
      try {
        return await call('query', 'get', `/payment/transaction/order/${encodeURIComponent(orderId)}`);
      } catch (err) {
        if (err instanceof RmApiError && (err.httpStatus === 404 || /NOT_FOUND/i.test(err.code))) return null;
        throw err;
      }
    },
    /** Refund all or part of a paid transaction. `amount` in sen. */
    refund: ({
      transactionId, amount, full, reason,
    }) => call('refund', 'post', '/payment/refund', {
      transactionId,
      refund: { type: full ? 'FULL' : 'PARTIAL', currencyType: 'MYR', amount },
      reason,
    }),
  };
}
