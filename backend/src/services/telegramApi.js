import { config } from '../config.js';

/** A Bot API call that Telegram answered with ok: false (or not at all). */
export class TelegramApiError extends Error {
  constructor(method, description, code = null) {
    super(`${method}: ${description}`);
    this.method = method;
    this.description = description;
    this.code = code;
  }
}

/**
 * Call the Bot API as the bot. The backend holds the same BOT_TOKEN (it checks
 * initData with it), so payments that must be answered from here — invoice
 * links, refunds, the transaction list — do not go through the bot process.
 */
export async function callBotApi(method, params = {}, { timeoutMs = 10_000 } = {}) {
  if (!config.botToken) throw new TelegramApiError(method, 'BOT_TOKEN is not set');
  const url = `${config.telegram.apiRoot}/bot${config.botToken}${config.telegram.testEnv ? '/test' : ''}/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Never echo the URL: it holds the token.
    throw new TelegramApiError(method, `request failed: ${err.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
  }
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new TelegramApiError(method, body?.description ?? `HTTP ${res.status}`, body?.error_code ?? res.status);
  return body.result;
}
