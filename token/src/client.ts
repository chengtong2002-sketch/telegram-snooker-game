import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient4, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { AssetsSDK, NoopStorage } from '@ton-community/assets-sdk';
import { getHttpV4Endpoint } from '@orbs-network/ton-access';
import type { Address, OpenedContract, Sender } from '@ton/core';
import {
  network, mnemonic, walletVersion, assertNetworkConfirmed, rpcEndpoint, rpcTimeoutMs, type Network,
} from './env.js';

type TreasuryWallet = WalletContractV4 | WalletContractV5R1;

export interface Treasury {
  sdk: AssetsSDK;
  api: TonClient4;
  wallet: OpenedContract<TreasuryWallet>;
  sender: Sender;
  address: string;
  network: 'testnet' | 'mainnet';
}

/**
 * The API client, built here rather than with the SDK's createApi, which pins
 * `timeout: 15000` at whatever endpoint the public Orbs pool hands out and
 * exposes no way to change either. Both are worth controlling: see
 * rpcTimeoutMs in env.ts for why a send in particular must not time out, and
 * rpcEndpoint for pointing a mainnet treasury at an RPC we actually pay for.
 */
export async function createApi(net: Network): Promise<TonClient4> {
  const endpoint = rpcEndpoint() ?? await getHttpV4Endpoint({ network: net });
  return new TonClient4({ endpoint, timeout: rpcTimeoutMs() });
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

  const wallet = api.open(
    createWallet(net, keyPair.publicKey),
  ) as OpenedContract<TreasuryWallet>;

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

/**
 * The same mnemonic yields a different address per wallet contract version, so
 * this must match the wallet app that holds the funds. Current Tonkeeper and
 * Telegram Wallet create W5 (v5r1). A v5r1 wallet id also embeds the network,
 * so a testnet W5 address differs from the mainnet one.
 */
function createWallet(net: Network, publicKey: Buffer): TreasuryWallet {
  if (walletVersion() === 'v4') {
    return WalletContractV4.create({ workchain: 0, publicKey });
  }
  return WalletContractV5R1.create({
    publicKey,
    walletId: { networkGlobalId: net === 'testnet' ? -3 : -239 },
  });
}

export async function treasuryBalance(treasury: Treasury): Promise<bigint> {
  return treasury.wallet.getBalance();
}

/**
 * An owner's Jetton balance, in contract units. A holder's Jetton wallet is only
 * deployed by the first mint or transfer to it, so an address that never
 * received any has no contract to query: that reads as 0, not an error.
 */
export async function jettonBalance(treasury: Treasury, master: Address, owner: Address): Promise<bigint> {
  const wallet = await treasury.sdk.openJetton(master).getWallet(owner);
  const { state } = await treasury.api.provider(wallet.address).getState();
  if (state.type !== 'active') return 0n;
  return (await wallet.getData()).balance;
}

export const explorerUrl =(net: 'testnet' | 'mainnet', address: string) =>
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
