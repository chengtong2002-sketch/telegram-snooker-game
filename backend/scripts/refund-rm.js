/**
 * Refund a Revenue Monster coin order (sandbox): the money goes back through RM,
 * the coins come off the player's balance (even below zero; buying then waits
 * until it is positive).
 *
 *   npm run refund:rm -w @snooker/backend -- <orderId>                                   # dry run
 *   npm run refund:rm -w @snooker/backend -- <orderId> --reason "…" --by nick --yes       # full refund
 *   npm run refund:rm -w @snooker/backend -- <orderId> --sen 990 --reason "…" --yes       # part of it
 *
 * Operator-only on purpose: there is no HTTP route that refunds. The debit is
 * keyed by the refunded total, so running it twice for one total debits once.
 * A refund made in RM's own portal is found by the daily reconcile instead.
 */
import os from 'node:os';
import '../src/config.js'; // loads .env, so DATABASE_URL and the RM keys are set as the server sets them
import { closeDb, getDb } from '@snooker/db';
import { balanceOf } from '../src/services/coins.js';
import { coinsForRefund, refundRmOrder } from '../src/services/rm/payments.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = ['--by', '--reason', '--sen'];
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? '';
};
const sen = (n) => `RM ${(n / 100).toFixed(2)}`;

async function main() {
  const orderId = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
  if (!orderId) throw new Error('usage: refund-rm <orderId> [--sen N] [--reason "…"] [--by name] [--yes]');
  const order = await getDb()('payment_orders').where({ id: orderId, provider: 'rm' }).first();
  if (!order) throw new Error(`no RM order ${orderId}`);
  const user = await getDb()('users').where({ id: order.user_id }).first();
  const who = `${user.first_name ?? ''}${user.username ? ` @${user.username}` : ''} (user ${user.id})`.trim();
  const refunded = Number(order.refunded_amount ?? 0);
  const remaining = Number(order.amount) - refunded;
  console.log(`order ${order.id}: ${order.pack_id}, ${order.coins} coins for ${sen(Number(order.amount))}, ${order.status}, ${who}`);
  if (!order.provider_txn_id) throw new Error('this order was never paid; there is nothing to refund');
  if (refunded) console.log(`  already refunded ${sen(refunded)}`);

  const amount = flag('--sen') === null ? remaining : Number(flag('--sen'));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) {
    throw new Error(`--sen must be a whole number from 1 to ${remaining}`);
  }
  const reason = (flag('--reason') ?? '').trim();
  const balance = await balanceOf(user.id);
  const taken = coinsForRefund(order, refunded + amount) - coinsForRefund(order, refunded);

  if (!args.includes('--yes')) {
    console.log(`DRY RUN: would refund ${sen(amount)} and take back ${taken} coins`);
    console.log(`  balance ${balance.toLocaleString('en')} → ${(balance - taken).toLocaleString('en')}`);
    console.log('  add --reason "…" --yes to refund.');
    return;
  }
  if (!reason) throw new Error('a refund needs --reason "…" (RM records it)');
  const actor = (flag('--by') ?? os.userInfo().username).trim().slice(0, 64);
  const result = await refundRmOrder(order.id, { actor, amountSen: amount, reason });
  if (result.status === 'provider_error') throw new Error(`RM refused the refund: ${result.reason}`);
  if (result.status !== 'debited' && result.status !== 'duplicate' && result.status !== 'refund_seen') {
    throw new Error(`not refunded: ${result.status}`);
  }
  console.log(`Refunded ${sen(amount)}: balance now ${result.balance.toLocaleString('en')}.`);
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
