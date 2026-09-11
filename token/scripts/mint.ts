/**
 * Mint tokens to an address by hand.
 *
 *   npm run mint -w @snooker/token -- <address> <amount>
 *
 * Used for smoke-testing a fresh deploy. Real payouts go through `payout.ts`,
 * which reads the redemption queue and records transaction results.
 */
import { Address } from '@ton/core';
import { openTreasury, explorerUrl, waitForSeqno } from '../src/client.js';
import { jettonMaster, toUnits } from '../src/env.js';

async function main() {
  const [rawAddress, rawAmount] = process.argv.slice(2);
  if (!rawAddress || !rawAmount) {
    console.error('usage: npm run mint -w @snooker/token -- <address> <amount>');
    process.exit(1);
  }

  const treasury = await openTreasury();
  const minter = treasury.sdk.openJetton(Address.parse(jettonMaster()));
  const recipient = Address.parse(rawAddress);
  const units = toUnits(rawAmount);

  console.log(`minting ${rawAmount} to ${recipient.toString()} on ${treasury.network}`);
  const seqno = await treasury.wallet.getSeqno();
  await minter.sendMint(treasury.sender, recipient, units);
  const landed = await waitForSeqno(treasury, seqno);
  console.log(landed ? 'sent.' : 'timed out waiting for confirmation; check the explorer.');
  console.log(explorerUrl(treasury.network, recipient.toString()));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
