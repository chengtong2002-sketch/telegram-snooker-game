/**
 * Live aim in PvP: the shooter's cue, aim line and power, drawn on the
 * waiting player's table as they move.
 *
 * Display only. None of this reaches the sim: the shot itself still goes
 * through POST /shot with {angle, power}, and the server re-simulates it. A
 * lost, late or bogus aim update can only make the opponent's view lag.
 *
 * Pure (no DOM): the transport is passed in, so node --test can drive it.
 */

/** Send at most this often while the aim moves (~10 a second). */
export const SEND_INTERVAL_MS = 100;
/** While the aim is still, resend this often, so the opponent can tell "still" from "lagging". */
export const HEARTBEAT_MS = 1000;
/** The opponent draws this far behind the newest update, so it can interpolate between two. */
export const RENDER_DELAY_MS = 120;
/** Nothing new for this long: the cue stays where it is, but dimmed. */
export const STALE_MS = 2500;

const ANGLE_EPS = 0.0015;  // rad; well under what a finger can see
const POWER_EPS = 0.004;
const CUE_EPS = 0.05;      // cm

const TAU = Math.PI * 2;
/** Signed shortest turn from a to b, in (-π, π]. */
export const angleDelta = (a, b) => {
  const d = (b - a) % TAU;
  if (d > Math.PI) return d - TAU;
  if (d <= -Math.PI) return d + TAU;
  return d;
};
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Throttles the shooter's aim to what is worth sending: only on change, at
 * most every SEND_INTERVAL_MS, plus a heartbeat while it holds still.
 */
export class AimSender {
  /** @param {(aim:{angle:number, power:number, seq:number, cue?:{x:number,y:number}}) => Promise|void} send */
  constructor(send, { intervalMs = SEND_INTERVAL_MS, heartbeatMs = HEARTBEAT_MS, maxInFlight = 2 } = {}) {
    this.send = send;
    this.intervalMs = intervalMs;
    this.heartbeatMs = heartbeatMs;
    this.maxInFlight = maxInFlight;
    this.seq = 0;
    this.inFlight = 0;
    this.sent = 0;
    this.reset();
  }

  /** A new turn: the next update goes out whatever the last one was. */
  reset() {
    this.last = null;
    this.lastAt = -Infinity;
  }

  #changed(aim) {
    const l = this.last;
    if (!l) return true;
    if (Math.abs(angleDelta(l.angle, aim.angle)) > ANGLE_EPS) return true;
    if (Math.abs(l.power - aim.power) > POWER_EPS) return true;
    if (Boolean(l.cue) !== Boolean(aim.cue)) return true;
    return Boolean(aim.cue) && Math.hypot(aim.cue.x - l.cue.x, aim.cue.y - l.cue.y) > CUE_EPS;
  }

  /**
   * Call every frame while aiming; it decides whether anything goes out.
   * @returns {boolean} whether an update was sent
   */
  update(aim, now) {
    if (now - this.lastAt < this.intervalMs) return false;
    if (!this.#changed(aim) && now - this.lastAt < this.heartbeatMs) return false;
    // A slow link: skip rather than queue, the next frame has a newer aim anyway.
    if (this.inFlight >= this.maxInFlight) return false;
    this.seq += 1;
    const msg = { angle: aim.angle, power: aim.power, seq: this.seq };
    if (aim.cue) msg.cue = { x: aim.cue.x, y: aim.cue.y };
    this.last = { angle: aim.angle, power: aim.power, cue: aim.cue ? { ...aim.cue } : null };
    this.lastAt = now;
    this.sent += 1;
    const p = this.send(msg);
    if (p && typeof p.then === 'function') {
      this.inFlight += 1;
      p.then(() => {}, () => {}).finally(() => { this.inFlight -= 1; });
    }
    return true;
  }
}

/**
 * The opponent's side: a short buffer of received aims, read back
 * RENDER_DELAY_MS in the past so the cue glides between updates instead of
 * jumping ten times a second. When updates stop, it holds the last one.
 */
export class RemoteAim {
  constructor({ delayMs = RENDER_DELAY_MS, staleMs = STALE_MS } = {}) {
    this.delayMs = delayMs;
    this.staleMs = staleMs;
    this.reset();
  }

  reset() {
    this.samples = [];
  }

  /** @param {{angle:number, power:number, seq?:number, cue?:{x:number,y:number}}} aim */
  push(aim, at) {
    const last = this.samples.at(-1);
    // Two POSTs can overtake each other: an older seq arriving late is dropped.
    // A much lower one is a reloaded shooter starting again from 1.
    if (last && aim.seq != null && last.seq != null && aim.seq <= last.seq && last.seq - aim.seq < 50) return;
    this.samples.push({ angle: aim.angle, power: aim.power, cue: aim.cue ?? null, seq: aim.seq ?? null, at });
    if (this.samples.length > 20) this.samples.shift();
  }

  /**
   * Where to draw the shooter's cue at `now`, or null before the first update.
   * @returns {{angle:number, power:number, cue:{x:number,y:number}|null, stale:boolean} | null}
   */
  pose(now) {
    const s = this.samples;
    if (s.length === 0) return null;
    const newest = s.at(-1);
    const stale = now - newest.at > this.staleMs;
    const t = now - this.delayMs;
    if (t >= newest.at || s.length === 1) return { angle: newest.angle, power: newest.power, cue: newest.cue, stale };
    if (t <= s[0].at) return { angle: s[0].angle, power: s[0].power, cue: s[0].cue, stale };
    let i = s.length - 1;
    while (i > 0 && s[i - 1].at > t) i -= 1;
    const a = s[i - 1];
    const b = s[i];
    const k = b.at === a.at ? 1 : (t - a.at) / (b.at - a.at);
    return {
      angle: a.angle + angleDelta(a.angle, b.angle) * k,
      power: lerp(a.power, b.power, k),
      cue: a.cue && b.cue ? { x: lerp(a.cue.x, b.cue.x, k), y: lerp(a.cue.y, b.cue.y, k) } : b.cue,
      stale,
    };
  }
}

/** Split an SSE byte stream into {event, data} messages. Comments (keepalives) are skipped. */
export function sseParser(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onMessage({ event, data: data.join('\n') });
    }
  };
}

/**
 * Hold the opponent-aim stream open for a match, reconnecting after drops.
 * Stops for good on 403/404/409 (not ours, gone, or over).
 *
 * @param {(signal:AbortSignal) => Promise<Response>} connect  opens the stream (api.openAimStream)
 * @param {(aim:object) => void} onAim
 * @param {object} [o]
 * @param {() => void} [o.onMoved]  the server applied a move in this match: worth a poll now
 * @returns {{close: () => void, state: () => string}}
 */
export function followAim(connect, onAim, { onMoved = () => {}, onStateChange = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let closed = false;
  let ac = null;
  let state = 'connecting';
  const setState = (s) => {
    state = s;
    onStateChange(s);
  };

  (async () => {
    let backoff = 1000;
    while (!closed) {
      ac = new AbortController();
      try {
        setState('connecting');
        const res = await connect(ac.signal);
        if ([401, 403, 404, 409].includes(res.status)) {
          setState('stopped');
          return;
        }
        if (res.status !== 200 || !res.body) {
          await sleep(res.status === 429 ? 10_000 : backoff);
          backoff = Math.min(8000, backoff * 2);
          continue;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const feed = sseParser(({ event, data }) => {
          if (event === 'ready') {
            backoff = 1000;
            setState('open');
          } else if (event === 'aim') {
            try { onAim(JSON.parse(data)); } catch { /* a bad line is just skipped */ }
          } else if (event === 'moved') {
            onMoved();
          }
        });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(dec.decode(value, { stream: true }));
        }
      } catch {
        // Dropped or aborted; the loop decides.
      }
      if (closed) break;
      setState('reconnecting');
      await sleep(backoff);
      backoff = Math.min(8000, backoff * 2);
    }
    setState('closed');
  })();

  return {
    close() {
      closed = true;
      ac?.abort();
    },
    state: () => state,
  };
}
