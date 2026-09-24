/**
 * Store smoke: lobby chip and Store button → store → buy → equip → the cue in
 * practice, at phone and desktop sizes, with screenshots.
 *
 *   npm run smoke:store -w @snooker/game
 *
 * Needs the backend (ALLOW_DEV_AUTH=true) and Vite running, and an installed
 * Chrome. It signs in as a fresh ?dev= player and grants that player coins
 * with the real grant script, so it writes to whatever database the backend
 * uses: point DATABASE_URL at a throwaway one, never a database with real
 * players in it. STORE_DEV_SLOT picks the slot (default: random 50-99); a slot
 * that already owns the items fails the run, so use another one.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const run = promisify(execFile);

const GAME = process.env.GAME_URL ?? 'http://localhost:5173';
const slot = Number(process.env.STORE_DEV_SLOT ?? 50 + Math.floor(Math.random() * 50));
const telegramId = 999_000_000 + slot;
const shot = (name) => path.join(here, `store-${name}.png`);

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
}

async function grant(amount) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npm, ['run', 'grant', '-w', '@snooker/backend', '--', String(telegramId), String(amount),
    '--note', 'smoke:store', '--by', 'drive-store', '--yes'], { cwd: repo, shell: process.platform === 'win32' });
}

/** Nothing on the screen scrolls sideways, and no button label is cut. */
async function layoutProblems(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    const root = document.querySelector(sel);
    if (root.scrollWidth > root.clientWidth + 1) out.push(`${sel} scrolls sideways`);
    for (const el of root.querySelectorAll('button, .item-name, .coin-chip')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`clipped: "${el.textContent.trim()}"`);
    }
    return out;
  }, scope);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const coins = async (page, sel) => Number((await text(page, sel)).replace(/[^\d-]/g, ''));

async function openLobby(page) {
  await page.goto(`${GAME}/?dev=${slot}`);
  await page.locator('#lobby').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('lobby-coins-value').textContent !== '–');
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  /* ---------- phone, 390 portrait ---------- */
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await phone.newPage();
  page.on('pageerror', (err) => check(false, `page error: ${err.message}`));

  await openLobby(page);
  check(await coins(page, '#lobby-coins-value') === 0, `new dev player ${slot} starts with 0 coins`);
  await grant(1500);
  await openLobby(page);
  check(await coins(page, '#lobby-coins-value') === 1500, 'the chip shows the granted 1,500');
  check(await page.locator('#lobby-store').isEnabled(), 'Store is enabled online');
  check((await layoutProblems(page, '#lobby')).length === 0, `lobby 390: ${(await layoutProblems(page, '#lobby')).join('; ') || 'fits'}`);
  await page.screenshot({ path: shot('lobby-390') });

  // The chip opens the store too; the Store button is tested on desktop.
  await page.locator('#lobby-coins').click();
  await page.locator('#store').waitFor({ state: 'visible' });
  await page.locator('#store .store-item').first().waitFor();
  check(await page.locator('#store .item-cue').count() === 5, 'five cues listed');
  check(await text(page, '#store .is-equipped .item-name') === 'Club Ash', 'Club Ash is equipped by default');
  check((await layoutProblems(page, '#store')).length === 0, `store 390: ${(await layoutProblems(page, '#store')).join('; ') || 'fits'}`);
  await page.screenshot({ path: shot('cues-390') });

  // Buy Crimson Crown (Rare, 500).
  const crown = page.locator('#store .store-item', { hasText: 'Crimson Crown' });
  await crown.locator('button.buy').click();
  await page.locator('#overlay').waitFor({ state: 'visible' });
  check((await text(page, '#overlay-title')) === 'Buy Crimson Crown?', 'buying asks first');
  check((await text(page, '#overlay-body')).includes('1,000'), 'the sheet shows the balance after');
  await page.screenshot({ path: shot('confirm-390') });
  await page.locator('#overlay-actions button', { hasText: 'Buy for 500' }).click();
  await page.locator('#overlay-title', { hasText: 'is yours' }).waitFor();
  check(await coins(page, '#store-coins-value') === 1000, 'the store balance drops to 1,000');
  check(await coins(page, '#lobby-coins-value') === 1000, 'the lobby chip follows');
  await page.locator('#overlay-actions button', { hasText: 'Equip now' }).click();
  await page.locator('#store .is-equipped', { hasText: 'Crimson Crown' }).waitFor();
  check(true, 'Crimson Crown equipped');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('snooker.equipped')));
  check(stored?.cue === 'crimson-crown', 'the device keeps a copy for offline practice');
  await page.screenshot({ path: shot('equipped-390') });

  // Too expensive: Obsidian Gold is 1,000 — exactly affordable — so try it twice.
  const gold = page.locator('#store .store-item', { hasText: 'Obsidian Gold' });
  await gold.locator('button.buy').click();
  await page.locator('#overlay-actions button', { hasText: 'Buy for 1,000' }).click();
  await page.locator('#overlay-title', { hasText: 'is yours' }).waitFor();
  await page.locator('#overlay-actions button', { hasText: 'Later' }).click();
  check(await coins(page, '#store-coins-value') === 0, 'balance 0 after Obsidian Gold');
  check(await page.locator('#store .is-equipped', { hasText: 'Crimson Crown' }).count() === 1, '"Later" leaves the equipped cue alone');

  await page.locator('#store .store-tab[data-tab="ball"]').click();
  const pearl = page.locator('#store .store-item', { hasText: 'Pearl' });
  await pearl.locator('button.buy').click();
  check((await text(page, '#overlay-title')) === 'Not enough coins', 'too few coins: explained, not charged');
  await page.screenshot({ path: shot('not-enough-390') });
  await page.locator('#overlay-actions button', { hasText: 'See coin packs' }).click();
  check(await page.locator('#store .item-pack').count() === 3, 'three coin packs');
  await page.screenshot({ path: shot('coins-390') });
  await page.locator('#store .store-tab[data-tab="ball"]').click();
  await page.screenshot({ path: shot('balls-390') });

  await page.locator('#store-back').click();
  await page.locator('#store').waitFor({ state: 'hidden' });
  check(await page.locator('#lobby').isVisible(), 'back lands on the lobby');

  /* ---------- the cue in practice (landscape) ---------- */
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('#lobby-practice').click();
  await page.locator('#lobby').waitFor({ state: 'hidden' });
  // Aim so the cue is drawn: a drag on the table.
  const box = await page.locator('#table').boundingBox();
  await page.mouse.move(box.x + box.width * 0.30, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('practice-cue-844') });
  await phone.close();

  /* ---------- desktop ---------- */
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dpage = await desk.newPage();
  dpage.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await openLobby(dpage);
  check((await layoutProblems(dpage, '#lobby')).length === 0, 'desktop lobby fits');
  await dpage.screenshot({ path: shot('lobby-desktop') });
  await dpage.locator('#lobby-store').click();
  await dpage.locator('#store .store-item').first().waitFor();
  check((await layoutProblems(dpage, '#store')).length === 0, 'desktop store fits');
  await dpage.screenshot({ path: shot('cues-desktop') });
  await desk.close();

  /* ---------- the narrow and short lobbies ---------- */
  for (const [w, h] of [[320, 640], [360, 780], [844, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: true });
    const p = await ctx.newPage();
    await openLobby(p);
    const problems = await layoutProblems(p, '#lobby');
    check(problems.length === 0, `lobby ${w}x${h}: ${problems.join('; ') || 'fits'}`);
    await p.screenshot({ path: shot(`lobby-${w}x${h}`) });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed (dev slot ${slot})` : `\nall checks passed (dev slot ${slot})`);
process.exit(failures ? 1 : 0);
