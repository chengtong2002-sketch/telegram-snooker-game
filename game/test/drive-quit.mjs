/**
 * Pause menu smoke: Resume / Surrender / Quit, and Rejoin from the lobby.
 *
 *   npm run smoke:quit -w @snooker/game
 *
 * 1. Practice: pause → Quit → "Quit practice?" → Keep playing goes back to the
 *    menu; Quit → the lobby, with nothing added to the practice record.
 * 2. PvP Quit (two ?dev= players paired through the API): "Are you sure you
 *    want to quit?" names the idle forfeit; Quit → the lobby while the match
 *    carries on (not conceded). The lobby's main button is Rejoin match; the
 *    opponent plays while we are away; Rejoin shows the table as it now is.
 *    When the opponent then surrenders, the lobby goes back to PLAY by itself.
 * 3. PvP Surrender: "Surrender this match? Your opponent wins." → Cancel goes
 *    back to the menu; Surrender → the match-over sheet, opponent the winner.
 *
 * Needs the backend (ALLOW_DEV_AUTH=true) and Vite running, and an installed
 * Chrome. Creates dev players and matches in whatever database the backend
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

/** Two fresh dev players in a new match; seat 0 (`a`) breaks. */
async function pair(base) {
  const slots = [base + Math.floor(Math.random() * 10), base + 10 + Math.floor(Math.random() * 10)];
  const [a, b] = await Promise.all(slots.map(devLogin));
  for (const p of [a, b]) {
    // A leftover match from an earlier run would pair these two with it.
    for (const m of (await api('/match/active', { token: p.token })).matches ?? []) {
      await api(`/match/${m.id}/concede`, { method: 'POST', token: p.token, body: { via: 'menu' } });
    }
    await api('/match/queue', { method: 'DELETE', token: p.token });
  }
  await api('/match/queue', { method: 'POST', token: a.token });
  const paired = await api('/match/queue', { method: 'POST', token: b.token });
  return { slots, a, b, matchId: paired.matchId ?? paired.match?.id };
}

/** A shot that touches nothing: a miss, 4 to the opponent, turn passes. */
let seq = 0;
const nudge = (matchId, p) => api(`/match/${matchId}/shot`, {
  method: 'POST', token: p.token, body: { resultId: `smoke-quit-${Date.now()}-${seq++}`, shot: { angle: Math.PI, power: 0.01 } },
});

const modal = (page) => page.evaluate(() => ({
  open: !document.getElementById('overlay').hidden,
  title: document.getElementById('overlay-title').textContent,
  body: document.getElementById('overlay-body').textContent.replace(/\s+/g, ' '),
  buttons: [...document.querySelectorAll('#overlay-actions button')].map((b) => b.textContent),
}));
const click = (page, label) => page.locator('#overlay-actions button', { hasText: label }).first().click();
const buttonLook = (page, label) => page.locator('#overlay-actions button', { hasText: label }).first()
  .evaluate((el) => ({ className: el.className, color: getComputedStyle(el).color }));
const RED = 'rgb(227, 92, 77)';

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
    check(menu.buttons[0] === 'Resume', `Resume on top (${menu.buttons.join(' | ')})`);
    check(menu.buttons.includes('Quit') && !menu.buttons.includes('Surrender'), 'practice: Quit, and no Surrender');
    check(menu.buttons.includes('Wallet & rewards') && menu.buttons.includes('Close game'), 'practice keeps Wallet & rewards and Close game');

    await click(page, 'Quit');
    let m = await modal(page);
    check(m.title === 'Quit practice?', `practice asks first: "${m.title}"`);
    check(m.buttons.join('|') === 'Quit|Keep playing', m.buttons.join('|'));
    await page.screenshot({ path: shot('practice-confirm') });
    await click(page, 'Keep playing');
    m = await modal(page);
    check(m.title === 'Paused', 'Keep playing goes back to the menu');

    await click(page, 'Quit');
    await click(page, 'Quit');
    await page.locator('#lobby').waitFor({ state: 'visible' });
    check(!(await modal(page)).open, 'practice: the lobby, no sheet over it');
    check(await page.evaluate(() => localStorage.getItem('snooker.practice')) === before, 'practice: nothing recorded');
    check(!new URL(page.url()).searchParams.has('mode'), 'the URL no longer names the table');
    check((await page.locator('#lobby-play').innerText()).trim() === 'PLAY', 'no match to rejoin: PLAY');

    await page.locator('#lobby-practice').click();
    await page.waitForFunction(() => window.__snookerDebug?.phase === 'aiming');
    check(true, 'practice starts again from the lobby');
    await ctx.close();
  }

  /* ---------- PvP: Quit, then Rejoin ---------- */
  {
    const { slots, a, b, matchId } = await pair(10);
    check(Boolean(matchId), `dev ${slots[0]} and dev ${slots[1]} paired`);
    await nudge(matchId, a); // a breaks and misses: 0–4, b to play

    const ctx = await browser.newContext(LANDSCAPE);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
    await page.goto(`${GAME}/?mode=pvp&match=${matchId}&dev=${slots[0]}`);
    await page.waitForFunction(() => ['aiming', 'waiting'].includes(window.__snookerDebug?.phase));

    await page.locator('#pause').click();
    const menu = await modal(page);
    check(menu.buttons[0] === 'Resume', `Resume on top (${menu.buttons.join(' | ')})`);
    check(menu.buttons.join('|') === 'Resume|Sound: on|Surrender|Quit', `PvP menu is Resume, Sound, Surrender, Quit only (${menu.buttons.join(' | ')})`);
    const surrender = await buttonLook(page, 'Surrender');
    const quit = await buttonLook(page, 'Quit');
    check(surrender.color === RED && /danger/.test(surrender.className), `Surrender is red (${surrender.color})`);
    check(quit.color !== RED && !/danger|quit/.test(quit.className), `Quit is neutral (${quit.color})`);
    await page.screenshot({ path: shot('pause-pvp') });

    await click(page, 'Quit');
    let m = await modal(page);
    check(m.title === 'Are you sure you want to quit?', `asks first: "${m.title}"`);
    check(m.body.includes("The match continues without you — if you don't return, you'll forfeit after 3 missed turns."),
      'says the match carries on and when it is forfeited');
    check(!/d+s*s|seconds/.test(m.body), 'and names no seconds');
    check(m.buttons.join('|') === 'Quit|Stay in the match', m.buttons.join('|'));
    await page.screenshot({ path: shot('confirm-pvp-quit') });
    await click(page, 'Stay in the match');
    check((await modal(page)).title === 'Paused', 'Stay goes back to the menu');

    await click(page, 'Quit');
    await click(page, 'Quit');
    await page.locator('#lobby').waitFor({ state: 'visible' });
    let match = (await api(`/match/${matchId}`, { token: a.token })).match;
    check(match.status === 'active' && !match.ended, 'quitting concedes nothing: the match is still on');
    await page.locator('#lobby-play', { hasText: 'REJOIN MATCH' }).waitFor({ timeout: 8000 });
    check(true, 'the lobby offers Rejoin match');
    await page.screenshot({ path: shot('lobby-rejoin') });

    // The opponent plays on while we are away: they miss too, 4–4 and our turn.
    await nudge(matchId, b);
    match = (await api(`/match/${matchId}`, { token: a.token })).match;
    check(match.frame.scores.join('–') === '4–4', `the server moved on: ${match.frame.scores.join('–')}`);

    await page.locator('#lobby-play').click();
    await page.waitForFunction(() => window.__snookerDebug?.phase === 'aiming');
    const shown = await page.evaluate(() => [
      document.getElementById('score-a').textContent, document.getElementById('score-b').textContent,
      window.__snookerDebug.ballsOnTable,
    ]);
    check(shown[0] === '4' && shown[1] === '4', `Rejoin shows the table as it stands: ${shown[0]}–${shown[1]}`);
    check(shown[2] === match.frame.balls.filter((x) => !x.potted).length, `the same balls on the table (${shown[2]})`);
    check(new URL(page.url()).searchParams.get('match') === matchId, 'the URL names the match again');
    await page.screenshot({ path: shot('rejoined') });

    // Leave again; the opponent surrenders; the lobby notices without a reload.
    await page.locator('#pause').click();
    await click(page, 'Quit');
    await click(page, 'Quit');
    await page.locator('#lobby-play', { hasText: 'REJOIN MATCH' }).waitFor({ timeout: 8000 });
    await api(`/match/${matchId}/concede`, { method: 'POST', token: b.token, body: { via: 'menu' } });
    await page.locator('#lobby-play', { hasText: /^PLAY$/ }).waitFor({ timeout: 15_000 });
    check(true, 'once the match is over, PLAY comes back');
    await ctx.close();
  }

  /* ---------- PvP: Surrender ---------- */
  {
    const { slots, a, b, matchId } = await pair(60);
    const ctx = await browser.newContext(LANDSCAPE);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
    await page.goto(`${GAME}/?mode=pvp&match=${matchId}&dev=${slots[0]}`);
    await page.waitForFunction(() => ['aiming', 'waiting'].includes(window.__snookerDebug?.phase));

    await page.locator('#pause').click();
    await click(page, 'Surrender');
    let m = await modal(page);
    check(m.title === 'Surrender this match?', `asks first: "${m.title}"`);
    check(m.body.startsWith('Your opponent wins.'), 'says the opponent wins');
    check(m.body.includes('Your breaks still count'), 'says breaks still count');
    check(m.buttons.join('|') === 'Surrender|Cancel', m.buttons.join('|'));
    await page.screenshot({ path: shot('confirm-surrender') });
    await click(page, 'Cancel');
    check((await modal(page)).title === 'Paused', 'Cancel goes back to the menu');
    check((await api(`/match/${matchId}`, { token: a.token })).match.status === 'active', 'nothing conceded yet');

    await click(page, 'Surrender');
    await click(page, 'Surrender');
    await page.locator('#overlay-title', { hasText: 'Match over' }).waitFor();
    m = await modal(page);
    check(m.body.includes('You conceded'), 'the match-over sheet says so');
    const { match } = await api(`/match/${matchId}`, { token: b.token });
    check(match.status === 'completed' && Number(match.players[match.winner]) === Number(b.user.id), 'the opponent wins');
    await page.screenshot({ path: shot('surrendered') });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
