import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BALL_RADIUS } from '@snooker/sim';
import {
  parseCueSvg, drawCueSkin, CUE_BUTT_WIDTH, prepareBallSvg, ballImageSize, ballBaseColour, pickSkins,
} from '../src/skins.js';
import { BALL_COLOURS, CLOTH } from '../src/renderer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'cosmetics');
const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'cosmetics.json'), 'utf8'));
const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
const cues = catalog.cues.map((c) => ({ ...c, svg: read(c.file), model: parseCueSvg(read(c.file)) }));
const balls = catalog.cueBalls.map((b) => ({ ...b, svg: read(b.file) }));
const bands = (model) => model.ops.filter((o) => o.kind === 'band');
const band = (model, from, to) => bands(model).find((b) => b.from === from && b.to === to);

/* ---------- the catalog ---------- */

test('the catalog has 5 cues and 5 cue balls, every file present', () => {
  assert.equal(cues.length, 5);
  assert.equal(balls.length, 5);
  for (const item of [...catalog.cues, ...catalog.cueBalls]) {
    assert.ok(fs.existsSync(path.join(dir, item.file)), item.file);
  }
});

test('the defaults are Club Ash and Club White', () => {
  assert.deepEqual(catalog.cues.filter((c) => c.default).map((c) => c.id), ['club-ash']);
  assert.deepEqual(catalog.cueBalls.filter((b) => b.default).map((b) => b.id), ['club-white']);
});

test('no SVG carries script, event handlers or outside references', () => {
  for (const { file, svg } of [...cues, ...balls]) {
    assert.doesNotMatch(svg, /<script|\son[a-z]+=|href="(?:https?:|\/\/|javascript:)|url\((?:https?:|\/\/)|foreignObject|<!ENTITY/i, file);
  }
});

/* ---------- cues: SVG → bands ---------- */

test('every polygon in a cue SVG becomes a band or an inlay, and every non-grain line a stripe', () => {
  for (const { id, svg, model } of cues) {
    const polygons = (svg.match(/<polygon\b/g) ?? []).length;
    const lines = [...svg.matchAll(/<line\b[^>]*>/g)].map((m) => m[0]);
    const grain = lines.filter((l) => /stroke="#8a6534"/.test(l));
    const kinds = (k) => model.ops.filter((o) => o.kind === k).length;
    assert.equal(kinds('band') + kinds('inlay'), polygons, `${id}: polygons`);
    assert.equal(kinds('stripe'), lines.length - grain.length, `${id}: stripes`);
    assert.equal(kinds('sheen'), 1, `${id}: sheen`);
  }
});

test('every cue has the shared anatomy: pale shaft, butt, black cap, ferrule and blue tip', () => {
  for (const { id, model } of cues) {
    const shaft = band(model, 0, 1000);
    assert.ok(shaft?.gradient, `${id}: shaft`);
    assert.equal(shaft.gradient[1].color, '#e2c68f', `${id}: shaft is pale ash`);
    assert.ok(band(model, 0, 340)?.gradient, `${id}: butt`);
    assert.equal(band(model, 0, 8)?.color, '#111', `${id}: butt cap`);
    assert.match(band(model, 975, 992)?.color ?? '', /^#(f1ece0|dfe3ea)$/, `${id}: pale ferrule`);
    assert.equal(band(model, 992, 1000)?.color, '#2d6aa8', `${id}: blue tip`);
    assert.deepEqual(model.taper.map((p) => [p.x, p.y]), [[0, 4], [1000, 13.5], [1000, 22.5], [0, 32]], `${id}: taper`);
  }
});

test('each cue keeps its own butt colour and details', () => {
  const byId = Object.fromEntries(cues.map((c) => [c.id, c.model]));
  const butt = (id) => band(byId[id], 0, 340).gradient[1].color;
  assert.equal(butt('club-ash'), '#4a2a17'); // walnut
  assert.equal(butt('ebony-points'), '#17110d');
  assert.equal(butt('crimson-crown'), '#8a1020');
  assert.equal(butt('emerald-hall'), '#145c38');
  assert.equal(butt('obsidian-gold'), '#121214');

  assert.equal(band(byId['club-ash'], 334, 340)?.color, '#d4ad52', 'club ash gold ring');
  const inlays = (id) => byId[id].ops.filter((o) => o.kind === 'inlay');
  assert.equal(inlays('ebony-points').length, 2, 'ebony points');
  assert.equal(inlays('ebony-points')[0].stroke, '#efe6cf');
  assert.equal(inlays('crimson-crown').length, 2, 'crimson points');
  assert.equal(inlays('emerald-hall').length, 3, 'emerald diamonds');
  assert.ok(inlays('emerald-hall').every((d) => d.opacity === 0.9 && d.points.length === 4));
  assert.equal(byId['obsidian-gold'].ops.filter((o) => o.kind === 'stripe').length, 41, 'obsidian weave');
  for (const [from, to] of [[60, 63], [150, 152], [240, 242]]) {
    assert.equal(band(byId['obsidian-gold'], from, to)?.color, '#d4ad52', `obsidian ring ${from}`);
  }
});

test('wood grain is dropped: it would be a fraction of a pixel on the table', () => {
  for (const { id, model } of cues) {
    assert.ok(!model.ops.some((o) => o.kind === 'stripe' && o.color === '#8a6534'), id);
  }
});

/* ---------- cues: drawn top-down ---------- */

/** A 2D context that only tracks the transform, and what was drawn through it. */
class FakeCtx {
  m = [1, 0, 0, 1, 0, 0];

  stack = [];

  calls = [];

  save() { this.stack.push([...this.m]); }

  restore() { this.m = this.stack.pop(); }

  translate(x, y) { this.#mul([1, 0, 0, 1, x, y]); }

  rotate(a) { this.#mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }

  scale(x, y) { this.#mul([x, 0, 0, y, 0, 0]); }

  #mul([a2, b2, c2, d2, e2, f2]) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  }

  /** Where an SVG-unit point lands on the table under the current transform. */
  at(x, y) { const [a, b, c, d, e, f] = this.m; return { x: a * x + c * y + e, y: b * x + d * y + f }; }

  createLinearGradient() { return { addColorStop() {} }; }

  beginPath() {}

  moveTo() {}

  lineTo() {}

  closePath() {}

  clip() { this.calls.push('clip'); }

  fill() { this.calls.push('fill'); this.lastFill = { tip: this.at(1000, 18), butt: this.at(0, 18), buttEdge: this.at(0, 4) }; }

  stroke() { this.calls.push('stroke'); }

  fillRect() { this.calls.push('fillRect'); }
}

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('the cue is drawn with its tip at the given point and its butt a cue-length back', () => {
  const ctx = new FakeCtx();
  const angle = 0.7;
  drawCueSkin(ctx, cues[0].model, { tipX: 50, tipY: 80, angle, length: 110 });
  const { tip, butt, buttEdge } = ctx.lastFill;
  close(tip.x, 50, 'tip x');
  close(tip.y, 80, 'tip y');
  // The butt lies behind the tip, away from the shot direction.
  close(butt.x, 50 - Math.cos(angle) * 110, 'butt x');
  close(butt.y, 80 - Math.sin(angle) * 110, 'butt y');
  // The butt is CUE_BUTT_WIDTH across: its edge is half of that from the axis.
  close(Math.hypot(buttEdge.x - butt.x, buttEdge.y - butt.y), CUE_BUTT_WIDTH / 2, 'butt half-width');
});

test('drawing a cue clips to its taper, leaves the context as it found it, and paints every op', () => {
  for (const { id, model } of cues) {
    const ctx = new FakeCtx();
    drawCueSkin(ctx, model, { tipX: 0, tipY: 0, angle: 0, length: 110 });
    assert.equal(ctx.calls[0], 'clip', `${id}: clips first`);
    assert.equal(ctx.stack.length, 0, `${id}: save/restore unbalanced`);
    assert.deepEqual(ctx.m, [1, 0, 0, 1, 0, 0], `${id}: transform leaked`);
    const painted = ctx.calls.filter((c) => c !== 'clip').length;
    assert.ok(painted >= model.ops.length, `${id}: ${painted} paints for ${model.ops.length} ops`);
  }
});

/* ---------- cue balls ---------- */

test('the side-view shadow is stripped from each ball, and nothing else', () => {
  for (const { id, svg } of balls) {
    const out = prepareBallSvg(svg);
    assert.doesNotMatch(out, /cy="96"/, `${id}: shadow left in`);
    assert.equal(out.length < svg.length, true, id);
    // The highlight ellipse and the ball itself are still there.
    assert.match(out, /<circle cx="50" cy="50" r="48"/, `${id}: ball`);
    assert.match(out, /<ellipse cx="36" cy="30"/, `${id}: highlight`);
  }
});

test('the ball image is sized so its circle is exactly the ball', () => {
  // The SVG is 100 units with an r=48 circle: 96 units across is the ball.
  close(ballImageSize(BALL_RADIUS) * (96 / 100), BALL_RADIUS * 2, 'diameter');
});

/** WCAG relative luminance and contrast. */
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const dist = (a, b) => {
  const c = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [p, q] = [c(a), c(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

test('every cue ball stands out from the cloth', () => {
  for (const { id, svg } of balls) {
    const base = ballBaseColour(svg);
    assert.ok(contrast(base, CLOTH) >= 4.5, `${id}: ${base} on cloth is ${contrast(base, CLOTH).toFixed(2)}:1`);
  }
});

test('every cue ball still reads as the cue ball, not as a colour', () => {
  const colours = Object.entries(BALL_COLOURS);
  for (const { id, svg } of balls) {
    const base = ballBaseColour(svg);
    const [nearest] = colours.map(([name, hex]) => [name, dist(base, hex)]).sort((a, b) => a[1] - b[1]);
    assert.equal(nearest[0], 'cue', `${id}: ${base} is nearest ${nearest[0]}`);
  }
});

/* ---------- choosing ---------- */

const ids = (picked) => ({ cue: picked.cue?.id, ball: picked.ball?.id });

test('with nothing chosen, everyone gets Club Ash and Club White', () => {
  assert.deepEqual(ids(pickSkins('', catalog)), { cue: 'club-ash', ball: 'club-white' });
  assert.deepEqual(ids(pickSkins('?mode=practice', catalog)), { cue: 'club-ash', ball: 'club-white' });
});

test('?cue= and ?ball= pick catalog items; unknown ids fall back to the defaults', () => {
  assert.deepEqual(ids(pickSkins('?cue=crimson-crown&ball=gold-band', catalog)), { cue: 'crimson-crown', ball: 'gold-band' });
  assert.deepEqual(ids(pickSkins('?cue=nope&ball=<b>', catalog)), { cue: 'club-ash', ball: 'club-white' });
  assert.deepEqual(ids(pickSkins(new URLSearchParams('ball=pearl'), catalog)), { cue: 'club-ash', ball: 'pearl' });
});

test('a catalog with no default gives no skin rather than throwing', () => {
  assert.deepEqual(pickSkins('', { cues: [], cueBalls: [] }), { cue: null, ball: null });
  assert.deepEqual(pickSkins('', {}), { cue: null, ball: null });
});

/* ---------- Pearl ---------- */

test('Pearl\'s sheen is strong enough to read at phone size', () => {
  // As supplied it was pale tints at 70%, indistinguishable from Club White in
  // game; strengthened in the SVG.
  const pearl = balls.find((b) => b.id === 'pearl').svg;
  const sheens = [...pearl.matchAll(/<radialGradient id="[^"]*p\d"><stop offset="0" stop-color="(#[0-9a-f]{6})" stop-opacity="([\d.]+)"/g)];
  assert.equal(sheens.length, 2);
  for (const [, colour, opacity] of sheens) {
    assert.ok(Number(opacity) >= 0.9, `${colour} at ${opacity}`);
    // Clearly tinted: well away from white.
    assert.ok(dist(colour, '#ffffff') > 80, `${colour} is too close to white`);
  }
});

/* ---------- the cue layer: overhanging the rail ---------- */

/** Canvases whose 2D contexts are FakeCtx, with a fixed on-screen box. */
function fakeCanvas(box) {
  const ctx = new FakeCtx();
  ctx.setTransform = (...m) => { ctx.m = m; ctx.calls.push(['setTransform', ...m]); };
  ctx.clearRect = (...r) => ctx.calls.push(['clearRect', ...r]);
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  ctx.arc = () => {};
  ctx.roundRect = () => {};
  ctx.fillRect = () => ctx.calls.push('fillRect');
  ctx.ellipse = () => {};
  ctx.setLineDash = () => {};
  ctx.drawImage = () => {};
  return {
    ctx,
    width: 0,
    height: 0,
    style: {},
    clientWidth: box.width,
    clientHeight: box.height,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: box.left, top: box.top, width: box.width, height: box.height }),
  };
}

async function rendererWithLayer() {
  globalThis.window ??= { devicePixelRatio: 2 };
  const { TableRenderer } = await import('../src/renderer.js');
  const table = fakeCanvas({ left: 100, top: 20, width: 600, height: 314 });
  const layer = fakeCanvas({ left: 0, top: 0, width: 844, height: 390 });
  const r = new TableRenderer(table, { cueLayer: layer });
  r.dpr = 2;
  r.scale = 1.6;
  r.setCueSkin(cues[0].model);
  const view = (aim) => ({ balls: [{ id: 'cue', color: 'cue', x: 66, y: 100.9 }], ballOn: 'red', aim });
  return { r, table, layer, view };
}

test('the cue is drawn on the cue layer, lined up with the table under it', async () => {
  const { r, table, layer, view } = await rendererWithLayer();
  r.draw(view({ angle: 0, power: 0.5 }));
  const set = layer.ctx.calls.find((c) => c[0] === 'setTransform' && c[1] !== 1);
  // Table cm → layer pixels: scale × dpr, offset by where the table sits in
  // the layer plus the rail.
  const k = 2 * 1.6;
  assert.deepEqual(set.slice(1), [k, 0, 0, k, 100 * 2 + 9 * k, 20 * 2 + 9 * k]);
  assert.ok(layer.ctx.calls.includes('fill'), 'nothing painted on the layer');
  assert.equal(layer.width, 844 * 2);
  assert.equal(layer.height, 390 * 2);
  // The table canvas still draws the table but no cue: its fills are the cloth, not a cue op.
  assert.ok(!table.ctx.calls.includes('clip'), 'cue clipped onto the table canvas');
});

test('the cue layer is cleared once the aim goes away', async () => {
  const { r, layer, view } = await rendererWithLayer();
  r.draw(view({ angle: 0, power: 0.5 }));
  layer.ctx.calls = [];
  r.draw(view(null)); // shot taken: balls moving, no aim
  assert.ok(layer.ctx.calls.some((c) => c[0] === 'clearRect'), 'old cue left on screen');
  assert.ok(!layer.ctx.calls.includes('fill'), 'drew a cue with no aim');
  layer.ctx.calls = [];
  r.draw(view(null));
  assert.equal(layer.ctx.calls.length, 0, 'cleared an already-empty layer');
});
