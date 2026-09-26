/** Thin wrapper over the Telegram WebApp SDK so the game also runs in a plain browser. */
import { deviceKind as browserDeviceKind } from './topup/logic.js';

const tg = window.Telegram?.WebApp ?? null;

export const isTelegram = () => Boolean(tg?.initData);

/**
 * @param {object} [opts]
 * @param {boolean} [opts.landscape=true]  the table screens want landscape; the
 *   wallet screen works in either orientation and should not lock anything.
 */
export function initTelegram({ landscape = true } = {}) {
  if (!tg) return;
  tg.ready();
  tg.expand();

  // The SDK script loads fine in a plain browser but every one of these logs a
  // console error when there is no real Telegram client behind it. Only ask for
  // them when we are actually running inside Telegram.
  if (!isTelegram()) return;

  const attempt = (fn) => {
    try {
      fn();
    } catch {
      // Older clients simply do not have these; none of them are essential.
    }
  };
  attempt(() => tg.requestFullscreen?.());
  attempt(() => tg.setHeaderColor?.('#16211d'));
  attempt(() => tg.setBackgroundColor?.('#0e1512'));
  attempt(() => tg.disableVerticalSwipes?.());

  // lockOrientation() takes no argument: it locks whatever orientation the app
  // is in *right now*. Players open the Mini App holding the phone upright, so
  // locking at startup pinned it to portrait and rotating did nothing — they
  // were stuck on "Turn your phone sideways". Unlock first (Telegram can carry
  // a lock over from an earlier session), then lock once actually landscape so
  // tilting the phone mid-shot does not flip the table.
  attempt(() => tg.unlockOrientation?.());
  if (landscape) preferLandscape();
}

let landscapeWatch = false;

/**
 * The table wants landscape: lock orientation as soon as the phone is actually
 * landscape. Called at startup for table screens, or later when a non-table
 * screen (wallet) hands over to the table.
 */
export function preferLandscape() {
  if (landscapeWatch || !isTelegram() || !tg.isVersionAtLeast?.('8.0')) return;
  landscapeWatch = true;
  const query = window.matchMedia('(orientation: landscape)');
  const lockIfLandscape = () => {
    if (!query.matches || tg.isOrientationLocked) return;
    try {
      tg.lockOrientation();
    } catch {
      // Best-effort, like the other SDK calls in initTelegram().
    }
  };
  query.addEventListener('change', lockIfLandscape);
  lockIfLandscape();
}

export const initData = () => tg?.initData ?? '';
export const initDataUnsafe = () => tg?.initDataUnsafe ?? {};

export function launchParams() {
  const url = new URL(window.location.href);
  const fromStartParam = initDataUnsafe()?.start_param ?? '';
  const params = new URLSearchParams(url.search);
  // Deep links from the bot arrive either as query params (webApp buttons) or
  // as a start_param like "pvp_<matchId>".
  if (fromStartParam.startsWith('pvp_')) {
    params.set('mode', 'pvp');
    params.set('match', fromStartParam.slice(4));
  }
  // "store", or back from a Revenue Monster checkout: "store_<orderId>".
  const store = /^store(?:_(rm[0-9a-f]{22}))?$/.exec(fromStartParam);
  if (store) {
    params.set('screen', 'store');
    if (store[1]) params.set('order', store[1]);
  }
  return {
    // null means "opened with no deep link", which lands on the lobby. Every
    // bot button sets mode (or screen), so those still go straight to the mode
    // they name and never see the lobby.
    mode: params.get('mode'),
    matchId: params.get('match') ?? null,
    screen: params.get('screen') ?? null,
    // A coin order to follow on the store screen (screen=store).
    orderId: params.get('order') ?? null,
  };
}

export function haptic(kind = 'light') {
  // Same as initTelegram(): outside a real client the SDK warns on every call.
  const h = isTelegram() ? tg.HapticFeedback : null;
  if (!h) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
    else h.impactOccurred(kind);
  } catch {
    // Haptics are best-effort.
  }
}

export function showBackButton(onClick) {
  if (!tg?.BackButton) return () => {};
  tg.BackButton.show();
  tg.BackButton.onClick(onClick);
  return () => {
    tg.BackButton.offClick(onClick);
    tg.BackButton.hide();
  };
}

export const close = () => tg?.close?.();

export const themeUser = () => initDataUnsafe()?.user ?? null;

/**
 * Telegram CloudStorage, promisified. Returns null when unavailable (browser
 * dev, or an old client) so callers can fall back to IndexedDB.
 */
// The SDK defines CloudStorage everywhere, but outside a real client (and in
// clients older than 6.9) every method throws WebAppMethodUnsupported, so the
// object's mere presence says nothing.
const cloudStorageWorks = isTelegram() && (tg.isVersionAtLeast?.('6.9') ?? false) && Boolean(tg.CloudStorage);

/** Call a CloudStorage method, resolving `failed` instead of throwing. */
const callCloud = (method, args, onResult, failed) => new Promise((resolve) => {
  try {
    tg.CloudStorage[method](...args, (err, value) => resolve(onResult(err, value)));
  } catch {
    resolve(failed);
  }
});

export const cloudStorage = cloudStorageWorks
  ? {
    get: (key) => callCloud('getItem', [key], (err, value) => (err ? null : value), null),
    set: (key, value) => callCloud('setItem', [key, value], (err) => !err, false),
    remove: (key) => callCloud('removeItem', [key], (err) => !err, false),
  }
  : null;

/**
 * Open a web page outside the Mini App: RM's checkout belongs in the browser,
 * not the webview (the TNG hand-off and bank redirects expect a real browser).
 */
export function openExternal(url) {
  if (isTelegram() && typeof tg.openLink === 'function') {
    try {
      tg.openLink(url);
      return;
    } catch {
      // Fall through to the plain browser way.
    }
  }
  window.open(url, '_blank', 'noopener');
}

const PHONE_PLATFORMS = new Set(['ios', 'android', 'android_x']);

/**
 * Phone or computer, for RM's checkout layout: a phone gets the TNG app, a
 * computer a QR code to scan. Telegram names its own platform; outside it
 * (or when it says 'unknown'), the browser's user agent decides.
 */
export function deviceKind() {
  const platform = tg?.platform;
  if (PHONE_PLATFORMS.has(platform)) return 'mobile';
  if (platform && platform !== 'unknown') return 'desktop';
  return browserDeviceKind(navigator.userAgent, navigator.maxTouchPoints);
}
