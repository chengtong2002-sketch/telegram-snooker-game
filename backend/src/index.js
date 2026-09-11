import { migrate, closeDb, purgeExpiredChallenges } from '@snooker/db';
import { config, assertProductionConfig } from './config.js';
import { logger } from './logger.js';
import { buildApp } from './app.js';
import { sweepShotClocks } from './services/matchService.js';

assertProductionConfig(logger);

const app = buildApp();

const server = app.listen(config.port, async () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'snooker backend listening');
  try {
    await migrate();
    logger.info('migrations up to date');
  } catch (err) {
    logger.error({ err: err.message }, 'migration failed');
  }
});

// The shot clock is enforced here, not on the client — a player who closes the
// Mini App mid-turn still loses the turn.
const sweeper = setInterval(() => {
  sweepShotClocks().catch((err) => logger.error({ err: err.message }, 'sweep failed'));
}, 10_000);

// Expired TON Connect nonces are already rejected on use; this just stops the
// table growing for every challenge a player requested and never completed.
const challengeReaper = setInterval(() => {
  purgeExpiredChallenges().catch((err) => logger.error({ err: err.message }, 'challenge purge failed'));
}, 10 * 60_000);
challengeReaper.unref();

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  clearInterval(challengeReaper);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
