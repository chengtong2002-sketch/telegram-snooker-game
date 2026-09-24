/**
 * Refund a Stars coin order: the Stars go back to the player, the coins come off
 * their balance (even below zero; buying then waits until it is positive).
 *
 *   npm run refund:stars -w @snooker/backend -- <orderId>                  # dry run
 *   npm run refund:stars -w @snooker/backend -- <orderId> --by nick --yes  # refunds
 *
 * Operator-only on purpose: there is no HTTP route that refunds. Running it
 * again is safe: Telegram answers "already refunded" and the ledger debits once.
 */
import os from 'node:os';
import '../src/config.js'; // loads .env, so DATABASE_URL and BOT_TOKEN are set as the server sets them
import { closeDb, getDb } from '@snooker/db';
import { balanceOf } from '../src/services/coins.js';
import { refundStarsOrder } from '../src/services/stars.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? '';
};

async function main() {
  const orderId = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--by');
  if (!orderId) throw new Error('usage: refund-stars <orderId> [--by name] [--yes]');
  const order = await getDb()('payment_orders').where({ id: orderId, provider: 'stars' }).first();
  if (!order) throw new Error(`no Stars order ${orderId}`);
  const user = await getDb()('users').where({ id: order.user_id }).first();
  const who = `${user.first_name ?? ''}${user.username ? ` @${user.username}` : ''} (user ${user.id})`.trim();
  const balance = await balanceOf(user.id);
  console.log(`order ${order.id}: ${order.pack_id}, ${order.coins} coins for ${order.amount} Stars, ${order.status}, ${who}`);
  if (!order.provider_txn_id) throw new Error('this order was never paid; there is nothing to refund');

  if (!args.includes('--yes')) {
    console.log(`DRY RUN: would refund ${order.amount} Stars and take back ${order.coins} coins`);
    console.log(`  balance ${balance.toLocaleString('en')} → ${(balance - order.coins).toLocaleString('en')}`);
    console.log('  add --yes to refund.');
    return;
  }
  const actor = (flag('--by') ?? os.userInfo().username).trim().slice(0, 64);
  const result = await refundStarsOrder(order.id, { actor });
  if (result.status === 'provider_error') throw new Error(`Telegram refused the refund: ${result.reason}`);
  console.log(`${result.status === 'debited' ? 'Refunded' : 'Already refunded'}: balance now ${result.balance.toLocaleString('en')}.`);
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
