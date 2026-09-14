import { BAULK_LINE_X, D_RADIUS, CENTRE_Y, BALL_RADIUS, TABLE } from '@snooker/sim';
import { haptic } from './telegram.js';

const inTheD = (x, y) => x <= BAULK_LINE_X && Math.hypot(x - BAULK_LINE_X, y - CENTRE_Y) <= D_RADIUS;

// Finger travel (CSS px) under which a touch counts as a tap rather than a drag.
const TAP_SLOP_PX = 10;
// Fine-aim gain while dragging: 0.15° per CSS pixel, so a 100px drag turns the
// cue 15°. Pointing straight at the finger was too twitchy on a phone.
const AIM_RAD_PER_PX = (0.15 * Math.PI) / 180;
// Closer than this to the cue ball, the finger's bearing is too unstable to
// define "around the ball", so drags rotate relative to the aim line instead.
const MIN_ORBIT_RADIUS = BALL_RADIUS * 3;

/**
 * Touch controls: tap the table to point the cue there, drag anywhere to
 * fine-tune the aim, drag the left meter for power, tap SHOOT to play.
 *
 * Dragging is relative, not absolute: the cue turns by how far the finger
 * travels around the cue ball, not to where the finger is. That keeps the
 * finger off the aim line and makes small corrections possible.
 *
 * Aim and power are deliberately separate gestures — a single drag-back
 * gesture is unusable one-handed in landscape on a phone.
 */
export class Controls {
  constructor({ canvas, renderer, hud, onShoot, onPlaceCue }) {
    this.renderer = renderer;
    this.hud = hud;
    this.onShoot = onShoot;
    this.onPlaceCue = onPlaceCue;

    this.angle = 0;
    this.power = 0.3;
    this.enabled = false;
    this.placing = false;

    hud.setPower(this.power);

    canvas.addEventListener('pointerdown', this.#onTableDown);
    canvas.addEventListener('pointermove', this.#onTableMove);
    canvas.addEventListener('pointerup', this.#onTableUp);
    canvas.addEventListener('pointercancel', this.#onTableUp);

    const meter = hud.el.power;
    meter.addEventListener('pointerdown', this.#onPowerDown);
    meter.addEventListener('pointermove', this.#onPowerMove);
    meter.addEventListener('pointerup', this.#onPowerUp);
    meter.addEventListener('pointercancel', this.#onPowerUp);

    hud.el.shoot.addEventListener('click', () => {
      if (!this.enabled) return;
      haptic('medium');
      this.onShoot({ angle: this.angle, power: this.power });
    });

    this.canvas = canvas;
    this.meter = meter;
    this.cue = null;
    this.aiming = null;
    this.dragPlacing = false;
    this.placed = false;
    this.poweringId = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.hud.setShootEnabled(enabled && this.power > 0.02);
  }

  setCue(cue) {
    this.cue = cue;
  }

  /**
   * Cue ball in hand, for the whole turn: touches inside the D place (and
   * re-place) the ball, touches elsewhere aim as usual, so the player can line
   * the shot up before committing to a position.
   */
  setPlacing(placing) {
    this.placing = placing;
    this.placed = false;
    if (placing) this.hud.hint('Tap inside the D to place the cue ball');
  }

  #placeAt(clientX, clientY) {
    const p = this.renderer.toWorld(clientX, clientY);
    const x = Math.min(TABLE.width - BALL_RADIUS, Math.max(BALL_RADIUS, p.x));
    const y = Math.min(TABLE.height - BALL_RADIUS, Math.max(BALL_RADIUS, p.y));
    if (!inTheD(x, y)) return false;
    this.onPlaceCue({ x, y });
    return true;
  }

  #aimAt(clientX, clientY) {
    if (!this.cue) return;
    const p = this.renderer.toWorld(clientX, clientY);
    const dx = p.x - this.cue.x;
    const dy = p.y - this.cue.y;
    if (Math.hypot(dx, dy) < BALL_RADIUS * 0.6) return; // too close to be meaningful
    this.angle = Math.atan2(dy, dx);
  }

  /** Rotate the aim by the finger's movement around the cue ball, scaled down. */
  #fineAim(fromX, fromY, toX, toY) {
    if (!this.cue) return;
    const px = Math.hypot(toX - fromX, toY - fromY);
    if (px === 0) return;

    // Work in world space so the rotation sense matches the table however the
    // renderer maps it onto the screen.
    const a = this.renderer.toWorld(fromX, fromY);
    const b = this.renderer.toWorld(toX, toY);
    const mx = b.x - a.x;
    const my = b.y - a.y;
    const len = Math.hypot(mx, my);
    if (len === 0) return;

    let rx = a.x - this.cue.x;
    let ry = a.y - this.cue.y;
    let r = Math.hypot(rx, ry);
    if (r < MIN_ORBIT_RADIUS) {
      rx = Math.cos(this.angle);
      ry = Math.sin(this.angle);
      r = 1;
    }

    // Cross product of the bearing and the movement direction: +1 for pure
    // movement around the ball in the direction of increasing angle, 0 for
    // movement straight towards or away from it.
    const tangential = (rx * my - ry * mx) / (r * len);
    this.angle += tangential * px * AIM_RAD_PER_PX;
  }

  #onTableDown = (e) => {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);

    // In hand and touching the D: place the ball, and let the drag slide it.
    if (this.placing && this.#placeAt(e.clientX, e.clientY)) {
      haptic('light');
      this.dragPlacing = true;
      if (!this.placed) {
        this.placed = true;
        this.hud.hint('Tap to aim · drag to fine-tune · tap the D to move the ball');
      }
      return;
    }

    this.aiming = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false };
  };

  #onTableMove = (e) => {
    if (this.dragPlacing && this.enabled) {
      this.#placeAt(e.clientX, e.clientY); // leaving the D just stops the ball at its last legal spot
      return;
    }
    const g = this.aiming;
    if (!g || !this.enabled) return;
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < TAP_SLOP_PX) return;
      g.dragging = true;
    }
    this.#fineAim(g.lastX, g.lastY, e.clientX, e.clientY);
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  };

  #onTableUp = (e) => {
    const g = this.aiming;
    if (g && !g.dragging && e.type === 'pointerup' && this.enabled) {
      this.#aimAt(g.startX, g.startY);
      haptic('light');
    }
    this.aiming = null;
    this.dragPlacing = false;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  #setPowerFromEvent(e) {
    const rect = this.meter.getBoundingClientRect();
    const ratio = 1 - (e.clientY - rect.top) / rect.height;
    this.power = Math.min(1, Math.max(0.02, ratio));
    this.hud.setPower(this.power);
    this.hud.setShootEnabled(this.enabled);
  }

  #onPowerDown = (e) => {
    if (!this.enabled) return;
    this.poweringId = e.pointerId;
    this.meter.setPointerCapture(e.pointerId);
    this.#setPowerFromEvent(e);
  };

  #onPowerMove = (e) => {
    if (this.poweringId !== e.pointerId) return;
    this.#setPowerFromEvent(e);
  };

  #onPowerUp = (e) => {
    if (this.poweringId === e.pointerId) {
      haptic('light');
      this.poweringId = null;
      if (this.meter.hasPointerCapture?.(e.pointerId)) this.meter.releasePointerCapture(e.pointerId);
    }
  };

  get aim() {
    return { angle: this.angle, power: this.power };
  }
}
