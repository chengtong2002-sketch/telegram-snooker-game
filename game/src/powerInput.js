/**
 * Desktop power controls: the mouse wheel and W / S nudge the same power value
 * the left meter sets. Input layer only — what a power value does to the cue
 * ball is the sim's business and is untouched here.
 *
 * Kept free of the DOM (targets, clock and frame scheduler are injected) so
 * the step, clamp, wheel and gating rules can be tested in Node.
 */

/** The meter's own range: it never goes below 2%, and SHOOT's check uses the same floor. */
export const POWER_MIN = 0.02;
export const POWER_MAX = 1;
/** One wheel notch or one W / S press. */
export const STEP = 0.02;
/** With Shift held. */
export const FINE_STEP = 0.01;

/**
 * Wheel normalisation. A mouse notch arrives as ~100px in Chrome and Safari and
 * as 3 lines in Firefox's line mode; a trackpad sends a stream of small pixel
 * deltas. Scaling so 100px is one notch keeps both at ~2% per notch, and
 * capping a single event at one notch stops a fast fling from jumping.
 */
export const WHEEL_NOTCH_PX = 100;
const LINE_PX = WHEEL_NOTCH_PX / 3;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Holding W / S: one step at once, then after a pause a steady stream. */
export const REPEAT_DELAY_MS = 250;
export const REPEAT_INTERVAL_MS = 50;

/** Clamp to the meter's range, dropping float dust so 30% + 2% is exactly 32%. */
export const clampPower = (p) => Math.min(POWER_MAX, Math.max(POWER_MIN, Math.round(p * 1e4) / 1e4));

/** One press: direction +1 (more) or -1 (less). */
export const stepPower = (power, direction, { fine = false } = {}) => clampPower(power + direction * (fine ? FINE_STEP : STEP));

/**
 * One wheel event. Up (negative deltaY) is more power. Shift+wheel is sent as
 * horizontal scroll by some browsers, so deltaX stands in when deltaY is 0.
 */
export function wheelPower(power, { deltaY = 0, deltaX = 0, deltaMode = 0, shiftKey = false }, pageHeightPx = 800) {
  const raw = deltaY || (shiftKey ? deltaX : 0);
  if (!raw) return clampPower(power);
  const scale = deltaMode === DOM_DELTA_LINE ? LINE_PX : deltaMode === DOM_DELTA_PAGE ? pageHeightPx : 1;
  const px = Math.max(-WHEEL_NOTCH_PX, Math.min(WHEEL_NOTCH_PX, raw * scale));
  return clampPower(power - (px / WHEEL_NOTCH_PX) * (shiftKey ? FINE_STEP : STEP));
}

/**
 * A mouse or trackpad: the only devices that send wheel events and usually
 * have a keyboard. Phones and tablets answer no, so their text stays as it was.
 */
export const hasDesktopPowerInput = (win = globalThis.window) => Boolean(win?.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches);

/** The aiming hint, naming the power control this device actually has. */
export const aimHint = (desktop) => `Tap to aim · drag to fine-tune · ${desktop ? 'scroll or W / S' : 'slide the bar'} for power`;

/** Where typing belongs to a field, not to the game. */
export const isTypingTarget = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? '')));

/**
 * Whether wheel / keys may change power right now: the player's own turn,
 * aiming (controls enabled — false while balls move), and nothing on top of
 * the table.
 */
export function powerInputAllowed({ controlsEnabled, lobbyOpen, overlayOpen, otherScreen, typing }) {
  return Boolean(controlsEnabled) && !lobbyOpen && !overlayOpen && !otherScreen && !typing;
}

const KEY_DIRECTION = { w: 1, s: -1 };

/**
 * Wires the wheel and W / S to a power value.
 *
 * @param {object} o
 * @param {EventTarget} o.wheelTarget   the game area (wheel is only taken over it)
 * @param {EventTarget} o.keyTarget     usually window
 * @param {() => number} o.getPower
 * @param {(p: number) => void} o.setPower
 * @param {() => boolean} o.isAllowed   see powerInputAllowed
 * @param {() => number} [o.now]
 * @param {(fn: Function) => any} [o.requestFrame]
 * @param {(id: any) => void} [o.cancelFrame]
 * @param {() => number} [o.pageHeight]
 */
export class DesktopPowerInput {
  constructor({
    wheelTarget, keyTarget, getPower, setPower, isAllowed,
    now = () => performance.now(),
    requestFrame = (fn) => requestAnimationFrame(fn),
    cancelFrame = (id) => cancelAnimationFrame(id),
    pageHeight = () => window.innerHeight,
  }) {
    Object.assign(this, { wheelTarget, keyTarget, getPower, setPower, isAllowed, now, requestFrame, cancelFrame, pageHeight });
    this.held = null; // { key, direction, fine, nextAt }
    this.frame = null;

    // passive: false, or preventDefault is ignored and the page scrolls.
    wheelTarget.addEventListener('wheel', this.onWheel, { passive: false });
    keyTarget.addEventListener('keydown', this.onKeyDown);
    keyTarget.addEventListener('keyup', this.onKeyUp);
    keyTarget.addEventListener('blur', this.release);
  }

  destroy() {
    this.release();
    this.wheelTarget.removeEventListener('wheel', this.onWheel, { passive: false });
    this.keyTarget.removeEventListener('keydown', this.onKeyDown);
    this.keyTarget.removeEventListener('keyup', this.onKeyUp);
    this.keyTarget.removeEventListener('blur', this.release);
  }

  #apply(next) {
    if (next !== this.getPower()) this.setPower(next);
  }

  onWheel = (e) => {
    // Ctrl+wheel (and a trackpad pinch, which arrives as one) is browser zoom.
    if (e.ctrlKey || e.metaKey) return;
    // Not ours to take: the lobby and sheets scroll with the wheel.
    if (!this.isAllowed()) return;
    e.preventDefault();
    this.#apply(wheelPower(this.getPower(), e, this.pageHeight()));
  };

  onKeyDown = (e) => {
    // Shift pressed mid-hold: carry on at the fine step.
    if (e.key === 'Shift' && this.held) {
      this.held.fine = true;
      return;
    }
    const direction = KEY_DIRECTION[e.key?.toLowerCase()];
    if (!direction) return;
    // Ctrl+S is save, Cmd+W closes the tab: leave every chord alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!this.isAllowed()) return;
    e.preventDefault();
    // The OS's own auto-repeat starts late and runs fast; the frame loop
    // below does the repeating, so its repeats are ignored.
    if (e.repeat && this.held) return;
    this.held = { key: e.key.toLowerCase(), direction, fine: e.shiftKey, nextAt: this.now() + REPEAT_DELAY_MS };
    this.#apply(stepPower(this.getPower(), direction, { fine: e.shiftKey }));
    this.#schedule();
  };

  onKeyUp = (e) => {
    if (this.held && e.key?.toLowerCase() === this.held.key) this.release();
    // Shift let go mid-hold: carry on at the normal step.
    else if (this.held && e.key === 'Shift') this.held.fine = false;
  };

  release = () => {
    this.held = null;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  };

  #schedule() {
    if (this.frame === null) this.frame = this.requestFrame(this.tick);
  }

  /** One frame of a held key: as many steps as are due, then on to the next frame. */
  tick = () => {
    this.frame = null;
    const h = this.held;
    if (!h) return;
    // The turn ended, a menu opened or a field took focus mid-hold.
    if (!this.isAllowed()) return this.release();
    const t = this.now();
    let power = this.getPower();
    while (t >= h.nextAt) {
      power = stepPower(power, h.direction, { fine: h.fine });
      h.nextAt += REPEAT_INTERVAL_MS;
    }
    this.#apply(power);
    return this.#schedule();
  };
}
