/**
 * Table sounds, synthesised with the Web Audio API — no audio files.
 *
 * Audio layer only: it listens to what the shot animation already produces
 * (the sim's ball-hit / cushion / pot events, and ball positions each step)
 * and never feeds anything back. See ImpactTracker below for how impact speed
 * is read without touching the sim.
 *
 * The engine takes its AudioContext factory, settings and screen check as
 * arguments so the gating, throttling and volume rules can be tested in Node
 * against a fake context.
 */

/* ---------- volume ---------- */

/**
 * Per sound: the speed (cm/s) below which it is silent, the speed at which it
 * reaches full volume, and its loudest level. Balls come to rest at 3 cm/s,
 * and the cue ball leaves at up to 340 cm/s.
 */
export const LEVELS = {
  strike: { quiet: 0, full: 340, max: 0.55 },
  click: { quiet: 4, full: 260, max: 0.8 },
  cushion: { quiet: 8, full: 260, max: 0.7 },
  pot: { quiet: 0, full: 200, max: 0.6 },
};

/**
 * Loudness for an impact speed: nothing below the threshold, then rising with
 * a slight curve (quiet touches stay audible, hard hits do not blow past a
 * medium one by much), never above the sound's maximum.
 */
export function volumeFor(kind, speed) {
  const l = LEVELS[kind];
  if (!l || !(speed > l.quiet)) return 0;
  const t = Math.min(1, (speed - l.quiet) / (l.full - l.quiet));
  return l.max * t ** 0.7;
}

/* ---------- throttling ---------- */

/** Voices playing at once. A break fires dozens of contacts in a few frames. */
export const MAX_VOICES = 8;
/** The same two balls (or ball and cushion) sound at most this often, in seconds. */
export const PAIR_GAP_S = 0.06;

/** How long each sound rings, in seconds — for voice accounting. */
const DURATION = { strike: 0.12, click: 0.07, cushion: 0.16, pot: 0.35 };

/* ---------- the engine ---------- */

export class SoundEngine {
  /**
   * @param {object} o
   * @param {() => AudioContext} o.createContext  called once, inside a user gesture
   * @param {() => boolean} o.isEnabled           the sound setting, read live
   * @param {() => boolean} [o.isSilentScreen]    lobby / wallet: never play
   */
  constructor({ createContext, isEnabled, isSilentScreen = () => false }) {
    this.createContext = createContext;
    this.isEnabled = isEnabled;
    this.isSilentScreen = isSilentScreen;
    this.ctx = null;
    this.hidden = false;
    this.voices = []; // end times
    this.lastByKey = new Map();
  }

  /** Whether a sound would be heard right now. */
  get ready() {
    return Boolean(this.ctx) && !this.hidden && this.isEnabled() && !this.isSilentScreen();
  }

  /**
   * First tap / click / key: create and start the context. Browsers (iOS and
   * Telegram's webview most strictly) only let audio start from inside a user
   * gesture, so this must be called from the gesture's own handler.
   */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = this.createContext();
      } catch {
        return; // no Web Audio: stay silent
      }
      this.#buildGraph();
    }
    if (!this.hidden && this.ctx.state !== 'running') this.ctx.resume?.();
  }

  /** App hidden (tab switched, Telegram minimised): stop the audio clock. */
  setHidden(hidden) {
    this.hidden = hidden;
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend?.();
    else if (this.ctx.state !== 'running') this.ctx.resume?.();
  }

  #buildGraph() {
    const { ctx } = this;
    // A gentle compressor on the master bus: a break's burst of clicks sums
    // loud, and this keeps the sum from clipping.
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // One second of white noise, reused by every sound from a random offset.
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  }

  /**
   * Admit one sound, or refuse it: not ready, too quiet, the same pair heard
   * too recently, or every voice busy. Returns the gain to play it at, or 0.
   */
  #admit(kind, key, speed) {
    if (!this.ready) return 0;
    const gain = volumeFor(kind, speed);
    if (gain <= 0) return 0;
    const now = this.ctx.currentTime;
    if (key) {
      const last = this.lastByKey.get(key);
      if (last !== undefined && now - last < PAIR_GAP_S) return 0;
    }
    this.voices = this.voices.filter((end) => end > now);
    if (this.voices.length >= MAX_VOICES) return 0;
    if (key) this.lastByKey.set(key, now);
    this.voices.push(now + DURATION[kind]);
    return gain;
  }

  /** The cue tip meets the cue ball. */
  strike(speed) {
    const g = this.#admit('strike', null, speed);
    if (g) this.#strike(g);
    return g;
  }

  /** Two balls touch; `relSpeed` is how fast they closed. */
  click(a, b, relSpeed) {
    const key = `ball:${a < b ? `${a}|${b}` : `${b}|${a}`}`;
    const g = this.#admit('click', key, relSpeed);
    if (g) this.#click(g);
    return g;
  }

  /** A ball meets a cushion. */
  cushion(ball, speed) {
    const g = this.#admit('cushion', `cushion:${ball}`, speed);
    if (g) this.#cushion(g);
    return g;
  }

  /** A ball drops into a pocket. */
  pot(ball, speed) {
    const g = this.#admit('pot', `pot:${ball}`, speed);
    if (g) this.#pot(g);
    return g;
  }

  /* ---------- synthesis ---------- */

  /** A decaying gain envelope into the master bus. */
  #envelope(peak, attack, decay, at) {
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    env.connect(this.master);
    return env;
  }

  /** Filtered noise: the body of every contact sound. */
  #noise(type, freq, q, into, at, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    src.connect(filter);
    filter.connect(into);
    src.start(at, Math.random() * 0.9, dur);
  }

  /** A sine partial, optionally sliding in pitch. */
  #tone(freq, toFreq, into, at, dur) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (toFreq !== freq) osc.frequency.exponentialRampToValueAtTime(toFreq, at + dur);
    osc.connect(into);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  // Leather tip on resin: a soft, woody "tock" rather than a crack.
  #strike(g) {
    const at = this.ctx.currentTime;
    const env = this.#envelope(g, 0.002, 0.09, at);
    this.#noise('bandpass', 1700, 1.2, env, at, 0.1);
    this.#tone(420, 300, this.#envelope(g * 0.5, 0.002, 0.06, at), at, 0.07);
  }

  // Resin on resin: a short, bright, glassy click, pitched a little
  // differently each time so a cluster does not sound like one sample.
  #click(g) {
    const at = this.ctx.currentTime;
    const pitch = 2400 + Math.random() * 900;
    this.#noise('bandpass', pitch * 1.3, 3, this.#envelope(g * 0.7, 0.001, 0.03, at), at, 0.04);
    this.#tone(pitch, pitch * 0.97, this.#envelope(g * 0.55, 0.001, 0.045, at), at, 0.05);
  }

  // Rubber cushion: a dull, low thump with only a little top end.
  #cushion(g) {
    const at = this.ctx.currentTime;
    this.#tone(130, 70, this.#envelope(g, 0.003, 0.12, at), at, 0.13);
    this.#noise('lowpass', 500, 0.7, this.#envelope(g * 0.5, 0.002, 0.06, at), at, 0.08);
  }

  // Into the pocket: a hollow knock as it hits the leather, then a smaller
  // second knock as it settles.
  #pot(g) {
    const at = this.ctx.currentTime;
    this.#tone(190, 110, this.#envelope(g, 0.004, 0.16, at), at, 0.17);
    this.#noise('lowpass', 700, 0.8, this.#envelope(g * 0.45, 0.002, 0.07, at), at, 0.09);
    const later = at + 0.11;
    this.#tone(160, 120, this.#envelope(g * 0.45, 0.004, 0.12, later), later, 0.13);
  }
}

/* ---------- in the browser ---------- */

/**
 * The app's engine: unlocked by the first tap, click or key anywhere, paused
 * while the app is hidden, silent on the lobby and wallet screens.
 *
 * Every gesture calls unlock(), not just the first: iOS can suspend a running
 * context (a phone call, another app's audio), and a later tap is the only
 * thing allowed to start it again. Once running, unlock() does nothing.
 */
export function installTableSound({ isEnabled }) {
  const Ctx = window.AudioContext ?? window.webkitAudioContext;
  const engine = new SoundEngine({
    createContext: () => new Ctx(),
    isEnabled,
    // The lobby and the wallet screen set data-screen; the table clears it.
    isSilentScreen: () => Boolean(document.documentElement.dataset.screen)
      || document.getElementById('lobby')?.hidden === false,
  });
  if (!Ctx) return engine; // no Web Audio: every call is a quiet no-op

  const unlock = () => engine.unlock();
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  const sync = () => engine.setHidden(document.hidden);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', () => engine.setHidden(true));
  window.addEventListener('pageshow', sync);
  // Telegram's own minimise, which not every client reports as visibilitychange.
  const tg = window.Telegram?.WebApp;
  tg?.onEvent?.('deactivated', () => engine.setHidden(true));
  tg?.onEvent?.('activated', sync);
  return engine;
}

/* ---------- reading impact speed from the animation ---------- */

/**
 * Turns the sim's events into sounds with a speed attached.
 *
 * The sim's events say what touched what, but not how hard. This reads the
 * ball positions after every step (the animation already has them) and keeps
 * each ball's velocity from the last step, so an event raised during a step
 * gets the speeds the balls had going into it. Read-only: the sim is never
 * given anything back.
 */
export class ImpactTracker {
  /**
   * @param {object} o
   * @param {number} o.dtMs  the sim's fixed step, in ms
   * @param {{ click: Function, cushion: Function, pot: Function }} o.sound
   */
  constructor({ dtMs, sound }) {
    this.dtS = dtMs / 1000;
    this.sound = sound;
    this.pos = new Map();
    this.vel = new Map();
    this.seen = 0;
  }

  /** Positions at the start of the shot, before any step. */
  start(balls) {
    this.pos.clear();
    this.vel.clear();
    this.seen = 0;
    for (const b of balls) if (!b.potted) this.pos.set(b.id, { x: b.x, y: b.y });
  }

  #speed(id) {
    const v = this.vel.get(id);
    return v ? Math.hypot(v.x, v.y) : 0;
  }

  /**
   * After each sim step: sound the step's new events at the speeds going into
   * it, then take this step's velocities for the next one.
   */
  afterStep(balls, events) {
    for (; this.seen < events.length; this.seen += 1) {
      const e = events[this.seen];
      if (e.type === 'ball-hit') {
        const va = this.vel.get(e.a) ?? { x: 0, y: 0 };
        const vb = this.vel.get(e.b) ?? { x: 0, y: 0 };
        this.sound.click(e.a, e.b, Math.hypot(va.x - vb.x, va.y - vb.y));
      } else if (e.type === 'cushion') {
        this.sound.cushion(e.ball, this.#speed(e.ball));
      } else if (e.type === 'pot') {
        this.sound.pot(e.ball, this.#speed(e.ball));
      }
    }
    for (const b of balls) {
      if (b.potted) continue;
      const prev = this.pos.get(b.id);
      if (prev) this.vel.set(b.id, { x: (b.x - prev.x) / this.dtS, y: (b.y - prev.y) / this.dtS });
      this.pos.set(b.id, { x: b.x, y: b.y });
    }
  }
}
