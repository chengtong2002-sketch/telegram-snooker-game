import { getDb } from '@snooker/db';

/**
 * Live aim, shooter → opponent, for display only.
 *
 * The shooter posts where the cue points (and the power) as it moves; the
 * opponent holds one server-sent-events stream per open table and draws it.
 * Nothing is stored and nothing is checked beyond "is it this player's turn":
 * the real shot still goes through POST /shot, which re-simulates from
 * {angle, power} alone, so a lying aim can only mislead the opponent's eyes.
 *
 * In memory, so it only works with ONE backend instance: a shooter and an
 * opponent on different replicas would never meet. Railway runs one.
 */

/** Aim events a match may relay per second (a bucket, so short bursts pass). */
export const AIM_RATE_PER_SEC = 15;
/** Streams one player may hold open at once (a table, plus a reload overlapping it). */
export const MAX_STREAMS_PER_USER = 3;
/** A comment line this often keeps proxies from closing an idle stream. */
export const KEEPALIVE_MS = 15_000;
/** How long a looked-up turn is trusted. Shots, concedes and continues clear it at once. */
const TURN_TTL_MS = 1_000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Keep only the fields the opponent draws, as numbers. Anything else in the
 * body is dropped, so the relay never forwards what it did not expect.
 * @returns {{angle:number, power:number, seq:number, cue?:{x:number,y:number}} | null}
 */
export function shapeAim(body) {
  const { angle, power, seq, cue } = body ?? {};
  if (!finite(angle) || !finite(power)) return null;
  const out = {
    angle: Math.round(angle * 1e4) / 1e4,
    power: Math.round(Math.min(1, Math.max(0, power)) * 1e3) / 1e3,
    seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
  };
  // Ball in hand: the shooter is still moving the cue ball around the D.
  if (cue && finite(cue.x) && finite(cue.y)) {
    out.cue = { x: Math.round(cue.x * 100) / 100, y: Math.round(cue.y * 100) / 100 };
  }
  return out;
}

/** Who plays in the match and whose shot it is. Two columns, no state JSON. */
async function loadTurnFromDb(matchId) {
  const row = await getDb()('matches').where({ id: matchId })
    .first('player_a', 'player_b', 'turn_user_id', 'status');
  if (!row) return null;
  return {
    players: [Number(row.player_a), Number(row.player_b)],
    shooter: row.turn_user_id == null ? null : Number(row.turn_user_id),
    active: row.status === 'active',
  };
}

export class AimRelay {
  constructor({ loadTurn = loadTurnFromDb, now = () => Date.now(), keepaliveMs = KEEPALIVE_MS } = {}) {
    this.loadTurn = loadTurn;
    this.now = now;
    this.keepaliveMs = keepaliveMs;
    this.streams = new Map();     // matchId → Set<{userId, res, timer}>
    this.perUser = new Map();     // userId → open stream count
    this.turns = new Map();       // matchId → {turn, at}
    this.buckets = new Map();     // matchId → {tokens, at}
    this.prunedAt = now();
  }

  /** A shooter with nobody watching still fills the caches: drop what has gone quiet. */
  #prune() {
    const now = this.now();
    if (now - this.prunedAt < 60_000) return;
    this.prunedAt = now;
    for (const [id, t] of this.turns) if (now - t.at > 60_000 && !this.streams.has(id)) this.turns.delete(id);
    for (const [id, b] of this.buckets) if (now - b.at > 60_000 && !this.streams.has(id)) this.buckets.delete(id);
  }

  async turn(matchId, { fresh = false } = {}) {
    const hit = this.turns.get(matchId);
    if (!fresh && hit && this.now() - hit.at < TURN_TTL_MS) return hit.turn;
    const turn = await this.loadTurn(matchId);
    if (turn) this.turns.set(matchId, { turn, at: this.now() });
    else this.turns.delete(matchId);
    return turn;
  }

  /** The turn moved (a shot, a concede, a continue): stop trusting the cached one. */
  forgetTurn(matchId) {
    this.turns.delete(matchId);
  }

  #take(matchId) {
    const now = this.now();
    const b = this.buckets.get(matchId) ?? { tokens: AIM_RATE_PER_SEC, at: now };
    b.tokens = Math.min(AIM_RATE_PER_SEC, b.tokens + ((now - b.at) / 1000) * AIM_RATE_PER_SEC);
    b.at = now;
    this.buckets.set(matchId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * One aim update from `userId`.
   * @returns {Promise<{status:'relayed', delivered:number}
   *   | {status:'ignored', reason:string} | {status:'limited'}
   *   | {status:'error', code:number, reason:string}>}
   */
  async publish(matchId, userId, body) {
    const aim = shapeAim(body);
    if (!aim) return { status: 'error', code: 400, reason: 'angle and power must be numbers' };
    this.#prune();
    const turn = await this.turn(matchId);
    if (!turn) return { status: 'error', code: 404, reason: 'match not found' };
    const seat = turn.players.indexOf(Number(userId));
    if (seat === -1) return { status: 'error', code: 403, reason: 'not a participant' };
    // Not an error: the turn can pass while an update is on its way.
    if (!turn.active || turn.shooter !== Number(userId)) return { status: 'ignored', reason: 'not your shot' };
    if (!this.#take(matchId)) return { status: 'limited' };

    const line = `event: aim\ndata: ${JSON.stringify({ ...aim, seat })}\n\n`;
    let delivered = 0;
    for (const s of this.streams.get(matchId) ?? []) {
      if (s.userId === Number(userId)) continue; // the opponent only, never back to the shooter
      s.res.write(line);
      delivered += 1;
    }
    return { status: 'relayed', delivered };
  }

  /**
   * Hold `res` open as an event stream for `userId` in `matchId`.
   * @returns {Promise<{status:'open'} | {status:'error', code:number, reason:string}>}
   */
  async subscribe(matchId, userId, req, res) {
    const uid = Number(userId);
    const turn = await this.turn(matchId, { fresh: true });
    if (!turn) return { status: 'error', code: 404, reason: 'match not found' };
    if (!turn.players.includes(uid)) return { status: 'error', code: 403, reason: 'not a participant' };
    if (!turn.active) return { status: 'error', code: 409, reason: 'match is not active' };
    if ((this.perUser.get(uid) ?? 0) >= MAX_STREAMS_PER_USER) {
      return { status: 'error', code: 429, reason: 'too many open aim streams' };
    }

    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx-style proxies: do not hold the stream back
    });
    res.flushHeaders();
    res.write('retry: 2000\n\nevent: ready\ndata: {}\n\n');

    const entry = { userId: uid, res, timer: null };
    entry.timer = setInterval(() => res.write(`: keepalive ${this.now()}\n\n`), this.keepaliveMs);
    entry.timer.unref?.();
    if (!this.streams.has(matchId)) this.streams.set(matchId, new Set());
    this.streams.get(matchId).add(entry);
    this.perUser.set(uid, (this.perUser.get(uid) ?? 0) + 1);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(entry.timer);
      const set = this.streams.get(matchId);
      set?.delete(entry);
      if (set && set.size === 0) {
        this.streams.delete(matchId);
        this.turns.delete(matchId);
        this.buckets.delete(matchId);
      }
      const left = (this.perUser.get(uid) ?? 1) - 1;
      if (left > 0) this.perUser.set(uid, left);
      else this.perUser.delete(uid);
    };
    req.on('close', close);
    res.on('close', close);
    return { status: 'open' };
  }

  /**
   * The match moved on (a shot resolved, a concede, a continue): tell the open
   * tables, so the waiting player polls now instead of up to a poll later.
   * Carries nothing; the poll fetches the truth.
   */
  announceMove(matchId) {
    this.forgetTurn(matchId);
    for (const s of this.streams.get(matchId) ?? []) s.res.write('event: moved\ndata: {}\n\n');
  }

  /** Streams open for a match (tests and the shutdown log). */
  openStreams(matchId = null) {
    if (matchId) return this.streams.get(matchId)?.size ?? 0;
    let n = 0;
    for (const set of this.streams.values()) n += set.size;
    return n;
  }

  /** End every stream, so a shutdown does not wait on them. */
  closeAll() {
    for (const set of this.streams.values()) {
      for (const s of set) s.res.end();
    }
  }
}

/** The process's one relay. */
export const aimRelay = new AimRelay();
