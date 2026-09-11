/**
 * Deploy the standard TEP-74 Jetton minter, keeping mint authority.
 *
 *   npm run deploy -w @snooker/token
 *
 * Testnet first, always. Fund the treasury wallet from @testgiver_ton_bot
 * before running this — the deploy costs a fraction of a GRAM in fees.
 */
import { openTreasury, treasuryBalance, explorerUrl, waitForSeqno } from '../src/client.js';
import { jettonMeta, fromUnits } from '../src/env.js';

const MIN_BALANCE = 50_000_000n; // 0.05 GRAM, comfortably over deploy cost

async function main() {
  const treasury = await openTreasury();
  const meta = jettonMeta();

  console.log(`network:  ${treasury.network}`);
  console.log(`treasury: ${treasury.address}`);

  const balance = await treasuryBalance(treasury);
  console.log(`balance:  ${Number(balance) / 1e9} GRAM`);
  if (balance < MIN_BALANCE) {
    console.error(
      '\nTreasury balance is too low to deploy.'
      + (treasury.network === 'testnet'
        ? '\nGet testnet funds from @testgiver_ton_bot in Telegram.'
        : '\nTop the wallet up before retrying.'),
    );
    process.exit(1);
  }

  console.log(`\ndeploying jetton "${meta.name}" (${meta.symbol}), ${meta.decimals} decimals…`);

  const seqnoBefore = await treasury.wallet.getSeqno();

  // adminAddress defaults to the sender, but be explicit: mint authority is
  // deliberately retained by the treasury rather than burned at deploy.
  const minter = await treasury.sdk.deployJetton(
    {
      name: meta.name,
      symbol: meta.symbol,
      description: meta.description,
      image: meta.image,
      decimals: meta.decimals,
      renderType: 'game',
    },
    {
      adminAddress: treasury.wallet.address,
      onchainContent: true, // metadata stored on-chain, so no IPFS pin to maintain
    },
  );

  const address = minter.address.toString({
    urlSafe: true, bounceable: true, testOnly: treasury.network === 'testnet',
  });

  console.log(`\njetton master: ${address}`);
  console.log(`explorer:      ${explorerUrl(treasury.network, address)}`);

  const landed = await waitForSeqno(treasury, seqnoBefore);
  console.log(landed ? '\ndeploy message accepted.' : '\ntimed out waiting for the wallet seqno — check the explorer.');

  try {
    const data = await minter.getData();
    console.log(`total supply:  ${fromUnits(data.totalSupply)} ${meta.symbol}`);
    console.log(`admin:         ${data.adminAddress?.toString() ?? '(none)'}`);
  } catch {
    console.log('contract not queryable yet; give it a few seconds and run `npm run info`.');
  }

  console.log('\nNext: put this in your .env files\n');
  console.log(`  JETTON_MASTER_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
