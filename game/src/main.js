import { trackVisibleViewport } from './viewport.js';
import {
  initTelegram, preferLandscape, launchParams, themeUser, close as closeApp,
} from './telegram.js';
import { Hud } from './hud.js';
import { TableRenderer } from './renderer.js';
import { Controls } from './controls.js';
import { Game } from './game.js';
import {
  showLobby, hideLobby, setPlayButton, refreshLobbyStats, setLobbyCoins,
} from './lobby.js';
import { openStore } from './store.js';
import { startAutoSync, onQueueChange, pendingCount } from './offline.js';
import { startConnectionWatch } from './connection.js';
import * as api from './api.js';
import { installTableSound } from './sound.js';
import { createSkinSwitcher, mySkinIds } from './skinLoader.js';
import { soundEnabled, setSetting, rememberEquipped } from './settings.js';

// TON Connect pulls in a large bundle; keep it out of the first paint so the
// table is playable immediately and the wallet loads only when asked for.
const openWalletScreen = async (...args) => {
  const mod = await import('./wallet.js');
  return mod.openWalletScreen(...args);
};

trackVisibleViewport();

const hud = new Hud();
const canvas = document.getElementById('table');
const renderer = new TableRenderer(canvas, { cueLayer: document.getElementById('cue-layer') });
// Cue and cue-ball skins. The player's own until a turn says otherwise (in PvP
// they follow the shooter); in dev, ?cue=…&ball=… previews any item.
const skins = createSkinSwitcher(renderer);
skins.show(mySkinIds());
// Read live, so the Settings toggle takes effect on the next sound.
const sound = installTableSound({ isEnabled: soundEnabled });

let game = null;

const tableWrap = document.getElementById('table-wrap');

/** Fill the table column. Its size is set by the layout alone, not by the canvas. */
function fitCanvas() {
  renderer.resize(Math.max(120, tableWrap.clientWidth), Math.max(80, tableWrap.clientHeight));
}

// Catches rotation, browser toolbars sliding away and Telegram's viewport
// changes, all of which resize the column without necessarily firing `resize`.
new ResizeObserver(fitCanvas).observe(tableWrap);

function pauseMenu() {
  const inPractice = game?.mode === 'practice';
  hud.modal({
    title: 'Paused',
    body: [
      '<p>The shot clock is paused while this is open in practice. In a PvP match the'
      + ' clock keeps running on the server — close this and take your shot.</p>',
      '<div class="row"><span>Mode</span><b>'
      + (inPractice ? 'Practice (not reward-eligible)' : 'PvP (reward-eligible)')
      + '</b></div>',
    ].join(''),
    actions: [
      { label: 'Resume', kind: 'primary', onClick: () => hud.closeModal() },
      {
        // Live: the next sound reads the setting, no reload needed.
        label: soundEnabled() ? 'Sound: on' : 'Sound: off',
        onClick: () => { setSetting('sound', !soundEnabled()); pauseMenu(); },
      },
      {
        label: 'Wallet & rewards',
        onClick: () => openWalletScreen(hud, { onClose: () => pauseMenu() }),
      },
      ...(game && game.mode === 'pvp' && !game.state?.ended
        ? [{
          label: 'Concede',
          kind: 'danger',
          // Same confirmation as the in-game paths, including the reassurance
          // that breaks already made still count.
          onClick: () => game.confirmConcede('menu'),
        }]
        : []),
      { label: 'Close game', onClick: () => closeApp() },
    ],
  });
}

document.getElementById('pause').addEventListener('click', pauseMenu);

/**
 * Which screen this launch lands on.
 *
 * The bot's buttons always name one (`mode=practice`, `mode=pvp&match=…`,
 * `screen=wallet`), so they keep opening straight into it. A bare launch — the
 * Mini App button, or the chat menu — has none, and gets the lobby.
 */
function initialScreen(params) {
  if (params.screen === 'wallet') return 'wallet';
  if (params.mode) return 'table';
  return 'lobby';
}

async function boot() {
  const params = launchParams();
  const screen = initialScreen(params);
  const onTable = screen === 'table';
  // The wallet and lobby screens are plain sheets that work upright; only the
  // table needs landscape (see the #rotate guard in style.css).
  if (!onTable) document.documentElement.dataset.screen = screen;
  initTelegram({ landscape: onTable });
  startConnectionWatch();
  fitCanvas();

  const tgUser = themeUser();

  hud.hint('Connecting…');

  let user = null;
  try {
    user = await api.login();
  } catch (err) {
    // A server that answered and said no is a real problem — wrong BOT_TOKEN,
    // a stale initData — and there is nothing useful to offer. A server we never
    // reached is just no connection: practice runs entirely on the device, so
    // carry on without a session and let the lobby disable what needs one.
    if (!err.offline) {
      hud.modal({
        title: 'Cannot start',
        body: `<p>${err.message}</p><p class="note">Open the game from the bot so Telegram can
               sign you in. If you are running it in a browser for development, set
               ALLOW_DEV_AUTH=true on the backend.</p>`,
        actions: [{ label: 'Retry', kind: 'primary', onClick: () => window.location.reload() }],
      });
      return;
    }
  }

  // The server's record of what is equipped, kept on the device for offline practice.
  if (user?.equipped) {
    rememberEquipped(user.equipped);
    skins.show(mySkinIds());
  }

  startAutoSync();
  onQueueChange((n) => hud.setPending(n));
  hud.setPending(await pendingCount());

  // Telegram's own copy of the name and photo comes from initData, which is
  // already in the page — so the player is still themselves with no connection.
  const me = {
    id: user?.id ?? null,
    name: tgUser?.first_name ?? user?.firstName ?? user?.username ?? 'You',
    photo: tgUser?.photo_url ?? null,
  };

  if (screen === 'wallet') {
    // Close hands over to the table rather than exiting the Mini App: players
    // read the dimmed table behind the sheet as "the game", and expect to land
    // there. Telegram's own close button still exits.
    await openWalletScreen(hud, { onClose: () => leaveWalletForTable(me) });
    return;
  }

  if (screen === 'lobby') {
    hud.hint('');
    await openLobby(me);
    return;
  }

  startTable(params, me);
}

/**
 * The lobby. Navigation lives here rather than in lobby.js so matchmaking and
 * the landscape handover stay in one place.
 */
async function openLobby(me) {
  document.documentElement.dataset.screen = 'lobby';
  await showLobby({
    hud,
    me,
    onPlay: () => findOpponent(),
    onPractice: () => leaveLobbyForTable({ mode: 'practice', matchId: null }, me),
    // The wallet sheet opens over the lobby, which stays behind it; closing
    // just drops back with the numbers re-read in case a claim changed them.
    onRewards: () => openWalletScreen(hud, { onClose: () => refreshLobbyStats() }),
    onStore: () => openStore({
      hud,
      onChange: ({ balance, equipped }) => {
        setLobbyCoins(balance);
        rememberEquipped(equipped);
        skins.show(mySkinIds());
      },
      onClose: () => refreshLobbyStats(),
    }),
  });
}

/** Lobby → table: re-arm the landscape guard, then start the mode. */
function leaveLobbyForTable(params, me) {
  hideLobby();
  delete document.documentElement.dataset.screen;
  preferLandscape();
  startTable(params, me);
}

/**
 * Join the PvP queue from the lobby. An immediate pairing reloads into the
 * match; otherwise the button becomes a cancel while `waitForMatch` polls.
 */
async function findOpponent() {
  setPlayButton({ label: 'FINDING OPPONENT…', disabled: true });
  try {
    const res = await api.joinQueue();
    if (res.status === 'matched') return openMatch(res.matchId);
    if (res.status === 'already-playing') return openMatch(res.match.id);
    hud.toast('Queued — the bot will message you when someone joins', '', 5000);
    const stop = waitForMatch();
    setPlayButton({
      label: 'Cancel search',
      onClick: async () => {
        stop();
        try {
          await api.leaveQueue();
        } catch {
          // Already matched or already gone; the reset below still applies.
        }
        setPlayButton({ label: 'PLAY', onClick: () => findOpponent() });
      },
    });
  } catch (err) {
    hud.toast(err.message, 'foul');
    setPlayButton({ label: 'PLAY', onClick: () => findOpponent() });
  }
  return undefined;
}

/** From the standalone wallet screen to the table: their live match, or the lobby. */
async function leaveWalletForTable(me) {
  delete document.documentElement.dataset.screen; // re-arm the landscape guard
  preferLandscape();
  hud.hint('Connecting…');
  let matchId = null;
  try {
    matchId = (await api.activeMatches()).matches?.[0]?.id ?? null;
  } catch {
    // Offline or server trouble: fall through to the lobby.
  }
  hud.hint('');
  startTable({ mode: 'pvp', matchId }, me);
}

function startTable(params, me) {
  // PvP needs a match id. Without one there is nothing to load, so fall back to
  // the lobby — it has Play, Practice and the player's stats on one screen.
  // Checked before Controls is built: a second instance would bind its own
  // listeners to the same canvas and every drag would be handled twice.
  if (params.mode === 'pvp' && !params.matchId) {
    openLobby(me);
    return;
  }

  const controls = new Controls({
    canvas,
    renderer,
    hud,
    onShoot: (aim) => game?.takeShot(aim),
    onPlaceCue: (point) => game?.placeCue(point),
  });

  startGame(params.mode === 'pvp' ? 'pvp' : 'practice', params.matchId, me, controls);
}

/** Reload into a match, keeping the other query params (e.g. ?dev=N). */
function openMatch(matchId) {
  const params = new URLSearchParams(window.location.search);
  params.set('mode', 'pvp');
  params.set('match', matchId);
  window.location.search = `?${params}`;
}

/**
 * While queued, check for a pairing and jump straight in. In Telegram the bot's
 * "matched" message does this job, but a player who stays on the page (or is
 * testing in a browser, with no bot) would otherwise wait forever.
 */
function waitForMatch() {
  const timer = setInterval(async () => {
    try {
      const status = await api.queueStatus();
      const match = status.activeMatches?.[0];
      if (match) {
        clearInterval(timer);
        openMatch(match.id);
      } else if (!status.queued) {
        clearInterval(timer);
        hud.hint('');
        hud.toast('No longer in the queue', 'foul', 4000);
        // Dropped by the server (swept, or matched elsewhere): give the lobby
        // its button back rather than leaving "Cancel search" on screen.
        setPlayButton({ label: 'PLAY', onClick: () => findOpponent() });
      }
    } catch {
      // Transient network failure: try again on the next tick.
    }
  }, 3000);
  return () => clearInterval(timer);
}

async function startGame(mode, matchId, me, controls) {
  game?.destroy();
  game = new Game({
    mode, matchId, me, hud, renderer, controls, sound, skins, mySkins: mySkinIds,
  });
  try {
    await game.start();
  } catch (err) {
    hud.modal({
      title: 'Could not load the match',
      body: `<p>${err.message}</p>`,
      actions: [
        { label: 'Practice instead', kind: 'primary', onClick: () => { hud.closeModal(); startGame('practice', null, me, controls); } },
        { label: 'Close', onClick: () => closeApp() },
      ],
    });
  }
}

boot();
