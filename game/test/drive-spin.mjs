/**
 * Drives the spin control in a real browser (practice).
 *
 *   node game/test/drive-spin.mjs
 *
 * Needs only vite (:5173): practice never needs the backend, so failed /api
 * calls are expected and ignored. Uses the installed Chrome.
 *
 * Phone (touch, 844x390): the button shows, tapping opens the large ball,
 * dragging sets draw, Done closes, the shot carries the spin, and the next
 * turn starts from the centre again. Desktop (1280x720): Shift + mouse shows
 * the ball and moves the dot, arrows step it, C centres it, Esc closes the
 * picker, and a centre shot carries no spin at all.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TABLE, BAULK_LINE_X, D_RADIUS, CENTRE_Y } from '@snooker/sim';

const here = path.dirname(fileURLToPath(import.meta.url));
const shotPath = (name) => path.join(here, name);
const URL = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173/?mode=practice';

const RAIL = 9;
const worldToPage = (box, x, y) => {
  const scale = box.width / (TABLE.width + RAIL * 2);
  return { x: box.x + (x + RAIL) * scale, y: box.y + (y + RAIL) * scale };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` (${detail})` : ''}`);
};

async function openTable(browser, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  page.on('console', (msg) => {
    // Practice without a backend: the sign-in attempt fails, and that is fine.
    if (msg.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|fetch/i.test(msg.text())) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  await page.goto(URL, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(() => window.__snookerDebug?.phase === 'aiming', null, { timeout: 20_000 });
  const box = await page.locator('#table').boundingBox();
  // Break off from hand: place the cue ball well inside the D.
  const spot = worldToPage(box, BAULK_LINE_X - D_RADIUS / 2, CENTRE_Y + 10);
  await page.mouse.click(spot.x, spot.y);
  await sleep(200);
  return { context, page, box, errors };
}

const state = (page) => page.evaluate(() => ({
  button: document.getElementById('spin-btn').getAttribute('aria-label'),
  buttonShown: !document.getElementById('spin-btn').hidden,
  picker: !document.getElementById('spin-picker').hidden,
  peek: document.getElementById('spin-picker').classList.contains('peek'),
  label: document.querySelector('#spin-picker .spin-label').textContent,
}));

/** Aim at the pack and shoot. */
async function shoot(page, box) {
  const target = worldToPage(box, TABLE.width * 0.75, CENTRE_Y);
  await page.mouse.click(target.x, target.y);
  await sleep(150);
  const before = await page.evaluate(() => window.__snookerDebug.shotsResolved ?? 0);
  await page.click('#shoot');
  return before;
}

async function phone(browser) {
  console.log('\n— phone 844x390, touch —');
  const { context, page, box, errors } = await openTable(browser, {
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true,
  });
  let s = await state(page);
  check('spin button shows in practice', s.buttonShown);
  check('it starts at the centre', s.button === 'Spin: Centre', s.button);

  await page.click('#spin-btn');
  s = await state(page);
  check('tapping it opens the large cue ball', s.picker && !s.peek);

  const ball = await page.locator('#spin-picker .spin-ball').boundingBox();
  const cx = ball.x + ball.width / 2;
  const cy = ball.y + ball.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + ball.height * 0.2, { steps: 4 });
  await page.mouse.move(cx, cy + ball.height * 0.35, { steps: 4 }); // 0.7 of the radius, below centre
  await page.mouse.up();
  s = await state(page);
  check('dragging below centre sets draw', s.label === 'Draw', s.label);
  await page.screenshot({ path: shotPath('spin-phone-picker.png') });

  await page.click('#spin-picker [data-spin="done"]');
  s = await state(page);
  check('Done closes it', !s.picker);
  check('the button shows the draw', s.button === 'Spin: Draw', s.button);
  await page.screenshot({ path: shotPath('spin-phone-set.png') });

  const before = await shoot(page, box);
  const shot = await page.evaluate(() => window.__snookerDebug.lastShot);
  check('the shot carries the draw', shot?.spin && Math.abs(shot.spin.x) < 0.02 && shot.spin.y < -0.6 && shot.spin.y >= -0.8,
    JSON.stringify(shot?.spin));
  s = await state(page);
  check('the picker cannot open while balls run', await (async () => {
    await page.click('#spin-btn').catch(() => {});
    return !(await state(page)).picker;
  })());

  // The AI takes its turn, then it is ours again, from the centre.
  await page.waitForFunction(
    (n) => (window.__snookerDebug.shotsResolved ?? 0) > n && window.__snookerDebug.phase === 'aiming'
      && !document.getElementById('shoot').disabled,
    before, { timeout: 90_000 },
  );
  s = await state(page);
  check('the next turn starts from the centre', s.button === 'Spin: Centre', s.button);

  check('phone: no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function desktop(browser) {
  console.log('\n— desktop 1280x720 —');
  const { context, page, box, errors } = await openTable(browser, { viewport: { width: 1280, height: 720 } });

  await page.mouse.move(640, 360);
  await page.keyboard.down('Shift');
  let s = await state(page);
  check('holding Shift shows the ball (peek)', s.picker && s.peek);
  await page.mouse.move(640 + 80, 360, { steps: 5 }); // half of SHIFT_PX_PER_RADIUS
  s = await state(page);
  check('Shift + mouse right sets right side', s.label === 'Right side', s.label);
  await page.screenshot({ path: shotPath('spin-desktop-peek.png') });
  await page.keyboard.up('Shift');
  s = await state(page);
  check('letting go of Shift hides it and keeps the spin', !s.picker && s.button === 'Spin: Right side', `${s.picker} ${s.button}`);

  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  s = await state(page);
  check('arrow keys step the dot', s.button === 'Spin: Draw + right', s.button);
  await page.keyboard.press('c');
  s = await state(page);
  check('C puts it back to the centre', s.button === 'Spin: Centre', s.button);

  await page.click('#spin-btn');
  check('clicking the button opens the picker', (await state(page)).picker);
  await page.keyboard.press('Escape');
  check('Esc closes it', !(await state(page)).picker);

  const power = await page.evaluate(() => document.getElementById('power-label').textContent);
  await page.keyboard.press('e');
  await page.keyboard.press('e');
  await page.keyboard.press('q');
  const after = await page.evaluate(() => document.getElementById('power-label').textContent);
  check('E / E / Q nets +1% power', parseInt(after, 10) === parseInt(power, 10) + 1, `${power} → ${after}`);

  await shoot(page, box);
  const shot = await page.evaluate(() => window.__snookerDebug.lastShot);
  check('a centre shot carries no spin at all', shot && !('spin' in shot), JSON.stringify(shot));

  check('desktop: no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  await phone(browser);
  await desktop(browser);
} catch (err) {
  failures.push(`driver: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
