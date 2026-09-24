import * as api from './api.js';
import { settings, setSetting, practiceRecord } from './settings.js';
import { onConnectionChange, isOnline } from './connection.js';
import { hasDesktopPowerInput } from './powerInput.js';

const $ = (id) => document.getElementById(id);

const fmt = (n) => Number(n ?? 0).toLocaleString();

let els = null;

/**
 * The last successful /stats payload, so the rules sheet can quote the real
 * caps. Both numbers come from the server (they are enforced there); with no
 * stats yet the sentences that need them are left out rather than guessed.
 */
let lastStats = null;

const pairCapHint = () => {
  const n = lastStats?.daily?.pairCap;
  return n ? ` At most ${n} of them against the same opponent.` : '';
};

function elements() {
  if (!els) {
    els = {
      root: $('lobby'),
      avatar: $('lobby-avatar'),
      name: $('lobby-name'),
      sub: $('lobby-sub'),
      points: $('stat-points'),
      matches: $('stat-matches'),
      best: $('stat-break'),
      capValue: $('cap-value'),
      capLine: $('cap-line'),
      capBar: $('cap-bar'),
      capFill: $('cap-fill'),
      capNote: $('cap-note'),
      play: $('lobby-play'),
      practice: $('lobby-practice'),
      store: $('lobby-store'),
      coins: $('lobby-coins'),
      coinsValue: $('lobby-coins-value'),
      rewards: $('lobby-rewards'),
      rules: $('lobby-rules'),
      settings: $('lobby-settings'),
      offlineChip: $('lobby-offline'),
      offlineNote: $('offline-note'),
    };
  }
  return els;
}

/** Fill the player card from Telegram's own name and photo. */
function paintPlayer(el, me) {
  el.name.textContent = me.name;
  el.avatar.textContent = me.name.slice(0, 2).toUpperCase();
  if (me.photo) el.avatar.innerHTML = `<img src="${me.photo}" alt="">`;
  paintSub(el);
}

/**
 * Write the allowance line as an optional bold count plus its sentence, built
 * as nodes rather than innerHTML so the number is emphasised without ever
 * putting a server value through the HTML parser.
 */
function setCapText(el, count, rest) {
  const nodes = [];
  if (count !== null) {
    const b = document.createElement('b');
    b.textContent = String(count);
    nodes.push(b);
  }
  nodes.push(document.createTextNode(rest));
  el.capValue.replaceChildren(...nodes);
}

/** The device's own practice record — the one line that needs no connection. */
function paintSub(el) {
  const rec = practiceRecord();
  el.sub.textContent = rec.played
    ? `Practice: ${rec.played} played · best break ${rec.bestBreak}`
    : 'Ready to play';
}

function paintStats(el, stats) {
  lastStats = stats;
  paintCoins(el, stats.coins);
  el.points.textContent = fmt(stats.lifetimeEligiblePoints);
  el.matches.textContent = `${fmt(stats.matchesWon)}/${fmt(stats.matchesPlayed)}`;
  el.best.textContent = fmt(stats.bestBreak);

  const { cap, remaining } = stats.daily ?? {};
  el.capLine.hidden = false;
  el.capBar.hidden = false;
  el.capLine.className = 'cap-line';
  if (cap === null || cap === undefined) {
    // Exempt test account: no cap to show, so do not imply one.
    setCapText(el, null, 'Unlimited matches today');
    el.capFill.style.width = '100%';
    el.capFill.className = 'cap-fill';
  } else {
    // Phrased as an allowance remaining. "15/15" beside a full bar read as a
    // meter that had filled up — i.e. the opposite of what it meant.
    if (remaining === 0) {
      setCapText(el, null, 'No matches left today');
      el.capLine.className = 'cap-line spent';
    } else {
      setCapText(el, remaining, ` match${remaining === 1 ? '' : 'es'} left today`);
    }
    el.capFill.style.width = `${Math.round((remaining / cap) * 100)}%`;
    el.capFill.className = `cap-fill${remaining === 0 ? ' spent' : remaining <= 3 ? ' warn' : ''}`;
  }
  el.capNote.textContent = remaining === 0
    ? 'Today\'s reward-eligible matches are used up. You can still play — those matches just earn no points until 00:00 UTC.'
    : `Only PvP matches earn reward points${cap ? `, up to ${cap} a day` : ''}.${pairCapHint()} Practice never earns.`;
}

/** The coin chip. Null: not known (no stats yet). Below zero reads in amber. */
function paintCoins(el, coins) {
  const known = typeof coins === 'number';
  el.coinsValue.textContent = known ? fmt(coins) : '–';
  el.coins.classList.toggle('neg', known && coins < 0);
}

/** After a purchase: the chip follows without re-reading every stat. */
export function setLobbyCoins(coins) {
  paintCoins(elements(), coins);
}

/** Stat placeholders while /stats is in flight, or after it fails. */
function paintStatsUnavailable(el, note = 'Stats are unavailable — you can still play.') {
  for (const key of ['points', 'matches', 'best']) el[key].textContent = '–';
  paintCoins(el, null);
  el.capValue.textContent = '–';
  el.capLine.className = 'cap-line';
  // Hidden rather than emptied: the fill animates, so a bar left on screen
  // keeps showing the old allowance for a moment next to a value reading "–".
  // The line goes too — a lone dash is not a sentence, and the note says why.
  el.capLine.hidden = true;
  el.capBar.hidden = true;
  el.capFill.style.width = '0%';
  el.capFill.className = 'cap-fill';
  el.capNote.textContent = note;
}

/**
 * Offline: the career stats and the daily cap both live on the server, so say so
 * rather than showing stale or invented numbers. The practice line under the
 * name is device-local and stays accurate.
 */
function paintPracticeOnly(el) {
  lastStats = null;
  paintStatsUnavailable(el, 'Career stats and the daily cap need a connection.');
  paintSub(el);
}

/**
 * The lobby: the first screen the Mini App opens on.
 *
 * Navigation stays with the caller — the lobby only reports which button was
 * pressed, so main.js keeps ownership of matchmaking and the landscape handover.
 *
 * @param {object} opts
 * @param {import('./hud.js').Hud} opts.hud
 * @param {{name:string, photo:string|null}} opts.me
 * @param {() => void} opts.onPlay       find a PvP opponent
 * @param {() => void} opts.onPractice   start a practice frame
 * @param {() => void} opts.onRewards    open the existing wallet/claim screen
 * @param {() => void} opts.onStore      open the store (the Store button and the coin chip)
 */
export async function showLobby({
  hud, me, onPlay, onPractice, onRewards, onStore,
}) {
  const el = elements();

  paintPlayer(el, me);
  el.root.hidden = false;

  setPlayButton({ label: 'PLAY', onClick: () => onPlay() });
  el.practice.onclick = () => onPractice();
  el.rewards.onclick = () => onRewards();
  el.store.onclick = () => onStore();
  el.coins.onclick = () => onStore();
  el.rules.onclick = () => rulesSheet(hud);
  el.settings.onclick = () => settingsSheet(hud);

  // Paints once with the current state (which fetches the stats when there is a
  // connection) and keeps the two server-backed buttons in step from here on.
  stopWatchingConnection?.();
  stopWatchingConnection = onConnectionChange(applyConnection);
}

export function hideLobby() {
  // Stop reacting while the table has the screen: nothing to repaint, and no
  // reason to poll /stats during a frame.
  stopWatchingConnection?.();
  stopWatchingConnection = null;
  elements().root.hidden = true;
}

/** Re-read the stats without rebuilding the screen (after a claim, say). */
export async function refreshLobbyStats() {
  const el = elements();
  if (el.root.hidden) return;
  try {
    paintStats(el, await api.stats());
  } catch {
    // The failure also told connection.js we are offline, which repaints this
    // properly; this keeps the screen honest in the meantime.
    paintStatsUnavailable(el);
  }
}

/* ---------- main button, and what the connection does to it ---------- */

// Two independent reasons Play can be unavailable: a queue request is in flight,
// or there is no connection. Kept apart so a reconnect cannot re-enable a button
// mid-search, and a finished search cannot re-enable it while still offline.
let playLabel = 'PLAY';
let playBusy = false;

/** Unsubscribe for the connection watch, live only while the lobby is showing. */
let stopWatchingConnection = null;

function syncPlayButton() {
  const el = elements();
  el.play.textContent = playLabel;
  el.play.disabled = playBusy || !isOnline();
}

/**
 * Retarget the main button. Queueing is not instant, so the caller turns it
 * into a cancel while a search is running — a disabled button would leave a
 * waiting player with no way out but closing the Mini App.
 */
export function setPlayButton({ label = 'PLAY', disabled = false, onClick } = {}) {
  playLabel = label;
  playBusy = disabled;
  if (onClick) elements().play.onclick = onClick;
  syncPlayButton();
}

/**
 * Online/offline. Practice is never touched — it runs entirely on the device —
 * so only the two things that genuinely need a server are disabled.
 */
function applyConnection(online) {
  const el = elements();
  el.offlineChip.hidden = online;
  el.offlineNote.hidden = online;
  el.rewards.disabled = !online;
  // The balance and every purchase live on the server. Offline, the Offline
  // chip takes the coin chip's place.
  el.store.disabled = !online;
  el.coins.hidden = !online;
  syncPlayButton();

  if (online) {
    // Numbers went stale while the connection was gone.
    refreshLobbyStats();
  } else {
    paintPracticeOnly(el);
  }
}

function settingsSheet(hud) {
  const render = () => {
    const current = settings();
    hud.modal({
      title: 'Settings',
      body: `<div class="row"><span>Sound</span><b>${current.sound ? 'On' : 'Off'}</b></div>
             <p class="note">Table sounds: the cue, ball contacts, cushions and pockets. The
             lobby is always quiet. Also in the in-game pause menu.</p>`,
      actions: [
        {
          label: current.sound ? 'Turn sound off' : 'Turn sound on',
          kind: 'primary',
          onClick: () => { setSetting('sound', !current.sound); render(); },
        },
        { label: 'Close', onClick: () => hud.closeModal() },
      ],
    });
  };
  render();
}

/**
 * Wheel and W / S only exist with a mouse or trackpad (see powerInput.js), so
 * only say so there; a phone's sheet reads as it always did.
 */
function desktopPowerHint() {
  return hasDesktopPowerInput() ? '\n      <div class="row"><span>Power</span><b>scroll wheel or W / S</b></div>' : '';
}

function rulesSheet(hud) {
  hud.modal({
    title: 'How to play',
    body: `
      <p>Drag on the table to aim, set power on the left meter, then press SHOOT.</p>${desktopPowerHint()}
      <div class="row"><span>Match</span><b>Best of 3 frames</b></div>
      <div class="row"><span>Shot clock</span><b>30 seconds</b></div>
      <div class="row"><span>Pot a red</span><b>1 point, then a colour</b></div>
      <div class="row"><span>Colours</span><b>yellow 2 … black 7</b></div>
      <div class="row"><span>Highest break</span><b>147</b></div>
      <p class="note"><b>Reds then colours.</b> Pot a red and any colour is on next; the colour
      comes back up while reds remain. Once the reds are gone, clear the colours in order
      yellow, green, brown, blue, pink, black.</p>
      <p class="note"><b>Fouls</b> give your opponent 4 points — or the value of the ball on if
      that is higher — and hand them the turn. Missing every ball, potting the cue ball and
      knocking a ball off the table are all fouls.</p>
      <p class="note"><b>Rewards</b> come from your single highest break in a PvP match.
      Practice is never eligible.${pairCapHint()}</p>`,
    actions: [{ label: 'Got it', kind: 'primary', onClick: () => hud.closeModal() }],
  });
}
