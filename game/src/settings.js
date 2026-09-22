/**
 * Player preferences, stored per device.
 *
 * localStorage, not CloudStorage: these are device-local choices (sound on a
 * phone in a quiet room), and every CloudStorage call is async and fails
 * outside a real Telegram client. Reads are wrapped because a Telegram webview
 * with site data blocked throws on access rather than returning null.
 */

const KEY = 'snooker.settings';

const DEFAULTS = { sound: true };

let cache = null;

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (raw) Object.assign(cache, JSON.parse(raw));
  } catch {
    // Blocked or corrupt: the defaults stand.
  }
  return cache;
}

export const settings = () => ({ ...load() });

export function setSetting(key, value) {
  const next = load();
  next[key] = value;
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not persisted, but honoured for this session.
  }
  return { ...next };
}

export const soundEnabled = () => load().sound !== false;

/* ---------- practice record ---------- */

/**
 * Practice results, on this device only.
 *
 * Practice is never reward-eligible and must never be reported as a match
 * result, so this deliberately does not go near the offline sync queue or any
 * endpoint. It is also the only practice history that exists — the server keeps
 * none — which is what lets a practice frame finish with no connection.
 */
const PRACTICE_KEY = 'snooker.practice';

const PRACTICE_DEFAULTS = { played: 0, framesWon: 0, bestBreak: 0 };

export function practiceRecord() {
  try {
    const raw = window.localStorage?.getItem(PRACTICE_KEY);
    if (raw) return { ...PRACTICE_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Blocked or corrupt storage: report an empty record.
  }
  return { ...PRACTICE_DEFAULTS };
}

/** @param {{framesWon: number[], highBreak: number}} result */
export function recordPracticeResult({ framesWon = [0, 0], highBreak = 0 } = {}) {
  const next = practiceRecord();
  next.played += 1;
  next.framesWon += Number(framesWon[0] ?? 0);
  next.bestBreak = Math.max(next.bestBreak, Number(highBreak ?? 0));
  try {
    window.localStorage?.setItem(PRACTICE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted; nothing downstream depends on it.
  }
  return next;
}
