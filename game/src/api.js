import { initData, themeUser } from './telegram.js';

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

let token = null;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    // 0 means "never reached the server", which is what the offline queue waits for.
    this.offline = status === 0;
  }
}

async function request(path, { method = 'GET', body, auth = true, timeout = 12_000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new ApiError(err.name === 'TimeoutError' ? 'request timed out' : 'network unavailable', 0);
  }

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`bad response from server (${res.status})`, res.status);
  }
  if (!res.ok) throw new ApiError(json.error ?? `request failed (${res.status})`, res.status);
  return json;
}

/**
 * Browser dev identity. `?dev=N` (1–99) picks a distinct player, so two phones
 * on the LAN can play PvP against each other; without it everyone is Dev 1,
 * and the queue never pairs a player with themselves.
 */
function devUser() {
  const n = Number(new URLSearchParams(window.location.search).get('dev') ?? 1);
  const slot = Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1;
  return { id: 999_000_000 + slot, first_name: `Dev ${slot}`, username: `dev${slot}` };
}

/** Exchange Telegram initData for a session token. */
export async function login() {
  const payload = initData()
    ? { initData: initData() }
    // Browser dev only; the backend accepts this only when ALLOW_DEV_AUTH is on.
    : { devUser: themeUser() ?? devUser() };
  const res = await request('/auth/telegram', { method: 'POST', body: payload, auth: false });
  token = res.token;
  return res.user;
}

export const hasSession = () => Boolean(token);

export const me = () => request('/auth/me');

export const joinQueue = () => request('/match/queue', { method: 'POST' });
export const leaveQueue = () => request('/match/queue', { method: 'DELETE' });
export const queueStatus = () => request('/match/queue');
export const getMatch = (id) => request(`/match/${id}`);
export const activeMatches = () => request('/match/active');
export const concedeMatch = (id) => request(`/match/${id}/concede`, { method: 'POST' });

/**
 * Submit a shot. Only what the player did is sent — angle and power. The server
 * re-simulates and its answer overrides whatever the client animated.
 */
export const sendShot = (matchId, resultId, shot) =>
  request(`/match/${matchId}/shot`, { method: 'POST', body: { resultId, shot } });

export const syncResults = (results) => request('/sync', { method: 'POST', body: { results } });

export const leaderboard = (scope = 'period') => request(`/leaderboard?scope=${scope}`);

export const walletChallenge = () => request('/wallet/challenge');
export const walletInfo = () => request('/wallet');
export const linkWallet = (payload) => request('/wallet/link', { method: 'POST', body: payload });

export const rewardPeriod = () => request('/rewards/period');
export const redeem = (requestId) => request('/rewards/redeem', { method: 'POST', body: { requestId } });
