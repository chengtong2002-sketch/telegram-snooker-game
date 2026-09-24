/**
 * Quit match smoke: the pause menu's Quit match in practice and in PvP.
 *
 *   npm run smoke:quit -w @snooker/game
 *
 * 1. Practice: pause → Quit match → the lobby, straight away, with no dialog
 *    and nothing added to the device's practice record.
 * 2. PvP (two ?dev= players paired through the API): pause → Quit match →
 *    "Concede this match?"; Cancel goes back to the pause menu; Concede and
 *    quit → the lobby. The server has the match completed with the opponent as
 *    winner, and the opponent's screen offers Back to lobby.
 *
 * Needs the backend (ALLOW_DEV_AUTH=true) and Vite running, and an installed
 * Chrome. Creates dev players and a match in whatever database the backend
 * uses: point DATABASE_URL at a throwaway one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL ?? 'http://localhost:5173';
const API = process.env.BACKEND_URL ?? 'http://localhost:8080';
const shot = (name) => path.join(here, `quit-${name}.png`);

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
}

async function api(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}
/** The same identity the page picks for ?dev=N (see devUser in src/api.js). */
const devLogin = async (slot) => api('/auth/telegram', {
  method: 'POST', body: { devUser: { id: 999_000_000 + slot, first_name: `Dev ${slot}`, username: `dev${slot}` } },
});

const modal = (page) => page.evaluate(() => ({
  open: !document.getElementById('overlay').hidden,
  title: document.getElementById('overlay-title').textContent,
  body: document.getElementById('overlay-body').textContent,
  buttons: [...document.querySelectorAll('#overlay-actions button')].map((b) => b.textContent),
}));
const lobbyShown = (page) => page.evaluate(() => !document.getElementById('lobby').hidden);
const click = (page, label) => page.locator('#overlay-actions button', { hasText: label }).first().click();

const LANDSCAPE = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const browser = await chromium.launch({ channel: 'chrome' });
try {
  /* ---------- practice ---------- */
  {
    const ctx = await browser.newContext(LANDSCAPE);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
    const slot = 40 + Math.floor(Math.random() * 10);
    await page.goto(`${GAME}/?mode=practice&dev=${slot}`);
    await page.waitForFunction(() => window.__snookerDebug?.phase === 'aiming');
    const before = await page.evaluate(() => localStorage.getItem('snooker.practice'));

    await page.locator('#pause').click();
    const menu = await modal(page);
    check(menu.buttons.at(-1) === 'Quit match', `Quit match is the last button (${menu.buttons.join(' | ')})`);
    check(menu.buttons[0] === 'Resume', 'Resume stays first');
    const style = await page.locator('#overlay-actions .btn.quit').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, border: cs.borderTopStyle, width: el.getBoundingClientRect().width, row: el.parentElement.getBoundingClientRect().width };
    });
    check(style.color === 'rgb(227, 92, 77)', `red text (${style.color})`);
    check(style.border === 'solid' && Math.abs(style.width - style.row) < 1, 'its own full-width row under a divider');
    await page.screenshot({ path: shot('pause-practice') });

    await click(page, 'Quit match');
    await page.locator('#lobby').waitFor({ state: 'visible' });
    check(!(await modal(page)).open, 'practice: no dialog, straight to the lobby');
    check(await page.evaluate(() => localStorage.getItem('snooker.practice')) === before, 'practice: nothing recorded');
    check(!new URL(page.url()).searchParams.has('mode'), 'the URL no longer names the match');

    // The table can be entered again with one set of controls (a drag aims once).
    await page.locator('#lobby-practice').click();
    await page.waitForFunction(() => window.__snookerDebug?.phase === 'aiming');
    check(true, 'practice starts again from the lobby');
    await ctx.close();
  }

  /* ---------- PvP ---------- */
  {
    const slots = [10 + Math.floor(Math.random() * 15), 25 + Math.floor(Math.random() * 15)];
    const [a, b] = await Promise.all(slots.map(devLogin));
    await api('/match/queue', { method: 'DELETE', token: a.token });
    await api('/match/queue', { method: 'DELETE', token: b.token });
    await api('/match/queue', { method: 'POST', token: a.token });
    const paired = await api('/match/queue', { method: 'POST', token: b.token });
    const matchId = paired.matchId ?? paired.match?.id;
    check(Boolean(matchId), `dev ${slots[0]} and dev ${slots[1]} paired`);

    const ctxA = await browser.newContext(LANDSCAPE);
    const pageA = await ctxA.newPage();
    pageA.on('pageerror', (err) => check(false, `page error: ${err.message}`));
    await pageA.goto(`${GAME}/?mode=pvp&match=${matchId}&dev=${slots[0]}`);
    await pageA.waitForFunction(() => ['aiming', 'waiting'].includes(window.__snookerDebug?.phase));

    await pageA.locator('#pause').click();
    const menu = await modal(pageA);
    check(menu.buttons.at(-1) === 'Quit match', `PvP pause menu ends with Quit match (${menu.buttons.join(' | ')})`);
    await pageA.screenshot({ path: shot('pause-pvp') });

    await click(pageA, 'Quit match');
    let m = await modal(pageA);
    check(m.title === 'Concede this match?', 'PvP: asks first');
    check(m.body.includes('Your opponent wins'), 'says the opponent wins');
    check(m.body.includes('Your breaks still count'), 'says breaks still count');
    check(m.buttons.join('|') === 'Concede and quit|Cancel', m.buttons.join('|'));
    await pageA.screenshot({ path: shot('confirm-pvp') });

    await click(pageA, 'Cancel');
    m = await modal(pageA);
    check(m.title === 'Paused', 'Cancel goes back to the pause menu');
    check((await api(`/match/${matchId}`, { token: a.token })).match.status === 'active', 'nothing conceded yet');

    await click(pageA, 'Quit match');
    await click(pageA, 'Concede and quit');
    await pageA.locator('#lobby').waitFor({ state: 'visible' });
    check(await lobbyShown(pageA), 'PvP: the quitter is back on the lobby');
    await pageA.screenshot({ path: shot('after-pvp') });

    const { match } = await api(`/match/${matchId}`, { token: b.token });
    check(match.status === 'completed' && match.ended, 'the server has the match completed');
    check(Number(match.players[match.winner]) === Number(b.user.id), 'the opponent is the winner');
    check(match.concededBy === match.players.findIndex((p) => Number(p) === Number(a.user.id)), 'recorded as conceded by the quitter');

    // The opponent's screen: the result, and the way back to the lobby.
    const ctxB = await browser.newContext(LANDSCAPE);
    const pageB = await ctxB.newPage();
    await pageB.goto(`${GAME}/?mode=pvp&match=${matchId}&dev=${slots[1]}`);
    await pageB.locator('#overlay-title').filter({ hasText: /won|Match over/ }).waitFor();
    m = await modal(pageB);
    check(m.body.includes('Your opponent conceded'), 'the opponent sees that you conceded');
    check(m.buttons[0] === 'Back to lobby', `the opponent's first choice is Back to lobby (${m.buttons.join(' | ')})`);
    await pageB.screenshot({ path: shot('opponent-pvp') });
    await click(pageB, 'Back to lobby');
    await pageB.locator('#lobby').waitFor({ state: 'visible' });
    check(true, 'the opponent gets back to the lobby');
    await ctxA.close();
    await ctxB.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
