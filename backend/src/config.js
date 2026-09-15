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

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback = false) => (v === undefined ? fallback : /^(1|true|yes)$/i.test(v));

export const config = {
  port: num(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  botToken: process.env.BOT_TOKEN ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
  jwtTtl: process.env.JWT_TTL ?? '12h',

  // Comma-separated. The Mini App origin must be listed in production.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),

  // Bot notification hook (backend -> bot) for "your turn" pushes.
  botNotifyUrl: process.env.BOT_NOTIFY_URL ?? 'http://localhost:8081/internal/notify',
  internalApiKey: process.env.INTERNAL_API_KEY ?? 'dev-internal-key',

  shotClockSeconds: num(process.env.SHOT_CLOCK_SECONDS, 25),

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
    autoPayout: bool(process.env.REWARD_AUTO_PAYOUT, false),
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

export function assertProductionConfig(logger, env = process.env) {
  if (!isDeployed(env)) return;
  const problems = productionConfigProblems();
  if (problems.length) {
    logger.error({ problems }, 'refusing to start with an unsafe production config');
    process.exit(1);
  }
}
