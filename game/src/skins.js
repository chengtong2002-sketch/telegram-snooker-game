/**
 * Cue and cue-ball skins: renderer only. Nothing here reaches the sim — a skin
 * changes how the cue and the cue ball are drawn, never where anything goes.
 *
 * Pure (no DOM, no Vite): takes SVG text and returns data or draws on a
 * context it is given, so it can be tested in Node. skinLoader.js does the
 * browser-side loading.
 */

/* ---------- cues: side-on SVG → bands along a top-down cue ---------- */

/**
 * The cue SVGs are side views, 1000 × 36: x runs butt (0) to tip (1000), and
 * the profile tapers from 28 units tall at the butt to 9 at the tip. Seen from
 * above, a cue is the same round profile, so the side view maps straight onto
 * the top-down cue: along the SVG → along the cue, and the SVG's height →
 * the cue's width.
 *
 * The result is the design as bands and inlays, in the SVG's own order:
 *   band    a full-width stretch between two x positions (butt, cap, rings,
 *           ferrule, tip — and the pale shaft under everything)
 *   inlay   anything else: points, diamonds
 *   stripe  a line across the cue (Obsidian Gold's weave)
 *   sheen   the shading laid over the whole cue
 * Wood grain lines (0.6 units at 22% opacity) are dropped: at table scale they
 * are a fraction of a pixel.
 */
export function parseCueSvg(svg) {
  const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const gradients = {};
  for (const [, id, body] of svg.matchAll(/<linearGradient id="([^"]+)"[^>]*>(.*?)<\/linearGradient>/gs)) {
    gradients[id] = [...body.matchAll(/<stop ([^>]*)\/>/g)].map(([, a]) => {
      const s = attrs(a);
      return { offset: Number(s.offset), color: s['stop-color'], opacity: s['stop-opacity'] === undefined ? 1 : Number(s['stop-opacity']) };
    });
  }
  const paint = (value) => {
    const ref = /^url\(#(.+)\)$/.exec(value ?? '');
    return ref ? { gradient: gradients[ref[1]] } : { color: value };
  };

  const clip = /<clipPath[^>]*>\s*<path d="([^"]+)"/.exec(svg);
  const taper = clip ? clip[1].match(/[\d.]+/g).map(Number).reduce((pts, v, i, a) => (i % 2 ? pts : [...pts, { x: v, y: a[i + 1] }]), []) : null;

  const body = /<g clip-path="[^"]*">(.*)<\/g>/s.exec(svg)?.[1] ?? '';
  const ops = [];
  for (const [, tag, a] of body.matchAll(/<(polygon|line|rect)\b([^>]*?)\/?>/g)) {
    const s = attrs(a);
    if (tag === 'polygon') {
      const n = s.points.trim().split(/[\s,]+/).map(Number);
      const points = [];
      for (let i = 0; i < n.length; i += 2) points.push({ x: n[i], y: n[i + 1] });
      const op = {
        ...paint(s.fill),
        points,
        stroke: s.stroke ?? null,
        strokeWidth: s['stroke-width'] ? Number(s['stroke-width']) : 0,
        opacity: s.opacity ? Number(s.opacity) : 1,
      };
      const isBand = points.length === 4 && points[0].x === points[3].x && points[1].x === points[2].x;
      ops.push(isBand ? { kind: 'band', from: points[0].x, to: points[1].x, ...op } : { kind: 'inlay', ...op });
    } else if (tag === 'line') {
      const grain = s.stroke === '#8a6534' && Number(s['stroke-opacity']) < 0.5;
      if (!grain) {
        ops.push({
          kind: 'stripe',
          from: { x: Number(s.x1), y: Number(s.y1) },
          to: { x: Number(s.x2), y: Number(s.y2) },
          color: s.stroke,
          strokeWidth: Number(s['stroke-width'] ?? 1),
        });
      }
    } else if (tag === 'rect') {
      ops.push({ kind: 'sheen', ...paint(s.fill), y0: Number(s.y ?? 0), y1: Number(s.y ?? 0) + Number(s.height) });
    }
  }
  return { taper, ops };
}

/** Butt diameter on the table, in cm. The tip comes out at 9/28 of it. */
export const CUE_BUTT_WIDTH = 2.0;
const SVG_LEN = 1000;
const SVG_MID = 18;
const SVG_BUTT = 28;

/**
 * Draw a cue skin top-down: the tip at (tipX, tipY), the butt `length` cm
 * back along `angle` + 180°. The caller's transform maps table cm to pixels.
 */
export function drawCueSkin(ctx, model, { tipX, tipY, angle, length, buttWidth = CUE_BUTT_WIDTH }) {
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(angle + Math.PI);
  // SVG units → cue: x = 1000 (tip) lands at the tip, x = 0 (butt) `length` back.
  ctx.translate(length, 0);
  ctx.scale(-length / SVG_LEN, buttWidth / SVG_BUTT);
  ctx.translate(0, -SVG_MID);

  if (model.taper) {
    ctx.beginPath();
    model.taper.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
  }

  const fillFor = (op, y0, y1) => {
    if (!op.gradient) return op.color;
    // SVG default: the gradient spans the shape's own box, top to bottom.
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    for (const s of op.gradient) g.addColorStop(s.offset, withAlpha(s.color, s.opacity));
    return g;
  };

  for (const op of model.ops) {
    if (op.kind === 'band' || op.kind === 'inlay') {
      const ys = op.points.map((p) => p.y);
      ctx.globalAlpha = op.opacity;
      ctx.beginPath();
      op.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = fillFor(op, Math.min(...ys), Math.max(...ys));
      ctx.fill();
      if (op.stroke && op.strokeWidth) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = op.strokeWidth;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (op.kind === 'stripe') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.strokeWidth;
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(op.to.x, op.to.y);
      ctx.stroke();
    } else if (op.kind === 'sheen') {
      ctx.fillStyle = fillFor(op, op.y0, op.y1);
      ctx.fillRect(0, op.y0, SVG_LEN, op.y1 - op.y0);
    }
  }
  ctx.restore();
}

function withAlpha(hex, alpha) {
  if (alpha >= 1) return hex;
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const n = parseInt(full.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ---------- cue balls: the SVG as a texture ---------- */

/**
 * The ball SVGs are 100 × 100 with the ball a circle of radius 48 at the
 * centre, plus a flattened shadow under it — a side-view shadow, and the
 * table renderer already draws its own. Remove it, so the ball is not
 * shadowed twice.
 */
export const prepareBallSvg = (svg) => svg.replace(/<ellipse[^>]*fill="#000"[^>]*opacity="\.45"[^>]*\/>/, '');

/** Drawn size of the whole 100-unit SVG, so its r=48 circle is `radius`. */
export const ballImageSize = (radius) => (2 * radius * 100) / 96;

/** The ball's base colour: the middle stop of its body gradient. */
export function ballBaseColour(svg) {
  const body = /<radialGradient id="[^"]*b"[^>]*>(.*?)<\/radialGradient>/s.exec(svg);
  const stops = [...(body?.[1] ?? '').matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1]);
  return stops[1] ?? stops[0] ?? null;
}

/* ---------- choosing skins ---------- */

/**
 * Which skins to draw: the catalog's defaults (Club Ash, Club White) unless
 * something else is chosen. `search` is the dev-only URL switch
 * (?cue=<id>&ball=<id>); pass '' to get the defaults. Unknown ids fall back
 * to the default rather than to nothing.
 *
 * @param {URLSearchParams|string} search
 * @param {object} catalog  cosmetics.json
 */
export function pickSkins(search, catalog, chosen = {}) {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const choose = (list = [], id) => list.find((item) => item.id === id)
    ?? list.find((item) => item.default)
    ?? null;
  return {
    cue: choose(catalog.cues, q.get('cue') ?? chosen?.cue),
    ball: choose(catalog.cueBalls, q.get('ball') ?? chosen?.ball),
  };
}

/**
 * Whose skins to draw this turn (docs/store-plan.md, decision 4): the
 * shooter's. PvP reads the seat's ids from the match payload; practice is
 * always the player's own, AI turns included. Anything missing gives {},
 * which pickSkins turns into the defaults.
 *
 * @param {{mode: 'practice'|'pvp', seatSkins?: object[], turn: number, mine?: object}} args
 */
export function skinIdsForTurn({ mode, seatSkins, turn, mine }) {
  if (mode === 'practice') return mine ?? {};
  return (Array.isArray(seatSkins) ? seatSkins[turn] : null) ?? {};
}
