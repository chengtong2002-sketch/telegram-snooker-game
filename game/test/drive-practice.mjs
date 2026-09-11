/**
 * Drives a practice frame in a real browser.
 *
 *   node game/test/drive-practice.mjs
 *
 * Needs the backend (:8080, ALLOW_DEV_AUTH=true) and vite (:5173) running.
 * Uses the installed Chrome rather than downloading a browser.
 *
 * This is a smoke test, not an assertion suite: it plays several shots and
 * reports anything the page logged, threw, or failed to load. The point is to
 * catch the class of bug that only shows up when the renderer, controls and
 * game loop actually run together.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TABLE, BAULK_LINE_X, CENTRE_Y, COLOURS } from '@snooker/sim';

// Resolve screenshots against this file, not the cwd: `npm run smoke -w
// @snooker/game` runs with cwd already at game/, so a repo-relative path wrote
// them to game/game/test/ — outside the gitignore rule that covers them.
const here = path.dirname(fileURLToPath(import.meta.url));
const shotPath = (name) => path.join(here, name);

// The renderer draws a 9cm rail around the playing surface; mirror that here so
// the driver can aim at real table coordinates instead of guessing at fractions.
const RAIL = 9;
const worldToPage = (box, x, y) => {
  const scale = box.width / (TABLE.width + RAIL * 2);
  return { x: box.x + (x + RAIL) * scale, y: box.y + (y + RAIL) * scale };
};

const URL = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173/?mode=practice';
// Screenshots land next to this script; they are gitignored build output.
const SHOTS = Number(process.env.SHOTS ?? 4);

const errors = [];
const consoleLines = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 900, height: 420 },   // landscape phone-ish
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    consoleLines.push(`${msg.type()}: ${msg.text()}`);
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      errors.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    // Favicon noise is not interesting.
    if (!req.url().includes('favicon')) {
      errors.push(`request failed: ${req.url()} (${failure})`);
    }
  });

  console.log(`opening ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });

  // The app boots async (login -> match setup). Wait for the shoot button to
  // become live, which only happens once it is actually the player's turn.
  await page.waitForFunction(
    () => document.getElementById('shoot') && !document.getElementById('shoot').disabled,
    null,
    { timeout: 20_000 },
  );

  const canvasBox = await page.locator('#table').boundingBox();
  const meterBox = await page.locator('#power').boundingBox();
  console.log(`canvas ${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`);

  const readHud = () => page.evaluate(() => ({
    scoreA: document.getElementById('score-a').textContent,
    scoreB: document.getElementById('score-b').textContent,
    ballOn: document.getElementById('ballon').textContent,
    breakLine: document.getElementById('breakline').textContent,
    clock: document.getElementById('clock').textContent,
    hint: document.getElementById('hint').textContent,
    toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
    activeSeat: document.getElementById('player-a').classList.contains('active') ? 'A'
      : (document.getElementById('player-b').classList.contains('active') ? 'B' : 'none'),
    ballsOnTable: window.__snookerDebug?.ballsOnTable ?? null,
  }));

  console.log('\ninitial HUD:', JSON.stringify(await readHud()));

  await page.screenshot({ path: shotPath('shot-0-initial.png') });

  // Break off: the cue ball starts in hand, so place it in the D first.
  const inHand = await page.evaluate(() => document.getElementById('hint').textContent.includes('D'));
  if (inHand) {
    // Park it on the brown spot, dead centre of the D.
    const spot = worldToPage(canvasBox, BAULK_LINE_X, CENTRE_Y + 10);
    console.log(`cue ball is in hand — placing it in the D at ${Math.round(spot.x)},${Math.round(spot.y)}`);
    await page.mouse.click(spot.x, spot.y);
    await sleep(300);
    const placed = await readHud();
    console.log('after placing:', JSON.stringify(placed));
    if (placed.toast.includes('must be placed')) {
      errors.push('cue ball placement was rejected at the centre of the D');
    }
  }

  for (let shot = 1; shot <= SHOTS; shot += 1) {
    const before = await readHud();
    if (before.activeSeat !== 'A') {
      console.log(`\nshot ${shot}: not the player's turn (AI is on) — waiting`);
      await page.waitForFunction(
        () => document.getElementById('player-a').classList.contains('active')
          && !document.getElementById('shoot').disabled,
        null,
        { timeout: 60_000 },
      ).catch(() => console.log('  (timed out waiting for the turn to come back)'));
    }

    // Aim at the pack, nudged a little each shot so we are not replaying one shot.
    const pink = COLOURS.find((c) => c.color === 'pink').spot;
    const target = worldToPage(canvasBox, pink.x, pink.y + (shot - 2) * 12);
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.25, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();

    // Power: drag the left meter to ~75%.
    const powerY = meterBox.y + meterBox.height * 0.25;
    await page.mouse.move(meterBox.x + meterBox.width / 2, meterBox.y + meterBox.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(meterBox.x + meterBox.width / 2, powerY, { steps: 5 });
    await page.mouse.up();

    const power = await page.locator('#power-label').textContent();
    console.log(`\nshot ${shot}: power ${power}`);

    await page.locator('#shoot').click();

    // Balls roll for a few seconds; wait for the shoot button to come back or
    // for the AI to take over.
    await page.waitForFunction(
      () => {
        const shootBtn = document.getElementById('shoot');
        const hint = document.getElementById('hint').textContent;
        return !shootBtn.disabled || hint.includes('AI');
      },
      null,
      { timeout: 45_000 },
    ).catch(() => console.log('  (shot did not settle within 45s)'));

    await sleep(400);
    const after = await readHud();
    console.log(`  -> ${JSON.stringify(after)}`);
    await page.screenshot({ path: shotPath(`shot-${shot}.png`) });
  }

  await page.screenshot({ path: shotPath('final.png') });

  console.log('\n--- console output ---');
  for (const line of consoleLines.slice(0, 40)) console.log('  ' + line);

  console.log('\n--- problems ---');
  if (errors.length === 0) console.log('  none');
  else for (const e of errors) console.log('  ✗ ' + e);

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nDRIVER FAILED:', err.message);
  console.log('\n--- console output before failure ---');
  for (const line of consoleLines.slice(-30)) console.log('  ' + line);
  console.log('\n--- problems ---');
  for (const e of errors) console.log('  ✗ ' + e);
  process.exit(1);
});
