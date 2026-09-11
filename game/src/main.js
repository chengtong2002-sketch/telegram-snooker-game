import { initTelegram, launchParams, themeUser, close as closeApp } from './telegram.js';
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

const hud = new Hud();
const canvas = document.getElementById('table');
const renderer = new TableRenderer(canvas);

let game = null;

function fitCanvas() {
  const stage = document.getElementById('stage');
  const meter = document.getElementById('power');
  const pad = 16;
  const w = stage.clientWidth - meter.offsetWidth - pad - 8;
  const h = stage.clientHeight - pad;
  renderer.resize(Math.max(120, w), Math.max(80, h));
}

window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 250));

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
  initTelegram();
  fitCanvas();

  const params = launchParams();
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
    await openWalletScreen(hud, { onClose: () => closeApp() });
    return;
  }

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
              if (res.status === 'matched') window.location.search = `?mode=pvp&match=${res.matchId}`;
              else if (res.status === 'already-playing') window.location.search = `?mode=pvp&match=${res.match.id}`;
              else {
                hud.closeModal();
                hud.toast('Queued — the bot will message you when someone joins', '', 5000);
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
      ],
    });
    return;
  }

  startGame(params.mode === 'pvp' ? 'pvp' : 'practice', params.matchId, me, controls);
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
