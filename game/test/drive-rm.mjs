/**
 * Ringgit payment smoke (Revenue Monster: TNG / card) in the Mini App's store:
 * the coin packs → RM checkout opened in the browser → "waiting" sheet → coins
 * credited; the trip back from RM's page (startapp=store_<orderId>) landing on
 * the store, following that order; and which layout RM is asked for: a phone
 * gets the TNG app, Telegram Desktop the QR page.
 *
 *   npm run smoke:rm -w @snooker/game
 *
 * Needs only Vite and an installed Chrome: every /api call is answered here, so
 * this drives the Mini App's side of the flow and nothing else. The backend's
 * side (signatures, webhook, reconciler, refunds) is backend/test/rmPayments.test.js.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL ?? 'http://localhost:5173';
const shot = (name) => path.join(here, `rm-${name}.png`);

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
}

const USER = {
  id: 7, telegramId: '999000070', username: 'dev70', firstName: 'Dev 70', equipped: { cue: 'club-ash', ball: 'club-white' },
};
const PACKS = [
  { id: 'coins-100', coins: 100, stars: 100, myrSen: 490 },
  { id: 'coins-550', coins: 550, stars: 400, myrSen: 1990 },
  { id: 'coins-1200', coins: 1200, stars: 800, myrSen: 3990 },
];
const ORDER_ID = 'rm0123456789abcdef012345';
const CHECKOUT = `https://sb-pg.revenuemonster.my/checkout?id=${ORDER_ID}`;

/** A stand-in backend. `state.orderStatuses` is what successive polls answer. */
function stubApi(page, state) {
  return page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^.*\/api/, '');
    state.calls.push(`${req.method()} ${p}`);
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/auth/telegram') return reply({ token: 'stub', user: USER });
    if (p === '/auth/me') return reply({ user: USER, wallet: null, activeMatches: [] });
    if (p === '/match/active') return reply({ matches: [] });
    if (p === '/stats') {
      return reply({
        matchesPlayed: 0, matchesWon: 0, coins: state.balance, daily: { cap: 15, remaining: 15, exempt: false, pairCap: 3 },
      });
    }
    if (p === '/store') {
      return reply({
        balance: state.balance,
        equipped: USER.equipped,
        items: [],
        packs: PACKS,
        starsEnabled: state.starsEnabled,
        rmEnabled: state.rmEnabled,
      });
    }
    if (p === '/payments/rm/orders' && req.method() === 'POST') {
      state.orderBodies.push(req.postDataJSON());
      return reply({
        status: 'created', orderId: ORDER_ID, url: CHECKOUT, coins: 100, myrSen: 490,
      });
    }
    if (p === `/payments/orders/${ORDER_ID}`) {
      const status = state.orderStatuses.length > 1 ? state.orderStatuses.shift() : state.orderStatuses[0];
      if (status === 'paid') state.balance = 100;
      return reply({
        orderId: ORDER_ID, provider: 'rm', status, coins: 100, amount: 490, currency: 'MYR', balance: state.balance,
      });
    }
    return reply({});
  });
}

/** Records what the page tries to open outside itself (window.open / Telegram's openLink). */
const recordOpens = () => {
  window.__opened = [];
  window.open = (url) => { window.__opened.push(String(url)); return null; };
};

async function layoutProblems(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    const root = document.querySelector(sel);
    if (root.scrollWidth > root.clientWidth + 1) out.push(`${sel} scrolls sideways`);
    for (const el of root.querySelectorAll('button')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`clipped: "${el.textContent.trim()}"`);
    }
    // Nothing pokes out of its card, either.
    for (const card of root.querySelectorAll('.store-item')) {
      const edge = card.getBoundingClientRect().right;
      for (const el of card.querySelectorAll('button')) {
        if (el.getBoundingClientRect().right > edge + 0.5) out.push(`past the card: "${el.textContent.trim()}"`);
      }
    }
    return out;
  }, scope);
}

const newState = (over = {}) => ({
  calls: [], orderBodies: [], balance: 0, starsEnabled: false, rmEnabled: true, orderStatuses: ['pending'], ...over,
});

const browser = await chromium.launch({ channel: 'chrome' });
try {
  /* ---------- buy a pack by card, 360 wide ---------- */
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await page.addInitScript(recordOpens);
  const state = newState({ orderStatuses: ['pending', 'pending', 'paid'] });
  await stubApi(page, state);

  await page.goto(`${GAME}/?dev=70`);
  await page.locator('#lobby').waitFor({ state: 'visible' });
  await page.locator('#lobby-coins').click();
  await page.locator('#store').waitFor({ state: 'visible' });
  await page.locator('#store .store-tab[data-tab="coins"]').click();
  await page.locator('#store .item-pack').first().waitFor();

  const labels = await page.locator('#store .item-pack button').allInnerTexts();
  check(JSON.stringify(labels) === JSON.stringify(['RM 4.90', 'RM 19.90', 'RM 39.90']),
    `packs are priced in ringgit, and the Stars buttons that can't be used here are left out: ${labels.join(', ')}`);
  check((await page.locator('#store-note').innerText()).includes("Touch 'n Go"), 'the note says how it is paid');
  const layout = await layoutProblems(page, '#store');
  check(layout.length === 0, `store 360: ${layout.join('; ') || 'fits'}`);
  await page.screenshot({ path: shot('packs-360') });

  await page.locator('#store .item-pack button', { hasText: 'RM 4.90' }).click();
  await page.locator('#overlay-title', { hasText: 'Waiting for your payment' }).waitFor();
  check(JSON.stringify(state.orderBodies) === JSON.stringify([{ packId: 'coins-100', device: 'mobile' }]), `only the pack id and the device are sent: ${JSON.stringify(state.orderBodies)}`);
  const opened = await page.evaluate(() => window.__opened);
  check(opened.length === 1 && opened[0] === CHECKOUT, 'RM\'s checkout opens outside the Mini App');
  await page.screenshot({ path: shot('waiting-360') });

  // "Open payment page" opens it again, the sheet stays.
  await page.locator('#overlay-actions button', { hasText: 'Open payment page' }).click();
  check((await page.evaluate(() => window.__opened.length)) === 2, 'the payment page can be opened again');

  // pending, pending, paid → the sheet goes, the coins arrive.
  await page.locator('#overlay').waitFor({ state: 'hidden', timeout: 20_000 });
  await page.waitForFunction(() => document.getElementById('store-coins-value').textContent === '100', null, { timeout: 5000 });
  check(true, 'paid: the sheet closes and the store shows 100 coins');
  check((await page.locator('#lobby-coins-value').innerText()) === '100', 'the lobby chip follows');
  const polls = state.calls.filter((c) => c.startsWith(`GET /payments/orders/${ORDER_ID}`)).length;
  check(polls === 3, `the order was polled until paid (${polls} polls)`);
  await page.screenshot({ path: shot('paid-360') });
  await ctx.close();

  /* ---------- back from RM's page: straight to the store, following the order ---------- */
  const back = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page2 = await back.newPage();
  page2.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  const state2 = newState({ orderStatuses: ['expired'] });
  await stubApi(page2, state2);
  // What startapp=store_<id> becomes outside Telegram (launchParams reads both).
  await page2.goto(`${GAME}/?dev=70&screen=store&order=${ORDER_ID}`);
  await page2.locator('#store').waitFor({ state: 'visible' });
  await page2.locator('#overlay-title', { hasText: 'Payment not completed' }).waitFor({ timeout: 10_000 });
  check(true, 'a lapsed order says so, and no coins were added');
  check(await page2.locator('#store .store-tab[data-tab="coins"]').getAttribute('aria-selected') === 'true', 'the store opened on the coin packs');
  await page2.screenshot({ path: shot('lapsed-390') });
  await back.close();

  /** Just enough of Telegram's WebApp for the store; openLink is recorded. */
  const fakeTelegram = async (pg, platform) => {
    await pg.addInitScript((plat) => {
      const noop = () => {};
      window.__links = [];
      window.Telegram = {
        WebApp: new Proxy({
          initData: 'stub', initDataUnsafe: {}, version: '8.0', platform: plat, themeParams: {},
          isVersionAtLeast: () => true, openInvoice: noop, openLink: (u) => window.__links.push(String(u)),
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
          CloudStorage: { getItem: (k, cb) => cb(null, ''), setItem: (k, v, cb) => cb?.(null, true), getKeys: (cb) => cb(null, []), removeItem: (k, cb) => cb?.(null, true) },
        }, { get: (t, k) => (k in t ? t[k] : noop) }),
      };
    }, platform);
    await pg.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  };

  /* ---------- Telegram Desktop: the QR page, opened through Telegram ---------- */
  const pc = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page5 = await pc.newPage();
  page5.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await fakeTelegram(page5, 'tdesktop');
  const state5 = newState();
  await stubApi(page5, state5);
  await page5.goto(`${GAME}/`);
  await page5.locator('#lobby').waitFor({ state: 'visible' });
  await page5.locator('#lobby-coins').click();
  await page5.locator('#store .store-tab[data-tab="coins"]').click();
  await page5.locator('#store .item-pack button', { hasText: 'RM 4.90' }).click();
  await page5.locator('#overlay-title', { hasText: 'Waiting for your payment' }).waitFor();
  check(state5.orderBodies[0]?.device === 'desktop', `Telegram Desktop asks for the QR page (${JSON.stringify(state5.orderBodies)})`);
  const links = await page5.evaluate(() => window.__links);
  check(links.length === 1 && links[0] === CHECKOUT, 'the checkout opens through Telegram openLink');
  await page5.screenshot({ path: shot('waiting-desktop') });
  await pc.close();

  /* ---------- in Telegram (Android) with Stars on too: two prices per pack, 320 wide ---------- */
  const both = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  const page4 = await both.newPage();
  page4.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await fakeTelegram(page4, 'android');
  const state4 = newState({ starsEnabled: true });
  await stubApi(page4, state4);
  await page4.goto(`${GAME}/`);
  await page4.locator('#lobby').waitFor({ state: 'visible' });
  await page4.locator('#lobby-coins').click();
  await page4.locator('#store .store-tab[data-tab="coins"]').click();
  await page4.locator('#store .item-pack').first().waitFor();
  const bothLabels = await page4.locator('#store .item-pack button').allInnerTexts();
  check(bothLabels.length === 6 && bothLabels.includes('RM 39.90') && bothLabels.includes('⭐ 800'), `both prices on every pack: ${bothLabels.join(', ')}`);
  const tight = await layoutProblems(page4, '#store');
  check(tight.length === 0, `store 320 with two prices: ${tight.join('; ') || 'fits'}`);
  await page4.screenshot({ path: shot('both-320') });
  await page4.locator('#store .item-pack button', { hasText: 'RM 39.90' }).click();
  await page4.locator('#overlay-title', { hasText: 'Waiting for your payment' }).waitFor();
  check(JSON.stringify(state4.orderBodies) === JSON.stringify([{ packId: 'coins-1200', device: 'mobile' }]), `Telegram on Android asks for the TNG app (${JSON.stringify(state4.orderBodies)})`);
  await both.close();

  /* ---------- switched off: no ringgit anywhere ---------- */
  const off = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page3 = await off.newPage();
  const state3 = newState({ rmEnabled: false });
  await stubApi(page3, state3);
  await page3.goto(`${GAME}/?dev=70`);
  await page3.locator('#lobby').waitFor({ state: 'visible' });
  await page3.locator('#lobby-coins').click();
  await page3.locator('#store .store-tab[data-tab="coins"]').click();
  await page3.locator('#store .item-pack').first().waitFor();
  const offLabels = await page3.locator('#store .item-pack button').allInnerTexts();
  check(offLabels.every((l) => !l.startsWith('RM')), `RM off: no ringgit prices (${offLabels.join(', ')})`);
  await off.close();
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
