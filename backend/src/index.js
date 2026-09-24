import { migrate, closeDb, purgeExpiredChallenges } from '@snooker/db';
import { config, assertProductionConfig } from './config.js';
import { logger } from './logger.js';
import { buildApp } from './app.js';
import { sweepShotClocks } from './services/matchService.js';
import { reconcileStars } from './services/stars.js';

assertProductionConfig(logger);
if (process.env.SHOT_CLOCK_SECONDS && Number(process.env.SHOT_CLOCK_SECONDS) !== config.shotClockSeconds) {
  logger.warn(
    { SHOT_CLOCK_SECONDS: process.env.SHOT_CLOCK_SECONDS, shotClockSeconds: config.shotClockSeconds },
    'SHOT_CLOCK_SECONDS is ignored: the shot clock is SHOT_CLOCK_MS in shared/sim, so client and server always agree',
  );
}

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
// Mini App mid-turn still loses the turn. Every 2s so an expired turn passes
// within a couple of seconds of the grace period ending, not up to 10s later
// while the player's countdown sits at zero.
const sweeper = setInterval(() => {
  sweepShotClocks().catch((err) => logger.error({ err: err.message }, 'sweep failed'));
}, 2_000);

// Expired TON Connect nonces are already rejected on use; this just stops the
// table growing for every challenge a player requested and never completed.
const challengeReaper = setInterval(() => {
  purgeExpiredChallenges().catch((err) => logger.error({ err: err.message }, 'challenge purge failed'));
}, 10 * 60_000);
challengeReaper.unref();

// A Stars payment the bot never passed on (bot or backend down at the time) is
// still in Telegram's transaction list: credit it from there. Does nothing
// while Stars are switched off.
const starsReconciler = setInterval(() => {
  reconcileStars().catch((err) => logger.error({ err: err.message }, 'stars reconcile failed'));
}, 5 * 60_000);
starsReconciler.unref();

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  clearInterval(challengeReaper);
  clearInterval(starsReconciler);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
