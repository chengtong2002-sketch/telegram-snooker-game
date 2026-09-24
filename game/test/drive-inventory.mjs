/**
 * Drives the Inventory tab in a real browser and takes its screenshots.
 *
 *   ALLOW_DEV_AUTH=true DATABASE_URL=<throwaway> npm run dev:backend
 *   npm run dev:game
 *   DATABASE_URL=<same throwaway> npm run smoke:inventory -w @snooker/game
 *
 * It grants coins straight into the backend's database (coins.js), so point it
 * at the same throwaway DATABASE_URL as the backend — never a real one.
 *
 * Phone 390x844: the avatar opens the Inventory; a new player sees the Starter
 * pair equipped, the empty state and no history; "Visit the store" goes to
 * Cues. After coins and two purchases: owned items with previews, Equipped
 * badges, Equip moves the badge and the setup preview (server-checked), the
 * history reads right and pages with "Show older". Then 320 wide (four tabs
 * fit) and desktop.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the same throwaway database the backend is using.');
  process.exit(2);
}
const { grantCoins } = await import('../../backend/src/services/coins.js');
const { getDb, closeDb } = await import('@snooker/db');

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173';
const API = process.env.BACKEND_URL_LOCAL ?? 'http://127.0.0.1:8080/api';
const slot = Number(process.env.INV_DEV_SLOT ?? 50 + Math.floor(Math.random() * 50));
const telegramId = 999_000_000 + slot;
const shot = (name) => path.join(here, `inventory-${name}.png`);

let failures = 0;
const errors = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function api(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const devLogin = async () => (await api('/auth/telegram', {
  method: 'POST', body: { devUser: { id: telegramId, first_name: `Dev ${slot}`, username: `dev${slot}` } },
})).body;

async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const root = document.getElementById('store');
    if (root.scrollWidth > root.clientWidth + 1) out.push('#store scrolls sideways');
    for (const el of root.querySelectorAll('button, .item-name, .inv-tx-label, .store-tab')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`clipped: "${el.textContent.trim()}"`);
    }
    return out;
  });
}

const view = (page) => page.evaluate(() => {
  const list = document.getElementById('store-list');
  const tab = document.querySelector('.store-tab.on')?.dataset.tab;
  const rows = [...list.querySelectorAll(':scope > .store-item:not(.inv-setup):not(.inv-empty)')].map((li) => ({
    name: li.querySelector('.item-name')?.textContent,
    equipped: li.classList.contains('is-equipped'),
    badge: li.querySelector('.item-state')?.textContent ?? null,
    button: li.querySelector('.item-btn')?.textContent ?? null,
    hasPreview: Boolean(li.querySelector('img')?.getAttribute('src')),
  }));
  return {
    tab,
    setup: list.querySelector('.inv-setup .item-name')?.textContent ?? null,
    setupImgs: list.querySelectorAll('.inv-setup img[src]').length,
    empty: list.querySelector('.inv-empty')?.textContent ?? null,
    heads: [...list.querySelectorAll('.inv-head')].map((h) => h.textContent),
    rows,
    history: [...list.querySelectorAll('.inv-tx')].map((li) => ({
      label: li.querySelector('.inv-tx-label').textContent,
      delta: li.querySelector('.inv-tx-delta').textContent,
      after: li.querySelector('.inv-tx-after').textContent,
    })),
    historyEmpty: [...list.querySelectorAll('.store-empty')].some((e) => e.textContent.includes('No coin activity')),
    more: list.querySelector('.inv-more')?.textContent ?? null,
  };
});

async function openLobby(page) {
  await page.goto(`${GAME}/?dev=${slot}`);
  await page.locator('#lobby').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('lobby-coins-value').textContent !== '–');
}
const waitInventory = (page) => page.waitForFunction(() => document.querySelector('#store-list .inv-setup')
  && !document.querySelector('#store-list .store-empty')?.textContent.includes('Loading'), null, { timeout: 10_000 });

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log(`\n[1] new player (dev slot ${slot}), phone 390`);
  await openLobby(page);
  await page.locator('#lobby-avatar').tap();
  await waitInventory(page);
  let v = await view(page);
  check(v.tab === 'inventory', 'tapping the avatar opens the store on Inventory', v.tab);
  check(v.setup === 'Club Ash · Club White' && v.setupImgs === 2, 'setup preview: Club Ash on Club White', `${v.setup} / ${v.setupImgs} imgs`);
  check(v.empty?.includes('No items yet') && v.empty.includes('Visit the store'), 'empty state with Visit the store', v.empty);
  check(v.rows.length === 2 && v.rows.every((r) => r.equipped && r.badge === 'Equipped' && r.hasPreview), 'owns the Starter pair, both Equipped, with previews', JSON.stringify(v.rows));
  check(JSON.stringify(v.heads) === '["Cues","Cue balls","Coin history"]', 'sections: Cues, Cue balls, Coin history', JSON.stringify(v.heads));
  check(v.historyEmpty, 'no coin activity yet');
  check((await layoutProblems(page)).length === 0, 'nothing clipped at 390', (await layoutProblems(page)).join('; '));
  await page.screenshot({ path: shot('empty-390') });

  await page.locator('.inv-empty .item-btn').tap();
  check((await view(page)).tab === 'cue', '"Visit the store" goes to the Cues tab');

  console.log('\n[2] coins, two purchases, a long history');
  const me = await devLogin();
  const user = await getDb()('users').where({ telegram_id: String(telegramId) }).first();
  await grantCoins({ userId: user.id, amount: 2000, actor: 'drive-inventory', note: 'smoke:inventory' });
  check((await api('/store/buy', { method: 'POST', token: me.token, body: { itemId: 'crimson-crown' } })).status === 200, 'bought Crimson Crown');
  check((await api('/store/buy', { method: 'POST', token: me.token, body: { itemId: 'pearl' } })).status === 200, 'bought Pearl');
  for (let i = 1; i <= 24; i += 1) await grantCoins({ userId: user.id, amount: 5, actor: 'drive-inventory', note: `filler ${i}` });

  // Back out to the lobby, then in through the name this time.
  await page.locator('#store-back').tap();
  await page.locator('#lobby-who').tap();
  await waitInventory(page);
  v = await view(page);
  check(v.tab === 'inventory', 'tapping the name opens Inventory too');
  check(v.empty === null, 'no empty state once something is bought');
  const names = v.rows.map((r) => r.name);
  check(JSON.stringify(names) === '["Club Ash","Crimson Crown","Club White","Pearl"]', 'owned: 2 cues, 2 balls, equipped first', JSON.stringify(names));
  check(v.rows.filter((r) => !r.equipped).every((r) => r.button === 'Equip'), 'Equip on the ones not worn');
  check(v.rows.every((r) => r.hasPreview), 'every owned item has a preview');
  check(v.history.length === 20 && v.more === 'Show older', 'history: first page of 20, then Show older', `${v.history.length} / ${v.more}`);
  check(v.history[0].label === 'Coins from Snooker' && v.history[0].delta === '+5', 'newest first: the latest grant', JSON.stringify(v.history[0]));
  await page.screenshot({ path: shot('owned-390') });

  await page.locator('.inv-more').tap();
  await page.waitForFunction(() => document.querySelectorAll('.inv-tx').length > 20);
  v = await view(page);
  check(v.history.length === 27 && v.more === null, 'Show older loads the rest (27 entries), then stops', `${v.history.length} / ${v.more}`);
  const last3 = v.history.slice(-3).map((h) => `${h.label} ${h.delta} ${h.after}`);
  check(JSON.stringify(last3) === JSON.stringify([
    'Bought Pearl −500 Balance 1,000',
    'Bought Crimson Crown −500 Balance 1,500',
    'Coins from Snooker +2,000 Balance 2,000',
  ]), 'oldest entries: grant, then the two buys, with running balances', JSON.stringify(last3));
  await page.locator('.inv-history').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('history-390') });

  console.log('\n[3] equip from the inventory');
  await page.locator('#store-list').evaluate((el) => { el.scrollTop = 0; });
  const pearlRow = page.locator('#store-list > .store-item', { hasText: 'Pearl' });
  await pearlRow.locator('.item-btn').tap();
  await page.waitForFunction(() => document.querySelector('.inv-setup .item-name')?.textContent.includes('Pearl'));
  v = await view(page);
  check(v.setup === 'Club Ash · Pearl', 'the setup preview follows: Club Ash on Pearl', v.setup);
  const ball = v.rows.filter((r) => ['Club White', 'Pearl'].includes(r.name));
  check(ball.find((r) => r.name === 'Pearl').badge === 'Equipped' && ball.find((r) => r.name === 'Club White').button === 'Equip',
    'Equipped badge moved to Pearl', JSON.stringify(ball));
  const server = (await api('/store/inventory', { token: me.token })).body;
  check(server.equipped.ball === 'pearl', 'the server has Pearl equipped');
  const refused = await api('/store/equip', { method: 'POST', token: me.token, body: { kind: 'cue', itemId: 'obsidian-gold' } });
  check(refused.status === 403, 'equipping an unowned item is refused by the server', String(refused.status));
  await page.screenshot({ path: shot('equipped-390') });
  check((await layoutProblems(page)).length === 0, 'nothing clipped at 390 with items', (await layoutProblems(page)).join('; '));

  console.log('\n[4] 320 wide and desktop');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(200);
  check((await layoutProblems(page)).length === 0, 'four tabs and the rows fit at 320', (await layoutProblems(page)).join('; '));
  await page.screenshot({ path: shot('320') });

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await openLobby(dp);
  await dp.locator('#lobby-who').click();
  await waitInventory(dp);
  check((await layoutProblems(dp)).length === 0, 'desktop: nothing clipped', (await layoutProblems(dp)).join('; '));
  await dp.screenshot({ path: shot('desktop') });
  await dp.locator('#store-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await dp.screenshot({ path: shot('desktop-history') });
} finally {
  await browser.close();
  await closeDb();
}

if (errors.length) console.log('\npage errors:\n  ' + errors.join('\n  '));
console.log(failures || errors.length ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures || errors.length ? 1 : 0);
