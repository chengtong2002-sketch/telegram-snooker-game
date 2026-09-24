import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { SHOT_CLOCK_MS, SHOT_CLOCK_GRACE_MS } from '@snooker/sim';
import { parsePacks } from './packs.js';

// npm workspaces run each service with cwd set to its own package directory, so
// a bare `import 'dotenv/config'` looks for ./<service>/.env and silently misses
// the repo-root file that .env.example tells you to create. Load both, nearest
// first: dotenv never overwrites an already-set variable, so a per-service .env
// beats the root one, and real environment variables (Railway) beat both.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const dir of ['..', '../..']) {
  loadEnv({ path: path.resolve(here, dir, '.env') });
}

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback = false) => (v === undefined ? fallback : /^(1|true|yes)$/i.test(v));
// A PEM from one env line: Railway variables can't hold newlines, so \n escapes are accepted.
const pem = (v) => (v ?? '').trim().replace(/\\n/g, '\n');

export const config = {
  port: num(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // Trimmed, and not just for tidiness. The token is the HMAC key for every
  // initData check (see auth.js), so one trailing newline from a copy-paste
  // changes the key and rejects every real sign-in with "bad signature" --
  // while the Bot API itself keeps working, because a URL drops trailing
  // control characters. That asymmetry (bot fine, Mini App broken) cost a
  // deploy on Railway; a token never legitimately has whitespace.
  botToken: (process.env.BOT_TOKEN ?? '').trim(),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
  jwtTtl: process.env.JWT_TTL ?? '12h',

  // Comma-separated. The Mini App origin must be listed in production.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),

  // Bot notification hook (backend -> bot) for "your turn" pushes.
  botNotifyUrl: process.env.BOT_NOTIFY_URL ?? 'http://localhost:8081/internal/notify',
  internalApiKey: process.env.INTERNAL_API_KEY ?? 'dev-internal-key',

  // Not configurable: the Mini App counts down the same shared constant, and a
  // different server value is exactly how a player sees time left after the
  // server has taken their turn. Change SHOT_CLOCK_MS in shared/sim instead.
  shotClockSeconds: SHOT_CLOCK_MS / 1000,
  shotClockGraceMs: SHOT_CLOCK_GRACE_MS,

  ton: {
    network: process.env.TON_NETWORK ?? 'testnet',
    jettonMaster: process.env.JETTON_MASTER_ADDRESS ?? '',
  },

  tonConnect: {
    manifestUrl: process.env.TONCONNECT_MANIFEST_URL ?? '',
    // Domains a ton_proof may be signed for. Empty = accept any (dev only).
    allowedDomains: (process.env.TONCONNECT_ALLOWED_DOMAINS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  rewards: {
    periodKind: process.env.REWARD_PERIOD_KIND ?? 'daily', // 'daily' | 'weekly'
    budgetTokens: num(process.env.REWARD_BUDGET_TOKENS, 1000),
    // Hard ceiling on a single player's share of one period's budget.
    maxShare: num(process.env.REWARD_MAX_SHARE, 0.25),
    minPointsToRedeem: num(process.env.REWARD_MIN_POINTS, 10),
    // How long after a period closes its reward can still be claimed. After
    // that an unclaimed reward expires and is never minted.
    claimWindowDays: num(process.env.REWARD_CLAIM_WINDOW_DAYS, 30),
    autoPayout: bool(process.env.REWARD_AUTO_PAYOUT, false),
    // Test accounts (Telegram user ids, comma-separated) that skip the daily
    // match / pairing limits and the wallet-change claim cooldown. Anything in
    // this list can farm rewards, so keep it empty outside testnet.
    limitExemptTelegramIds: new Set((process.env.REWARD_LIMIT_EXEMPT_TELEGRAM_IDS ?? '')
      .split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))),
  },

  store: {
    packs: parsePacks(process.env.COIN_PACKS),
    // Off by default: on the production bot a Star is real money. Prove it on
    // Telegram's test environment first (TELEGRAM_TEST_ENV + a test-server bot).
    starsEnabled: bool(process.env.PAYMENTS_STARS_ENABLED, false),
    // With Stars off for everyone, these Telegram user ids may still buy with
    // them (comma-separated): real-money testing on the production bot by the
    // owner. Ignored when PAYMENTS_STARS_ENABLED is on (everyone can then).
    starsAllowTelegramIds: new Set((process.env.PAYMENTS_STARS_ALLOW_TELEGRAM_IDS ?? '')
      .split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))),
  },

  // Revenue Monster (MYR), sandbox only: the hosts are fixed in
  // services/rm/client.js and nothing here can point them at production.
  rm: {
    enabled: bool(process.env.PAYMENTS_RM_ENABLED, false),
    clientId: (process.env.RM_CLIENT_ID ?? '').trim(),
    clientSecret: (process.env.RM_CLIENT_SECRET ?? '').trim(),
    storeId: (process.env.RM_STORE_ID ?? '').trim(),
    privateKey: pem(process.env.RM_PRIVATE_KEY),
    serverPublicKey: pem(process.env.RM_SERVER_PUBLIC_KEY),
    publicBackendUrl: (process.env.PUBLIC_BACKEND_URL ?? '').trim().replace(/\/+$/, ''),
    returnAppUrl: (process.env.RM_RETURN_APP_URL ?? 'https://t.me/snookerPlayBot/play').trim().replace(/\/+$/, ''),
  },

  telegram: {
    // Only tests point this elsewhere (a local stub of the Bot API).
    apiRoot: (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    // Telegram's test environment: same host, /bot<token>/test/<method>.
    testEnv: bool(process.env.TELEGRAM_TEST_ENV, false),
  },

  // Allows local dev without a real Telegram client.
  allowDevAuth: bool(process.env.ALLOW_DEV_AUTH, false),
};

/**
 * Deployed means NODE_ENV=production OR running on Railway at all. Keying the
 * safety check off NODE_ENV alone failed open: forget that one variable (or
 * paste a local .env, which says development) and every check below was skipped.
 */
export const isDeployed = (env = process.env) => env.NODE_ENV === 'production'
  || ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']
    .some((name) => Boolean(env[name]));

// Defaults and .env.example placeholders are public — as good as no secret.
const weakSecret = (value, fallback, minLength) => !value || value === fallback
  || /change-me/i.test(value) || value.length < minLength;

/** Everything unsafe about `cfg` for a deployed backend. Pure, for tests. */
export function productionConfigProblems(cfg = config) {
  const problems = [];
  if (!cfg.botToken) problems.push('BOT_TOKEN is required to verify Telegram initData');
  if (weakSecret(cfg.jwtSecret, 'dev-only-insecure-secret', 32)) {
    problems.push('JWT_SECRET must be a real secret of at least 32 characters (openssl rand -hex 32)');
  }
  if (weakSecret(cfg.internalApiKey, 'dev-internal-key', 24)) {
    problems.push('INTERNAL_API_KEY must be a real secret of at least 24 characters (openssl rand -hex 24)');
  }
  if (cfg.allowedOrigins.includes('*')) problems.push('ALLOWED_ORIGINS must list the game origin, not *');
  if (cfg.allowDevAuth) problems.push('ALLOW_DEV_AUTH must be off — it lets anyone sign in as anyone');
  if (cfg.tonConnect.allowedDomains.length === 0) {
    problems.push('TONCONNECT_ALLOWED_DOMAINS must name the game domain — empty accepts wallet proofs signed for any site');
  }
  return problems;
}

/**
 * What is missing or broken for Revenue Monster, when it is switched on. Pure,
 * for tests. Checked everywhere, not only when deployed: a half-configured
 * payment provider fails closed at boot instead of at a player's first order.
 */
export function rmConfigProblems(rm = config.rm) {
  if (!rm.enabled) return [];
  const problems = [];
  for (const [key, name] of [['clientId', 'RM_CLIENT_ID'], ['clientSecret', 'RM_CLIENT_SECRET'], ['storeId', 'RM_STORE_ID']]) {
    if (!rm[key]) problems.push(`${name} is required when PAYMENTS_RM_ENABLED is on`);
  }
  try {
    const key = createPrivateKey(rm.privateKey);
    if (key.asymmetricKeyType !== 'rsa') problems.push('RM_PRIVATE_KEY must be an RSA key');
  } catch {
    problems.push('RM_PRIVATE_KEY must be our RSA private key as PEM');
  }
  try {
    createPublicKey(rm.serverPublicKey);
  } catch {
    problems.push("RM_SERVER_PUBLIC_KEY must be Revenue Monster's server public key as PEM");
  }
  if (!/^https:\/\/[^/]+/.test(rm.publicBackendUrl)) {
    problems.push('PUBLIC_BACKEND_URL must be the https address RM can reach this backend on');
  }
  if (!/^https:\/\/t\.me\/[^/]+\/[^/]+$/.test(rm.returnAppUrl)) {
    problems.push('RM_RETURN_APP_URL must be a Mini App link like https://t.me/<bot>/<app>');
  }
  return problems;
}

export function assertPaymentsConfig(logger) {
  const problems = rmConfigProblems();
  if (problems.length) {
    logger.error({ problems }, 'refusing to start: Revenue Monster is switched on but not configured');
    process.exit(1);
  }
}

export function assertProductionConfig(logger, env = process.env) {
  if (!isDeployed(env)) return;
  if (config.rewards.limitExemptTelegramIds.size > 0) {
    logger.warn(
      { telegramIds: [...config.rewards.limitExemptTelegramIds], network: config.ton.network },
      'REWARD_LIMIT_EXEMPT_TELEGRAM_IDS is set: these accounts bypass the daily reward limits and the wallet cooldown',
    );
  }
  const problems = productionConfigProblems();
  if (problems.length) {
    logger.error({ problems }, 'refusing to start with an unsafe production config');
    process.exit(1);
  }
}
