import Matter from 'matter-js';
import {
  TABLE, BALL_RADIUS, POCKETS, PHYSICS, MAX_SHOT_SPEED,
  CORNER_POCKET_CUT, MIDDLE_POCKET_CUT,
  cmPerSecToMatter, matterToCmPerSec,
} from './constants.js';
import { installExactContacts, markCircle } from './contacts.js';

const { Engine, Bodies, Body, Composite, Events, Resolver } = Matter;

// Matter keeps this on the resolver itself, not per engine. The sim is the only
// thing using Matter in the Mini App and on the server, so setting it here, on
// import, applies it to every simulation on both. See PHYSICS.restingThresh.
Resolver._restingThresh = PHYSICS.restingThresh;
// Likewise global: contacts involving balls are computed as true circles, not
// Matter's polygons. See contacts.js.
installExactContacts();

const CUSHION_THICKNESS = 12;
const OFF_TABLE_MARGIN = 30;

/** Sides for a ball's polygon, only a bounding shape for Matter to find nearby pairs (contacts use the exact circle). */
const BALL_SIDES = 16;

/** Radius of an N-gon whose flat sides just touch a circle of radius r, so the polygon encloses the circle. */
const circumscribed = (r, sides) => r / Math.cos(Math.PI / sides);

function buildCushions() {
  const W = TABLE.width;
  const H = TABLE.height;
  const C = CORNER_POCKET_CUT;
  const M = MIDDLE_POCKET_CUT;
  const T = CUSHION_THICKNESS;
  const opts = {
    isStatic: true,
    restitution: PHYSICS.cushionRestitution,
    friction: 0.1,
    label: 'cushion',
  };
  const seg = (x1, y1, x2, y2) => Bodies.rectangle(
    (x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1), Math.abs(y2 - y1), opts,
  );
  return [
    // Top rail, split either side of the middle pocket.
    seg(C, -T, W / 2 - M, 0),
    seg(W / 2 + M, -T, W - C, 0),
    // Bottom rail.
    seg(C, H, W / 2 - M, H + T),
    seg(W / 2 + M, H, W - C, H + T),
    // Baulk and black-end rails.
    seg(-T, C, 0, H - C),
    seg(W, C, W + T, H - C),
  ];
}

function makeBallBody(ball) {
  const body = Bodies.polygon(ball.x, ball.y, BALL_SIDES, circumscribed(BALL_RADIUS, BALL_SIDES), {
    restitution: PHYSICS.ballRestitution,
    friction: PHYSICS.ballFriction,
    frictionAir: PHYSICS.frictionAir,
    frictionStatic: 0,
    slop: 0.005,
    label: ball.id,
  });
  body.ballId = ball.id;
  return markCircle(body, BALL_RADIUS);
}

const speedCmPerSec = (body) => matterToCmPerSec(Math.hypot(body.velocity.x, body.velocity.y));

/**
 * Build a shot simulation that can be stepped one physics tick at a time.
 *
 * The Mini App drives this from requestAnimationFrame so the player watches the
 * balls roll; the backend drains it in a tight loop to decide what actually
 * happened. Same code, same fixed timestep, so the two agree.
 *
 * @param {Array} balls  Ball records ({id,color,value,x,y,potted}).
 * @param {{angle:number,power:number,cuePlacement?:{x,y}}} shot
 */
export function createSimulation(balls, shot) {
  const working = balls.map((b) => ({ ...b }));
  const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  engine.enableSleeping = false;
  Composite.add(engine.world, buildCushions());

  const bodies = new Map();
  for (const ball of working) {
    if (ball.potted) continue;
    if (ball.id === 'cue' && shot.cuePlacement) {
      ball.x = shot.cuePlacement.x;
      ball.y = shot.cuePlacement.y;
    }
    const body = makeBallBody(ball);
    bodies.set(ball.id, body);
    Composite.add(engine.world, body);
  }

  const events = [];
  const state = { step: 0, firstContact: null, done: false };

  Events.on(engine, 'collisionStart', (evt) => {
    for (const pair of evt.pairs) {
      const { bodyA: a, bodyB: b } = pair;
      // Matter gives a pair the higher of the two restitutions, which would make
      // every cushion as bouncy as a ball. This event fires before the contact
      // is solved, so the bounce uses the cushion's value.
      if (a.label === 'cushion' || b.label === 'cushion') pair.restitution = PHYSICS.cushionRestitution;
      if (a.ballId && b.ballId) {
        events.push({ type: 'ball-hit', a: a.ballId, b: b.ballId, step: state.step });
        if (!state.firstContact && (a.ballId === 'cue' || b.ballId === 'cue')) {
          state.firstContact = a.ballId === 'cue' ? b.ballId : a.ballId;
        }
      } else {
        const ballBody = a.ballId ? a : b;
        if (ballBody.ballId) {
          events.push({ type: 'cushion', ball: ballBody.ballId, step: state.step });
        }
      }
    }
  });

  const cue = bodies.get('cue');
  if (cue) {
    const power = Math.min(1, Math.max(0, shot.power));
    const v = cmPerSecToMatter(power * MAX_SHOT_SPEED);
    Body.setVelocity(cue, {
      x: Math.cos(shot.angle) * v,
      y: Math.sin(shot.angle) * v,
    });
  } else {
    state.done = true;
  }

  function syncPositions() {
    for (const [id, body] of bodies.entries()) {
      const rec = working.find((w) => w.id === id);
      rec.x = +body.position.x.toFixed(4);
      rec.y = +body.position.y.toFixed(4);
    }
  }

  /** Advance one fixed tick. Returns true when everything has come to rest. */
  function step() {
    if (state.done) return true;
    Engine.update(engine, PHYSICS.dt);

    for (const [id, body] of [...bodies.entries()]) {
      const pocket = POCKETS.find(
        (p) => Math.hypot(body.position.x - p.x, body.position.y - p.y) <= p.r,
      );
      const rec = working.find((w) => w.id === id);
      if (pocket) {
        events.push({ type: 'pot', ball: id, pocket: pocket.id, step: state.step });
        Composite.remove(engine.world, body);
        bodies.delete(id);
        rec.potted = true;
        continue;
      }
      const { x, y } = body.position;
      if (x < -OFF_TABLE_MARGIN || x > TABLE.width + OFF_TABLE_MARGIN
        || y < -OFF_TABLE_MARGIN || y > TABLE.height + OFF_TABLE_MARGIN) {
        events.push({ type: 'off-table', ball: id, step: state.step });
        Composite.remove(engine.world, body);
        bodies.delete(id);
        rec.potted = true;
        rec.offTable = true;
      }
    }

    let moving = false;
    for (const body of bodies.values()) {
      if (speedCmPerSec(body) < PHYSICS.restSpeed) {
        Body.setVelocity(body, { x: 0, y: 0 });
        Body.setAngularVelocity(body, 0);
      } else {
        moving = true;
      }
    }

    state.step += 1;
    syncPositions();

    if (!moving || state.step >= PHYSICS.maxSteps) {
      state.done = true;
      Engine.clear(engine);
      Events.off(engine);
    }
    return state.done;
  }

  return {
    step,
    get done() { return state.done; },
    get steps() { return state.step; },
    get events() { return events; },
    get firstContact() { return state.firstContact; },
    balls: () => working,
    result: () => ({
      balls: working,
      events,
      firstContact: state.firstContact,
      steps: state.step,
    }),
  };
}

/**
 * Resolve a shot in one call. This is what the backend uses: authoritative,
 * no animation, bounded by PHYSICS.maxSteps.
 */
export function simulateShot(balls, shot, opts = {}) {
  const sim = createSimulation(balls, shot);
  const trace = opts.trace ? [] : null;
  while (!sim.done) {
    sim.step();
    if (trace && sim.steps % 5 === 0) {
      trace.push(sim.balls().filter((b) => !b.potted).map((b) => ({
        id: b.id, x: +b.x.toFixed(3), y: +b.y.toFixed(3),
      })));
    }
  }
  const result = sim.result();
  if (trace) result.trace = trace;
  return result;
}
