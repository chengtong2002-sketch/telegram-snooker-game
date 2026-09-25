/**
 * The web top-up page (docs/topup-web-plan.md): Telegram login, a coin pack,
 * Touch 'n Go through Revenue Monster, and the done screen.
 *
 * Nothing here credits coins or decides a price: the server prices every pack,
 * and coins arrive only when RM itself confirms the payment to the server.
 * Whatever RM appends to the return URL is never read.
 *
 * Built from DOM nodes: no server value is ever parsed as HTML.
 */
import {
  widgetLogin, withoutWidgetFields, deviceKind, myr, fmt, liveSession, orderFromQuery, orderMessage, SETTLED,
} from './logic.js';

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
const BOT = import.meta.env.VITE_BOT_USERNAME || 'snookerPlayBot';
const GAME_LINK = `https://t.me/${BOT}/play`;
const STORE_KEY = 'snooker.topup';
const POLL_MS = 2000;
const POLL_FOR_MS = 2 * 60_000;

const screen = document.getElementById('screen');
const who = document.getElementById('who');

/** For the smoke driver: which screen is showing. */
const debug = { screen: 'boot' };
window.__topupDebug = debug;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(name, ...children) {
  debug.screen = name;
  screen.replaceChildren(...children);
}

/* ---------- the session (30 min, top-up routes only) ---------- */

function loadSession() {
  try {
    return liveSession(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}
function saveSession(session) {
  try {
    if (session) localStorage.setItem(STORE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Private mode: the session lasts as long as the page.
  }
}
let session = loadSession();

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(`${BASE}/api/topup${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON: judged by the status below.
  }
  if (!res.ok) {
    if (res.status === 401 && session && path !== '/login') {
      session = null;
      saveSession(null);
    }
    throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

/* ---------- pieces ---------- */

function backToGame(label = 'Back to game') {
  const a = el('a', 'btn btn-game', label);
  a.href = GAME_LINK;
  return a;
}

function setWho(user, balance) {
  if (!user) {
    who.hidden = true;
    who.replaceChildren();
    return;
  }
  const name = el('b', null, user.firstName || (user.username ? `@${user.username}` : 'Player'));
  const bal = el('span', null, `${fmt(balance)} coins`);
  bal.id = 'who-balance';
  who.replaceChildren(name, bal);
  who.hidden = false;
}

/** Telegram's login button. Telegram sends the player back to `returnTo` with the login in the query. */
function loginButton(returnTo) {
  const box = el('div', 'login');
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.dataset.telegramLogin = BOT;
  script.dataset.size = 'large';
  script.dataset.radius = '10';
  script.dataset.authUrl = returnTo;
  box.append(script);
  return box;
}

const here = () => `${window.location.origin}${window.location.pathname}${withoutWidgetFields(window.location.search)}`;

function packList(packs, { onPay = null } = {}) {
  const list = el('ul', 'packs');
  for (const pack of packs) {
    const li = el('li', 'pack');
    const coins = el('div', 'pack-coins', `${fmt(pack.coins)} coins`);
    const price = el('button', 'btn-pay', myr(pack.myrSen));
    price.dataset.pack = pack.id;
    price.setAttribute('aria-label', `Buy ${fmt(pack.coins)} coins for ${myr(pack.myrSen)}`);
    if (onPay) price.onclick = () => onPay(pack, price);
    else price.disabled = true;
    li.append(coins, price);
    list.append(li);
  }
  return list;
}

/* ---------- screens ---------- */

function showUnavailable() {
  setWho(null);
  show(
    'unavailable',
    el('h1', null, 'Top-up is not available yet'),
    el('p', 'muted', 'Buying coins here has not opened. Check back soon.'),
    backToGame(),
  );
}

function showError(message, retry) {
  const again = el('button', 'btn-pay', 'Try again');
  again.onclick = retry;
  show('error', el('div', 'note bad', message), again);
}

function showLoggedOut(packs, { note = null } = {}) {
  setWho(null);
  show(
    'logged-out',
    el('h1', null, 'Top up your coins'),
    el('p', 'muted', 'Log in with the Telegram account you play with. Coins go straight to that account.'),
    ...(note ? [el('div', 'note bad', note)] : []),
    loginButton(here()),
    packList(packs),
    el('p', 'pay-with', 'Pay with Touch \'n Go eWallet: the app on your phone, or scan a QR code on a computer.'),
  );
}

function showPacks(packs, me) {
  setWho(me.user, me.balance);
  const logout = el('button', 'btn-plain', 'Log out');
  logout.onclick = () => {
    session = null;
    saveSession(null);
    showLoggedOut(packs);
  };
  const row = el('div', 'row');
  row.append(el('span', 'muted', 'Not you?'), logout);
  show(
    'packs',
    el('h1', null, 'Choose a coin pack'),
    el('p', 'muted', 'You pay with Touch \'n Go eWallet on Revenue Monster\'s secure payment page.'),
    packList(packs, { onPay: (pack, button) => pay(pack, button) }),
    row,
  );
}

let paying = false;
async function pay(pack, button) {
  if (paying) return;
  paying = true;
  for (const b of screen.querySelectorAll('.btn-pay')) b.disabled = true;
  button.textContent = 'Opening…';
  try {
    const order = await api('/orders', {
      method: 'POST', body: { packId: pack.id, device: deviceKind(navigator.userAgent, navigator.maxTouchPoints) },
    });
    debug.checkout = order.url;
    window.location.assign(order.url);
  } catch (err) {
    paying = false;
    if (err.status === 401) {
      boot({ note: 'Your login ran out. Log in again to pay.' });
      return;
    }
    for (const b of screen.querySelectorAll('.btn-pay')) b.disabled = false;
    button.textContent = myr(pack.myrSen);
    screen.prepend(el('div', 'note bad', err.message));
  }
}

async function showDone(orderId, packs) {
  const status = el('div', 'result wait');
  const spinner = el('div', 'spinner');
  const title = el('div', 'big');
  const text = el('p', 'muted');
  status.append(spinner, title, text);
  const again = el('a', 'btn btn-plain', 'Buy more coins');
  again.href = '/topup';
  show('done', status, backToGame(), again);

  const paint = (order, opts) => {
    const m = orderMessage(order, opts);
    status.className = `result ${m.kind}`;
    spinner.hidden = m.kind !== 'wait';
    title.textContent = m.title;
    text.textContent = m.text;
    debug.order = order?.status ?? null;
    debug.result = m.kind;
  };
  paint(null);

  const until = Date.now() + POLL_FOR_MS;
  let order = null;
  while (Date.now() < until) {
    try {
      order = await api(`/orders/${orderId}`);
    } catch (err) {
      if (err.status === 401) {
        showLoggedOut(packs, { note: 'Log in again to see this payment. If you paid, your coins arrive either way.' });
        return;
      }
      if (err.status === 404) {
        paint({ status: 'unknown' }, { timedOut: true });
        return;
      }
      // A dropped poll changes nothing: ask again.
    }
    if (order && SETTLED.has(order.status)) break;
    if (order) paint(order);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  paint(order, { timedOut: true });
  if (order?.balance !== undefined) {
    const me = await api('/me').catch(() => null);
    if (me) setWho(me.user, me.balance);
  }
}

/* ---------- start ---------- */

async function boot({ note = null } = {}) {
  show('loading', el('div', 'spinner'));
  let packs;
  try {
    ({ packs } = await api('/packs'));
  } catch (err) {
    // 404: RM payments are switched off, so the whole top-up API is absent.
    if (err.status === 404) return showUnavailable();
    return showError(err.message, () => boot());
  }

  // Back from Telegram's login: swap its fields for a session, and take them
  // out of the address bar at once (the page is then safe to share or reload).
  const login = widgetLogin(window.location.search);
  if (login) {
    window.history.replaceState(null, '', here());
    try {
      const res = await api('/login', { method: 'POST', body: login });
      session = { token: res.token, expiresAt: res.expiresAt };
      saveSession(session);
    } catch (err) {
      const why = err.body?.status === 'no_account'
        ? `Open @${BOT} in Telegram once first, then come back and log in.`
        : (err.status === 0 ? err.message : 'That login did not work. Please log in again.');
      return showLoggedOut(packs, { note: why });
    }
  }

  const orderId = window.location.pathname.replace(/\/+$/, '').endsWith('/done') ? orderFromQuery(window.location.search) : null;
  if (!session) {
    // Back from paying in another browser or tab: the login lives per browser.
    const why = note ?? (orderId ? 'Log in to see this payment. If you paid, your coins arrive either way.' : null);
    return showLoggedOut(packs, { note: why });
  }
  if (orderId) return showDone(orderId, packs);

  try {
    const me = await api('/me');
    return showPacks(packs, me);
  } catch (err) {
    if (err.status === 401) return showLoggedOut(packs, { note: 'Your login ran out. Log in again.' });
    return showError(err.message, () => boot());
  }
}

boot();
