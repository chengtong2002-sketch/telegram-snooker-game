import { trackVisibleViewport } from './viewport.js';
import {
  initTelegram, preferLandscape, launchParams, themeUser, close as closeApp,
} from './telegram.js';
import { Hud } from './hud.js';
import { TableRenderer } from './renderer.js';
import { Controls } from './controls.js';
import { Game } from './game.js';
import { startAutoSync, onQueueChange, pendingCount } from './offline.js';
import * as api from './api.js';

// TON Connect pulls in a large bundle; keep it out of the first paint so the
// table is playable immediately and the wallet loads only when asked for.
const openWalletScreen = async (...args) => {
  const mod = await import('./wallet.js');
  return mod.openWalletScreen(...args);
};

trackVisibleViewport();

const hud = new Hud();
const canvas = document.getElementById('table');
const renderer = new TableRenderer(canvas);

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
        label: 'Wallet & rewards',
        onClick: () => openWalletScreen(hud, { onClose: () => pauseMenu() }),
      },
      ...(game && game.mode === 'pvp' && !game.state?.ended
        ? [{
          label: 'Concede',
          kind: 'danger',
          onClick: async () => {
            try {
              await api.concedeMatch(game.matchId);
              hud.closeModal();
              hud.toast('You conceded the match', 'foul');
              closeApp();
            } catch (err) {
              hud.toast(err.message, 'foul');
            }
          },
        }]
        : []),
      { label: 'Close game', onClick: () => closeApp() },
    ],
  });
}

document.getElementById('pause').addEventListener('click', pauseMenu);

async function boot() {
  const params = launchParams();
  const onTable = params.screen !== 'wallet';
  // The wallet screen is a plain sheet that works upright; only the table
  // needs landscape (see the #rotate guard in style.css).
  if (!onTable) document.documentElement.dataset.screen = params.screen;
  initTelegram({ landscape: onTable });
  fitCanvas();

  const tgUser = themeUser();

  hud.hint('Connecting…');

  let user;
  try {
    user = await api.login();
  } catch (err) {
    hud.modal({
      title: 'Cannot start',
      body: `<p>${err.message}</p><p class="note">Open the game from the bot so Telegram can
             sign you in. If you are running it in a browser for development, set
             ALLOW_DEV_AUTH=true on the backend.</p>`,
      actions: [{ label: 'Retry', kind: 'primary', onClick: () => window.location.reload() }],
    });
    return;
  }

  startAutoSync();
  onQueueChange((n) => hud.setPending(n));
  hud.setPending(await pendingCount());

  const me = {
    id: user.id,
    name: tgUser?.first_name ?? user.firstName ?? user.username ?? 'You',
    photo: tgUser?.photo_url ?? null,
  };

  if (params.screen === 'wallet') {
    // Close hands over to the table rather than exiting the Mini App: players
    // read the dimmed table behind the sheet as "the game", and expect to land
    // there. Telegram's own close button still exits.
    await openWalletScreen(hud, { onClose: () => leaveWalletForTable(me) });
    return;
  }

  startTable(params, me);
}

/** From the standalone wallet screen to the table: their live match, or a choice. */
async function leaveWalletForTable(me) {
  delete document.documentElement.dataset.screen; // re-arm the landscape guard
  preferLandscape();
  hud.hint('Connecting…');
  let matchId = null;
  try {
    matchId = (await api.activeMatches()).matches?.[0]?.id ?? null;
  } catch {
    // Offline or server trouble: fall through to the choice sheet.
  }
  hud.hint('');
  startTable({ mode: 'pvp', matchId }, me);
}

function startTable(params, me) {
  const controls = new Controls({
    canvas,
    renderer,
    hud,
    onShoot: (aim) => game?.takeShot(aim),
    onPlaceCue: (point) => game?.placeCue(point),
  });

  // PvP needs a match id. Without one, offer to find an opponent rather than
  // silently dropping the player into practice.
  if (params.mode === 'pvp' && !params.matchId) {
    hud.modal({
      title: 'No match selected',
      body: '<p>Use /play in the bot to find an opponent, or start a practice frame.</p>',
      actions: [
        {
          label: 'Find opponent',
          kind: 'primary',
          onClick: async () => {
            try {
              const res = await api.joinQueue();
              if (res.status === 'matched') openMatch(res.matchId);
              else if (res.status === 'already-playing') openMatch(res.match.id);
              else {
                hud.closeModal();
                hud.hint('Waiting for an opponent…');
                hud.toast('Queued — the bot will message you when someone joins', '', 5000);
                waitForMatch();
              }
            } catch (err) {
              hud.toast(err.message, 'foul');
            }
          },
        },
        {
          label: 'Practice instead',
          onClick: () => {
            hud.closeModal();
            startGame('practice', null, me, controls);
          },
        },
        { label: 'Close game', onClick: () => closeApp() },
      ],
    });
    return;
  }

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
      }
    } catch {
      // Transient network failure: try again on the next tick.
    }
  }, 3000);
}

async function startGame(mode, matchId, me, controls) {
  game?.destroy();
  game = new Game({ mode, matchId, me, hud, renderer, controls });
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
