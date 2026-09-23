import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SoundEngine, ImpactTracker, volumeFor, LEVELS, MAX_VOICES, PAIR_GAP_S,
} from '../src/sound.js';

/* ---------- a fake Web Audio context ---------- */

const param = () => ({
  value: 0,
  calls: [],
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); },
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); },
  linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); },
});

class FakeContext {
  constructor() {
    this.state = 'suspended'; // what a browser hands you before a gesture
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = { name: 'destination' };
    this.started = []; // every source started: one entry per oscillator / noise burst
    this.resumes = 0;
    this.suspends = 0;
  }

  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }

  suspend() { this.suspends += 1; this.state = 'suspended'; return Promise.resolve(); }

  #node(extra = {}) { return { connect() {}, ...extra }; }

  createGain() { return this.#node({ gain: param() }); }

  createDynamicsCompressor() {
    return this.#node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  }

  createBiquadFilter() { return this.#node({ type: '', frequency: param(), Q: param() }); }

  createBuffer(_ch, len) { const data = new Float32Array(len); return { getChannelData: () => data }; }

  createBufferSource() {
    return this.#node({ buffer: null, start: (at) => this.started.push({ kind: 'noise', at }) });
  }

  createOscillator() {
    return this.#node({ type: '', frequency: param(), start: (at) => this.started.push({ kind: 'tone', at }), stop() {} });
  }
}

function rig({ enabled = true, silentScreen = false } = {}) {
  const r = { enabled, silentScreen, contexts: [] };
  r.engine = new SoundEngine({
    createContext: () => { const c = new FakeContext(); r.contexts.push(c); return c; },
    isEnabled: () => r.enabled,
    isSilentScreen: () => r.silentScreen,
  });
  r.ctx = () => r.contexts[0];
  return r;
}

/** A rig that has already been unlocked by a tap. */
const unlocked = (opts) => { const r = rig(opts); r.engine.unlock(); return r; };

/* ---------- volume mapping ---------- */

test('volume is zero below each sound\'s threshold', () => {
  assert.equal(volumeFor('click', 0), 0);
  assert.equal(volumeFor('click', LEVELS.click.quiet), 0);
  assert.equal(volumeFor('cushion', 5), 0); // a ball settling against the rail
  assert.equal(volumeFor('click', NaN), 0);
  assert.equal(volumeFor('nonsense', 100), 0);
});

test('volume rises with impact speed and never passes the sound\'s maximum', () => {
  for (const kind of Object.keys(LEVELS)) {
    let last = -1;
    for (let speed = 0; speed <= 600; speed += 10) {
      const v = volumeFor(kind, speed);
      assert.ok(v >= last, `${kind} got quieter at ${speed} cm/s`);
      assert.ok(v <= LEVELS[kind].max + 1e-12, `${kind} too loud at ${speed} cm/s`);
      last = v;
    }
    assert.equal(volumeFor(kind, LEVELS[kind].full), LEVELS[kind].max);
    assert.equal(volumeFor(kind, 5000), LEVELS[kind].max, `${kind} not capped`);
  }
});

test('a soft touch is quiet but audible; a hard hit is loud', () => {
  const soft = volumeFor('click', 20);
  const hard = volumeFor('click', 250);
  assert.ok(soft > 0 && soft < 0.2, `soft ${soft}`);
  assert.ok(hard > 0.7, `hard ${hard}`);
});

test('the cue strike scales with shot power', () => {
  assert.ok(volumeFor('strike', 0.1 * 340) < volumeFor('strike', 0.5 * 340));
  assert.ok(volumeFor('strike', 0.5 * 340) < volumeFor('strike', 340));
});

/* ---------- unlock gating ---------- */

test('no AudioContext exists, and nothing plays, until the first gesture', () => {
  const r = rig();
  assert.equal(r.engine.click('cue', 'red1', 200), 0);
  assert.equal(r.engine.strike(300), 0);
  assert.equal(r.contexts.length, 0, 'a context was created outside a gesture');
});

test('the first gesture creates and resumes the context; later ones reuse it', () => {
  const r = rig();
  r.engine.unlock();
  assert.equal(r.contexts.length, 1);
  assert.equal(r.ctx().state, 'running');
  r.engine.unlock();
  assert.equal(r.contexts.length, 1, 'made a second context');
  assert.ok(r.engine.click('cue', 'red1', 200) > 0);
});

test('a gesture restarts a context the system suspended', () => {
  const r = unlocked();
  r.ctx().state = 'interrupted'; // iOS: a call came in
  r.engine.unlock();
  assert.equal(r.ctx().state, 'running');
});

test('no Web Audio at all: stays silent and does not throw', () => {
  const engine = new SoundEngine({ createContext: () => { throw new Error('no audio'); }, isEnabled: () => true });
  engine.unlock();
  assert.equal(engine.click('cue', 'red1', 200), 0);
});

test('hiding the app suspends the context and silences it; showing resumes', () => {
  const r = unlocked();
  r.engine.setHidden(true);
  assert.equal(r.ctx().state, 'suspended');
  assert.equal(r.engine.click('cue', 'red1', 200), 0);
  r.engine.setHidden(false);
  assert.equal(r.ctx().state, 'running');
  assert.ok(r.engine.click('cue', 'red1', 200) > 0);
});

test('a tap while the app is hidden does not start audio', () => {
  const r = rig();
  r.engine.setHidden(true);
  r.engine.unlock();
  assert.notEqual(r.ctx().state, 'running');
});

/* ---------- the sound toggle ---------- */

test('sound off: nothing plays, and turning it back on works without a reload', () => {
  const r = unlocked({ enabled: false });
  assert.equal(r.engine.click('cue', 'red1', 200), 0);
  assert.equal(r.engine.strike(300), 0);
  assert.equal(r.ctx().started.length, 0);
  r.enabled = true; // Settings toggled mid-game
  assert.ok(r.engine.click('cue', 'red1', 200) > 0);
  r.enabled = false;
  r.ctx().currentTime += 1;
  assert.equal(r.engine.click('cue', 'red1', 200), 0);
});

test('the lobby and wallet screens are always silent', () => {
  const r = unlocked({ silentScreen: true });
  assert.equal(r.engine.strike(300), 0);
  assert.equal(r.engine.pot('red1', 100), 0);
  assert.equal(r.ctx().started.length, 0);
});

/* ---------- throttling ---------- */

test(`no more than ${MAX_VOICES} sounds at once`, () => {
  const r = unlocked();
  let played = 0;
  for (let i = 0; i < 20; i += 1) if (r.engine.click('cue', `red${i}`, 200) > 0) played += 1;
  assert.equal(played, MAX_VOICES);
});

test('voices free up as sounds finish', () => {
  const r = unlocked();
  for (let i = 0; i < MAX_VOICES; i += 1) r.engine.click('cue', `red${i}`, 200);
  assert.equal(r.engine.click('cue', 'red99', 200), 0);
  r.ctx().currentTime += 0.5;
  assert.ok(r.engine.click('cue', 'red99', 200) > 0);
});

test('the same pair of balls is not re-sounded within the gap, in either order', () => {
  const r = unlocked();
  assert.ok(r.engine.click('red1', 'red2', 200) > 0);
  r.ctx().currentTime += PAIR_GAP_S / 2;
  assert.equal(r.engine.click('red1', 'red2', 200), 0);
  assert.equal(r.engine.click('red2', 'red1', 200), 0, 'order of the pair mattered');
  // A different pair at the same moment is fine.
  assert.ok(r.engine.click('red1', 'red3', 200) > 0);
  r.ctx().currentTime += PAIR_GAP_S;
  assert.ok(r.engine.click('red1', 'red2', 200) > 0);
});

test('cushion and pot gaps are per ball', () => {
  const r = unlocked();
  assert.ok(r.engine.cushion('red1', 200) > 0);
  assert.equal(r.engine.cushion('red1', 200), 0);
  assert.ok(r.engine.cushion('red2', 200) > 0);
  assert.ok(r.engine.pot('red1', 100) > 0);
});

test('a refused sound does not use up a voice or reset its pair\'s gap', () => {
  const r = unlocked();
  r.engine.click('red1', 'red2', 1); // too soft to hear
  assert.ok(r.engine.click('red1', 'red2', 200) > 0, 'a silent touch blocked the real one');
});

test('a simulated break stays within the voice cap', () => {
  // The cue ball into the pack, then a burst of contacts across a few frames.
  const r = unlocked();
  let maxAtOnce = 0;
  const live = [];
  for (let frame = 0; frame < 30; frame += 1) {
    r.ctx().currentTime = frame / 60;
    for (let k = 0; k < 6; k += 1) {
      const a = `red${(frame + k) % 15}`;
      const b = `red${(frame * 3 + k + 1) % 15}`;
      if (a !== b && r.engine.click(a, b, 120) > 0) live.push(r.ctx().currentTime + 0.07);
    }
    const now = r.ctx().currentTime;
    maxAtOnce = Math.max(maxAtOnce, live.filter((end) => end > now).length);
  }
  assert.ok(maxAtOnce <= MAX_VOICES, `${maxAtOnce} at once`);
});

test('each sound actually schedules audio', () => {
  const r = unlocked();
  for (const play of [() => r.engine.strike(300), () => r.engine.click('a', 'b', 200),
    () => r.engine.cushion('a', 200), () => r.engine.pot('a', 100)]) {
    const before = r.ctx().started.length;
    play();
    assert.ok(r.ctx().started.length > before);
  }
});

/* ---------- reading speed from the animation ---------- */

test('impact speed comes from the step before the event, not after it', () => {
  const heard = [];
  const sound = {
    click: (a, b, v) => heard.push(['click', a, b, Math.round(v)]),
    cushion: (ball, v) => heard.push(['cushion', ball, Math.round(v)]),
    pot: (ball, v) => heard.push(['pot', ball, Math.round(v)]),
  };
  const t = new ImpactTracker({ dtMs: 10, sound }); // 10ms steps: 1cm a step = 100 cm/s
  const cue = { id: 'cue', x: 0, y: 0, potted: false };
  const red = { id: 'red1', x: 10, y: 0, potted: false };
  const events = [];
  t.start([cue, red]);
  cue.x = 2; // step 1: cue moves 2cm → 200 cm/s
  t.afterStep([cue, red], events);
  // Step 2: they touch; the cue ball has stopped dead and the red has taken off.
  events.push({ type: 'ball-hit', a: 'cue', b: 'red1' });
  red.x = 12;
  t.afterStep([cue, red], events);
  assert.deepEqual(heard, [['click', 'cue', 'red1', 200]], 'used post-impact speeds');
  // Step 3: the red, still at 200 cm/s, hits a cushion; step 4 it drops.
  events.push({ type: 'cushion', ball: 'red1' });
  red.x = 14;
  t.afterStep([cue, red], events);
  events.push({ type: 'pot', ball: 'red1' });
  red.potted = true;
  t.afterStep([cue, red], events);
  assert.deepEqual(heard.slice(1), [['cushion', 'red1', 200], ['pot', 'red1', 200]]);
});

test('each event is sounded once, however many steps follow', () => {
  let clicks = 0;
  const t = new ImpactTracker({ dtMs: 10, sound: { click: () => { clicks += 1; }, cushion() {}, pot() {} } });
  const balls = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }];
  const events = [{ type: 'ball-hit', a: 'a', b: 'b' }];
  t.start(balls);
  for (let i = 0; i < 5; i += 1) t.afterStep(balls, events);
  assert.equal(clicks, 1);
});
