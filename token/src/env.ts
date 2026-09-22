import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// npm workspaces run each service with cwd set to its own package directory, so
// a bare `import 'dotenv/config'` looks for ./<service>/.env and silently misses
// the repo-root file that .env.example tells you to create. Load both, nearest
// first: dotenv never overwrites an already-set variable, so a per-service .env
// beats the root one, and real environment variables (Railway) beat both.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const dir of ['..', '../..']) {
  loadEnv({ path: path.resolve(here, dir, '.env') });
}

export type Network = 'testnet' | 'mainnet';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const network = (): Network => {
  const value = (process.env.TON_NETWORK ?? 'testnet').toLowerCase();
  if (value !== 'testnet' && value !== 'mainnet') {
    throw new Error(`TON_NETWORK must be "testnet" or "mainnet", got "${value}"`);
  }
  return value;
};

export const mnemonic = (): string[] => required('TON_WALLET_MNEMONIC').trim().split(/\s+/);

export const walletVersion = (): 'v4' | 'v5r1' => {
  const value = (process.env.TON_WALLET_VERSION ?? 'v5r1').toLowerCase();
  if (value !== 'v4' && value !== 'v5r1') {
    throw new Error(`TON_WALLET_VERSION must be "v4" or "v5r1", got "${value}"`);
  }
  return value;
};

export const jettonMaster = (): string => required('JETTON_MASTER_ADDRESS');

// `KEY=` in .env is an empty string, not unset. `??` let that through, which is
// how the testnet master ended up with image "" stored on-chain.
const envOr = (name: string, fallback?: string) => process.env[name]?.trim() || fallback;

/**
 * A dedicated RPC v4 endpoint. Empty falls back to the public Orbs ton-access
 * pool, which is fine for testnet and is not what a mainnet payout should
 * depend on -- see the note on the timeout below.
 */
export const rpcEndpoint = (): string | undefined => envOr('TON_RPC_ENDPOINT');

/**
 * The assets-sdk builds its own client with a fixed 15s timeout, which the
 * public pool does not reliably beat on a send. That matters more here than
 * anywhere else: a mint that times out mid-send leaves the redemption
 * `unconfirmed`, and an unconfirmed row blocks every later payout until an
 * operator has checked the chain by hand. Hence a generous default.
 */
export const rpcTimeoutMs = (): number => {
  const raw = process.env.TON_RPC_TIMEOUT_MS?.trim();
  if (!raw) return 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TON_RPC_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`);
  }
  return value;
};

export const jettonMeta = () => ({
  name: envOr('JETTON_NAME', 'Snooker Points')!,
  symbol: envOr('JETTON_SYMBOL', 'SNKR')!,
  description: envOr(
    'JETTON_DESCRIPTION',
    'In-game reward token for the Snooker Mini App. Earned by making breaks in PvP matches.',
  )!,
  image: envOr('JETTON_IMAGE_URL'),
  decimals: Number(process.env.JETTON_DECIMALS ?? 9),
});

export const DECIMALS = Number(process.env.JETTON_DECIMALS ?? 9);

/** Whole tokens -> the integer unit the contract actually stores. */
export const toUnits = (tokens: number | string): bigint => {
  const [whole, frac = ''] = String(tokens).split('.');
  const padded = (frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS);
  return BigInt(whole || '0') * 10n ** BigInt(DECIMALS) + BigInt(padded || '0');
};

export const fromUnits = (units: bigint): string => {
  const base = 10n ** BigInt(DECIMALS);
  const whole = units / base;
  const frac = (units % base).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

/**
 * Mainnet moves real value. Every script that can spend refuses to run against
 * mainnet unless this is explicitly set, so a stray TON_NETWORK cannot cost money.
 */
export function assertNetworkConfirmed() {
  if (network() === 'mainnet' && process.env.I_UNDERSTAND_THIS_IS_MAINNET !== 'yes') {
    throw new Error(
      'Refusing to run against mainnet. Set I_UNDERSTAND_THIS_IS_MAINNET=yes once you have '
      + 'completed a full testnet run-through.',
    );
  }
}
