/**
 * DEV ONLY — a stand-in spin control for feel-testing the physics before the
 * real controls exist (spin phase 4). main.js loads it only when
 * import.meta.env.DEV, so it never reaches a production build. Practice only:
 * PvP shots never carry it.
 *
 *   ?spin=x,y   start with this spin (x right, y up; e.g. ?spin=0,-0.8 = max draw)
 *   I / K       more top / more draw (0.1)
 *   J / L       more left / more right (0.1)
 *   O           back to centre
 *   tap the box cycles centre → draw → follow → left → right (for phones)
 *
 * Unlike the real control it does NOT reset each turn: it is a test tool.
 */
import { normaliseSpin, SPIN } from '@snooker/sim';

const PRESETS = [[0, 0], [0, -0.8], [0, 0.8], [-0.6, 0], [0.6, 0]];
const round = (v) => Math.round(v * 10) / 10;

export function createDevSpin() {
  const q = new URLSearchParams(window.location.search).get('spin');
  let [x, y] = (q ?? '0,0').split(',').map(Number);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  let preset = 0;

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:60;padding:6px 8px;border-radius:8px;'
    + 'background:rgba(0,0,0,.7);color:#fff;font:12px/1.3 system-ui;display:flex;gap:8px;align-items:center;cursor:pointer';
  const ball = document.createElement('div');
  ball.style.cssText = 'position:relative;width:34px;height:34px;border-radius:50%;background:#f4f1e6';
  const dot = document.createElement('div');
  dot.style.cssText = 'position:absolute;width:7px;height:7px;border-radius:50%;background:#c8202a;transform:translate(-50%,-50%)';
  ball.append(dot);
  const label = document.createElement('div');
  box.append(ball, label);
  document.body.append(box);

  const set = (nx, ny) => {
    const s = normaliseSpin({ x: nx, y: ny }) ?? { x: 0, y: 0 };
    x = round(s.x);
    y = round(s.y);
    dot.style.left = `${50 + x * 50}%`;
    dot.style.top = `${50 - y * 50}%`;
    const kind = [y < 0 ? `draw ${-y}` : y > 0 ? `follow ${y}` : '', x < 0 ? `left ${-x}` : x > 0 ? `right ${x}` : '']
      .filter(Boolean).join(' · ') || 'centre (stun)';
    label.innerHTML = `<b>DEV spin</b><br>${kind}<br><span style="opacity:.6">I/K J/L · O centre · max ${SPIN.maxOffset}</span>`;
  };
  set(x, y);

  box.addEventListener('click', () => {
    preset = (preset + 1) % PRESETS.length;
    set(...PRESETS[preset]);
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'i') set(x, y + 0.1);
    else if (k === 'k') set(x, y - 0.1);
    else if (k === 'j') set(x - 0.1, y);
    else if (k === 'l') set(x + 0.1, y);
    else if (k === 'o') set(0, 0);
  });

  return {
    /** The spin for the next practice shot, or undefined for none. */
    current: () => (x === 0 && y === 0 ? undefined : { x, y }),
    show: (on) => { box.hidden = !on; },
  };
}
