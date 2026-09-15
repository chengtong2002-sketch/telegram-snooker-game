import { Bot, GrammyError, HttpError } from 'grammy';
import { migrate, closeDb } from '@snooker/db';
import { config, assertConfig } from './config.js';
import { registerCommands, COMMAND_LIST } from './commands/index.js';
import { startNotificationServer } from './notifications.js';

assertConfig();

const bot = new Bot(config.botToken);

// One line per incoming update (kind only, no message content), so "the bot is
// not responding" can be told apart from "the bot never received anything".
bot.use((ctx, next) => {
  const kind = Object.keys(ctx.update).find((k) => k !== 'update_id');
  const text = ctx.message?.text?.startsWith('/') ? ` ${ctx.message.text.split(/\s/)[0]}` : '';
  console.log(`update ${ctx.update.update_id}: ${kind}${text}`);
  return next();
});

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
  // Keep pending updates: commands sent while the bot was restarting or down
  // (a deploy, a crash) should still get answered, not silently vanish.
  await bot.api.setWebhook(config.webhookUrl, { drop_pending_updates: false });
  console.log(`webhook set to ${config.webhookUrl}`);
} else {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
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
