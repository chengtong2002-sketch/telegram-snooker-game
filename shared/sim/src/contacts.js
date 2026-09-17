/**
 * Exact contacts for round bodies.
 *
 * Matter has no true circles: a circle is a polygon (a ball this small gets 10
 * sides), and its separating-axis test pushes along one of the polygon's face
 * normals. For snooker that is badly wrong: a dead-straight hit sent the object
 * ball off 9° from the line, and cut shots were out by up to 20°. Adding sides
 * only helps slowly (180 sides still averaged 1.7° off) and costs far too much.
 *
 * So any contact involving a body marked `exactCircle` is computed exactly here:
 *   circle–circle   along the line between the two centres
 *   circle–polygon  from the nearest point of the (convex) polygon to the centre
 * Everything else goes to Matter's own test. The record has the same shape
 * Matter's Collision.collides returns, so the resolver treats it identically.
 */
import Matter from 'matter-js';

const { Collision, Pair, Vertices } = Matter;

let installed = false;

/** Mark a body as a true circle of radius `r` centred on its position. */
export function markCircle(body, r) {
  body.exactCircle = r;
  return body;
}

export function installExactContacts() {
  if (installed) return;
  installed = true;
  const polygonTest = Collision.collides;
  Collision.collides = function collides(bodyA, bodyB, pairs) {
    if (!bodyA.exactCircle && !bodyB.exactCircle) return polygonTest(bodyA, bodyB, pairs);
    return exactCollides(bodyA, bodyB, pairs);
  };
}

/**
 * Circle against circle or against a convex polygon. Returns a Matter collision
 * record, or null when the shapes do not overlap.
 */
function exactCollides(first, second, pairs) {
  // Matter orders a record's bodies by id; keep to that so pairs match up.
  const bodyA = first.id < second.id ? first : second;
  const bodyB = first.id < second.id ? second : first;

  // `normal` points from B to A (Matter's convention); `point` is where they touch.
  let depth;
  let nx;
  let ny;
  let px;
  let py;

  if (bodyA.exactCircle && bodyB.exactCircle) {
    const reach = bodyA.exactCircle + bodyB.exactCircle;
    const dx = bodyA.position.x - bodyB.position.x;
    const dy = bodyA.position.y - bodyB.position.y;
    const dist = Math.hypot(dx, dy);
    depth = reach - dist;
    if (depth <= 0) return null;
    // By the time an overlap is seen, the balls have moved past first touch, and
    // on a cut the line between their centres has already turned. Rewind along
    // this step's motion to the moment they touched and push along that line.
    const [tx, ty] = touchLine(bodyA, bodyB, reach) ?? [dx, dy];
    const tl = Math.hypot(tx, ty);
    if (tl === 0) { nx = 1; ny = 0; } else { nx = tx / tl; ny = ty / tl; }
    px = bodyB.position.x + nx * bodyB.exactCircle;
    py = bodyB.position.y + ny * bodyB.exactCircle;
  } else {
    const circle = bodyA.exactCircle ? bodyA : bodyB;
    const polygon = circle === bodyA ? bodyB : bodyA;
    const hit = circleAgainstPolygon(circle.position, circle.exactCircle, polygon.vertices);
    if (!hit) return null;
    depth = hit.depth;
    px = hit.x;
    py = hit.y;
    // hit.nx/ny point from the polygon toward the circle's centre.
    const towardA = circle === bodyA ? 1 : -1;
    nx = hit.nx * towardA;
    ny = hit.ny * towardA;
  }

  const pair = pairs && pairs.table[Pair.id(bodyA, bodyB)];
  let collision;
  if (pair) {
    collision = pair.collision;
  } else {
    collision = Collision.create(bodyA, bodyB);
    collision.collided = true;
    collision.bodyA = bodyA;
    collision.bodyB = bodyB;
    collision.parentA = bodyA.parent;
    collision.parentB = bodyB.parent;
  }
  collision.normal.x = nx;
  collision.normal.y = ny;
  collision.tangent.x = -ny;
  collision.tangent.y = nx;
  collision.penetration.x = nx * depth;
  collision.penetration.y = ny * depth;
  collision.depth = depth;
  // One contact point. Reuse the same object so Matter's contact matching (by
  // identity) keeps its warm-started impulse from step to step.
  const support = collision.exactSupport ?? (collision.exactSupport = { x: 0, y: 0 });
  support.x = px;
  support.y = py;
  collision.supports[0] = support;
  collision.supports[1] = null;
  collision.supportCount = 1;
  return collision;
}

/**
 * The centre-to-centre vector (B to A) at the moment two circles first touched
 * during this step, or null if they were already touching at the start of it.
 * Matter keeps each body's position from before the step in `positionPrev`.
 */
function touchLine(bodyA, bodyB, reach) {
  const sx = bodyA.positionPrev.x - bodyB.positionPrev.x;
  const sy = bodyA.positionPrev.y - bodyB.positionPrev.y;
  if (Math.hypot(sx, sy) <= reach) return null;
  const ex = bodyA.position.x - bodyB.position.x;
  const ey = bodyA.position.y - bodyB.position.y;
  // |s + t(e - s)| = reach, smallest t in [0, 1].
  const mx = ex - sx;
  const my = ey - sy;
  const a = mx * mx + my * my;
  if (a === 0) return null;
  const b = 2 * (sx * mx + sy * my);
  const c = sx * sx + sy * sy - reach * reach;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  return [sx + mx * t, sy + my * t];
}

/**
 * Overlap of a circle with a convex polygon (Matter vertices, either winding).
 * @returns {{depth:number, x:number, y:number, nx:number, ny:number}|null}
 *   the contact point on the polygon and the unit normal toward the centre
 */
function circleAgainstPolygon(centre, r, vertices) {
  const inside = Vertices.contains(vertices, centre);
  let best = null;
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((centre.x - a.x) * ex + (centre.y - a.y) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + ex * t;
    const qy = a.y + ey * t;
    const d = Math.hypot(centre.x - qx, centre.y - qy);
    if (!best || d < best.d) best = { d, qx, qy };
  }
  if (!inside) {
    if (best.d >= r) return null;
    if (best.d === 0) return null; // touching exactly: no direction to push
    return {
      depth: r - best.d, x: best.qx, y: best.qy, nx: (centre.x - best.qx) / best.d, ny: (centre.y - best.qy) / best.d,
    };
  }
  // Centre inside the polygon (a very deep hit): push out through the nearest edge.
  const nx = (best.qx - centre.x) / (best.d || 1);
  const ny = (best.qy - centre.y) / (best.d || 1);
  return {
    depth: r + best.d, x: best.qx, y: best.qy, nx, ny,
  };
}
