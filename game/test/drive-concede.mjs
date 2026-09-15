/**
 * Drives both PvP concede paths in a real browser, two players at once.
 *
 *   DATABASE_URL=file:/tmp/concede.sqlite npm run dev:backend   (ALLOW_DEV_AUTH=true)
 *   npm run dev:game
 *   DATABASE_URL=file:/tmp/concede.sqlite node game/test/drive-concede.mjs
 *
 * The driver writes match state straight into the backend's database to skip
 * to the interesting moment (last black of a frame, a hopeless deficit), so
 * point both at the same throwaway DATABASE_URL — never the dev database.
 *
 * 1. Checkpoint: seat 0 pots the last black to go 1-0. The trailing player gets
 *    Continue/Concede, the leader only Continue. Cancel returns to the prompt;
 *    Concede → Confirm ends the match at 1-0 on both screens.
 * 2. Mid-frame: the Concede match button is hidden at a deficit equal to what is
 *    left, shown once it is one more. Confirming ends the match at 0-0 and the
 *    conceder's break is still recorded as the eligible break.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { getDb, closeDb, fromJson, toJson } from '@snooker/db';
import { POCKETS, ballById } from '@snooker/sim';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the same throwaway database the backend is using.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173/';
const API = process.env.BACKEND_URL_LOCAL ?? 'http://127.0.0.1:8080/api';

const errors = [];
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
}

async function call(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Same identities the page picks for ?dev=N (see devUser() in src/api.js).
const devId = (n) => 999_000_000 + n;
const login = async (n) => (await call('/auth/telegram', {
  method: 'POST', body: { devUser: { id: devId(n), first_name: `Dev ${n}`, username: `dev${n}` } },
})).body;

/** Pair dev players a (seat 0) and b (seat 1). */
async function newMatch(a, b) {
  const [pa, pb] = [await login(a), await login(b)];
  await call('/match/queue', { method: 'POST', token: pa.token });
  const { body } = await call('/match/queue', { method: 'POST', token: pb.token });
  if (!body.matchId) throw new Error(`matchmaking did not pair: ${JSON.stringify(body)}`);
  return { matchId: body.matchId, tokens: [pa.token, pb.token], users: [pa.user, pb.user] };
}

async function setState(matchId, mutate) {
  const knex = getDb();
  const row = await knex('matches').where({ id: matchId }).first();
  const state = fromJson(row.state);
  mutate(state);
  await knex('matches').where({ id: matchId }).update({
    state: toJson(state),
    turn_user_id: state.players[state.frame.turn],
    shot_deadline: new Date(Date.now() + 25_000),
  });
}

/** Only the black left, lined up for seat 0 to pot it. */
const lastBlack = (scores) => (state) => {
  const pocket = POCKETS.find((p) => p.id === 'br');
  const black = { x: pocket.x - 60, y: pocket.y - 60 };
  const f = state.frame;
  f.balls.forEach((ball) => { ball.potted = true; });
  Object.assign(ballById(f, 'black'), black, { potted: false });
  Object.assign(ballById(f, 'cue'), { x: black.x - 40, y: black.y - 40, potted: false });
  Object.assign(f, { phase: 'colours', ballOn: 'black', redsRemaining: 0, inHand: false, turn: 0, scores });
};
const POT_BLACK = { angle: Math.PI / 4, power: 0.55 };

async function openPlayer(context, n, matchId) {
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`dev${n} console.error: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`dev${n} uncaught: ${err.message}`));
  page.on('response', (res) => {
    // A 409 from /shot is expected nowhere here; anything >= 400 is worth seeing.
    if (res.status() >= 400 && !res.url().includes('favicon')) errors.push(`dev${n} HTTP ${res.status()} ${res.url()}`);
  });
  await page.goto(`${GAME}?dev=${n}&mode=pvp&match=${matchId}`, { waitUntil: 'networkidle' });
  return page;
}

const modal = (page) => page.evaluate(() => {
  const overlay = document.getElementById('overlay');
  return {
    open: !overlay.hidden,
    title: document.getElementById('overlay-title').textContent,
    body: document.getElementById('overlay-body').textContent.replace(/\s+/g, ' ').trim(),
    buttons: [...document.querySelectorAll('#overlay-actions button')].map((b) => b.textContent),
  };
});
const waitForTitle = (page, text, timeout = 15_000) => page.waitForFunction(
  (t) => !document.getElementById('overlay').hidden && document.getElementById('overlay-title').textContent.includes(t),
  text,
  { timeout },
);
const clickAction = (page, label) => page.locator('#overlay-actions button', { hasText: label }).click();
const concedeVisible = (page) => page.evaluate(() => !document.getElementById('concede').hidden);

async function checkpointScenario(context) {
  console.log('\n[1] between-frame checkpoint');
  const { matchId, tokens } = await newMatch(1, 2);
  await setState(matchId, lastBlack([40, 30]));

  // The trailing player is already waiting (polling) when the frame ends.
  const trailing = await openPlayer(context, 2, matchId);
  const shot = await call(`/match/${matchId}/shot`, {
    method: 'POST', token: tokens[0], body: { resultId: `${matchId}-black`, shot: POT_BLACK },
  });
  check('seat 0 pots the black and the frame ends 1-0',
    shot.body.outcome?.frameEnded === true && shot.body.match?.framesWon.join('-') === '1-0',
    JSON.stringify(shot.body).slice(0, 200));

  // The leader opens the game after the frame ended.
  const leader = await openPlayer(context, 1, matchId);

  await waitForTitle(trailing, 'Frame 1 complete');
  let m = await modal(trailing);
  await trailing.screenshot({ path: path.join(here, 'concede-1-trailing-checkpoint.png') });
  check('trailing player: "Frame 1 complete"', m.title === 'Frame 1 complete', m.title);
  check('trailing player: "Continue to frame 2?"', m.body.includes('Continue to frame 2?'), m.body);
  check('trailing player: Continue and Concede', m.buttons.join('|') === 'Continue|Concede', m.buttons.join('|'));
  check('trailing player: says breaks still count', /Breaks you've already made still count/.test(m.body), m.body);
  check('no mid-frame concede button during the checkpoint', !(await concedeVisible(trailing)));

  await waitForTitle(leader, 'Frame 1 complete');
  m = await modal(leader);
  await leader.screenshot({ path: path.join(here, 'concede-1-leader-checkpoint.png') });
  check('leader: "Continue to frame 2?"', m.body.includes('Continue to frame 2?'), m.body);
  check('leader: Continue only', m.buttons.join('|') === 'Continue', m.buttons.join('|'));

  await clickAction(leader, 'Continue');
  await sleep(500);
  const leaderHint = await leader.locator('#hint').textContent();
  check('leader Continue is only an acknowledgement', (await modal(leader)).open === false
    && leaderHint.includes('Waiting for your opponent'), leaderHint);

  await clickAction(trailing, 'Concede');
  await waitForTitle(trailing, 'Concede this match?');
  m = await modal(trailing);
  await trailing.screenshot({ path: path.join(here, 'concede-2-confirm.png') });
  check('confirm: "Your opponent will be recorded as the winner."', m.body.includes('Your opponent will be recorded as the winner.'), m.body);
  check('confirm: Confirm and Cancel', m.buttons.join('|') === 'Confirm|Cancel', m.buttons.join('|'));
  check('confirm: says breaks still count', m.body.includes('Your breaks still count'), m.body);

  await clickAction(trailing, 'Cancel');
  await waitForTitle(trailing, 'Frame 1 complete');
  check('Cancel returns to the checkpoint prompt', (await modal(trailing)).buttons.join('|') === 'Continue|Concede');

  await clickAction(trailing, 'Concede');
  await waitForTitle(trailing, 'Concede this match?');
  await clickAction(trailing, 'Confirm');
  await trailing.waitForFunction(() => document.getElementById('overlay-body').textContent.includes('You conceded'), null, { timeout: 10_000 });
  m = await modal(trailing);
  await trailing.screenshot({ path: path.join(here, 'concede-3-over-conceder.png') });
  check('conceder sees "You conceded" at frames 1–0', m.body.includes('You conceded') && m.body.includes('Frames1–0'), m.body);

  await leader.waitForFunction(() => document.getElementById('overlay-body').textContent.includes('Your opponent conceded'), null, { timeout: 10_000 })
    .catch(() => {});
  m = await modal(leader);
  await leader.screenshot({ path: path.join(here, 'concede-3-over-winner.png') });
  check('leader sees "Your opponent conceded" at frames 1–0', m.body.includes('Your opponent conceded') && m.body.includes('Frames1–0'), m.body);

  const { body } = await call(`/match/${matchId}`, { token: tokens[0] });
  check('server: ended, winner seat 0, conceded by seat 1, no frame 2 played',
    body.match.ended && body.match.winner === 0 && body.match.concededBy === 1 && body.match.framesWon.join('-') === '1-0');
  await Promise.all([trailing.close(), leader.close()]);
}

async function midFrameScenario(context) {
  console.log('\n[2] mid-frame surrender');
  const { matchId, tokens, users } = await newMatch(3, 4);
  // Seat 0 made a 20 this frame and is now behind by exactly what is left (7).
  const setScores = (scores) => setState(matchId, (s) => {
    lastBlack(scores)(s);
    s.frame.turn = 1;
    s.frame.highBreaks = [20, 0];
  });
  await setScores([50, 57]);

  const page = await openPlayer(context, 3, matchId);
  await sleep(800);
  check('hidden when the deficit equals what remains (7 behind, 7 on the table)', !(await concedeVisible(page)));

  await setScores([50, 58]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('concede').hidden, null, { timeout: 10_000 }).catch(() => {});
  check('shown once the deficit exceeds it (8 behind, 7 on the table)', await concedeVisible(page));
  await page.screenshot({ path: path.join(here, 'concede-4-midframe-button.png') });

  await page.locator('#concede').click();
  await waitForTitle(page, 'Concede this match?');
  let m = await modal(page);
  check('confirm: "Your opponent will be recorded as the winner."', m.body.includes('Your opponent will be recorded as the winner.'), m.body);
  check('confirm: Confirm and Cancel', m.buttons.join('|') === 'Confirm|Cancel', m.buttons.join('|'));
  check('confirm: says breaks still count', m.body.includes('Your breaks still count'), m.body);

  await clickAction(page, 'Cancel');
  await sleep(300);
  check('Cancel closes the dialog and leaves the match running',
    !(await modal(page)).open && await concedeVisible(page));

  await page.locator('#concede').click();
  await waitForTitle(page, 'Concede this match?');
  await clickAction(page, 'Confirm');
  await page.waitForFunction(() => document.getElementById('overlay-body').textContent.includes('You conceded'), null, { timeout: 10_000 }).catch(() => {});
  m = await modal(page);
  await page.screenshot({ path: path.join(here, 'concede-5-midframe-over.png') });
  check('match over: "You conceded" at frames 0–0', m.body.includes('You conceded') && m.body.includes('Frames0–0'), m.body);
  check('match over: concede button gone', !(await concedeVisible(page)));

  const eligible = await getDb()('eligible_breaks').where({ match_id: matchId }).first();
  check('the conceder\'s 20 break is still the eligible break',
    eligible && Number(eligible.user_id) === Number(users[0].id) && eligible.break_value === 20,
    JSON.stringify(eligible));
  const { body } = await call(`/match/${matchId}`, { token: tokens[1] });
  check('server: winner is the opponent', body.match.winner === 1 && body.match.concededBy === 0);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2, hasTouch: true });
  try {
    await checkpointScenario(context);
    await midFrameScenario(context);
  } finally {
    await browser.close();
    await closeDb();
  }

  console.log('\n--- page problems ---');
  if (errors.length === 0) console.log('  none');
  else for (const e of errors) console.log(`  ✗ ${e}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nDRIVER FAILED:', err.message);
  for (const e of errors) console.log(`  ✗ ${e}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
