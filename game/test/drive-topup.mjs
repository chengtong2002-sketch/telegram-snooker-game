/**
 * Drives the web top-up page (/topup, docs/topup-web-plan.md) in a real
 * browser and takes its screenshots. Needs only vite: every /api/topup call
 * is answered here, Telegram's widget script is stubbed, and RM's checkout is
 * a stub page.
 *
 *   npm run dev:game
 *   npm run smoke:topup -w @snooker/game
 *
 * RM off (packs 404) → "not available yet", never the game. Logged out → the
 * packs with server prices, nothing buyable, Telegram's button pointed back
 * here. Back from Telegram's login → only the widget's fields are posted, the
 * address bar is wiped, the packs are buyable. A pack → the order carries only
 * the pack id and the device (desktop / phone), then RM's page. The done
 * screen follows the order to paid / failed and ignores RM's own params; a
 * return in another browser asks to log in again. Screens at 320, 390, desktop.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173';
const API = (process.env.BACKEND_URL_LOCAL ?? 'http://localhost:8080').replace(/\/+$/, '');
const shot = (name) => path.join(here, `topup-${name}.png`);
const ORDER = 'rm0123456789abcdef012345';
const CHECKOUT = `https://sb-pg.revenuemonster.my/checkout?id=${ORDER}`;
const PACKS = [
  { id: 'coins-100', coins: 100, myrSen: 490 },
  { id: 'coins-550', coins: 550, myrSen: 1990 },
  { id: 'coins-1200', coins: 1200, myrSen: 3990 },
];
const LOGIN = {
  id: '7625262769', first_name: 'Nick', username: 'nick', auth_date: '1790000000', hash: 'ab'.repeat(32),
};
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A fresh browser context with the API, the widget and RM stubbed. `state` says how the fake server answers. */
async function open(browser, state, { width = 390, height = 844, userAgent } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, userAgent });
  state.calls = [];
  state.bodies = {};
  await context.route('https://telegram.org/js/telegram-widget.js*', (route) => {
    state.widget = route.request().url();
    route.fulfill({ contentType: 'application/javascript', body: 'document.currentScript.insertAdjacentHTML("afterend","<button class=tg-fake>Log in with Telegram</button>")' });
  });
  await context.route('https://sb-pg.revenuemonster.my/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>RM checkout</title>RM' }));
  await context.route(`${API}/api/topup/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace('/api/topup', '');
    state.calls.push(`${req.method()} ${p}`);
    if (req.method() === 'POST') state.bodies[p] = req.postDataJSON();
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!state.enabled) return json(404, { error: 'no route' });
    const authed = req.headers().authorization === 'Bearer web-token';
    if (p === '/packs') return json(200, { packs: PACKS });
    if (p === '/login') {
      if (state.loginAnswer) return json(state.loginAnswer.status, state.loginAnswer.body);
      return json(200, {
        token: 'web-token', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), user: { firstName: 'Nick', username: 'nick' }, balance: 950,
      });
    }
    if (!authed) return json(401, { error: 'invalid or expired token' });
    if (p === '/me') return json(200, { user: { firstName: 'Nick', username: 'nick' }, balance: state.balance ?? 950 });
    if (p === '/orders') return json(200, { status: 'created', orderId: ORDER, url: CHECKOUT, coins: 550, myrSen: 1990 });
    if (p === `/orders/${ORDER}`) {
      const status = state.statuses.length > 1 ? state.statuses.shift() : state.statuses[0];
      return json(200, {
        orderId: ORDER, provider: 'rm', status, coins: 550, amount: 1990, currency: 'MYR', balance: status === 'paid' ? 1500 : 950,
      });
    }
    return json(404, { error: 'no route' });
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => { failures += 1; console.log(`FAIL uncaught: ${err.message}`); });
  return { context, page };
}

const screenName = (page) => page.evaluate(() => window.__topupDebug?.screen);
const waitScreen = (page, name) => page.waitForFunction((n) => window.__topupDebug?.screen === n, name, { timeout: 10_000 })
  .then(() => true, () => false);
const text = (page) => page.evaluate(() => document.querySelector('main').innerText);
const signIn = (page) => page.evaluate((token) => localStorage.setItem('snooker.topup', JSON.stringify({ token, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() })), 'web-token');

const browser = await chromium.launch({ channel: 'chrome' });
try {
  // 1. RM switched off: the page says so, and it is not the game.
  {
    const state = { enabled: false, statuses: ['pending'] };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
    check(await waitScreen(page, 'unavailable'), 'flag off: "not available yet" screen', await screenName(page));
    check((await page.title()) === 'Snooker coins', 'flag off: the top-up page, not the game', await page.title());
    check(await page.locator('#table').count() === 0, 'flag off: no game canvas on the page');
    check((await text(page)).includes('Top-up is not available yet'), 'flag off: says so in words');
    check(await page.locator('a.btn-game').getAttribute('href') === 'https://t.me/snookerPlayBot/play', 'flag off: Back to game goes into the Mini App');
    await page.screenshot({ path: shot('unavailable-390') });
    await context.close();
  }

  // 2. Logged out, then back from Telegram's login, then a pack.
  {
    const state = { enabled: true, statuses: ['pending'] };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
    check(await waitScreen(page, 'logged-out'), 'logged out: login screen');
    const prices = await page.locator('.btn-pay').allTextContents();
    check(JSON.stringify(prices) === JSON.stringify(['RM 4.90', 'RM 19.90', 'RM 39.90']), 'logged out: the server\'s MYR prices', JSON.stringify(prices));
    check(await page.locator('.btn-pay:not([disabled])').count() === 0, 'logged out: nothing is buyable');
    check(Boolean(state.widget), 'logged out: Telegram\'s widget script is loaded');
    const authUrl = await page.locator('.login script').getAttribute('data-auth-url');
    check(authUrl === `${GAME}/topup`, 'widget sends the player back to /topup', authUrl);
    check(await page.locator('.login script').getAttribute('data-telegram-login') === 'snookerPlayBot', 'widget names @snookerPlayBot');
    await page.screenshot({ path: shot('logged-out-390') });

    // Telegram's redirect back, with a stray param that must not reach the login.
    const q = new URLSearchParams({ ...LOGIN, utm: 'x' });
    await page.goto(`${GAME}/topup?${q}`, { waitUntil: 'load' });
    check(await waitScreen(page, 'packs'), 'after login: the packs');
    check(JSON.stringify(Object.keys(state.bodies['/login']).sort()) === JSON.stringify(Object.keys(LOGIN).sort()), 'login posts only the widget\'s fields', JSON.stringify(state.bodies['/login']));
    check(!page.url().includes('hash=') && !page.url().includes('id='), 'the login is wiped from the address bar', page.url());
    const who = await page.locator('#who').innerText();
    check(who.includes('Nick') && who.includes('950 coins'), 'header shows the player and balance', who);
    check(await page.locator('.btn-pay:not([disabled])').count() === 3, 'after login: every pack is buyable');
    await page.screenshot({ path: shot('packs-390') });

    await Promise.all([page.waitForURL(/sb-pg\.revenuemonster\.my/, { timeout: 10_000 }).catch(() => {}), page.locator('.btn-pay', { hasText: 'RM 19.90' }).click()]);
    check(JSON.stringify(state.bodies['/orders']) === JSON.stringify({ packId: 'coins-550', device: 'desktop' }), 'order sends only the pack and the device', JSON.stringify(state.bodies['/orders']));
    check(page.url() === CHECKOUT, 'then RM\'s checkout opens', page.url());
    await context.close();
  }

  // 3. A phone gets the TNG app checkout.
  {
    const state = { enabled: true, statuses: ['pending'] };
    const { context, page } = await open(browser, state, { userAgent: IPHONE });
    await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
    await signIn(page);
    await page.reload({ waitUntil: 'load' });
    check(await waitScreen(page, 'packs'), 'phone: a saved session goes straight to the packs');
    await Promise.all([page.waitForURL(/sb-pg/, { timeout: 10_000 }).catch(() => {}), page.locator('.btn-pay').first().click()]);
    check(state.bodies['/orders']?.device === 'mobile', 'phone: device is mobile', JSON.stringify(state.bodies['/orders']));
    await context.close();
  }

  // 4. The done screen: pending → paid, with RM's own params ignored.
  {
    const state = { enabled: true, statuses: ['pending', 'pending', 'paid'] };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
    await signIn(page);
    await page.goto(`${GAME}/topup/done?order=${ORDER}&status=FAILED&orderId=x`, { waitUntil: 'load' });
    check(await waitScreen(page, 'done'), 'done: the done screen');
    const paid = await page.waitForFunction(() => window.__topupDebug?.result === 'good', null, { timeout: 15_000 }).then(() => true, () => false);
    check(paid, 'done: follows the order to paid, whatever RM appended (status=FAILED)');
    const t = await text(page);
    check(t.includes('+550 coins') && t.includes('1,500 coins'), 'done: shows the coins and the new balance', t);
    check(await page.locator('a.btn-game').getAttribute('href') === 'https://t.me/snookerPlayBot/play', 'done: Back to game → t.me/snookerPlayBot/play');
    check(state.calls.filter((c) => c === `GET /orders/${ORDER}`).length >= 3, 'done: polled our server (never RM)');
    await page.screenshot({ path: shot('done-paid-390') });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({ path: shot('done-paid-320') });
    await context.close();
  }

  // 5. The done screen: failed.
  {
    const state = { enabled: true, statuses: ['failed'] };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
    await signIn(page);
    await page.goto(`${GAME}/topup/done?order=${ORDER}`, { waitUntil: 'load' });
    const bad = await page.waitForFunction(() => window.__topupDebug?.result === 'bad', null, { timeout: 10_000 }).then(() => true, () => false);
    check(bad, 'done: a failed payment says so');
    check((await text(page)).includes('No coins were added'), 'done: failed text');
    await page.screenshot({ path: shot('done-failed-390') });
    await context.close();
  }

  // 6. Back from paying in another browser: no session, so log in again.
  {
    const state = { enabled: true, statuses: ['paid'] };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup/done?order=${ORDER}`, { waitUntil: 'load' });
    check(await waitScreen(page, 'logged-out'), 'done without a session: asks to log in');
    check((await text(page)).includes('Log in to see this payment'), 'done without a session: explains why');
    const authUrl = await page.locator('.login script').getAttribute('data-auth-url');
    check(authUrl === `${GAME}/topup/done?order=${ORDER}`, 'the login comes back to this order', authUrl);
    await context.close();
  }

  // 7. Someone who never opened the bot.
  {
    const state = { enabled: true, statuses: ['pending'], loginAnswer: { status: 404, body: { status: 'no_account', error: 'x' } } };
    const { context, page } = await open(browser, state);
    await page.goto(`${GAME}/topup?${new URLSearchParams(LOGIN)}`, { waitUntil: 'load' });
    check(await waitScreen(page, 'logged-out'), 'no account: stays logged out');
    check((await text(page)).includes('Open @snookerPlayBot in Telegram once first'), 'no account: says to open the bot first');
    await page.screenshot({ path: shot('no-account-390') });
    await context.close();
  }

  // 8. 320 wide and desktop.
  {
    const state = { enabled: true, statuses: ['pending'] };
    for (const [name, width, height] of [['packs-320', 320, 640], ['packs-desktop', 1280, 800]]) {
      const { context, page } = await open(browser, state, { width, height });
      await page.goto(`${GAME}/topup`, { waitUntil: 'load' });
      await signIn(page);
      await page.reload({ waitUntil: 'load' });
      await waitScreen(page, 'packs');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check(!overflow, `${name}: no sideways scroll`);
      await page.screenshot({ path: shot(name), fullPage: true });
      await context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
