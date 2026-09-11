import 'dotenv/config';

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  // Public HTTPS URL of the built Mini App (/game). Telegram will not open http://.
  gameUrl: process.env.GAME_URL ?? '',
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:8080',
  internalApiKey: process.env.INTERNAL_API_KEY ?? 'dev-internal-key',
  notifyPort: num(process.env.BOT_PORT, 8081),
  // Set to use webhooks instead of long polling (Railway can do either).
  webhookUrl: process.env.BOT_WEBHOOK_URL ?? '',
  tonNetwork: process.env.TON_NETWORK ?? 'testnet',
  supportHandle: process.env.SUPPORT_HANDLE ?? '',
};

export function assertConfig() {
  if (!config.botToken) {
    console.error('BOT_TOKEN is not set — copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  if (!config.gameUrl) {
    console.warn('GAME_URL is not set: Mini App buttons will be hidden until it is.');
  } else if (!config.gameUrl.startsWith('https://')) {
    console.warn('GAME_URL must be https:// for Telegram to open it.');
  }
}
