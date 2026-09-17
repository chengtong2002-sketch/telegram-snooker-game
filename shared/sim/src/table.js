import {
  TABLE, POCKETS, CORNER_POCKET_CUT, MIDDLE_POCKET_CUT, CUSHION_DEPTH, JAWS,
} from './constants.js';

/**
 * Cushion and pocket-mouth geometry, shared by the physics and the renderer so
 * players see exactly what the balls hit.
 *
 * Each of the six rails is one convex polygon plus a rounded knuckle at each
 * end. Where a rail meets a pocket:
 *
 *   jaw point  where the cushion face would meet the facing if the corner were
 *              sharp. The pocket opening is measured between jaw points (the
 *              89mm / 102mm spec), so the rounding never changes the opening.
 *   facing     the straight end of the cushion, leaving the jaw point into the
 *              cushion at `facingAngle` degrees from square, leaning toward the
 *              pocket. 0 is a square end.
 *   knuckle    a circle of `knuckleRadius` tangent to both the face and the
 *              facing, replacing the sharp corner with a round one.
 *
 * On their own, rounder knuckles make a pocket more forgiving: a ball clipping
 * one is pushed inward. What turns a clipped ball away is the combination with
 * the fall set back behind the jaws (POCKETS in constants.js). The inward-pushed
 * ball has to cross the mouth, meets the opposite facing leaning toward it, and
 * is thrown back out.
 *
 * With facingAngle 0 and knuckleRadius 0 this is exactly the old square-ended
 * rectangles (checked shot for shot when this replaced them).
 */

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const norm = (a) => { const l = Math.hypot(a.x, a.y); return { x: a.x / l, y: a.y / l }; };

/**
 * One end of a rail, at the pocket it faces.
 *
 * @param {{x,y}} jaw    jaw point on the cushion face
 * @param {{x,y}} u      unit vector along the face, pointing into the pocket
 * @param {{x,y}} w      unit vector perpendicular to the face, pointing into the cushion
 * @param {{facingAngle:number, knuckleRadius:number}} jaws
 * @param {number} depth how far back into the cushion to take the facing
 */
function railEnd(jaw, u, w, { facingAngle, knuckleRadius }, depth) {
  const a = (facingAngle * Math.PI) / 180;
  // Facing direction: into the cushion, leaning toward the pocket by `a`.
  const d = add(mul(w, Math.cos(a)), mul(u, Math.sin(a)));
  // The cushion material's corner angle at the jaw is 90° + a (between -u and d).
  const half = (Math.PI / 2 + a) / 2;
  const k = knuckleRadius;
  const along = k > 0 ? k / Math.tan(half) : 0;
  const faceTangent = add(jaw, mul(u, -along));
  const facingTangent = add(jaw, mul(d, along));
  // The facing runs back until it is `depth` behind the face.
  const back = add(jaw, mul(d, depth / Math.cos(a)));
  const knuckle = k > 0
    ? { ...add(jaw, mul(norm(add(mul(u, -1), d)), k / Math.sin(half))), r: k }
    : null;
  return { jaw, faceTangent, facingTangent, back, knuckle };
}

/**
 * The six rails. For each: `polygon` (convex, table coordinates, the face and
 * facings with the knuckle corners cut off) and `knuckles` (circles filling
 * those corners back out to a round edge).
 *
 * @param {{depth?:number, jaws?:typeof JAWS}} [opts] depth of cushion to build
 *   behind the face (physics uses the full CUSHION_DEPTH; the renderer draws a
 *   shallower strip), and the jaw shapes (JAWS unless given, for tests).
 */
export function cushionGeometry({ depth = CUSHION_DEPTH, jaws = JAWS } = {}) {
  const W = TABLE.width;
  const H = TABLE.height;
  const C = CORNER_POCKET_CUT;
  const M = MIDDLE_POCKET_CUT;
  const { corner, middle } = jaws;

  // [end A, end B] of each rail: jaw point, direction into that pocket, pocket type.
  const up = { x: 0, y: -1 }; const down = { x: 0, y: 1 };
  const left = { x: -1, y: 0 }; const right = { x: 1, y: 0 };
  const rails = [
    { id: 'top-baulk', w: up, a: [{ x: C, y: 0 }, left, corner], b: [{ x: W / 2 - M, y: 0 }, right, middle] },
    { id: 'top-black', w: up, a: [{ x: W / 2 + M, y: 0 }, left, middle], b: [{ x: W - C, y: 0 }, right, corner] },
    { id: 'bottom-baulk', w: down, a: [{ x: C, y: H }, left, corner], b: [{ x: W / 2 - M, y: H }, right, middle] },
    { id: 'bottom-black', w: down, a: [{ x: W / 2 + M, y: H }, left, middle], b: [{ x: W - C, y: H }, right, corner] },
    { id: 'baulk', w: left, a: [{ x: 0, y: C }, up, corner], b: [{ x: 0, y: H - C }, down, corner] },
    { id: 'black', w: right, a: [{ x: W, y: C }, up, corner], b: [{ x: W, y: H - C }, down, corner] },
  ];

  return rails.map(({ id, w, a, b }) => {
    const ea = railEnd(a[0], a[1], w, a[2], depth);
    const eb = railEnd(b[0], b[1], w, b[2], depth);
    return {
      id,
      // Face (A tangent → B tangent), B's knuckle chord, B facing, back, A facing, A's knuckle chord.
      polygon: dedupe([ea.faceTangent, eb.faceTangent, eb.facingTangent, eb.back, ea.back, ea.facingTangent]),
      knuckles: [ea.knuckle, eb.knuckle].filter(Boolean),
      ends: [ea, eb],
    };
  });
}

/** Drop consecutive duplicate vertices (a zero knuckle makes tangent points coincide). */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 1e-9) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) out.pop();
  return out;
}

/**
 * Each pocket's mouth: the area between its two facings, from the jaw points
 * back to `depth` behind the cushion face. The renderer fills it as the shelf
 * a ball rolls over before it drops.
 *
 * @returns {Array<{pocket:string, polygon:Array<{x,y}>}>}
 */
export function pocketMouths({ depth = CUSHION_DEPTH, jaws = JAWS } = {}) {
  const rails = cushionGeometry({ depth, jaws });
  const endsAt = (pocket) => {
    const found = [];
    for (const rail of rails) {
      for (const end of rail.ends) {
        const nearest = POCKETS.reduce((best, p) => {
          const dist = Math.hypot(p.x - end.jaw.x, p.y - end.jaw.y);
          return !best || dist < best.dist ? { id: p.id, dist } : best;
        }, null);
        if (nearest.id === pocket.id) found.push(end);
      }
    }
    return found;
  };
  return POCKETS.map((pocket) => {
    const [e1, e2] = endsAt(pocket);
    // Jaw, back of one facing, back of the other, other jaw: a convex quad.
    return { pocket: pocket.id, polygon: [e1.jaw, e1.back, e2.back, e2.jaw] };
  });
}
