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

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  // Public HTTPS URL of the built Mini App (/game). Telegram will not open http://.
  gameUrl: process.env.GAME_URL ?? '',
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:8080',
  internalApiKey: process.env.INTERNAL_API_KEY ?? 'dev-internal-key',
  // Railway injects PORT per service and health-checks that port, so the bot
  // must bind it there. BOT_PORT wins when set, which keeps local dev off the
  // backend's port even when a shared .env defines PORT.
  notifyPort: num(process.env.BOT_PORT ?? process.env.PORT, 8081),
  // Set to use webhooks instead of long polling (Railway can do either).
  webhookUrl: process.env.BOT_WEBHOOK_URL ?? '',
  tonNetwork: process.env.TON_NETWORK ?? 'testnet',
  supportHandle: process.env.SUPPORT_HANDLE ?? '',
};

/** Same rule as the backend: NODE_ENV=production, or on Railway at all. */
export const isDeployed = (env = process.env) => env.NODE_ENV === 'production'
  || ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']
    .some((name) => Boolean(env[name]));

/**
 * The internal key guards /internal/notify (which makes the bot message any
 * player, with a game button) and, in webhook mode, the Telegram update path.
 * The default and the .env.example placeholder are public.
 */
export function productionConfigProblems(cfg = config) {
  const key = cfg.internalApiKey ?? '';
  return key === 'dev-internal-key' || /change-me/i.test(key) || key.length < 24
    ? ['INTERNAL_API_KEY must be a real secret of at least 24 characters (openssl rand -hex 24), the same on bot and backend']
    : [];
}

export function assertConfig() {
  if (!config.botToken) {
    console.error('BOT_TOKEN is not set — copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  const problems = isDeployed() ? productionConfigProblems() : [];
  if (problems.length) {
    console.error(`refusing to start with an unsafe production config:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  if (!config.gameUrl) {
    console.warn('GAME_URL is not set: Mini App buttons will be hidden until it is.');
  } else if (!config.gameUrl.startsWith('https://')) {
    console.warn('GAME_URL must be https:// for Telegram to open it.');
  }
}
