import 'dotenv/config';

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

export function assertProductionConfig(logger) {
  if (config.nodeEnv !== 'production') return;
  const problems = [];
  if (!config.botToken) problems.push('BOT_TOKEN is required to verify Telegram initData');
  if (config.jwtSecret === 'dev-only-insecure-secret') problems.push('JWT_SECRET must be set');
  if (config.allowedOrigins.includes('*')) problems.push('ALLOWED_ORIGINS must not be *');
  if (config.allowDevAuth) problems.push('ALLOW_DEV_AUTH must be off in production');
  if (problems.length) {
    logger.error({ problems }, 'refusing to start with an unsafe production config');
    process.exit(1);
  }
}
