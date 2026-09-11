/** Read the deployed Jetton's on-chain state. `npm run info -w @snooker/token` */
import { Address } from '@ton/core';
import { openTreasury, treasuryBalance, explorerUrl } from '../src/client.js';
import { jettonMaster, fromUnits } from '../src/env.js';

async function main() {
  const treasury = await openTreasury();
  const master = Address.parse(jettonMaster());
  const minter = treasury.sdk.openJetton(master);
  const data = await minter.getData();

  console.log(`network:      ${treasury.network}`);
  console.log(`treasury:     ${treasury.address}`);
  console.log(`treasury GRAM: ${Number(await treasuryBalance(treasury)) / 1e9}`);
  console.log(`jetton:       ${master.toString()}`);
  console.log(`total supply: ${fromUnits(data.totalSupply)}`);
  console.log(`admin:        ${data.adminAddress?.toString() ?? '(none — mint authority burned)'}`);
  console.log(`mintable:     ${data.adminAddress ? 'yes' : 'no'}`);
  console.log(`explorer:     ${explorerUrl(treasury.network, master.toString())}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
