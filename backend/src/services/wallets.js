import { getDb, activeWallet, linkWallet } from '@snooker/db';
import { logger } from '../logger.js';
import { notifyWalletChanged } from './notify.js';

const sameWallet = (a, b) => Boolean(a && b) && a.address === b.address && a.network === b.network;

/**
 * Make a verified address the player's payout wallet.
 *
 * A change of payout address (including a first link) starts the claim
 * cooldown and tells the player through the bot, so a session hijacker cannot
 * quietly redirect rewards. Re-proving the wallet that is already active
 * changes nothing and does neither.
 *
 * @returns {Promise<{wallet: object, changed: boolean}>}
 */
export async function setPayoutWallet(userId, { address, network, publicKey }) {
  const previous = await activeWallet(userId);
  const wallet = await linkWallet(userId, { address, network, publicKey });
  const changed = !sameWallet(previous, wallet);
  if (changed) {
    await getDb()('users').where({ id: userId }).update({ wallet_changed_at: new Date() });
    logger.info({ userId, address, previous: previous?.address ?? null }, 'payout wallet changed');
    await notifyWalletChanged(userId, {
      action: 'linked', address, network, hadWallet: Boolean(previous),
    });
  }
  return { wallet, changed };
}

/** Unlink the payout wallet. The player hears about it if there was one. */
export async function removePayoutWallet(userId) {
  const previous = await activeWallet(userId);
  await getDb()('wallets').where({ user_id: userId }).update({ active: false });
  if (previous) {
    logger.info({ userId, address: previous.address }, 'payout wallet unlinked');
    await notifyWalletChanged(userId, {
      action: 'unlinked', address: previous.address, network: previous.network,
    });
  }
  return { removed: Boolean(previous) };
}
