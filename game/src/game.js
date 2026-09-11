import {
  newMatch, resolveShot, resolveTimeout, advanceMatch, createSimulation,
  chooseShot, matchHighBreak, PHYSICS, SHOT_CLOCK_MS, MAX_BREAK,
} from '@snooker/sim';
import { describeOutcome } from './hud.js';
import { haptic } from './telegram.js';
import * as api from './api.js';
import { enqueue, flush, newResultId } from './offline.js';

const AI_THINK_MS = 900;
const POLL_MS = 4000;
const STEPS_PER_FRAME = Math.round((1000 / 60) / PHYSICS.dt); // 5 at dt = 1/300s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives one session of play.
 *
 * Practice resolves everything locally — it is never worth anything, so there
 * is no reason to bother the server. PvP animates locally for feel and then
 * hands the shot to the backend, whose resolution replaces whatever the client
 * came up with.
 */
export class Game {
  constructor({ mode, matchId, me, hud, renderer, controls }) {
    this.mode = mode;             // 'practice' | 'pvp'
    this.matchId = matchId;
    this.me = me;
    this.hud = hud;
    this.renderer = renderer;
    this.controls = controls;

    this.myIndex = 0;
    this.state = null;            // sim match state
    this.serverMatch = null;      // last authoritative payload
    this.phase = 'idle';          // idle|aiming|animating|sending|waiting|over
    this.clockEndsAt = null;
    this.pendingCuePlacement = null;
    this.animBalls = null;
    this.pollTimer = null;
    this.destroyed = false;
  }

  // --- lifecycle -----------------------------------------------------------

  async start() {
    if (this.mode === 'pvp') await this.#loadServerMatch();
    else this.#startPractice();

    this.#tick();
    requestAnimationFrame(this.#renderLoop);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    clearInterval(this.clockTimer);
  }

  #startPractice() {
    this.state = newMatch([this.me.id, 'ai']);
    this.myIndex = 0;
    this.hud.setPlayers(
      { name: this.me.name ?? 'You', photo: this.me.photo },
      { name: 'AI' },
    );
    this.hud.toast('Practice frame — not reward-eligible', '', 3200);
    this.#beginTurn();
  }

  async #loadServerMatch() {
    const { match } = await api.getMatch(this.matchId);
    this.#adoptServerMatch(match);
    this.#setPlayerLabels(match.playerNames);
    this.#beginTurn();
  }

  /** Replace local state with the server's. The server is always right. */
  #adoptServerMatch(match) {
    this.serverMatch = match;
    this.myIndex = match.players.findIndex((p) => Number(p) === Number(this.me.id));
    if (this.myIndex === -1) this.myIndex = 0;
    this.state = {
      players: match.players,
      framesWon: match.framesWon,
      frame: match.frame,
      frameHistory: match.frameHistory ?? [],
      highBreaks: match.highBreaks,
      ended: match.ended,
      winner: match.winner,
    };
    this.clockEndsAt = match.shotDeadline ? new Date(match.shotDeadline).getTime() : null;
  }

  /** The HUD keeps seat order (player A left, B right); mark which seat is you. */
  #setPlayerLabels(names = []) {
    const label = (idx) => (idx === this.myIndex
      ? (this.me.name ?? 'You')
      : (names[idx] ?? 'Opponent'));
    this.hud.setPlayers(
      { name: label(0), photo: this.myIndex === 0 ? this.me.photo : null },
      { name: label(1), photo: this.myIndex === 1 ? this.me.photo : null },
    );
  }

  get frame() {
    return this.state.frame;
  }

  get isMyTurn() {
    return this.frame.turn === this.myIndex;
  }

  // --- turn handling -------------------------------------------------------

  #beginTurn() {
    if (this.state.ended) return this.#showMatchOver();
    clearInterval(this.pollTimer);

    const frame = this.frame;
    this.controls.setCue(frame.balls.find((b) => b.id === 'cue'));
    this.hud.setFrame(frame, this.state.framesWon);

    if (this.isMyTurn) {
      this.phase = 'aiming';
      this.controls.setEnabled(true);
      this.controls.setPlacing(frame.inHand);
      this.pendingCuePlacement = null;
      if (this.mode === 'practice') this.clockEndsAt = Date.now() + SHOT_CLOCK_MS;
      this.hud.hint(frame.inHand ? 'Tap inside the D to place the cue ball' : 'Drag to aim · slide the bar for power');
    } else {
      this.phase = 'waiting';
      this.controls.setEnabled(false);
      this.controls.setPlacing(false);
      if (this.mode === 'practice') {
        this.clockEndsAt = null;
        this.hud.hint('AI is thinking…');
        this.#playAiTurn();
      } else {
        this.hud.hint('Waiting for your opponent — you can close the app, the bot will ping you.');
        this.pollTimer = setInterval(() => this.#poll(), POLL_MS);
      }
    }
    return undefined;
  }

  async #playAiTurn() {
    await sleep(AI_THINK_MS);
    if (this.destroyed || this.isMyTurn || this.state.ended) return;
    const shot = chooseShot(this.frame, { difficulty: 'normal' });
    await this.#animate(shot);
    const { state, outcome } = resolveShot(this.frame, shot);
    this.#applyLocalResult(state, outcome, false);
  }

  // --- shooting ------------------------------------------------------------

  placeCue(point) {
    this.pendingCuePlacement = point;
    const cue = this.frame.balls.find((b) => b.id === 'cue');
    cue.x = point.x;
    cue.y = point.y;
    this.controls.setCue(cue);
  }

  async takeShot(aim) {
    if (this.phase !== 'aiming' || !this.isMyTurn) return;
    if (this.frame.inHand && !this.pendingCuePlacement) {
      this.hud.toast('Place the cue ball in the D first', 'foul');
      return;
    }
    const shot = { angle: aim.angle, power: aim.power };
    if (this.pendingCuePlacement) shot.cuePlacement = this.pendingCuePlacement;

    this.phase = 'animating';
    this.controls.setEnabled(false);
    this.clockEndsAt = null;
    this.hud.hint('');

    await this.#animate(shot);

    if (this.mode === 'practice') {
      const { state, outcome } = resolveShot(this.frame, shot);
      this.#applyLocalResult(state, outcome, true);
    } else {
      await this.#submitShot(shot);
    }
  }

  /**
   * Play the shot out on screen. Uses the same fixed-step simulation the server
   * runs, just drained a display frame at a time.
   */
  #animate(shot) {
    return new Promise((resolve) => {
      const sim = createSimulation(this.frame.balls, shot);
      let potted = 0;
      const tick = () => {
        if (this.destroyed) return resolve();
        for (let i = 0; i < STEPS_PER_FRAME && !sim.done; i += 1) sim.step();
        this.animBalls = sim.balls();
        const pots = sim.events.filter((e) => e.type === 'pot').length;
        if (pots > potted) {
          potted = pots;
          haptic('medium');
        }
        if (sim.done) {
          this.animBalls = null;
          return resolve(sim.result());
        }
        return requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  #applyLocalResult(frameState, outcome, wasMine) {
    this.state = advanceMatch(this.state, frameState);
    const msg = describeOutcome(outcome, wasMine);
    this.hud.toast(msg.text, msg.kind);
    haptic(outcome.foul ? 'error' : (outcome.pointsScored > 0 ? 'success' : 'light'));

    if (this.state.ended) return this.#showMatchOver();
    if (frameState.ended) this.hud.toast(`Frame to ${frameState.winner === this.myIndex ? 'you' : 'them'}`, '', 3000);
    return this.#beginTurn();
  }

  // --- PvP submission ------------------------------------------------------

  async #submitShot(shot) {
    this.phase = 'sending';
    const resultId = newResultId();

    // Persist before sending: if the app dies here, the shot still reaches the
    // server on the next launch, and the resultId stops it counting twice.
    await enqueue({ resultId, kind: 'shot', matchId: this.matchId, payload: { shot } });

    try {
      const res = await api.sendShot(this.matchId, resultId, shot);
      await flush(); // the entry we just queued is now settled server-side
      this.#applyServerResult(res);
    } catch (err) {
      if (err.offline) {
        this.hud.toast('Offline — your shot is queued and will be sent automatically', '', 4000);
        this.hud.hint('Queued. Reconnect to see the result.');
        this.phase = 'waiting';
        this.controls.setEnabled(false);
        this.pollTimer = setInterval(() => this.#poll(), POLL_MS);
      } else {
        this.hud.toast(err.message, 'foul', 4000);
        await this.#refresh();
      }
    }
  }

  #applyServerResult(res) {
    const { outcome, match } = res;
    this.#adoptServerMatch(match);

    if (outcome) {
      const msg = describeOutcome(outcome, true);
      this.hud.toast(msg.text, msg.kind);
      haptic(outcome.foul ? 'error' : (outcome.pointsScored > 0 ? 'success' : 'light'));
    }
    if (match.ended) return this.#showMatchOver();
    return this.#beginTurn();
  }

  async #poll() {
    if (this.destroyed) return;
    try {
      const { match } = await api.getMatch(this.matchId);
      const wasMyTurn = this.isMyTurn;
      this.#adoptServerMatch(match);
      this.hud.setFrame(this.frame, this.state.framesWon);
      if (match.ended) {
        clearInterval(this.pollTimer);
        this.#showMatchOver();
      } else if (this.isMyTurn && !wasMyTurn) {
        clearInterval(this.pollTimer);
        haptic('success');
        this.hud.toast('Your shot', 'good');
        this.#beginTurn();
      }
    } catch {
      // Offline: keep polling quietly, the badge already shows the queue.
    }
  }

  async #refresh() {
    try {
      const { match } = await api.getMatch(this.matchId);
      this.#adoptServerMatch(match);
      this.#beginTurn();
    } catch {
      this.hud.toast('Could not reach the server', 'foul');
    }
  }

  // --- clock ---------------------------------------------------------------

  #tick() {
    this.clockTimer = setInterval(() => {
      if (this.destroyed) return;
      // No clock while the balls are rolling or while it is not your turn.
      if (!this.clockEndsAt || this.phase === 'animating') {
        this.hud.setClock(null);
        return;
      }
      const left = (this.clockEndsAt - Date.now()) / 1000;
      this.hud.setClock(left);
      if (left <= 0) {
        this.clockEndsAt = null;
        this.#onClockExpired();
      }
    }, 200);
  }

  #onClockExpired() {
    if (this.mode === 'practice') {
      if (!this.isMyTurn) return;
      const { state, outcome } = resolveTimeout(this.frame);
      this.hud.toast('Shot clock — 4 to your opponent', 'foul');
      this.#applyLocalResult(state, outcome, true);
    } else {
      // The backend sweeper is authoritative here; just resync.
      this.controls.setEnabled(false);
      this.hud.toast('Shot clock ran out', 'foul');
      this.#refresh();
    }
  }

  // --- end of match --------------------------------------------------------

  #showMatchOver() {
    this.phase = 'over';
    this.controls.setEnabled(false);
    clearInterval(this.pollTimer);
    this.hud.setClock(null);

    const won = this.state.winner === this.myIndex;
    const best = Math.min(MAX_BREAK, matchHighBreak(this.state));
    const myBest = Math.min(MAX_BREAK, this.state.highBreaks[this.myIndex]);

    const rows = [
      `<div class="row"><span>Frames</span><b>${this.state.framesWon[0]}–${this.state.framesWon[1]}</b></div>`,
      `<div class="row"><span>Your highest break</span><b>${myBest}</b></div>`,
      `<div class="row"><span>Match highest break</span><b>${best}</b></div>`,
    ];

    const note = this.mode === 'pvp'
      ? `<p class="note">Only the single highest break of a PvP match counts toward rewards,
         and only up to the ${MAX_BREAK} maximum. Your share of the period's pool depends on
         how many eligible points everyone earns before it closes.</p>`
      : '<p class="note">Practice frames are never reward-eligible. Play a PvP match to put a break on the board.</p>';

    if (this.mode === 'practice') {
      // Analytics only — the server records it as explicitly non-eligible.
      enqueue({
        kind: 'practice-stat',
        payload: {
          framesWon: this.state.framesWon,
          highBreak: myBest,
          endedAt: Date.now(),
        },
      }).then(() => flush()).catch(() => {});
    }

    this.hud.modal({
      title: won ? '🏆 You won the match' : 'Match over',
      body: rows.join('') + note,
      actions: [
        {
          label: this.mode === 'practice' ? 'Play again' : 'Back to the bot',
          kind: 'primary',
          onClick: () => {
            if (this.mode === 'practice') {
              this.hud.closeModal();
              this.#startPractice();
            } else {
              window.Telegram?.WebApp?.close?.();
            }
          },
        },
      ],
    });
  }

  // --- rendering -----------------------------------------------------------

  #renderLoop = () => {
    if (this.destroyed) return;
    if (this.state) {
      const balls = this.animBalls ?? this.frame.balls;
      this.renderer.draw({
        balls,
        ballOn: this.frame.ballOn,
        highlightOn: this.phase === 'aiming',
        aim: this.phase === 'aiming' && !this.frame.inHand ? this.controls.aim : null,
        showD: this.phase === 'aiming' && this.frame.inHand,
      });
    }
    requestAnimationFrame(this.#renderLoop);
  };
}
