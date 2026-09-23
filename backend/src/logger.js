import pino from 'pino';

const production = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Railway parses each JSON line and reads `level` to classify severity. Pino
  // writes the numeric level (30/40/50), which Railway does not recognise, so
  // every line arrived tagged "info" — including `bot notify failed`, the one
  // warning that says a player will never be told it is their turn. Emit the
  // label instead, and only in production: pino-pretty wants the number.
  ...(production ? { formatters: { level: (label) => ({ level: label }) } } : {}),
  transport: production
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
