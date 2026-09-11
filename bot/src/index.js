import { Bot, GrammyError, HttpError } from 'grammy';
import { migrate, closeDb } from '@snooker/db';
import { config, assertConfig } from './config.js';
import { registerCommands, COMMAND_LIST } from './commands/index.js';
import { startNotificationServer } from './notifications.js';

assertConfig();

const bot = new Bot(config.botToken);

registerCommands(bot);

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('telegram API error:', e.description);
  else if (e instanceof HttpError) console.error('could not reach Telegram:', e);
  else console.error('bot error:', e);
});

await migrate();
await bot.api.setMyCommands(COMMAND_LIST);

const notifyServer = startNotificationServer(bot);

if (config.webhookUrl) {
  // Railway can run this as a web service; long polling is the default locally.
  // The listener mounts /telegram/<INTERNAL_API_KEY>, so point BOT_WEBHOOK_URL there.
  await bot.init();
  await bot.api.setWebhook(config.webhookUrl, { drop_pending_updates: true });
  console.log(`webhook set to ${config.webhookUrl}`);
} else {
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  bot.start({ onStart: (me) => console.log(`@${me.username} polling for updates`) });
}

async function shutdown(signal) {
  console.log(`\n${signal} — stopping bot`);
  await bot.stop();
  notifyServer.close();
  await closeDb();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
