import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient4, WalletContractV4 } from '@ton/ton';
import { AssetsSDK, createApi, NoopStorage } from '@ton-community/assets-sdk';
import type { OpenedContract, Sender } from '@ton/core';
import { network, mnemonic, assertNetworkConfirmed } from './env.js';

export interface Treasury {
  sdk: AssetsSDK;
  api: Awaited<ReturnType<typeof createApi>>;
  wallet: OpenedContract<WalletContractV4>;
  sender: Sender;
  address: string;
  network: 'testnet' | 'mainnet';
}

/**
 * Open the treasury wallet and an AssetsSDK bound to it.
 *
 * The SDK ships the standard TEP-74 minter code, which is the "no-code" path:
 * we deploy the reference Jetton contract rather than writing and auditing our
 * own emission contract. Mint authority stays with this wallet.
 */
export async function openTreasury(): Promise<Treasury> {
  assertNetworkConfirmed();

  const net = network();
  const api = await createApi(net);
  const keyPair = await mnemonicToPrivateKey(mnemonic());

  const wallet = (api as unknown as TonClient4).open(
    WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }),
  ) as OpenedContract<WalletContractV4>;

  const sender = wallet.sender(keyPair.secretKey);
  const sdk = AssetsSDK.create({ api, sender, storage: new NoopStorage() });

  return {
    sdk,
    api,
    wallet,
    sender,
    address: wallet.address.toString({ urlSafe: true, bounceable: false, testOnly: net === 'testnet' }),
    network: net,
  };
}

export async function treasuryBalance(treasury: Treasury): Promise<bigint> {
  return treasury.wallet.getBalance();
}

export const explorerUrl = (net: 'testnet' | 'mainnet', address: string) =>
  `https://${net === 'testnet' ? 'testnet.' : ''}tonviewer.com/${address}`;

/** Poll until the wallet's seqno advances, i.e. the message actually landed. */
export async function waitForSeqno(treasury: Treasury, before: number, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const now = await treasury.wallet.getSeqno();
    if (now > before) return true;
  }
  return false;
}
