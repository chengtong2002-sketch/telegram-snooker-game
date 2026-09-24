/**
 * Live aim in a real browser: two players, one match, the waiting player
 * watches the shooter's cue move. Then the practice AI lining up its shot.
 *
 *   ALLOW_DEV_AUTH=true DATABASE_URL=<throwaway> npm run dev:backend
 *   npm run dev:game
 *   npm run smoke:aim -w @snooker/game
 *
 * Only talks to the API (no database access), so it creates its own match
 * between two fresh dev players each run.
 *
 * [1] PvP: the shooter drags the aim and the power meter; the opponent's drawn
 *     cue follows (angle and power), the cue layer really has a cue on it,
 *     updates stay near 10 a second, the watcher cannot inject aim, a stalled
 *     link freezes and dims the cue, and after the shot the watcher is handed
 *     the turn at once (the `moved` event) instead of at the next 4 s poll.
 * [2] Practice: the AI's cue swings for 1.5–2.5 s and stops exactly on the
 *     shot it then plays.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TABLE, BAULK_LINE_X, D_RADIUS, CENTRE_Y } from '@snooker/sim';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.GAME_URL_LOCAL ?? 'http://127.0.0.1:5173/';
const API = process.env.BACKEND_URL_LOCAL ?? 'http://127.0.0.1:8080/api';

const errors = [];
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const devId = (n) => 999_000_000 + n;
const login = async (n) => (await call('/auth/telegram', {
  method: 'POST', body: { devUser: { id: devId(n), first_name: `Dev ${n}`, username: `dev${n}` } },
})).body;

const RAIL = 9;
const worldToPage = (box, x, y) => {
  const scale = box.width / (TABLE.width + RAIL * 2);
  return { x: box.x + (x + RAIL) * scale, y: box.y + (y + RAIL) * scale };
};
const debug = (page) => page.evaluate(() => ({ ...window.__snookerDebug }));
const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function watch(page, name) {
  page.on('console', (m) => {
    // The lag check aborts /aim on purpose; Chrome logs each as a failed resource.
    if (m.type() === 'error' && !m.location()?.url?.endsWith('/aim')) errors.push(`${name} console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name} uncaught: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`${name} HTTP ${r.status()} ${r.url()}`);
  });
}

/** Count painted pixels on the cue layer: the cue is drawn there, nothing else is. */
const cuePixels = (page) => page.evaluate(() => {
  const c = document.getElementById('cue-layer');
  if (!c.width || !c.height) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 40) n += 1;
  return n;
});

async function pvp(browser) {
  console.log('\n[1] PvP live aim');
  const a = 20 + Math.floor(Math.random() * 70);
  const b = a + 1;
  const [pa, pb] = [await login(a), await login(b)];
  if (!pa?.token || !pb?.token) throw new Error('dev sign-in failed: is ALLOW_DEV_AUTH=true on the backend?');
  await call('/match/queue', { method: 'DELETE', token: pa.token });
  await call('/match/queue', { method: 'DELETE', token: pb.token });
  await call('/match/queue', { method: 'POST', token: pa.token });
  const { body } = await call('/match/queue', { method: 'POST', token: pb.token });
  const matchId = body?.matchId;
  if (!matchId) throw new Error(`no match: ${JSON.stringify(body)}`);
  console.log(`  match ${matchId} (dev${a} shoots first, dev${b} watches)`);

  // Two browsers' worth of state: separate contexts.
  const ctxS = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const ctxW = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const shooter = await ctxS.newPage();
  const watcher = await ctxW.newPage();
  watch(shooter, 'shooter');
  watch(watcher, 'watcher');

  const sent = [];
  shooter.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/match/${matchId}/aim`)) sent.push({ at: Date.now(), ...JSON.parse(r.postData()) });
  });

  await watcher.goto(`${GAME}?dev=${b}&mode=pvp&match=${matchId}`, { waitUntil: 'load' });
  await watcher.waitForFunction(() => window.__snookerDebug?.aimStream === 'open', null, { timeout: 15_000 });
  check('watcher is waiting with its aim stream open', (await debug(watcher)).phase === 'waiting');
  check('no cue on the watcher before the shooter opens the table', (await debug(watcher)).otherAim == null);
  await shooter.goto(`${GAME}?dev=${a}&mode=pvp&match=${matchId}`, { waitUntil: 'load' });
  await shooter.waitForFunction(() => window.__snookerDebug?.phase === 'aiming', null, { timeout: 15_000 });

  const box = await shooter.locator('#table').boundingBox();
  const meter = await shooter.locator('#power').boundingBox();

  // Break-off: the cue ball is in hand. Place it, so the watcher sees it moved too.
  const spot = { x: BAULK_LINE_X - D_RADIUS / 2, y: CENTRE_Y + 12 };
  const sp = worldToPage(box, spot.x, spot.y);
  await shooter.mouse.click(sp.x, sp.y);
  await sleep(400);

  // Aim: tap towards the pack, then a long slow drag that swings the cue.
  const target = worldToPage(box, TABLE.width * 0.75, CENTRE_Y);
  await shooter.mouse.click(target.x, target.y);
  await sleep(300);
  const trail = [];
  const start = Date.now();
  await shooter.mouse.move(target.x, target.y + 60);
  await shooter.mouse.down();
  for (let i = 0; i < 90; i += 1) {
    await shooter.mouse.move(target.x + i * 1.5, target.y + 60 - i * 2.2);
    await sleep(1000 / 60);
    if (i % 6 === 0) trail.push((await debug(watcher)).otherAim);
  }
  await shooter.mouse.up();
  const dragMs = Date.now() - start;
  const dragSent = sent.filter((s) => s.at >= start && s.at <= start + dragMs).length;
  const rate = dragSent / (dragMs / 1000);
  check('shooter sends ~10 updates a second while the aim moves', rate > 5 && rate <= 11.5, `${rate.toFixed(1)}/s over ${dragMs}ms`);

  const angles = trail.filter(Boolean).map((p) => p.angle.toFixed(3));
  check("watcher's cue moved during the drag", new Set(angles).size >= 6, `${new Set(angles).size} distinct angles in ${trail.length} samples`);
  await watcher.screenshot({ path: path.join(here, 'aim-1-watcher-mid-drag.png') });

  await sleep(600);
  const last = sent.at(-1);
  let w = await debug(watcher);
  check("watcher's cue settles on the shooter's last aim", w.otherAim && angleGap(w.otherAim.angle, last.angle) < 0.002,
    `watcher ${w.otherAim?.angle?.toFixed(4)} vs sent ${last.angle.toFixed(4)}`);
  check('the in-hand cue ball position travels with it', last.cue && Math.abs(last.cue.x - spot.x) < 1 && Math.abs(last.cue.y - spot.y) < 1,
    JSON.stringify(last.cue));
  check('the watcher really draws a cue (cue layer painted)', (await cuePixels(watcher)) > 50, `${await cuePixels(watcher)} px`);

  // Power: drag the shooter's meter up to ~80%.
  await shooter.mouse.move(meter.x + meter.width / 2, meter.y + meter.height * 0.7);
  await shooter.mouse.down();
  for (let i = 0; i <= 20; i += 1) {
    await shooter.mouse.move(meter.x + meter.width / 2, meter.y + meter.height * (0.7 - i * 0.025));
    await sleep(30);
  }
  await shooter.mouse.up();
  await sleep(700);
  const shooterPower = await shooter.locator('#power-label').textContent();
  const watcherPower = await watcher.locator('#power-label').textContent();
  check("watcher's power bar shows the shooter's power", shooterPower === watcherPower, `${shooterPower} vs ${watcherPower}`);
  w = await debug(watcher);
  check('…and the drawn cue uses it', Math.abs(w.otherAim.power - sent.at(-1).power) < 0.005,
    `${w.otherAim.power} vs ${sent.at(-1).power}`);
  await Promise.all([
    shooter.screenshot({ path: path.join(here, 'aim-2-shooter.png') }),
    watcher.screenshot({ path: path.join(here, 'aim-2-watcher.png') }),
  ]);

  // The waiting player cannot drive the shooter's cue.
  const inject = await call(`/match/${matchId}/aim`, { method: 'POST', token: pb.token, body: { angle: 2, power: 1 } });
  check("the non-shooter's aim is ignored by the server", inject.status === 204 && inject.headers.get('x-aim') === 'ignored', inject.headers.get('x-aim'));

  // Lag: the shooter's updates stop reaching the server. The watcher's cue
  // holds where it was, dimmed, instead of snapping or vanishing.
  const held = (await debug(watcher)).otherAim;
  await shooter.route('**/aim', (r) => r.abort());
  await shooter.mouse.move(target.x, target.y);
  await shooter.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await shooter.mouse.move(target.x - i * 3, target.y + i * 3);
    await sleep(20);
  }
  await shooter.mouse.up();
  await sleep(3000);
  w = await debug(watcher);
  check('on lag the cue freezes where it was', w.otherAim && angleGap(w.otherAim.angle, held.angle) < 1e-6, `${w.otherAim?.angle} vs ${held.angle}`);
  check('…and is marked stale (drawn dimmed)', w.otherAim?.stale === true);
  check('…and is still drawn', (await cuePixels(watcher)) > 50);
  await watcher.screenshot({ path: path.join(here, 'aim-3-watcher-stale.png') });
  await shooter.unroute('**/aim');
  await sleep(1300); // the next heartbeat gets through
  w = await debug(watcher);
  check('live again once updates arrive', w.otherAim?.stale === false);

  // The shot itself goes through /shot as always. The watcher gets `moved` and polls at once.
  const shotAt = Date.now();
  await shooter.locator('#shoot').click();
  await watcher.waitForFunction(() => window.__snookerDebug?.phase === 'aiming', null, { timeout: 8_000 }).catch(() => {});
  const handover = Date.now() - shotAt;
  w = await debug(watcher);
  check('after the shot the watcher gets the turn quickly (moved → poll)', w.phase === 'aiming' && handover < 3000, `${handover}ms`);
  check("the new shooter's view shows no leftover cue from the other player", w.otherAim == null);

  // Roles swap: the first shooter now watches the second.
  await shooter.waitForFunction(() => window.__snookerDebug?.phase === 'waiting', null, { timeout: 10_000 });
  const wbox = await watcher.locator('#table').boundingBox();
  const t2 = worldToPage(wbox, TABLE.width * 0.3, CENTRE_Y - 30);
  await watcher.mouse.click(t2.x, t2.y);
  await sleep(700);
  const s = await debug(shooter);
  check('roles swapped: the first shooter now sees the opponent aim', Boolean(s.otherAim), JSON.stringify(s.otherAim));

  await call(`/match/${matchId}/concede`, { method: 'POST', token: pa.token, body: { via: 'menu' } });
  await ctxS.close();
  await ctxW.close();
}

async function practice(browser) {
  console.log('\n[2] Practice AI lines up its shot');
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, 'practice');
  await page.goto(`${GAME}?mode=practice`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('shoot').disabled, null, { timeout: 20_000 });
  const box = await page.locator('#table').boundingBox();
  const sp = worldToPage(box, BAULK_LINE_X - D_RADIUS / 2, CENTRE_Y + 10);
  await page.mouse.click(sp.x, sp.y);
  await sleep(300);
  const t = worldToPage(box, TABLE.width * 0.72, CENTRE_Y + 25);
  await page.mouse.click(t.x, t.y);
  await page.locator('#shoot').click();

  // Sample the AI's cue from the moment it appears until the shot starts.
  const run = await page.evaluate(async () => {
    const D = window.__snookerDebug;
    const shotsBefore = (D.aiShots ?? []).length;
    const poses = [];
    const t0 = performance.now();
    let firstAt = null;
    let lastAt = null;
    while (performance.now() - t0 < 30_000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (D.mode === 'practice' && D.otherAim) {
        firstAt ??= performance.now();
        lastAt = performance.now();
        poses.push(D.otherAim);
      }
      if ((D.aiShots ?? []).length > shotsBefore) break;
    }
    return { poses, ms: lastAt - firstAt, shot: (D.aiShots ?? []).at(-1) };
  });
  const angles = new Set(run.poses.map((p) => p.angle.toFixed(3)));
  check('the AI cue is shown and swings before the shot', run.poses.length > 30 && angles.size > 10, `${run.poses.length} frames, ${angles.size} angles`);
  check('the aim lasts 1.5–2.5 s', run.ms >= 1400 && run.ms <= 2600, `${Math.round(run.ms)}ms`);
  const end = run.poses.at(-1);
  check('it ends exactly on the shot played', end && run.shot && end.angle === run.shot.angle && end.power === run.shot.power,
    `${end?.angle}/${end?.power} vs ${run.shot?.angle}/${run.shot?.power}`);
  const powers = run.poses.map((p) => p.power);
  check('the power bar fills during the aim', powers[0] < 0.05 && Math.abs(powers.at(-1) - run.shot.power) < 1e-12);
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    await pvp(browser);
    await practice(browser);
  } finally {
    await browser.close();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (errors.length) {
    console.log('\npage errors:');
    for (const e of errors) console.log(`  ${e}`);
  }
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
