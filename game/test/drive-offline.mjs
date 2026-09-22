/**
 * Drives the offline story in a real browser.
 *
 *   node game/test/drive-offline.mjs
 *
 * Needs the backend (:8080, ALLOW_DEV_AUTH=true) and vite (:5173) running.
 *
 * What it proves, in order:
 *   1. the lobby loads online, with Play and Rewards live
 *   2. dropping the connection greys out Play and Rewards, shows the Offline
 *      chip, and leaves Practice alone
 *   3. the connection coming back re-enables both, with no reload
 *   4. practice *started* while offline plays a full sequence of shots
 *   5. a connection lost *mid-frame* does not interrupt the frame
 *   6. no practice frame makes a single backend call, online or offline
 *
 * (6) is the load-bearing one: practice has to be device-only, so the driver
 * counts every request to /api during each phase and fails if a practice phase
 * made any.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TABLE, BAULK_LINE_X, D_RADIUS, CENTRE_Y, COLOURS } from '@snooker/sim';

const here = path.dirname(fileURLToPath(import.meta.url));
const shotPath = (name) => path.join(here, name);

const RAIL = 9;
const worldToPage = (box, x, y) => {
  const scale = box.width / (TABLE.width + RAIL * 2);
  return { x: box.x + (x + RAIL) * scale, y: box.y + (y + RAIL) * scale };
};

const ORIGIN = process.env.GAME_ORIGIN ?? 'http://127.0.0.1:5173';
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 900, height: 420 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Requests to the backend, tagged with the phase they happened in. */
let phase = 'boot';
const apiCalls = [];
const callsIn = (...phases) => apiCalls.filter((c) => phases.includes(c.phase));

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: PORTRAIT,
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`${phase}: uncaught ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`${phase}: console.error ${msg.text()}`);
  });
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/')) apiCalls.push({ phase, path: new URL(url).pathname });
  });

  const lobbyState = () => page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    return {
      lobbyVisible: !el('lobby').hidden,
      playLabel: el('lobby-play').textContent.trim(),
      playDisabled: el('lobby-play').disabled,
      practiceDisabled: el('lobby-practice').disabled,
      rewardsDisabled: el('lobby-rewards').disabled,
      offlineChip: !el('lobby-offline').hidden,
      offlineNote: !el('offline-note').hidden,
      name: el('lobby-name').textContent.trim(),
      sub: el('lobby-sub').textContent.trim(),
      points: el('stat-points').textContent.trim(),
      matches: el('stat-matches').textContent.trim(),
      best: el('stat-break').textContent.trim(),
      cap: el('cap-value').textContent.trim(),
      capNote: el('cap-note').textContent.trim(),
    };
  });

  const tableState = () => page.evaluate(() => ({
    scoreA: document.getElementById('score-a').textContent,
    scoreB: document.getElementById('score-b').textContent,
    breakLine: document.getElementById('breakline').textContent,
    ballOn: document.getElementById('ballon').textContent,
    hint: document.getElementById('hint').textContent,
    shootDisabled: document.getElementById('shoot').disabled,
    ballsOnTable: window.__snookerDebug?.ballsOnTable ?? null,
    shotsResolved: window.__snookerDebug?.shotsResolved ?? 0,
  }));

  const waitForShoot = (timeout = 20_000) => page.waitForFunction(
    () => document.getElementById('shoot') && !document.getElementById('shoot').disabled,
    null,
    { timeout },
  );

  /** Place the cue ball if it is in hand, then play one shot at the pack. */
  async function playShot(n) {
    // A foul hands the frame to the AI. Clicking SHOOT while it is the AI's turn
    // does nothing at all, which would look exactly like a shot that failed to
    // resolve — so wait for the turn to come back first.
    await page.waitForFunction(
      () => document.getElementById('player-a').classList.contains('active')
        && !document.getElementById('shoot').disabled,
      null,
      { timeout: 60_000 },
    ).catch(() => console.log(`   (shot ${n}: turn did not come back in 60s)`));

    const canvasBox = await page.locator('#table').boundingBox();
    const meterBox = await page.locator('#power').boundingBox();

    const inHand = await page.evaluate(
      () => document.getElementById('hint').textContent.includes('D'),
    );
    if (inHand) {
      const spot = worldToPage(canvasBox, BAULK_LINE_X - D_RADIUS / 2, CENTRE_Y + 10);
      await page.mouse.click(spot.x, spot.y);
      await sleep(250);
    }

    const pink = COLOURS.find((c) => c.color === 'pink').spot;
    const target = worldToPage(canvasBox, pink.x, pink.y + (n - 2) * 12);
    await page.mouse.click(target.x, target.y);

    // Power to ~75%.
    await page.mouse.move(meterBox.x + meterBox.width / 2, meterBox.y + meterBox.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(meterBox.x + meterBox.width / 2, meterBox.y + meterBox.height * 0.25, { steps: 5 });
    await page.mouse.up();

    const before = await tableState();
    await page.locator('#shoot').click();

    // The frame is settled when the button comes back, or the AI takes over.
    await page.waitForFunction(
      () => !document.getElementById('shoot').disabled
        || document.getElementById('hint').textContent.includes('AI'),
      null,
      { timeout: 45_000 },
    ).catch(() => {});
    await sleep(500);
    const after = await tableState();
    // The game counts every shot it resolves. A legal shot that pots nothing
    // leaves score, ball-on and ball count untouched, so the counter is the
    // only signal that separates "played and resolved" from "never happened".
    const moved = after.shotsResolved > before.shotsResolved;
    return { before, after, moved };
  }

  // ---------------------------------------------------------------- 1. lobby
  console.log('\n1. lobby, online');
  phase = 'lobby-online';
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById('lobby').hidden, null, { timeout: 20_000 });
  // Stats arrive a moment after the screen paints.
  await page.waitForFunction(
    () => document.getElementById('stat-points').textContent.trim() !== '–',
    null,
    { timeout: 15_000 },
  ).catch(() => {});

  const online1 = await lobbyState();
  console.log('   ', JSON.stringify(online1));
  check('lobby is the first screen', online1.lobbyVisible);
  check('Play is live online', !online1.playDisabled);
  check('Rewards is live online', !online1.rewardsDisabled);
  check('no Offline chip online', !online1.offlineChip);
  check('stats loaded', online1.points !== '–', `points=${online1.points} cap=${online1.cap}`);
  await page.screenshot({ path: shotPath('lobby-1-online.png') });
  await page.setViewportSize(LANDSCAPE);
  await sleep(300);
  await page.screenshot({ path: shotPath('lobby-2-online-landscape.png') });
  await page.setViewportSize(PORTRAIT);
  await sleep(300);

  // ------------------------------------------------------------- 2. offline
  console.log('\n2. connection drops while in the lobby');
  phase = 'lobby-offline';
  await context.setOffline(true);
  await page.waitForFunction(
    () => !document.getElementById('lobby-offline').hidden,
    null,
    { timeout: 15_000 },
  ).catch(() => {});

  const off = await lobbyState();
  console.log('   ', JSON.stringify(off));
  check('Offline chip shows', off.offlineChip);
  check('offline note shows', off.offlineNote);
  check('Play is greyed out offline', off.playDisabled);
  check('Rewards is greyed out offline', off.rewardsDisabled);
  check('Practice stays available offline', !off.practiceDisabled);
  await page.screenshot({ path: shotPath('lobby-3-offline.png') });

  // --------------------------------------------------------- 3. back online
  console.log('\n3. connection returns (no reload)');
  phase = 'lobby-reonline';
  await context.setOffline(false);
  await page.waitForFunction(
    () => document.getElementById('lobby-offline').hidden
      && !document.getElementById('lobby-play').disabled,
    null,
    { timeout: 20_000 },
  ).catch(() => {});
  const back = await lobbyState();
  console.log('   ', JSON.stringify(back));
  check('Play re-enables on reconnect', !back.playDisabled);
  check('Rewards re-enables on reconnect', !back.rewardsDisabled);
  check('Offline chip clears on reconnect', !back.offlineChip);

  // ------------------------------------- 4. start practice while offline
  console.log('\n4. practice started while offline');
  await page.setViewportSize(LANDSCAPE); // the table needs landscape
  await sleep(300);
  await context.setOffline(true);
  await page.waitForFunction(
    () => !document.getElementById('lobby-offline').hidden,
    null,
    { timeout: 15_000 },
  ).catch(() => {});

  phase = 'practice-offline-enter';
  await page.locator('#lobby-practice').click();
  await waitForShoot().catch(() => {});
  const started = await page.evaluate(() => document.getElementById('lobby').hidden);
  check('practice starts with no connection', started);

  // Only from here on is the frame itself under test — boot and sign-in are not
  // part of a practice frame, and are counted separately below.
  phase = 'practice-offline-shots';
  for (let n = 1; n <= 2; n += 1) {
    const { after, moved } = await playShot(n);
    check(`offline practice shot ${n} resolved`, moved, JSON.stringify({
      score: `${after.scoreA}-${after.scoreB}`, balls: after.ballsOnTable, shots: after.shotsResolved,
    }));
  }
  await page.screenshot({ path: shotPath('practice-4-offline.png') });
  check('offline practice frame made no backend calls',
    callsIn('practice-offline-shots').length === 0,
    callsIn('practice-offline-shots').map((c) => c.path).join(', '));

  // ------------------------------------------- 5. connection drops mid-frame
  console.log('\n5. connection drops mid-frame');
  phase = 'practice-online-boot';
  await context.setOffline(false);
  await page.goto(`${ORIGIN}/?mode=practice`, { waitUntil: 'networkidle', timeout: 30_000 });
  await waitForShoot();

  phase = 'practice-online-shots';
  const first = await playShot(1);
  check('online practice shot resolved', first.moved);

  console.log('   pulling the connection now, mid-frame');
  phase = 'practice-mid-drop';
  await context.setOffline(true);

  for (let n = 2; n <= 3; n += 1) {
    const { after, moved } = await playShot(n);
    check(`shot ${n} after the drop resolved`, moved, JSON.stringify({
      score: `${after.scoreA}-${after.scoreB}`, balls: after.ballsOnTable, shots: after.shotsResolved,
    }));
  }
  await page.screenshot({ path: shotPath('practice-5-mid-drop.png') });
  check('practice after the drop made no backend calls',
    callsIn('practice-mid-drop').length === 0,
    callsIn('practice-mid-drop').map((c) => c.path).join(', '));
  check('practice with a connection made no backend calls either',
    callsIn('practice-online-shots').length === 0,
    callsIn('practice-online-shots').map((c) => c.path).join(', '));

  // Deliberately last: reconnecting fires the probe, and attributing that to a
  // practice phase is what made an earlier run of this driver look like a leak.
  phase = 'teardown';
  await context.setOffline(false);
  await sleep(500);
  await browser.close();

  // ------------------------------------------------------------- report
  console.log(`\n${'='.repeat(64)}`);
  console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  console.log('api calls by phase:');
  for (const p of [...new Set(apiCalls.map((c) => c.phase))]) {
    console.log(`  ${p}: ${callsIn(p).map((c) => c.path).join(', ')}`);
  }
  if (pageErrors.length) {
    console.log(`\npage errors (${pageErrors.length}):`);
    for (const e of pageErrors.slice(0, 15)) console.log(`  ${e}`);
  }
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
