import { cloudStorage } from './telegram.js';
import * as api from './api.js';

/**
 * Offline-first result queue.
 *
 * Every result gets a client-generated resultId before it is ever sent. That id
 * is the dedupe key on the server, so replaying the queue after a dropped
 * connection can never double-apply a shot. Entries live in IndexedDB (with a
 * localStorage fallback) and are mirrored into Telegram CloudStorage, which
 * survives a cleared browser store and follows the player between devices.
 */

const DB_NAME = 'snooker';
const STORE = 'queue';
const LS_KEY = 'snooker.queue';
const MAX_ATTEMPTS = 12;
const BATCH = 20;

const cloudKey = (resultId) => `q_${resultId.replace(/-/g, '')}`.slice(0, 128);

export const newResultId = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// --- storage layer ---------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'resultId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    return undefined;
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const lsRead = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const lsWrite = (rows) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rows));
  } catch {
    // Storage full or blocked: the CloudStorage mirror is the backstop.
  }
};

async function readAll() {
  const db = await openDb();
  if (db) {
    try {
      return (await tx(db, 'readonly', (s) => s.getAll())) ?? [];
    } catch {
      return lsRead();
    }
  }
  return lsRead();
}

async function put(entry) {
  const db = await openDb();
  if (db) {
    try {
      await tx(db, 'readwrite', (s) => s.put(entry));
    } catch {
      lsWrite([...lsRead().filter((e) => e.resultId !== entry.resultId), entry]);
    }
  } else {
    lsWrite([...lsRead().filter((e) => e.resultId !== entry.resultId), entry]);
  }
  if (cloudStorage) await cloudStorage.set(cloudKey(entry.resultId), JSON.stringify(entry));
}

async function drop(resultId) {
  const db = await openDb();
  if (db) {
    try {
      await tx(db, 'readwrite', (s) => s.delete(resultId));
    } catch {
      lsWrite(lsRead().filter((e) => e.resultId !== resultId));
    }
  } else {
    lsWrite(lsRead().filter((e) => e.resultId !== resultId));
  }
  if (cloudStorage) await cloudStorage.remove(cloudKey(resultId));
}

// --- queue -----------------------------------------------------------------

const listeners = new Set();
let syncing = false;
let timer = null;

const notify = async () => {
  const pending = await readAll();
  for (const fn of listeners) fn(pending.length);
};

export const onQueueChange = (fn) => {
  listeners.add(fn);
  notify();
  return () => listeners.delete(fn);
};

/** Persist a result before attempting to send it. Returns the stored entry. */
export async function enqueue({ resultId = newResultId(), kind, matchId = null, payload }) {
  const entry = { resultId, kind, matchId, payload, createdAt: Date.now(), attempts: 0 };
  await put(entry);
  await notify();
  return entry;
}

export async function pendingCount() {
  return (await readAll()).length;
}

/**
 * Push everything queued at the server, oldest first.
 * Returns the per-entry outcomes so a caller that is waiting on a specific
 * shot can pick its own result out of the batch.
 */
export async function flush() {
  if (syncing || !navigator.onLine || !api.hasSession()) return [];
  const all = (await readAll()).sort((a, b) => a.createdAt - b.createdAt);
  if (all.length === 0) return [];

  syncing = true;
  const settled = [];
  try {
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      let res;
      try {
        res = await api.syncResults(batch.map(({ resultId, kind, matchId, payload }) => ({
          resultId, kind, matchId, payload,
        })));
      } catch (err) {
        // Network still down, or the server is unhappy: keep everything and
        // count the attempt so a poison entry eventually gets dropped.
        for (const entry of batch) {
          const attempts = entry.attempts + 1;
          if (attempts >= MAX_ATTEMPTS && !err.offline) await drop(entry.resultId);
          else await put({ ...entry, attempts, lastError: err.message });
        }
        break;
      }
      for (const result of res.results ?? []) {
        if (['applied', 'ok', 'duplicate', 'rejected'].includes(result.status)) {
          await drop(result.resultId);
          settled.push(result);
        } else {
          const entry = batch.find((e) => e.resultId === result.resultId);
          if (entry) await put({ ...entry, attempts: entry.attempts + 1, lastError: result.reason });
        }
      }
    }
  } finally {
    syncing = false;
    await notify();
  }
  return settled;
}

/** Background sync: on reconnect, on tab focus, and on a slow timer. */
export function startAutoSync(intervalMs = 20_000) {
  if (timer) return;
  const kick = () => { flush().catch(() => {}); };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  timer = setInterval(kick, intervalMs);
  kick();
}

/** Pull any entries CloudStorage knows about that this device does not. */
export async function restoreFromCloud(resultIds = []) {
  if (!cloudStorage || resultIds.length === 0) return 0;
  let restored = 0;
  for (const id of resultIds) {
    const raw = await cloudStorage.get(cloudKey(id));
    if (!raw) continue;
    try {
      await put(JSON.parse(raw));
      restored += 1;
    } catch {
      // Corrupt mirror entry; ignore it.
    }
  }
  await notify();
  return restored;
}
