/**
 * Transfer Jettons the treasury already holds (TEP-74 transfer, not a mint).
 *
 *   npm run transfer -w @snooker/token -- <address> <amount>
 *
 * For smoke-testing the contract and for manual operator moves. Player payouts
 * mint instead (see payout.ts), so the treasury never has to pre-hold rewards.
 */
import { Address } from '@ton/core';
import {
  openTreasury, jettonBalance, explorerUrl, waitForSeqno,
} from '../src/client.js';
import { jettonMaster, toUnits, fromUnits } from '../src/env.js';

async function main() {
  const [rawAddress, rawAmount] = process.argv.slice(2);
  if (!rawAddress || !rawAmount) {
    console.error('usage: npm run transfer -w @snooker/token -- <address> <amount>');
    process.exit(1);
  }

  const treasury = await openTreasury();
  const master = Address.parse(jettonMaster());
  const recipient = Address.parse(rawAddress);
  const units = toUnits(rawAmount);

  const held = await jettonBalance(treasury, master, treasury.wallet.address);
  if (held < units) {
    console.error(`treasury holds ${fromUnits(held)}, cannot transfer ${rawAmount}.`);
    process.exit(1);
  }

  const before = await jettonBalance(treasury, master, recipient);
  const wallet = await treasury.sdk.openJetton(master).getWallet(treasury.wallet.address);

  console.log(`transferring ${rawAmount} from ${treasury.address} to ${recipient.toString()} on ${treasury.network}`);
  const seqno = await treasury.wallet.getSeqno();
  // returnExcess: unspent forward gas comes back to the treasury.
  await wallet.send(treasury.sender, recipient, units, { returnExcess: true });
  if (!(await waitForSeqno(treasury, seqno))) {
    console.log('timed out waiting for the wallet seqno; check the explorer.');
    return;
  }

  // The wallet message lands first; the Jetton wallets update a few blocks later.
  const deadline = Date.now() + 90_000;
  let after = before;
  while (after === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    after = await jettonBalance(treasury, master, recipient);
  }
  console.log(`recipient balance: ${fromUnits(before)} -> ${fromUnits(after)}`);
  console.log(after - before === units ? 'transfer confirmed.' : 'balance did not change as expected; check the explorer.');
  console.log(explorerUrl(treasury.network, recipient.toString()));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
