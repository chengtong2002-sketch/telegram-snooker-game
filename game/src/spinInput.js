/**
 * Spin controls: where the cue tip meets the cue ball. Offered in practice, and
 * in a PvP match the server allows it in (match.spinAllowed).
 *
 *   phone    tap the cue-ball button on the left; a large cue ball opens, and
 *            the dot goes wherever the finger is. Reset / Done.
 *   desktop  the same, plus: hold Shift and move the mouse (the large ball
 *            shows while Shift is down), arrow keys 0.1 a press, C for centre.
 *
 * Spin is {x, y} on the ball's face as the player sees it: x right, y up, at
 * most SPIN.maxOffset from the centre. It goes back to the centre every turn
 * (decided Sep 24) — the Game calls reset().
 *
 * The maths is plain functions so it can be tested in Node; SpinControl is the
 * DOM wiring around them.
 */
import { SPIN } from '@snooker/sim';

/** One arrow-key press. */
export const SPIN_STEP = 0.1;
/** Shift + mouse: this many CSS px of travel moves the dot the ball's full radius. */
export const SHIFT_PX_PER_RADIUS = 160;
export const CENTRE = Object.freeze({ x: 0, y: 0 });

// Two decimals is finer than a finger or a key can set, and keeps 0.1 + 0.2 at 0.3.
const tidy = (v) => Math.round(v * 100) / 100 || 0; // `|| 0` turns -0 into 0

/** Pull a spin back inside the circle the tip may reach. Anything unusable is centre. */
export function clampSpin(spin) {
  const x = Number(spin?.x);
  const y = Number(spin?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return CENTRE;
  const len = Math.hypot(x, y);
  const k = len > SPIN.maxOffset ? SPIN.maxOffset / len : 1;
  const out = { x: tidy(x * k), y: tidy(y * k) };
  // Rounding a point on the edge can push it just past it; the sim would then
  // shrink it again, so the shot would not be what the dot shows. Cut towards
  // the centre instead.
  if (Math.hypot(out.x, out.y) > SPIN.maxOffset) {
    const cut = (v) => Math.trunc(v * 100) / 100 || 0;
    return { x: cut(x * k), y: cut(y * k) };
  }
  return out;
}

export const isCentre = (spin) => spin.x === 0 && spin.y === 0;

/**
 * A point on the drawn ball, as an offset from its centre in screen px (y
 * down), to a spin (y up).
 */
export function spinFromOffset(dx, dy, radiusPx) {
  if (!(radiusPx > 0)) return CENTRE;
  return clampSpin({ x: dx / radiusPx, y: -dy / radiusPx });
}

/** Screen-px mouse movement (y down) added to a spin, for Shift + mouse. */
export function nudgeSpin(spin, dxPx, dyPx, pxPerRadius = SHIFT_PX_PER_RADIUS) {
  return clampSpin({ x: spin.x + dxPx / pxPerRadius, y: spin.y - dyPx / pxPerRadius });
}

const ARROWS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

/** An arrow key's step, or null for any other key. */
export function stepSpin(spin, key) {
  const d = ARROWS[key];
  if (!d) return null;
  return clampSpin({ x: spin.x + d[0] * SPIN_STEP, y: spin.y + d[1] * SPIN_STEP });
}

// Below this the spin is too slight to name (it still plays).
const NAMED = 0.05;

/** "Centre", "Top", "Draw", "Left side", "Draw + right"… */
export function spinLabel(spin) {
  const vertical = spin.y > NAMED ? 'Top' : spin.y < -NAMED ? 'Draw' : '';
  const side = spin.x > NAMED ? 'right' : spin.x < -NAMED ? 'left' : '';
  if (vertical && side) return `${vertical} + ${side}`;
  if (vertical) return vertical;
  if (side) return `${side[0].toUpperCase()}${side.slice(1)} side`;
  return isCentre(spin) ? 'Centre' : 'Nearly centre';
}

/** What goes on the shot: nothing at all for centre, so it plays exactly as before spin. */
export const spinForShot = (spin) => (isCentre(spin) ? undefined : { x: spin.x, y: spin.y });

/** Where the dot sits inside a drawn ball, as CSS percentages. */
export const dotPosition = (spin) => ({ left: `${50 + spin.x * 50}%`, top: `${50 - spin.y * 50}%` });

/**
 * The DOM side: the small button, the large picker, keys and Shift + mouse.
 *
 * @param {object} o
 * @param {HTMLElement} o.button     #spin-btn
 * @param {HTMLElement} o.picker     #spin-picker
 * @param {() => boolean} o.isAllowed  the player's own turn, aiming, nothing on top
 * @param {(spin) => void} [o.onChange]
 */
export class SpinControl {
  constructor({ button, picker, isAllowed, onChange = () => {} }) {
    this.button = button;
    this.picker = picker;
    this.isAllowed = isAllowed;
    this.onChange = onChange;
    this.spin = CENTRE;
    this.available = false;
    this.mode = null;        // null (closed) | 'open' (tapped open) | 'peek' (Shift held)
    this.dragId = null;
    this.lastMouse = null;

    this.ball = picker.querySelector('.spin-ball');
    this.label = picker.querySelector('.spin-label');
    this.dots = [button.querySelector('.spin-dot'), this.ball.querySelector('.spin-dot')];

    button.addEventListener('click', () => {
      if (this.available && this.isAllowed()) this.open();
    });
    picker.querySelector('[data-spin="reset"]').addEventListener('click', () => this.set(CENTRE));
    picker.querySelector('[data-spin="done"]').addEventListener('click', () => this.close());
    // A tap on the dimmed table around the sheet closes it, like Done.
    picker.addEventListener('pointerdown', (e) => {
      if (e.target === picker && this.mode === 'open') this.close();
    });

    this.ball.addEventListener('pointerdown', this.#onBallDown);
    this.ball.addEventListener('pointermove', this.#onBallMove);
    this.ball.addEventListener('pointerup', this.#onBallUp);
    this.ball.addEventListener('pointercancel', this.#onBallUp);

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('mousemove', this.#onMouseMove);
    window.addEventListener('blur', () => { if (this.mode === 'peek') this.close(); });

    this.#paint();
  }

  /** Practice only for now: PvP hides the button and ignores the keys. */
  setAvailable(on) {
    this.available = on;
    this.button.hidden = !on;
    if (!on) this.close();
  }

  set(spin) {
    const next = clampSpin(spin);
    if (next.x === this.spin.x && next.y === this.spin.y) return;
    this.spin = next;
    this.#paint();
    this.onChange(next);
  }

  /** Back to the centre, as every turn starts. */
  reset() {
    this.set(CENTRE);
  }

  open(mode = 'open') {
    this.mode = mode;
    this.picker.hidden = false;
    this.picker.classList.toggle('peek', mode === 'peek');
  }

  close() {
    this.mode = null;
    this.dragId = null;
    this.lastMouse = null;
    this.picker.hidden = true;
  }

  #paint() {
    const pos = dotPosition(this.spin);
    for (const dot of this.dots) Object.assign(dot.style, pos);
    const text = spinLabel(this.spin);
    this.label.textContent = text;
    this.button.setAttribute('aria-label', `Spin: ${text}`);
    this.button.classList.toggle('set', !isCentre(this.spin));
  }

  #fromPointer(e) {
    const r = this.ball.getBoundingClientRect();
    this.set(spinFromOffset(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / 2));
  }

  #onBallDown = (e) => {
    if (this.mode !== 'open') return;
    this.dragId = e.pointerId;
    this.ball.setPointerCapture(e.pointerId);
    this.#fromPointer(e);
  };

  #onBallMove = (e) => {
    if (this.dragId === e.pointerId) this.#fromPointer(e);
  };

  #onBallUp = (e) => {
    if (this.dragId !== e.pointerId) return;
    this.dragId = null;
    if (this.ball.hasPointerCapture?.(e.pointerId)) this.ball.releasePointerCapture(e.pointerId);
  };

  #onKeyDown = (e) => {
    if (!this.available) return;
    if (e.key === 'Escape' && this.mode === 'open') {
      this.close();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || !this.isAllowed()) return;
    if (e.key === 'Shift') {
      if (!e.repeat && this.mode === null) {
        this.lastMouse = null; // the first move only sets where the mouse is
        this.open('peek');
      }
      return;
    }
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      this.reset();
      return;
    }
    const next = stepSpin(this.spin, e.key);
    if (next) {
      e.preventDefault(); // arrows would scroll the page
      this.set(next);
    }
  };

  #onKeyUp = (e) => {
    if (e.key === 'Shift' && this.mode === 'peek') this.close();
  };

  #onMouseMove = (e) => {
    if (this.mode !== 'peek') return;
    if (!e.shiftKey || !this.isAllowed()) {
      this.close();
      return;
    }
    if (this.lastMouse) this.set(nudgeSpin(this.spin, e.clientX - this.lastMouse.x, e.clientY - this.lastMouse.y));
    this.lastMouse = { x: e.clientX, y: e.clientY };
  };
}
