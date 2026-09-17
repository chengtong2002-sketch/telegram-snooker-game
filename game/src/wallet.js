import { TonConnectUI } from '@tonconnect/ui';
import * as api from './api.js';
import { newResultId } from './offline.js';

const MANIFEST = import.meta.env.VITE_TONCONNECT_MANIFEST_URL
  ?? `${window.location.origin}/tonconnect-manifest.json`;

let ui = null;

// Payout states (token/src/settlement.ts) as a player should read them.
// `sending`/`unconfirmed` are operator bookkeeping, not something to alarm anyone with.
const CLAIM_LABEL = {
  pending: 'queued',
  sending: 'processing',
  unconfirmed: 'processing',
  sent: 'sent ✓',
  failed: 'failed — contact support',
};

function tonConnect() {
  if (!ui) {
    ui = new TonConnectUI({
      manifestUrl: MANIFEST,
      // Telegram Wallet is the least friction inside a Mini App.
      actionsConfiguration: { twaReturnUrl: window.location.href },
    });
  }
  return ui;
}

/**
 * Link a TON wallet.
 *
 * The nonce comes from the backend and is signed by the wallet as part of
 * ton_proof, so the server can prove the player actually controls the address
 * it is being asked to pay. Without the proof step, anyone could type in
 * anyone's address.
 */
export async function connectWallet(onStatus) {
  const connector = tonConnect();
  const { payload } = await api.walletChallenge();

  connector.setConnectRequestParameters({ state: 'ready', value: { tonProof: payload } });

  if (connector.connected) await connector.disconnect();

  return new Promise((resolve, reject) => {
    const unsubscribe = connector.onStatusChange(async (wallet) => {
      if (!wallet) return;
      const proof = wallet.connectItems?.tonProof;
      if (!proof || 'error' in proof) {
        unsubscribe();
        reject(new Error('Wallet did not return an ownership proof'));
        return;
      }
      try {
        onStatus?.('Verifying…');
        const res = await api.linkWallet({
          address: wallet.account.address,
          network: wallet.account.chain,
          publicKey: wallet.account.publicKey,
          walletStateInit: wallet.account.walletStateInit,
          proof: proof.proof,
        });
        unsubscribe();
        resolve(res.wallet);
      } catch (err) {
        unsubscribe();
        reject(err);
      }
    });

    connector.openModal().catch(reject);
  });
}

export async function disconnectWallet() {
  const connector = tonConnect();
  if (connector.connected) await connector.disconnect();
}

const fmt = (n) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-6)}`;

/** The /wallet screen: linked address, this period's pool, and redemption. */
export async function openWalletScreen(hud, { onClose } = {}) {
  const render = async (statusLine = '') => {
    let wallet = null;
    let period = null;
    let claims = { periods: [], totalTokens: 0, windowDays: 30 };
    let history = [];
    try {
      // The open period (provisional numbers, still earning), every closed
      // period that can still be claimed, and recent claims.
      const [walletRes, current, claimable, hist] = await Promise.all([
        api.walletInfo(), api.rewardPeriod(), api.rewardClaimable(), api.rewardHistory(),
      ]);
      wallet = walletRes.wallet;
      period = current;
      claims = claimable;
      history = hist.redemptions ?? [];
    } catch (err) {
      hud.modal({
        title: 'Wallet',
        body: `<p>Could not reach the server: ${err.message}</p>`,
        actions: [{ label: 'Close', onClick: () => { hud.closeModal(); onClose?.(); } }],
      });
      return;
    }

    const rows = [
      `<div class="row"><span>Wallet</span><b>${wallet ? shortAddr(wallet.address) : 'not linked'}</b></div>`,
      `<div class="row"><span>Network</span><b>${period?.network ?? '—'}</b></div>`,
      `<div class="row"><span>Your eligible points</span><b>${period?.points ?? 0}</b></div>`,
      `<div class="row"><span>Pool this period</span><b>${fmt(period?.budget)} tokens</b></div>`,
      `<div class="row"><span>All eligible points</span><b>${period?.totalPoints ?? 0}</b></div>`,
      `<div class="row"><span>Rate</span><b>${fmt(period?.rate)} / point</b></div>`,
      `<div class="row"><span>Your share</span><b>${fmt(period?.tokens)} tokens${period?.capped ? ' (capped)' : ''}</b></div>`,
    ].join('');

    const note = `<p class="note">This period is still open, so the rate is provisional — it drops
       as other players earn eligible points. Redemption unlocks once the period closes
       ${period?.endsAt ? `(${new Date(period.endsAt).toLocaleString()})` : ''}.</p>`;

    const day = (iso) => new Date(iso).toLocaleDateString();
    // Periods are UTC days (or weeks): label them by the UTC date they started on.
    const periodDay = (iso) => new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC' });
    const claimRows = claims.periods.map((p) => (p.claimable
      ? `<div class="row"><span>${periodDay(p.startsAt)} · claim by ${day(p.expiresAt)}</span><b>${fmt(p.tokens)} tokens${p.capped ? ' (capped)' : ''}</b></div>`
      : `<div class="row"><span>${periodDay(p.startsAt)} · ${p.points} points, below the ${p.minPoints} minimum</span><b>—</b></div>`)).join('');
    const unclaimed = claims.periods.length
      ? `<h3 style="margin:14px 0 6px;font-size:14px">Unclaimed rewards</h3>${claimRows}
         <p class="note">Each closed period's rate is final. Rewards can be claimed for
         ${claims.windowDays} days after a period closes; after that they expire.</p>`
      : '';
    const recent = history.slice(0, 3).map((r) => `<div class="row"><span>Claim · ${fmt(r.tokens)} tokens</span><b>${CLAIM_LABEL[r.status] ?? r.status}</b></div>`).join('');
    const closedRows = unclaimed + (recent ? `<h3 style="margin:14px 0 6px;font-size:14px">Recent claims</h3>${recent}` : '');

    const actions = [];
    if (!wallet) {
      actions.push({
        label: 'Link TON wallet',
        kind: 'primary',
        onClick: async () => {
          try {
            await render('Opening wallet…');
            await connectWallet((s) => render(s));
            await render('Wallet linked ✓');
          } catch (err) {
            await render(`Could not link: ${err.message}`);
          }
        },
      });
    } else if (claims.totalTokens > 0) {
      actions.push({
        label: `Redeem ${fmt(claims.totalTokens)}`,
        kind: 'primary',
        onClick: async () => {
          try {
            const res = await api.redeem(newResultId());
            const n = res.redemptions?.length ?? 0;
            await render(res.status === 'queued'
              ? `Queued ${n} claim${n === 1 ? '' : 's'} — they settle on-chain shortly.`
              : 'Nothing left to claim.');
          } catch (err) {
            await render(err.message);
          }
        },
      });
    }
    actions.push({ label: 'Close', onClick: () => { hud.closeModal(); onClose?.(); } });

    hud.modal({
      title: 'Wallet & rewards',
      body: (statusLine ? `<p><b>${statusLine}</b></p>` : '') + rows + note + closedRows,
      actions,
    });
  };

  await render();
}
