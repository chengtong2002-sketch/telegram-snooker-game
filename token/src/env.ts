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

export const jettonMeta = () => ({
  name: process.env.JETTON_NAME ?? 'Snooker Points',
  symbol: process.env.JETTON_SYMBOL ?? 'SNKR',
  description: process.env.JETTON_DESCRIPTION
    ?? 'In-game reward token for the Snooker Mini App. Earned by making breaks in PvP matches.',
  image: process.env.JETTON_IMAGE_URL ?? undefined,
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
