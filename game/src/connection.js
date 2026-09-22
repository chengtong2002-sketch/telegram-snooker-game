/**
 * Is the backend reachable?
 *
 * `navigator.onLine` is necessary but not sufficient: it reports whether the OS
 * has a link, not whether our server answers. Inside Telegram's webview it is
 * also unreliable — it has been seen stuck at `true` on a phone with no data.
 * So the real signal is our own traffic: api.js reports every request that
 * never reached the server (ApiError.offline) and every one that did, and while
 * we believe we are offline we probe /health until it answers.
 *
 * Nothing here blocks practice. Practice asks no questions of this module; only
 * the screens that genuinely need a server (PvP, Rewards) consult it.
 */

const PROBE_MS = 5000;

let online = true;
let probeTimer = null;
const listeners = new Set();

/** Probe with a plain fetch: going through api.js would recurse back into here. */
const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

export const isOnline = () => online;

function emit() {
  for (const fn of listeners) {
    try {
      fn(online);
    } catch {
      // A broken listener must not stop the others being told.
    }
  }
}

/**
 * Probe only while we think we are offline *and* something is listening.
 *
 * The lobby is the only listener, and it unsubscribes while the table has the
 * screen — which is what makes a practice frame genuinely zero-network. Nobody
 * is waiting on the answer during a frame, and the lobby re-probes the moment
 * it comes back.
 */
function updateProbing() {
  if (!online && listeners.size > 0) startProbing();
  else stopProbing();
}

function set(next) {
  if (next === online) return;
  online = next;
  updateProbing();
  emit();
}

export const markOnline = () => set(true);
export const markOffline = () => set(false);

/**
 * Subscribe to changes. Called immediately with the current state so a caller
 * never has to paint twice, and returns an unsubscribe.
 */
export function onConnectionChange(fn) {
  listeners.add(fn);
  updateProbing();
  fn(online);
  return () => {
    listeners.delete(fn);
    updateProbing();
  };
}

async function probe() {
  try {
    const res = await fetch(`${BASE}/api/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) markOnline();
  } catch {
    // Still down; the timer tries again.
  }
}

function startProbing() {
  if (probeTimer) return;
  probeTimer = setInterval(probe, PROBE_MS);
}

function stopProbing() {
  clearInterval(probeTimer);
  probeTimer = null;
}

/**
 * Start watching. The browser's own events are a useful *hint* — they fire
 * instantly, where a probe takes seconds — but only ever trigger a check, and
 * are never trusted on their own.
 */
export function startConnectionWatch({ assumeOffline = false } = {}) {
  window.addEventListener('offline', () => markOffline());
  window.addEventListener('online', () => {
    // The OS says there is a link; confirm the server agrees before re-enabling
    // anything, because a captive portal also looks like "online". Only when
    // someone is actually waiting on the answer: during a practice frame nobody
    // is, and the frame is supposed to touch the network zero times. The lobby
    // probes again as soon as it is back on screen.
    if (listeners.size > 0) probe();
  });
  if (assumeOffline || navigator.onLine === false) markOffline();
}
