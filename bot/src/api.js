import { config } from './config.js';

/** Thin client for the backend's /internal endpoints (shared-secret auth). */
async function call(path, body, { timeoutMs = 8000 } = {}) {
  const res = await fetch(`${config.backendUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': config.internalApiKey,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`backend returned non-JSON (${res.status})`);
  }
  if (!res.ok) throw new Error(json.error ?? `backend ${res.status}`);
  return json;
}

const telegramUser = (from) => ({
  id: from.id,
  username: from.username,
  first_name: from.first_name,
  language_code: from.language_code,
});

export const joinQueue = (from) => call('/internal/queue/join', { telegramUser: telegramUser(from) });
export const leaveQueue = (from) => call('/internal/queue/leave', { telegramUser: telegramUser(from) });
export const status = (from) => call('/internal/status', { telegramUser: telegramUser(from) });

