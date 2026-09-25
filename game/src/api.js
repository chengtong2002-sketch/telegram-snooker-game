import { initData, themeUser } from './telegram.js';
import { markOnline, markOffline } from './connection.js';

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

let token = null;

export class ApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.status = status;
    // The server's JSON, for callers that branch on its reason code (the store).
    this.body = body;
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
    // Never reached the server: the most trustworthy offline signal there is.
    markOffline();
    throw new ApiError(err.name === 'TimeoutError' ? 'request timed out' : 'network unavailable', 0);
  }

  // It answered — even a 4xx/5xx proves the connection is back.
  markOnline();

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`bad response from server (${res.status})`, res.status);
  }
  if (!res.ok) throw new ApiError(json.error ?? `request failed (${res.status})`, res.status, json);
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
/** @param {'unrecoverable'|'checkpoint'|'menu'} via  which button it came from (logs only) */
export const concedeMatch = (id, via = 'menu') => request(`/match/${id}/concede`, { method: 'POST', body: { via } });
export const continueMatch = (id) => request(`/match/${id}/continue`, { method: 'POST' });

/**
 * Submit a shot. Only what the player did is sent — angle and power. The server
 * re-simulates and its answer overrides whatever the client animated.
 */
export const sendShot = (matchId, resultId, shot) =>
  request(`/match/${matchId}/shot`, { method: 'POST', body: { resultId, shot } });

/**
 * Live aim, display only (see aimSync.js). Fire and forget: nothing waits on
 * it, and it does not touch the online/offline badge — a dropped aim update
 * says nothing the shot and poll requests do not already say.
 */
export async function sendAim(matchId, aim) {
  if (!token) return;
  await fetch(`${BASE}/api/match/${matchId}/aim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(aim),
    signal: AbortSignal.timeout(3000),
  });
}

/** The opponent's aim as server-sent events. fetch, not EventSource: it has to carry the Bearer header. */
export const openAimStream = (matchId, signal) => fetch(`${BASE}/api/match/${matchId}/aim-stream`, {
  headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  signal,
});

export const syncResults =(results) => request('/sync', { method: 'POST', body: { results } });

export const leaderboard = (scope = 'period') => request(`/leaderboard?scope=${scope}`);

/** Career totals plus today's eligible-match allowance, for the lobby. */
export const stats = () => request('/stats');

export const walletChallenge = () => request('/wallet/challenge');
export const walletInfo = () => request('/wallet');
export const linkWallet = (payload) => request('/wallet/link', { method: 'POST', body: payload });

export const rewardPeriod = ({ closed = false } = {}) => request(`/rewards/period${closed ? '?closed=1' : ''}`);
export const rewardHistory = () => request('/rewards/history');
/** Closed periods still claimable, oldest first, each with its reward and expiry. */
export const rewardClaimable = () => request('/rewards/claimable');
/** Claims every claimable period at once. */
export const redeem = (requestId) => request('/rewards/redeem', { method: 'POST', body: { requestId } });

/** Catalog with prices, owned and equipped, the balance, and the coin packs. */
export const store = () => request('/store');
/** Owned cues and cue balls (Starter included), each with equipped / acquiredAt. */
export const inventory = () => request('/store/inventory');
/** One page of coin history, newest first; pass the previous page's `next` as `before`. */
export const coinHistory = (before = null) => request(`/store/history${before ? `?before=${before}` : ''}`);
/** Only the id is sent: the server prices the item. Answers with the whole store on success. */
export const buyItem = (itemId) => request('/store/buy', { method: 'POST', body: { itemId } });
/** @param {'cue'|'ball'} kind */
export const equipItem = (kind, itemId) => request('/store/equip', { method: 'POST', body: { kind, itemId } });

/** A Stars invoice for one coin pack. Only the pack id is sent: the server prices it. */
export const starsInvoice = (packId) => request('/payments/stars/invoice', { method: 'POST', body: { packId } });