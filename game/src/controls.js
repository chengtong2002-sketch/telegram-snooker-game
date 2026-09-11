import { BAULK_LINE_X, D_RADIUS, CENTRE_Y, BALL_RADIUS, TABLE } from '@snooker/sim';
import { haptic } from './telegram.js';

const inTheD = (x, y) => x <= BAULK_LINE_X && Math.hypot(x - BAULK_LINE_X, y - CENTRE_Y) <= D_RADIUS;

/**
 * Touch controls: drag on the table to aim, drag the left meter for power,
 * tap SHOOT to play. Aim and power are deliberately separate gestures — a
 * single drag-back gesture is unusable one-handed in landscape on a phone.
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
    this.aiming = false;
    this.poweringId = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.hud.setShootEnabled(enabled && this.power > 0.02);
  }

  setCue(cue) {
    this.cue = cue;
  }

  /** Cue ball in hand: the next tap inside the D places it. */
  setPlacing(placing) {
    this.placing = placing;
    if (placing) this.hud.hint('Tap inside the D to place the cue ball');
  }

  #aimAt(clientX, clientY) {
    if (!this.cue) return;
    const p = this.renderer.toWorld(clientX, clientY);
    const dx = p.x - this.cue.x;
    const dy = p.y - this.cue.y;
    if (Math.hypot(dx, dy) < BALL_RADIUS * 0.6) return; // too close to be meaningful
    this.angle = Math.atan2(dy, dx);
  }

  #onTableDown = (e) => {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);

    if (this.placing) {
      const p = this.renderer.toWorld(e.clientX, e.clientY);
      const x = Math.min(TABLE.width - BALL_RADIUS, Math.max(BALL_RADIUS, p.x));
      const y = Math.min(TABLE.height - BALL_RADIUS, Math.max(BALL_RADIUS, p.y));
      if (!inTheD(x, y)) {
        this.hud.toast('The cue ball must be placed inside the D', 'foul', 1800);
        return;
      }
      haptic('light');
      this.placing = false;
      this.hud.hint('');
      this.onPlaceCue({ x, y });
      return;
    }

    this.aiming = true;
    this.#aimAt(e.clientX, e.clientY);
  };

  #onTableMove = (e) => {
    if (!this.aiming || !this.enabled) return;
    this.#aimAt(e.clientX, e.clientY);
  };

  #onTableUp = (e) => {
    this.aiming = false;
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
