import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import routes, { internalRoutes } from './routes/index.js';
import { isAimPath } from './routes/match.js';
import rmPublicRoutes from './routes/rmPublic.js';

/** Build the Express app. Kept separate from index.js so tests can mount it. */
export function buildApp({ requestLogging = true } = {}) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Before the JSON parser: RM's webhook is checked against its raw body.
  app.use(rmPublicRoutes);
  app.use(express.json({ limit: '256kb' }));
  if (requestLogging) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  }

  const allowAll = config.allowedOrigins.includes('*');
  app.use(cors({
    origin: allowAll ? true : config.allowedOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-internal-key'],
  }));

  // Live aim has its own per-player and per-match caps (routes/match.js): at
  // ~10 updates a second it would use up this limit in half a minute.
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: 240, standardHeaders: true, skip: (req) => isAimPath(req.path),
  }));
  app.use('/api', routes);
  app.use('/internal', internalRoutes);

  app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((err, req, res, _next) => {
    logger.error({ err: err.message, stack: err.stack, path: req.path }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
