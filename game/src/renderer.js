import {
  TABLE, BALL_RADIUS, POCKETS, BAULK_LINE_X, D_RADIUS, CENTRE_Y, COLOURS,
  cushionGeometry,
} from '@snooker/sim';

const BALL_COLOURS = {
  cue: '#f4f1e6',
  red: '#c8202a',
  yellow: '#e8c53a',
  green: '#1c7a45',
  brown: '#7a4a24',
  blue: '#1f5fbf',
  pink: '#e58bb0',
  black: '#141414',
};

const RAIL = 9;        // cm of visible rail drawn outside the playing surface
const CUSHION_DRAWN = 3.6; // cm of cushion rubber drawn behind the face; wood beyond
const CLOTH = '#0f6b48';
const CUSHION = '#0b5a3c';
const CUSHION_EDGE = 'rgba(255,255,255,.14)';
const WOOD = '#4a2f1c';

// Same shapes the physics collides with (shared/sim/src/table.js), so the jaws
// a player sees are the jaws the ball hits. Built once: they never change.
const CUSHIONS = cushionGeometry({ depth: CUSHION_DRAWN });
const POCKET_DARK = '#0b0f0d';

/** The short way round a circle from one angle to another. */
const shortSweep = (from, to) => {
  let sweep = to - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return sweep;
};

/**
 * Each pocket's rounded mouth. Everything a ball can touch is the collision
 * geometry: from each knuckle's face tangent round the knuckle and down the
 * straight facing, as deep as the cushion is drawn. Behind that no ball ever
 * reaches, so the mouth closes with a round bowl, a circle tangent to both
 * facings, instead of the square back of a slot.
 */
const MOUTHS = POCKETS.map((pocket) => {
  const ends = CUSHIONS.flatMap((rail) => rail.ends)
    .map((end) => ({ end, dist: Math.hypot(end.jaw.x - pocket.x, end.jaw.y - pocket.y) }))
    .sort((p, q) => p.dist - q.dist)
    .slice(0, 2)
    .map(({ end }) => end);
  const [a, b] = ends;
  // Unit normal to an end's facing, pointing across the mouth toward the other end.
  const across = (end, other) => {
    const dx = end.back.x - end.jaw.x;
    const dy = end.back.y - end.jaw.y;
    const len = Math.hypot(dx, dy);
    const n = { x: -dy / len, y: dx / len };
    const toward = (other.back.x - end.back.x) * n.x + (other.back.y - end.back.y) * n.y;
    return toward < 0 ? { x: -n.x, y: -n.y } : n;
  };
  const na = across(a, b);
  const nb = across(b, a);
  // The bowl's centre is on both normals: a.back + na·t = b.back + nb·s.
  const det = -na.x * nb.y + na.y * nb.x;
  const rx = b.back.x - a.back.x;
  const ry = b.back.y - a.back.y;
  const radius = (-rx * nb.y + ry * nb.x) / det;
  const centre = { x: a.back.x + na.x * radius, y: a.back.y + na.y * radius };
  const angleA = Math.atan2(a.back.y - centre.y, a.back.x - centre.x);
  const angleB = Math.atan2(b.back.y - centre.y, b.back.x - centre.x);
  // Round the back of the pocket, not across its front.
  const inward = Math.atan2((a.jaw.y + b.jaw.y) / 2 - centre.y, (a.jaw.x + b.jaw.x) / 2 - centre.x);
  const short = shortSweep(angleA, angleB);
  const mid = angleA + short / 2;
  const sweep = Math.abs(shortSweep(mid, inward)) < Math.PI / 2 ? short - Math.sign(short) * 2 * Math.PI : short;
  // Where the fall zone (a ball drops once its centre is inside it) crosses each
  // facing, the first crossing going back from the knuckle.
  const facingMeetsFall = (end) => {
    const dx = end.back.x - end.facingTangent.x;
    const dy = end.back.y - end.facingTangent.y;
    const len = Math.hypot(dx, dy);
    const ox = end.facingTangent.x - pocket.x;
    const oy = end.facingTangent.y - pocket.y;
    const along = (ox * dx + oy * dy) / len;
    const disc = along * along - (ox * ox + oy * oy - pocket.r * pocket.r);
    if (disc <= 0) return null;
    const s = -along - Math.sqrt(disc);
    return s >= 0 && s <= len ? { x: end.facingTangent.x + (dx / len) * s, y: end.facingTangent.y + (dy / len) * s } : null;
  };
  // Where the fall zone reaches both facings (the corners), the hole's front is
  // the zone's round edge: the ledge between it and the knuckles, where no
  // ball's centre can get, is cloth. Otherwise (the middles, whose falls sit
  // well inside the mouth) the hole runs right up to the knuckles.
  const fa = facingMeetsFall(a);
  const fb = facingMeetsFall(b);
  let front = null;
  if (fa && fb) {
    const fromB = Math.atan2(fb.y - pocket.y, fb.x - pocket.x);
    const toA = Math.atan2(fa.y - pocket.y, fa.x - pocket.x);
    const towardTable = Math.atan2((a.jaw.y + b.jaw.y) / 2 - pocket.y, (a.jaw.x + b.jaw.x) / 2 - pocket.x);
    const shortWay = shortSweep(fromB, toA);
    // Round the front of the zone, toward the table.
    const frontSweep = Math.abs(shortSweep(fromB + shortWay / 2, towardTable)) < Math.PI / 2
      ? shortWay
      : shortWay - Math.sign(shortWay) * 2 * Math.PI;
    front = { a: fa, b: fb, from: fromB, sweep: frontSweep };
  }
  // Otherwise (the middles) the hole is an oval: its front just meets the
  // cushion face line on the pocket's axis, its back is the back of the bowl,
  // and it is as wide as fits between the facings. The facings close in toward
  // the back, so the oval is widest a little in front of halfway (a front and a
  // back half-ellipse sharing that width), which fits 90mm across where a
  // symmetric oval fits 88. Further forward flattens the arch where it meets
  // the cloth. It covers the whole fall zone, and the ledge around it, up to
  // the knuckles, is cloth.
  let oval = null;
  if (!front) {
    const mx = (a.jaw.x + b.jaw.x) / 2;
    const my = (a.jaw.y + b.jaw.y) / 2;
    const toCentre = Math.hypot(centre.x - mx, centre.y - my);
    const wx = (centre.x - mx) / toCentre; // into the pocket, along its axis
    const wy = (centre.y - my) / toCentre;
    const back = toCentre + radius;
    const widest = back * 0.42;
    // Distance from the axis to a facing at a given depth behind the face.
    const gapAt = (end, depth) => {
      const dx = end.back.x - end.jaw.x;
      const dy = end.back.y - end.jaw.y;
      const t = (depth - ((end.jaw.x - mx) * wx + (end.jaw.y - my) * wy)) / (dx * wx + dy * wy);
      const px = end.jaw.x + dx * t - mx;
      const py = end.jaw.y + dy * t - my;
      return Math.abs(px * -wy + py * wx);
    };
    // Widest oval that stays between the facings at every depth.
    let across = Infinity;
    for (let i = 1; i < 200; i += 1) {
      const depth = (back * i) / 200;
      const halfDepth = depth < widest ? widest : back - widest;
      const shape = Math.sqrt(1 - ((depth - widest) / halfDepth) ** 2);
      across = Math.min(across, gapAt(a, depth) / shape, gapAt(b, depth) / shape);
    }
    oval = {
      x: mx + wx * widest,
      y: my + wy * widest,
      across,
      front: widest,
      back: back - widest,
      rotation: Math.atan2(wx, -wy),
    };
  }
  // Unit vector out of the pocket onto the table, along its axis.
  const outX = (a.jaw.x + b.jaw.x) / 2 - centre.x;
  const outY = (a.jaw.y + b.jaw.y) / 2 - centre.y;
  const outLen = Math.hypot(outX, outY);
  const onTable = { x: outX / outLen, y: outY / outLen };
  return { pocket, ends: [a, b], bowl: { centre, radius, from: angleA, sweep }, front, oval, onTable };
});

export class TableRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  }

  /** Fit the table into the available box, keeping the 2:1 aspect ratio. */
  resize(maxW, maxH) {
    const worldW = TABLE.width + RAIL * 2;
    const worldH = TABLE.height + RAIL * 2;
    this.scale = Math.max(0.1, Math.min(maxW / worldW, maxH / worldH));
    const cssW = Math.floor(worldW * this.scale);
    const cssH = Math.floor(worldH * this.scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
  }

  /** Canvas pixel -> table centimetres. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / this.scale - RAIL,
      y: (clientY - rect.top) / this.scale - RAIL,
    };
  }

  #begin() {
    const { ctx } = this;
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, 0, 0);
    ctx.translate(RAIL, RAIL);
  }

  #drawTable() {
    const { ctx } = this;
    // Rails.
    ctx.fillStyle = WOOD;
    ctx.beginPath();
    ctx.roundRect(-RAIL, -RAIL, TABLE.width + RAIL * 2, TABLE.height + RAIL * 2, 4);
    ctx.fill();

    // Cloth.
    ctx.fillStyle = CLOTH;
    ctx.fillRect(0, 0, TABLE.width, TABLE.height);

    // Baulk line and the D.
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(BAULK_LINE_X, 0);
    ctx.lineTo(BAULK_LINE_X, TABLE.height);
    ctx.stroke();
    // The D sits on the baulk side of the line, bulging toward x = 0. Sweeping
    // the other way mirrors it onto the black-end side, which is not where the
    // cue ball is actually allowed to go (see inTheD() in controls.js).
    ctx.beginPath();
    ctx.arc(BAULK_LINE_X, CENTRE_Y, D_RADIUS, Math.PI / 2, -Math.PI / 2, false);
    ctx.stroke();

    // Spots.
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    for (const c of COLOURS) {
      ctx.beginPath();
      ctx.arc(c.spot.x, c.spot.y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pockets: a cloth ledge between the knuckles and facings, and the hole in
    // it (see MOUTHS): round at the corners, an oval in the middles.
    for (const { pocket: p, ends: [a, b], bowl, front, oval, onTable } of MOUTHS) {
      const bowlArc = () => {
        ctx.lineTo(a.back.x, a.back.y);
        ctx.arc(bowl.centre.x, bowl.centre.y, bowl.radius, bowl.from, bowl.from + bowl.sweep, bowl.sweep < 0);
      };
      ctx.fillStyle = CLOTH;
      ctx.beginPath();
      ctx.moveTo(a.faceTangent.x, a.faceTangent.y);
      this.#knuckleArc(a, 'face', 'facing');
      // Behind the drawn cushion the corner ledge follows the bowl; the middle
      // ledge stops there, so wood shows round the back of the oval.
      if (front) bowlArc();
      else ctx.lineTo(a.back.x, a.back.y);
      ctx.lineTo(b.back.x, b.back.y);
      ctx.lineTo(b.facingTangent.x, b.facingTangent.y);
      this.#knuckleArc(b, 'facing', 'face');
      // Overlap the table cloth by a hair: where two fills only meet, their
      // anti-aliased edges leave a faint line across the mouth.
      const seam = 0.4;
      ctx.lineTo(b.faceTangent.x + onTable.x * seam, b.faceTangent.y + onTable.y * seam);
      ctx.lineTo(a.faceTangent.x + onTable.x * seam, a.faceTangent.y + onTable.y * seam);
      ctx.closePath();
      ctx.fill();

      const grad = ctx.createRadialGradient(p.x, p.y, 0.5, p.x, p.y, p.r + BALL_RADIUS);
      grad.addColorStop(0, '#000');
      grad.addColorStop(1, POCKET_DARK);
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (front) {
        ctx.moveTo(front.a.x, front.a.y);
        bowlArc();
        ctx.lineTo(front.b.x, front.b.y);
        ctx.arc(p.x, p.y, p.r, front.from, front.from + front.sweep, front.sweep < 0);
      } else {
        // In the ellipse's own frame +y points out of the pocket, onto the table.
        ctx.ellipse(oval.x, oval.y, oval.across, oval.front, oval.rotation, 0, Math.PI);
        ctx.ellipse(oval.x, oval.y, oval.across, oval.back, oval.rotation, Math.PI, Math.PI * 2);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Cushions on top, so the facings and rounded knuckles frame each mouth.
    ctx.fillStyle = CUSHION;
    ctx.strokeStyle = CUSHION_EDGE;
    ctx.lineWidth = 0.35;
    for (const rail of CUSHIONS) {
      this.#polygon(rail.polygon);
      ctx.fill();
      for (const k of rail.knuckles) {
        ctx.beginPath();
        ctx.arc(k.x, k.y, k.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // A light line along the playing edge: face, knuckle arcs and facings.
    for (const rail of CUSHIONS) this.#cushionEdge(rail);
  }

  #polygon(points) {
    const { ctx } = this;
    ctx.beginPath();
    points.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.closePath();
  }

  /**
   * Continue the current path round an end's knuckle, the short way from one
   * tangent point ('face' or 'facing') to the other. A square jaw has no knuckle
   * and the two points coincide, so this is a line to it.
   */
  #knuckleArc(end, fromSide, toSide) {
    const { ctx } = this;
    const start = end[`${fromSide}Tangent`];
    const finish = end[`${toSide}Tangent`];
    if (!end.knuckle) {
      ctx.lineTo(finish.x, finish.y);
      return;
    }
    const { x, y, r } = end.knuckle;
    const from = Math.atan2(start.y - y, start.x - x);
    const sweep = shortSweep(from, Math.atan2(finish.y - y, finish.x - x));
    ctx.arc(x, y, r, from, from + sweep, sweep < 0);
  }

  /** Stroke the surface a ball can touch: facing, knuckle, face, knuckle, facing. */
  #cushionEdge(rail) {
    const { ctx } = this;
    const [a, b] = rail.ends;
    ctx.beginPath();
    ctx.moveTo(a.back.x, a.back.y);
    ctx.lineTo(a.facingTangent.x, a.facingTangent.y);
    this.#knuckleArc(a, 'facing', 'face');
    ctx.lineTo(b.faceTangent.x, b.faceTangent.y);
    this.#knuckleArc(b, 'face', 'facing');
    ctx.lineTo(b.back.x, b.back.y);
    ctx.stroke();
  }

  #drawBall(ball, { highlight = false, dim = false } = {}) {
    const { ctx } = this;
    const fill = BALL_COLOURS[ball.color] ?? '#999';

    ctx.save();
    if (dim) ctx.globalAlpha = 0.35;

    ctx.beginPath();
    ctx.arc(ball.x, ball.y + 0.6, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill();

    const grad = ctx.createRadialGradient(
      ball.x - BALL_RADIUS * 0.35, ball.y - BALL_RADIUS * 0.4, BALL_RADIUS * 0.15,
      ball.x, ball.y, BALL_RADIUS,
    );
    grad.addColorStop(0, '#ffffff88');
    grad.addColorStop(0.35, fill);
    grad.addColorStop(1, '#00000055');

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = grad;
    ctx.fill();

    if (highlight) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.6;
      ctx.setLineDash([1.6, 1.6]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS + 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  #drawAim(cue, angle, power) {
    const { ctx } = this;
    const len = 40 + power * 90;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 2.5]);
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(cue.x + Math.cos(angle) * len, cue.y + Math.sin(angle) * len);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghost cue ball at the end of the aim line.
    const gx = cue.x + Math.cos(angle) * len;
    const gy = cue.y + Math.sin(angle) * len;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.arc(gx, gy, BALL_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    // Cue stick behind the ball, pulled back with power.
    const back = 8 + power * 22;
    ctx.strokeStyle = '#d8b076';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cue.x - Math.cos(angle) * back, cue.y - Math.sin(angle) * back);
    ctx.lineTo(cue.x - Math.cos(angle) * (back + 110), cue.y - Math.sin(angle) * (back + 110));
    ctx.stroke();
    ctx.restore();
  }

  #drawDZone() {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(53,196,138,.16)';
    ctx.beginPath();
    ctx.arc(BAULK_LINE_X, CENTRE_Y, D_RADIUS, Math.PI / 2, -Math.PI / 2, false);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * @param {object} view
   * @param {Array}  view.balls
   * @param {string} view.ballOn      'red' | 'colour' | a colour id
   * @param {object} [view.aim]       {angle, power} while aiming
   * @param {boolean} [view.showD]    highlight the D for in-hand placement
   */
  draw(view) {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#begin();
    this.#drawTable();
    if (view.showD) this.#drawDZone();

    const onTable = view.balls.filter((b) => !b.potted);
    const cue = onTable.find((b) => b.id === 'cue');

    for (const ball of onTable) {
      if (ball.id === 'cue') continue;
      const isOn = view.ballOn === 'red'
        ? ball.color === 'red'
        : (view.ballOn === 'colour' ? ball.color !== 'red' : ball.id === view.ballOn);
      this.#drawBall(ball, { highlight: isOn && view.highlightOn !== false });
    }

    if (cue) {
      if (view.aim) this.#drawAim(cue, view.aim.angle, view.aim.power);
      this.#drawBall(cue);
    }
  }
}
