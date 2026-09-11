/** Thin wrapper over the Telegram WebApp SDK so the game also runs in a plain browser. */

const tg = window.Telegram?.WebApp ?? null;

export const isTelegram = () => Boolean(tg?.initData);

export function initTelegram() {
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
  attempt(() => tg.lockOrientation?.('landscape'));
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
  return {
    mode: params.get('mode') ?? 'practice',
    matchId: params.get('match') ?? null,
    screen: params.get('screen') ?? null,
  };
}

export function haptic(kind = 'light') {
  const h = tg?.HapticFeedback;
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
export const cloudStorage = tg?.CloudStorage
  ? {
    get: (key) => new Promise((resolve) => {
      tg.CloudStorage.getItem(key, (err, value) => resolve(err ? null : value));
    }),
    set: (key, value) => new Promise((resolve) => {
      tg.CloudStorage.setItem(key, value, (err) => resolve(!err));
    }),
    remove: (key) => new Promise((resolve) => {
      tg.CloudStorage.removeItem(key, (err) => resolve(!err));
    }),
  }
  : null;
