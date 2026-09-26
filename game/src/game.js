import {
  newMatch, resolveShot, resolveTimeout, advanceMatch, createSimulation,
  chooseShot, matchHighBreak, frameUnrecoverable, cuePlacementProblem, PHYSICS, SHOT_CLOCK_MS, MAX_BREAK, MAX_SHOT_SPEED,
  localDeadline,
} from '@snooker/sim';
import { describeOutcome } from './hud.js';
import { haptic } from './telegram.js';
import * as api from './api.js';
import { enqueue, flush, newResultId } from './offline.js';
import { recordPracticeResult } from './settings.js';
import { aimHint, hasDesktopPowerInput } from './powerInput.js';
import { ImpactTracker } from './sound.js';
import { skinIdsForTurn } from './skins.js';
import { AimSender, RemoteAim, followAim } from './aimSync.js';
import { runAiAim } from './aiAim.js';

/**
 * Live state the browser drivers read. Not used by the game itself.
 *
 * `shotsResolved` matters because a legal shot that pots nothing leaves the
 * score, the ball on and the ball count all unchanged — indistinguishable from
 * a shot that never happened if you only watch the HUD.
 */
const DEBUG = (window.__snookerDebug ??= { shotsResolved: 0 });

const POLL_MS = 4000;
const STEPS_PER_FRAME = Math.round((1000 / 60) / PHYSICS.dt); // 5 at dt = 1/300s

/**
 * Drives one session of play.
 *
 * Practice resolves everything locally — it is never worth anything, so there
 * is no reason to bother the server. PvP sends the shot to the backend the
 * moment it is taken and animates it locally while the request travels; the
 * server's resolution replaces whatever the client came up with.
 */
export class Game {
  constructor({
    mode, matchId, me, hud, renderer, controls, sound = null, skins = null, mySkins = () => ({}),
    onExit = null,
  }) {
    this.mode = mode;             // 'practice' | 'pvp'
    this.matchId = matchId;
    this.me = me;
    this.hud = hud;
    this.renderer = renderer;
    this.controls = controls;
    this.sound = sound;
    this.skins = skins;           // createSkinSwitcher(renderer), or null
    this.mySkins = mySkins;       // the player's own equipped ids
    this.onExit = onExit;         // back to the lobby

    this.myIndex = 0;
    this.state = null;            // sim match state
    this.serverMatch = null;      // last authoritative payload
    this.phase = 'idle';          // idle|aiming|animating|sending|waiting|expired|checkpoint|over
    this.clockEndsAt = null;
    this.pendingCuePlacement = null;
    this.animBalls = null;
    this.pollTimer = null;
    this.destroyed = false;
    this.checkpointAcked = null;  // frame number the leading player already dismissed

    // Someone else's cue, drawn while it is not your shot (display only, never the sim):
    // the PvP opponent's live aim, or the practice AI lining up.
    this.remoteAim = new RemoteAim();
    this.aimSender = null;        // PvP: this player's aim, out to the opponent
    this.aimFeed = null;          // PvP: the opponent's aim, in
    this.aiPose = null;           // practice: the AI's cue while it lines up
    this.shownPower = null;       // what the power meter shows, when it is not ours

    // PvP turns it on once the match is loaded, if the server allows spin in it.
    controls.setSpinAvailable(mode === 'practice');
    hud.setConcede(false);
    hud.onConcede(() => this.confirmConcede('unrecoverable'));
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
    this.aimFeed?.close();
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
    this.controls.setSpinAvailable(this.spinAllowed);
    this.#setPlayerLabels(match.playerNames);
    // Both cue balls decoded now, so the first swap at a turn change is instant.
    this.skins?.preload(match.skins);
    if (!match.ended) this.#startAimSync();
    this.#beginTurn();
  }

  #startAimSync() {
    this.aimSender = new AimSender((aim) => api.sendAim(this.matchId, aim));
    this.aimFeed = followAim(
      (signal) => api.openAimStream(this.matchId, signal),
      (aim) => this.#onRemoteAim(aim),
      {
        // The opponent's shot just landed on the server: fetch it now, not at the next poll.
        onMoved: () => { if (this.phase === 'waiting') this.#poll(); },
        onStateChange: (st) => { DEBUG.aimStream = st; },
      },
    );
  }

  #onRemoteAim(aim) {
    DEBUG.aimReceived = (DEBUG.aimReceived ?? 0) + 1;
    // Only the player on the table now, and only while this one is watching.
    if (this.phase !== 'waiting' || aim.seat === this.myIndex || aim.seat !== this.frame.turn) return;
    this.remoteAim.push(aim, performance.now());
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
      concededBy: match.concededBy ?? null,
      forfeit: match.forfeit ?? null,
      abandoned: match.abandoned ?? null,
      checkpoint: match.checkpoint ?? null,
    };
    // Server time at the moment this response arrived: deadlines are converted
    // with it, so a phone whose clock is off still counts down what the server enforces.
    this.serverClock = { serverNow: match.serverNow, receivedAt: Date.now() };
    this.clockEndsAt = this.#toLocalTime(match.shotDeadline);
  }

  /** A server timestamp on this device's clock (see localDeadline in shared/sim). */
  #toLocalTime(serverTimestamp) {
    return localDeadline(serverTimestamp, this.serverClock?.serverNow, this.serverClock?.receivedAt);
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

  /** Practice always; PvP only when the server allowed spin in this match. */
  get spinAllowed() {
    return this.mode === 'practice' || this.serverMatch?.spinAllowed === true;
  }

  // --- turn handling -------------------------------------------------------

  #beginTurn() {
    if (this.state.ended) return this.#showMatchOver();
    clearInterval(this.pollTimer);

    if (this.mode === 'pvp' && this.state.checkpoint) return this.#showCheckpoint();

    // Whoever aims now starts from nothing: no leftover cue from the last turn.
    this.remoteAim.reset();
    this.aiPose = null;
    this.aimSender?.reset();

    const frame = this.frame;
    // Every ball is at rest here, so this is the one place the cue ball may
    // change skin: the shooter's, never mid-shot (docs/store-plan.md, decision 4).
    this.skins?.show(skinIdsForTurn({
      mode: this.mode, seatSkins: this.serverMatch?.skins, turn: frame.turn, mine: this.mySkins(),
    }));
    this.controls.setCue(frame.balls.find((b) => b.id === 'cue'));
    this.hud.setFrame(frame, this.state.framesWon);
    this.#updateConcedeButton();

    // The server's clock has run out but its sweeper has not passed the turn yet:
    // do not hand the player a turn they can no longer take.
    if (this.isMyTurn && this.mode === 'pvp' && this.clockEndsAt !== null && this.clockEndsAt <= Date.now()) {
      return this.#awaitTurnExpiry();
    }

    if (this.isMyTurn) {
      this.#showPower(null); // the meter is yours again
      this.phase = 'aiming';
      this.controls.resetSpin();
      this.controls.setEnabled(true);
      this.controls.setPlacing(frame.inHand);
      this.pendingCuePlacement = null;
      if (this.mode === 'practice') this.clockEndsAt = Date.now() + SHOT_CLOCK_MS;
      this.hud.hint(frame.inHand ? 'Tap inside the D to place the cue ball' : aimHint(hasDesktopPowerInput()));
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
    // Decided first, then only acted out: runAiAim hands back this same object.
    const shot = chooseShot(this.frame, { difficulty: 'normal' });
    const gone = () => this.destroyed || this.isMyTurn || this.state.ended;
    await runAiAim({
      shot,
      fromAngle: this.lastAiAngle ?? this.controls.angle,
      fromPower: 0.02,
      onPose: (pose) => { this.aiPose = pose; },
      cancelled: gone,
    });
    this.aiPose = null;
    if (gone()) return;
    this.lastAiAngle = shot.angle;
    DEBUG.aiShots = [...(DEBUG.aiShots ?? []).slice(-9), { angle: shot.angle, power: shot.power }];
    await this.#animate(shot);
    const { state, outcome } = resolveShot(this.frame, shot);
    this.#applyLocalResult(state, outcome, false);
  }

  // --- shooting ------------------------------------------------------------

  /** @returns {boolean} false when the spot is illegal (the server would reject the shot). */
  placeCue(point) {
    if (cuePlacementProblem(this.frame, point)) return false;
    this.pendingCuePlacement = point;
    const cue = this.frame.balls.find((b) => b.id === 'cue');
    cue.x = point.x;
    cue.y = point.y;
    this.controls.setCue(cue);
    return true;
  }

  async takeShot(aim) {
    if (this.phase !== 'aiming' || !this.isMyTurn) return;
    if (this.frame.inHand && !this.pendingCuePlacement) {
      this.hud.toast('Place the cue ball in the D first', 'foul');
      return;
    }
    const shot = { angle: aim.angle, power: aim.power };
    if (this.pendingCuePlacement) shot.cuePlacement = this.pendingCuePlacement;
    // Controls offers spin only where it is allowed; this is the belt to that braces
    // (the server would drop spin in a match without it, and play a different shot).
    if (this.spinAllowed && aim.spin) shot.spin = aim.spin;
    DEBUG.lastShot = shot;

    this.phase = 'animating';
    this.controls.setEnabled(false);
    this.clockEndsAt = null;
    this.hud.hint('');

    if (this.mode === 'practice') {
      await this.#animate(shot);
      const { state, outcome } = resolveShot(this.frame, shot);
      this.#applyLocalResult(state, outcome, true);
      return;
    }

    // PvP: send the shot the moment it is taken, then animate while it travels.
    // The server times the shot on arrival, so animating first (seconds, for a
    // long shot) could land a shot taken with time left after the deadline.
    const sending = this.#sendShot(shot);
    await this.#animate(shot);
    this.phase = 'sending';
    this.#finishShot(await sending);
  }

  /**
   * Play the shot out on screen. Uses the same fixed-step simulation the server
   * runs, just drained a display frame at a time.
   */
  #animate(shot) {
    return new Promise((resolve) => {
      const sim = createSimulation(this.frame.balls, shot);
      // Sound listens to the animation and never touches the sim: it reads the
      // events and ball positions after each step (see ImpactTracker).
      const impacts = this.sound ? new ImpactTracker({ dtMs: PHYSICS.dt, sound: this.sound }) : null;
      impacts?.start(sim.balls());
      this.sound?.strike(Math.min(1, Math.max(0, shot.power)) * MAX_SHOT_SPEED);
      let potted = 0;
      const tick = () => {
        if (this.destroyed) return resolve();
        for (let i = 0; i < STEPS_PER_FRAME && !sim.done; i += 1) {
          sim.step();
          impacts?.afterStep(sim.balls(), sim.events);
        }
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
    DEBUG.shotsResolved = (DEBUG.shotsResolved ?? 0) + 1;
    this.state = advanceMatch(this.state, frameState);
    const msg = describeOutcome(outcome, wasMine);
    this.hud.toast(msg.text, msg.kind);
    haptic(outcome.foul ? 'error' : (outcome.pointsScored > 0 ? 'success' : 'light'));

    if (this.state.ended) return this.#showMatchOver();
    if (frameState.ended) this.hud.toast(`Frame to ${frameState.winner === this.myIndex ? 'you' : 'them'}`, '', 3000);
    return this.#beginTurn();
  }

  // --- PvP submission ------------------------------------------------------

  /** Queue and send a PvP shot. Resolves to {res} or {err}; never rejects. */
  async #sendShot(shot) {
    const resultId = newResultId();
    try {
      // Persist before sending: if the app dies here, the shot still reaches the
      // server on the next launch, and the resultId stops it counting twice.
      await enqueue({ resultId, kind: 'shot', matchId: this.matchId, payload: { shot } });
      const res = await api.sendShot(this.matchId, resultId, shot);
      await flush(); // the entry we just queued is now settled server-side
      return { res };
    } catch (err) {
      return { err };
    }
  }

  async #finishShot({ res, err }) {
    if (res) {
      this.#applyServerResult(res);
      return;
    }
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
      const wasCheckpoint = this.phase === 'checkpoint';
      this.#adoptServerMatch(match);
      this.hud.setFrame(this.frame, this.state.framesWon);
      this.#updateConcedeButton();
      const cp = match.checkpoint;
      if (match.ended) {
        clearInterval(this.pollTimer);
        this.#showMatchOver();
      } else if (cp && (!wasCheckpoint
        || (cp.trailing === this.myIndex && this.hud.el.overlay.hidden))) {
        // A frame just ended, or the trailing player dismissed the prompt some
        // other way (pause menu): the decision is still theirs to make.
        this.#showCheckpoint();
      } else if (!cp && wasCheckpoint) {
        clearInterval(this.pollTimer);
        this.hud.closeModal();
        this.hud.toast(`Frame ${this.frame.frame}`, 'good');
        this.#beginTurn();
      } else if (!cp && this.phase === 'expired' && !this.isMyTurn) {
        // The server has now passed the turn the clock took.
        this.#beginTurn();
      } else if (!cp && this.isMyTurn && !wasMyTurn) {
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
    } else if (this.phase === 'checkpoint') {
      // Decision window over: the server starts the next frame. Just resync.
      this.#poll();
    } else if (this.isMyTurn && this.phase === 'aiming') {
      this.hud.toast('Shot clock ran out', 'foul');
      this.#awaitTurnExpiry();
    }
  }

  /**
   * The countdown has hit zero. The server passes the turn once the shot-clock
   * grace is over; until then there is nothing to do but wait for it, without
   * re-offering a turn the player can no longer take.
   */
  #awaitTurnExpiry() {
    this.phase = 'expired';
    this.clockEndsAt = null;
    this.controls.setEnabled(false);
    this.controls.setPlacing(false);
    this.hud.hint("Time's up — the turn passes to your opponent.");
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.#poll(), 1500);
  }

  // --- conceding ----------------------------------------------------------

  /**
   * Mid-frame surrender is offered only once the player cannot win the frame
   * by potting: behind by more than every point left on the table.
   */
  #updateConcedeButton() {
    const show = this.mode === 'pvp'
      && !this.state.ended
      && !this.state.checkpoint
      && this.phase !== 'over'
      && frameUnrecoverable(this.frame, this.myIndex);
    this.hud.setConcede(show);
  }

  /** The between-frame decision: trailing player continues or concedes. */
  #showCheckpoint() {
    const cp = this.state.checkpoint;
    this.phase = 'checkpoint';
    this.controls.setEnabled(false);
    this.controls.setPlacing(false);
    this.hud.setConcede(false);
    this.hud.hint(''); // any "waiting for your opponent" from the last frame is stale now
    this.hud.setFrame(this.frame, this.state.framesWon);
    this.clockEndsAt = this.#toLocalTime(cp.deadline);
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.#poll(), POLL_MS);

    const trailing = cp.trailing === this.myIndex;
    const secondsLeft = Math.max(0, Math.round((this.clockEndsAt - Date.now()) / 1000));
    const last = this.state.frameHistory.at(-1);
    const [a, b] = this.state.framesWon;
    const rows = [
      last ? `<div class="row"><span>Frame ${cp.frame}</span><b>${last.scores[0]}–${last.scores[1]}</b></div>` : '',
      `<div class="row"><span>Match</span><b>${a}–${b}</b></div>`,
    ].join('');

    if (!trailing) {
      if (this.checkpointAcked === cp.frame) {
        this.hud.closeModal();
        this.hud.hint('Waiting for your opponent to continue…');
        return;
      }
      this.hud.modal({
        title: `Frame ${cp.frame} complete`,
        body: `<p>Continue to frame ${cp.frame + 1}?</p>${rows}
          <p class="note">Your opponent can continue or concede. Frame ${cp.frame + 1} starts
          when they continue, or automatically in ${secondsLeft} seconds.</p>`,
        actions: [{
          label: 'Continue',
          kind: 'primary',
          onClick: () => {
            this.checkpointAcked = cp.frame;
            api.continueMatch(this.matchId).catch(() => {}); // acknowledgement only
            this.#showCheckpoint();
          },
        }],
      });
      return;
    }

    this.hud.modal({
      title: `Frame ${cp.frame} complete`,
      body: `<p>Continue to frame ${cp.frame + 1}?</p>${rows}
        <p class="note">If you concede, the match ends now at ${a}–${b} and your opponent is
        recorded as the winner. <b>Breaks you've already made still count</b> — conceding doesn't
        cancel them, and if yours is the highest break of this match it stays reward-eligible.</p>
        <p class="note">Frame ${cp.frame + 1} starts automatically in ${secondsLeft} seconds.</p>`,
      actions: [
        { label: 'Continue', kind: 'primary', onClick: () => this.#continueToNextFrame() },
        { label: 'Concede', kind: 'danger', onClick: () => this.confirmConcede('checkpoint') },
      ],
    });
  }

  async #continueToNextFrame() {
    try {
      const { match } = await api.continueMatch(this.matchId);
      this.#adoptServerMatch(match);
      if (match.checkpoint) return this.#showCheckpoint();
      clearInterval(this.pollTimer);
      this.hud.closeModal();
      return this.#beginTurn();
    } catch (err) {
      return this.hud.toast(err.message, 'foul', 4000);
    }
  }

  /**
   * Ask before conceding. Used by the mid-frame button, the checkpoint and the
   * pause menu's Surrender. The server keeps every break already made, so say so.
   *
   * @param {'unrecoverable'|'checkpoint'|'menu'} via
   * @param {{onCancel?: () => void}} [opts]  where Cancel goes (the pause menu, for Surrender)
   */
  confirmConcede(via, { onCancel } = {}) {
    if (this.mode !== 'pvp' || !this.state || this.state.ended) return;
    const back = onCancel
      ?? (() => (this.phase === 'checkpoint' ? this.#showCheckpoint() : this.hud.closeModal()));
    const surrender = via === 'menu';
    const [a, b] = this.state.framesWon;
    this.hud.modal({
      title: surrender ? 'Surrender this match?' : 'Concede this match?',
      body: `<p>${surrender ? 'Your opponent wins.' : 'Your opponent will be recorded as the winner.'}</p>
        <div class="row"><span>Match ends at</span><b>${a}–${b}</b></div>
        <p class="note"><b>Your breaks still count.</b> ${surrender ? 'Surrendering' : 'Conceding'} only decides who wins the match.
        It doesn't cancel any break you've already made — if yours is the highest break of this
        match, it stays reward-eligible.</p>`,
      actions: [
        {
          label: surrender ? 'Surrender' : 'Confirm',
          kind: 'danger',
          onClick: async () => {
            try {
              const { match } = await api.concedeMatch(this.matchId, via);
              this.#adoptServerMatch(match);
              this.#showMatchOver();
            } catch (err) {
              this.hud.toast(err.offline ? 'No connection. You are still in the match.' : err.message, 'foul', 4000);
            }
          },
        },
        { label: 'Cancel', onClick: back },
      ],
    });
  }

  /**
   * The pause menu's Quit. Leaving concedes nothing: in PvP the match carries on
   * on the server under the idle rules, and the lobby offers Rejoin while it
   * lasts. Practice lives on this device only, so quitting it records nothing.
   * A match that is already over just leaves.
   *
   * @param {{onQuit: () => void, onCancel: () => void}} handlers
   */
  confirmQuit({ onQuit, onCancel }) {
    if (!this.state || this.state.ended) {
      onQuit();
      return;
    }
    const pvp = this.mode === 'pvp';
    // The server's rule, sent with the match, so the warning cannot drift from it.
    const misses = this.serverMatch?.idleForfeitTimeouts ?? 3;
    this.hud.modal({
      title: pvp ? 'Are you sure you want to quit?' : 'Quit practice?',
      body: pvp
        ? `<p>The match continues without you — if you don't return, you'll forfeit after
           ${misses} missed turns.</p>
           <p class="note">Rejoin from the lobby any time before then and carry on where you left off.</p>`
        : '<p>This frame is not saved. Practice is never recorded or reward-eligible.</p>',
      actions: [
        { label: 'Quit', onClick: () => onQuit() },
        { label: pvp ? 'Stay in the match' : 'Keep playing', kind: 'primary', onClick: () => onCancel() },
      ],
    });
  }

  // --- end of match --------------------------------------------------------

  #showMatchOver() {
    this.phase = 'over';
    this.aimFeed?.close();
    this.aimFeed = null;
    this.#showPower(null);
    this.controls.setEnabled(false);
    this.hud.setConcede(false);
    clearInterval(this.pollTimer);
    this.hud.setClock(null);
    this.hud.hint('');

    const won = this.state.winner === this.myIndex;
    const best = Math.min(MAX_BREAK, matchHighBreak(this.state));
    const myBest = Math.min(MAX_BREAK, this.state.highBreaks[this.myIndex]);
    const conceded = this.state.concededBy != null;
    const iConceded = this.state.concededBy === this.myIndex;
    let result = '';
    if (this.state.abandoned) result = 'Abandoned — nobody was shooting';
    else if (conceded && this.state.forfeit === 'idle') result = iConceded ? 'You timed out 3 times' : 'Your opponent timed out 3 times';
    else if (conceded) result = iConceded ? 'You conceded' : 'Your opponent conceded';

    const rows = [
      result ? `<div class="row"><span>Result</span><b>${result}</b></div>` : '',
      `<div class="row"><span>Frames</span><b>${this.state.framesWon[0]}–${this.state.framesWon[1]}</b></div>`,
      `<div class="row"><span>Your highest break</span><b>${myBest}</b></div>`,
      `<div class="row"><span>Match highest break</span><b>${best}</b></div>`,
    ];

    const abandonedNote = '<p class="note">The shot clock ran out 4 times in a row, so the match was called off. Nothing from it counts toward rewards.</p>';
    const note = this.state.abandoned ? abandonedNote : this.mode === 'pvp'
      ? `<p class="note">Only the single highest break of a PvP match counts toward rewards,
         and only up to the ${MAX_BREAK} maximum. Your share of the period's pool depends on
         how many eligible points everyone earns before it closes.</p>`
      : '<p class="note">Practice frames are never reward-eligible. Play a PvP match to put a break on the board.</p>';

    if (this.mode === 'practice') {
      // Device-only, and deliberately not through the offline queue: that queue
      // is the match-result channel, and practice must never travel on it.
      // Practice also has to finish with no connection at all, which a queue
      // flush cannot promise.
      recordPracticeResult({ framesWon: this.state.framesWon, highBreak: myBest });
    }

    this.hud.modal({
      title: won ? '🏆 You won the match' : (this.state.abandoned ? 'Match abandoned' : 'Match over'),
      body: rows.join('') + note,
      actions: this.mode === 'practice'
        ? [{
          label: 'Play again',
          kind: 'primary',
          onClick: () => { this.hud.closeModal(); this.#startPractice(); },
        }]
        : [
          // Both players land here when a match ends, including the one whose
          // opponent just quit: the lobby is one tap away, the bot one more.
          ...(this.onExit ? [{ label: 'Back to lobby', kind: 'primary', onClick: () => this.onExit() }] : []),
          {
            label: 'Back to the bot',
            kind: this.onExit ? '' : 'primary',
            onClick: () => window.Telegram?.WebApp?.close?.(),
          },
        ],
    });
  }

  // --- rendering -----------------------------------------------------------

  /** PvP, this player aiming: out to the opponent, throttled (AimSender decides what goes). */
  #sendAim() {
    if (this.mode !== 'pvp' || !this.aimSender || !this.controls.cue) return;
    const { angle, power } = this.controls.aim;
    const cue = this.frame.inHand ? { x: this.controls.cue.x, y: this.controls.cue.y } : undefined;
    if (this.aimSender.update({ angle, power, cue }, performance.now())) DEBUG.aimSent = this.aimSender.sent;
  }

  /** The meter shows the other player's power while they aim; null gives it back to yours. */
  #showPower(power) {
    if (power == null) {
      // The controls drive the meter from here on, so forget what was last shown.
      this.shownPower = null;
      this.hud.setPower(this.controls.power);
      return;
    }
    const pct = Math.round(power * 100);
    if (pct === this.shownPower) return;
    this.shownPower = pct;
    this.hud.setPower(power);
  }

  #renderLoop = () => {
    if (this.destroyed) return;
    if (this.state) {
      let balls = this.animBalls ?? this.frame.balls;
      let aim = null;
      DEBUG.otherAim = null;
      if (this.phase === 'aiming') {
        aim = this.controls.aim;
        this.#sendAim();
      } else if (this.phase === 'waiting' && !this.animBalls) {
        const pose = this.mode === 'pvp' ? this.remoteAim.pose(performance.now()) : this.aiPose;
        if (pose) {
          aim = { angle: pose.angle, power: pose.power, ghost: Boolean(pose.stale) };
          this.#showPower(pose.power);
          // Ball in hand: draw the cue ball where they are holding it.
          if (pose.cue && this.frame.inHand) {
            balls = balls.map((b) => (b.id === 'cue' ? { ...b, x: pose.cue.x, y: pose.cue.y } : b));
          }
        }
        DEBUG.otherAim = pose ? { angle: pose.angle, power: pose.power, stale: Boolean(pose.stale) } : null;
      }
      // Hook for the browser drivers (test/drive-*.mjs): it lets them tell a
      // shot that actually resolved from one that silently did nothing, which
      // the HUD text alone cannot always show.
      DEBUG.ballsOnTable = this.frame.balls.length;
      DEBUG.phase = this.phase;
      DEBUG.mode = this.mode;
      this.renderer.draw({
        balls,
        ballOn: this.frame.ballOn,
        highlightOn: this.phase === 'aiming',
        // Also while the cue ball is in hand: the player needs to see the line
        // while choosing where in the D to put the ball.
        aim,
        showD: this.phase === 'aiming' && this.frame.inHand,
      });
    }
    requestAnimationFrame(this.#renderLoop);
  };
}
