import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POWER_MIN, POWER_MAX, STEP, FINE_STEP, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS,
  clampPower, stepPower, wheelPower, powerInputAllowed, isTypingTarget, DesktopPowerInput,
  aimHint, hasDesktopPowerInput,
} from '../src/powerInput.js';

/* ---------- the aiming hint ---------- */

test('the aiming hint names the power control the device has', () => {
  assert.equal(aimHint(true), 'Tap to aim · drag to fine-tune · scroll or W / S for power');
  assert.equal(aimHint(false), 'Tap to aim · drag to fine-tune · slide the bar for power');
});

test('desktop means a mouse or trackpad; touch devices and no window are not', () => {
  const win = (matches) => ({
    matchMedia: (q) => ({ matches: q === '(hover: hover) and (pointer: fine)' && matches }),
  });
  assert.equal(hasDesktopPowerInput(win(true)), true);
  assert.equal(hasDesktopPowerInput(win(false)), false); // phone: hover none, pointer coarse
  assert.equal(hasDesktopPowerInput({}), false); // no matchMedia at all
  assert.equal(hasDesktopPowerInput(undefined), false); // Node, no window
});

/* ---------- clamping and step size ---------- */

test('power clamps to the meter range, 2%–100%', () => {
  assert.equal(POWER_MIN, 0.02);
  assert.equal(POWER_MAX, 1);
  assert.equal(clampPower(-5), 0.02);
  assert.equal(clampPower(0), 0.02);
  assert.equal(clampPower(1.7), 1);
  assert.equal(clampPower(0.5), 0.5);
});

test('a press is 2%, a fine (Q / E) press is 1%, with no float drift', () => {
  assert.equal(STEP, 0.02);
  assert.equal(FINE_STEP, 0.01);
  assert.equal(stepPower(0.3, 1), 0.32);
  assert.equal(stepPower(0.3, -1), 0.28);
  assert.equal(stepPower(0.3, 1, { fine: true }), 0.31);
  assert.equal(stepPower(0.3, -1, { fine: true }), 0.29);
  // 35 presses from 30% land exactly on 100%, not 99.99999%.
  let p = 0.3;
  for (let i = 0; i < 35; i += 1) p = stepPower(p, 1);
  assert.equal(p, 1);
});

test('steps stop at both ends', () => {
  assert.equal(stepPower(1, 1), 1);
  assert.equal(stepPower(0.99, 1), 1);
  assert.equal(stepPower(0.02, -1), 0.02);
  assert.equal(stepPower(0.03, -1), 0.02);
});

/* ---------- wheel normalisation ---------- */

test('one mouse notch is 2%: up for more, down for less', () => {
  assert.equal(wheelPower(0.3, { deltaY: -100 }), 0.32);
  assert.equal(wheelPower(0.3, { deltaY: 100 }), 0.28);
});

test('a bigger notch (Windows sends 120) still moves only 2%', () => {
  assert.equal(wheelPower(0.3, { deltaY: -120 }), 0.32);
});

test('Firefox line mode (3 lines a notch) is 2% too', () => {
  assert.equal(wheelPower(0.3, { deltaY: -3, deltaMode: 1 }), 0.32);
});

test('page mode is capped at one notch', () => {
  assert.equal(wheelPower(0.3, { deltaY: -1, deltaMode: 2 }, 900), 0.32);
});

test('a trackpad stream adds up smoothly instead of jumping', () => {
  // 25 events of 4px = one notch's worth, spread across the gesture.
  let p = 0.3;
  const seen = [];
  for (let i = 0; i < 25; i += 1) {
    p = wheelPower(p, { deltaY: -4 });
    seen.push(p);
  }
  assert.equal(p, 0.32);
  assert.ok(seen.every((v, i) => i === 0 || v - seen[i - 1] < 0.002), 'moved in a jump');
});

test('a fast fling is capped at one notch per event', () => {
  assert.equal(wheelPower(0.3, { deltaY: -2500 }), 0.32);
});

test('Shift+wheel stays 2% (Shift is spin now), including when sent as horizontal', () => {
  assert.equal(wheelPower(0.3, { deltaY: -100, shiftKey: true }), 0.32);
  assert.equal(wheelPower(0.3, { deltaY: 0, deltaX: -100, shiftKey: true }), 0.32);
  // Horizontal scroll without Shift is not a power gesture.
  assert.equal(wheelPower(0.3, { deltaY: 0, deltaX: -100 }), 0.3);
});

test('the wheel clamps too', () => {
  assert.equal(wheelPower(0.99, { deltaY: -100 }), 1);
  assert.equal(wheelPower(0.03, { deltaY: 100 }), 0.02);
});

/* ---------- gating ---------- */

const OPEN = { controlsEnabled: true, lobbyOpen: false, overlayOpen: false, otherScreen: false, typing: false };

test('power input is allowed only on your turn, aiming, with nothing on top', () => {
  assert.equal(powerInputAllowed(OPEN), true);
  // Not your turn, or the balls are moving: Game disables the controls.
  assert.equal(powerInputAllowed({ ...OPEN, controlsEnabled: false }), false);
  assert.equal(powerInputAllowed({ ...OPEN, lobbyOpen: true }), false);
  assert.equal(powerInputAllowed({ ...OPEN, overlayOpen: true }), false); // pause, How to play, dialogs
  assert.equal(powerInputAllowed({ ...OPEN, otherScreen: true }), false); // wallet screen
  assert.equal(powerInputAllowed({ ...OPEN, typing: true }), false);
});

test('a text field with focus counts as typing', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget(null), false);
});

/* ---------- the wired-up input: wheel, keys, hold-to-repeat ---------- */

class FakeTarget {
  listeners = {};

  addEventListener(type, fn, opts) {
    (this.listeners[type] ??= []).push({ fn, opts });
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn);
  }

  fire(type, props = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (const { fn } of this.listeners[type] ?? []) fn(e);
    return e;
  }
}

function rig({ power = 0.3, allowed = true } = {}) {
  const r = {
    power, allowed, t: 0, frames: [], sets: 0,
    wheel: new FakeTarget(), keys: new FakeTarget(),
  };
  r.input = new DesktopPowerInput({
    wheelTarget: r.wheel,
    keyTarget: r.keys,
    getPower: () => r.power,
    setPower: (p) => { r.power = p; r.sets += 1; },
    isAllowed: () => r.allowed,
    now: () => r.t,
    requestFrame: (fn) => { r.frames.push(fn); return r.frames.length; },
    cancelFrame: () => { r.frames = []; },
    pageHeight: () => 800,
  });
  /** Advance the clock and run whatever frame is waiting. */
  r.at = (t) => {
    r.t = t;
    const due = r.frames;
    r.frames = [];
    for (const fn of due) fn();
  };
  return r;
}

test('the wheel listener is non-passive, so preventDefault works', () => {
  const r = rig();
  assert.equal(r.wheel.listeners.wheel[0].opts.passive, false);
});

test('wheel changes power and stops the page scrolling', () => {
  const r = rig();
  const e = r.wheel.fire('wheel', { deltaY: -100 });
  assert.equal(r.power, 0.32);
  assert.equal(e.defaultPrevented, true);
});

test('wheel outside your aiming turn does nothing and lets the page scroll', () => {
  const r = rig({ allowed: false });
  const e = r.wheel.fire('wheel', { deltaY: -100 });
  assert.equal(r.power, 0.3);
  assert.equal(e.defaultPrevented, false, 'swallowed a scroll the lobby or a sheet needed');
});

test('Ctrl+wheel is left to the browser as zoom', () => {
  const r = rig();
  const e = r.wheel.fire('wheel', { deltaY: -100, ctrlKey: true });
  assert.equal(r.power, 0.3);
  assert.equal(e.defaultPrevented, false);
});

test('W raises and S lowers power by 2%; E and Q by 1%; Shift changes nothing', () => {
  const r = rig();
  r.keys.fire('keydown', { key: 'w' });
  assert.equal(r.power, 0.32);
  r.keys.fire('keyup', { key: 'w' });
  r.keys.fire('keydown', { key: 's' });
  r.keys.fire('keyup', { key: 's' });
  r.keys.fire('keydown', { key: 's' });
  r.keys.fire('keyup', { key: 's' });
  assert.equal(r.power, 0.28);
  r.keys.fire('keydown', { key: 'W', shiftKey: true }); // Shift turns the key upper-case
  r.keys.fire('keyup', { key: 'W' });
  assert.equal(r.power, 0.3);
  r.keys.fire('keydown', { key: 'e' });
  r.keys.fire('keyup', { key: 'e' });
  assert.equal(r.power, 0.31);
  r.keys.fire('keydown', { key: 'q' });
  r.keys.fire('keyup', { key: 'q' });
  r.keys.fire('keydown', { key: 'Q' });
  r.keys.fire('keyup', { key: 'Q' });
  assert.equal(r.power, 0.29);
});

test('W / S outside your aiming turn do nothing and are not swallowed', () => {
  const r = rig({ allowed: false });
  const e = r.keys.fire('keydown', { key: 'w' });
  assert.equal(r.power, 0.3);
  assert.equal(e.defaultPrevented, false);
  assert.equal(r.frames.length, 0, 'started a repeat');
});

test('shortcuts that use W or S are left alone', () => {
  const r = rig();
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    const e = r.keys.fire('keydown', { key: 's', [mod]: true });
    assert.equal(e.defaultPrevented, false, mod);
  }
  assert.equal(r.power, 0.3);
});

test('other keys are ignored', () => {
  const r = rig();
  const e = r.keys.fire('keydown', { key: 'a' });
  assert.equal(r.power, 0.3);
  assert.equal(e.defaultPrevented, false);
});

test('holding W steps once, pauses, then repeats steadily', () => {
  const r = rig();
  r.keys.fire('keydown', { key: 'w' });
  assert.equal(r.power, 0.32, 'first step is immediate');
  r.at(REPEAT_DELAY_MS - 1);
  assert.equal(r.power, 0.32, 'repeated before the delay');
  r.at(REPEAT_DELAY_MS);
  assert.equal(r.power, 0.34);
  r.at(REPEAT_DELAY_MS + 3 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.40, 'three more steps, one per interval');
  r.keys.fire('keyup', { key: 'w' });
  r.at(REPEAT_DELAY_MS + 20 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.40, 'kept going after the key came up');
});

test("the OS's own key repeat does not add extra steps", () => {
  const r = rig();
  r.keys.fire('keydown', { key: 'w' });
  r.keys.fire('keydown', { key: 'w', repeat: true });
  r.keys.fire('keydown', { key: 'w', repeat: true });
  assert.equal(r.power, 0.32);
});

test('holding stops at 100%', () => {
  const r = rig({ power: 0.96 });
  r.keys.fire('keydown', { key: 'w' });
  r.at(REPEAT_DELAY_MS + 10 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 1);
});

test('holding E repeats in 1% steps; Shift mid-hold changes nothing', () => {
  const r = rig();
  r.keys.fire('keydown', { key: 'e' }); // 0.31
  r.keys.fire('keydown', { key: 'Shift' });
  r.at(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS); // two more fine steps
  assert.equal(r.power, 0.33);
  r.keys.fire('keyup', { key: 'Shift' });
  r.at(REPEAT_DELAY_MS + 2 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.34);
  r.keys.fire('keyup', { key: 'e' });
});

test('a hold stops the moment the turn ends or a menu opens', () => {
  const r = rig();
  r.keys.fire('keydown', { key: 'w' });
  r.at(REPEAT_DELAY_MS);
  assert.equal(r.power, 0.34);
  r.allowed = false; // shot taken, balls moving
  r.at(REPEAT_DELAY_MS + 10 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.34);
  assert.equal(r.frames.length, 0, 'still scheduling frames');
  r.allowed = true; // next turn: the old hold must not resume
  r.at(REPEAT_DELAY_MS + 20 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.34);
});

test('losing window focus releases a held key', () => {
  const r = rig();
  r.keys.fire('keydown', { key: 's' });
  r.keys.fire('blur');
  r.at(REPEAT_DELAY_MS + 10 * REPEAT_INTERVAL_MS);
  assert.equal(r.power, 0.28);
});

test('destroy removes every listener', () => {
  const r = rig();
  r.input.destroy();
  r.wheel.fire('wheel', { deltaY: -100 });
  r.keys.fire('keydown', { key: 'w' });
  assert.equal(r.power, 0.3);
});
