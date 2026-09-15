/**
 * Read the deployed Jetton's on-chain state. Read-only: sends nothing.
 *
 *   npm run info -w @snooker/token                 # the master + the treasury's holdings
 *   npm run info -w @snooker/token -- <address>    # also that address's balance
 */
import { Address } from '@ton/core';
import { openTreasury, treasuryBalance, jettonBalance, explorerUrl } from '../src/client.js';
import { jettonMaster, fromUnits } from '../src/env.js';

async function main() {
  const treasury = await openTreasury();
  const master = Address.parse(jettonMaster());
  const minter = treasury.sdk.openJetton(master);
  const data = await minter.getData();
  const content = await minter.getContent();
  const symbol = content.symbol ?? '';

  console.log(`network:       ${treasury.network}`);
  console.log(`jetton:        ${master.toString()}`);
  console.log(`total supply:  ${fromUnits(data.totalSupply)} ${symbol}`);
  console.log(`admin:         ${data.adminAddress?.toString() ?? '(none — mint authority burned)'}`);
  console.log(`mintable:      ${data.adminAddress ? 'yes' : 'no'}`);
  console.log(`admin is treasury: ${data.adminAddress?.equals(treasury.wallet.address) ? 'yes' : 'NO'}`);

  // What wallets and explorers will actually show, read back from the contract.
  console.log('\nmetadata (as stored):');
  console.log(`  storage:     ${content.type}${content.offchainUrl ? ` (${content.offchainUrl})` : ''}`);
  console.log(`  name:        ${content.name ?? '(unset)'}`);
  console.log(`  symbol:      ${content.symbol ?? '(unset)'}`);
  console.log(`  decimals:    ${content.decimals ?? '(unset — wallets assume 9)'}`);
  console.log(`  description: ${content.description ?? '(unset)'}`);
  console.log(`  image:       ${typeof content.image === 'string' ? content.image : content.image ? '(inline data)' : '(unset)'}`);
  console.log(`  render_type: ${content.render_type ?? '(unset)'}`);

  console.log(`\ntreasury:      ${treasury.address}`);
  console.log(`  GRAM:        ${Number(await treasuryBalance(treasury)) / 1e9}`);
  console.log(`  ${symbol || 'jetton'}:        ${fromUnits(await jettonBalance(treasury, master, treasury.wallet.address))}`);

  const extra = process.argv[2];
  if (extra) {
    const owner = Address.parse(extra);
    console.log(`\n${owner.toString()}`);
    console.log(`  ${symbol || 'jetton'}:        ${fromUnits(await jettonBalance(treasury, master, owner))}`);
  }
  console.log(`\nexplorer:      ${explorerUrl(treasury.network, master.toString())}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
