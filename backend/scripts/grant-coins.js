/**
 * Give a player coins: for the demo, testing and support.
 *
 *   npm run grant -w @snooker/backend -- <telegramId> <amount> --note "why"          # dry run
 *   npm run grant -w @snooker/backend -- <telegramId> <amount> --note "why" --yes    # grants
 *   npm run grant -w @snooker/backend -- <telegramId>                                # balance only
 *
 * Operator-only on purpose: there is no HTTP route that grants coins. Every
 * grant is a ledger row naming who ran it (--by, default the OS user) and why,
 * and running the command twice grants twice. Against Railway, run it with the
 * production DATABASE_URL in the environment.
 */
import os from 'node:os';
import '../src/config.js'; // loads .env, so DATABASE_URL is set the same way the server sets it
import { closeDb, userByTelegramId } from '@snooker/db';
import { balanceOf, grantCoins, MAX_GRANT } from '../src/services/coins.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? '';
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--note', '--by'].includes(args[i - 1]));

async function main() {
  const [tgArg, amountArg] = positional;
  if (!/^\d+$/.test(tgArg ?? '')) throw new Error('usage: grant-coins <telegramId> [amount] --note "why" [--yes]');
  const user = await userByTelegramId(Number(tgArg));
  if (!user) throw new Error(`no player with Telegram id ${tgArg} (they must open the Mini App once first)`);
  const who = `${user.first_name ?? ''}${user.username ? ` @${user.username}` : ''} (user ${user.id})`.trim();
  const before = await balanceOf(user.id);

  if (amountArg === undefined) {
    console.log(`${who}: ${before.toLocaleString('en')} coins`);
    return;
  }
  if (!/^\d+$/.test(amountArg) || Number(amountArg) < 1 || Number(amountArg) > MAX_GRANT) {
    throw new Error(`amount must be a whole number from 1 to ${MAX_GRANT.toLocaleString('en')}`);
  }
  const amount = Number(amountArg);
  const note = (flag('--note') ?? '').trim();
  if (!note) throw new Error('say why with --note "…" (it is stored with the grant)');
  const actor = (flag('--by') ?? os.userInfo().username).trim().slice(0, 64);

  if (!args.includes('--yes')) {
    console.log(`DRY RUN: would grant ${amount.toLocaleString('en')} coins to ${who}`);
    console.log(`  balance ${before.toLocaleString('en')} → ${(before + amount).toLocaleString('en')}, by ${actor}: "${note}"`);
    console.log('  add --yes to grant.');
    return;
  }
  const { entry, balance } = await grantCoins({ userId: user.id, amount, actor, note: note.slice(0, 200) });
  console.log(`Granted ${amount.toLocaleString('en')} coins to ${who}: ledger #${entry.id}, balance now ${balance.toLocaleString('en')}.`);
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
