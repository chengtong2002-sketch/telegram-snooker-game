import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

/**
 * One knex config for both engines. SQLite is the default so a clone runs with
 * no services; set DATABASE_URL to a postgres:// URL and the same migrations
 * and queries run unchanged on Railway Postgres.
 */
export function knexConfig() {
  const url = process.env.DATABASE_URL ?? '';
  const isPostgres = url.startsWith('postgres://') || url.startsWith('postgresql://');

  const common = {
    migrations: { directory: path.join(pkgRoot, 'migrations'), loadExtensions: ['.js'] },
    pool: { min: 0, max: isPostgres ? 10 : 1 },
  };

  if (isPostgres) {
    return {
      ...common,
      client: 'pg',
      connection: {
        connectionString: url,
        ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      },
    };
  }

  const filename = url.startsWith('file:')
    ? url.slice('file:'.length)
    : (process.env.SQLITE_PATH ?? path.join(pkgRoot, '..', '..', 'data', 'snooker.sqlite'));

  // better-sqlite3 will not create missing directories, and on a fresh clone
  // ./data does not exist — so the first `npm run migrate` would fail.
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  return {
    ...common,
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
  };
}

export const isPostgres = () => (process.env.DATABASE_URL ?? '').startsWith('postgres');
