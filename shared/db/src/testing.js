import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';

/**
 * A throwaway database for one test file. Call it before anything touches the
 * db (it sets DATABASE_URL), and await the returned cleanup after closeDb().
 *
 * SQLite by default. Set TEST_POSTGRES_URL (a server URL whose user may create
 * databases, e.g. postgres://postgres:pw@localhost:5432/postgres) to run the
 * same suite on Postgres: each file gets its own database, so test files that
 * run in parallel cannot see each other's rows.
 */
export async function useTestDatabase(label) {
  const name = `snooker_${label}_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const server = process.env.TEST_POSTGRES_URL;

  if (!server) {
    const file = path.join(os.tmpdir(), `${name}.sqlite`);
    process.env.DATABASE_URL = `file:${file}`;
    return async () => fs.rmSync(file, { force: true });
  }

  const admin = knexFactory({ client: 'pg', connection: server, pool: { min: 0, max: 1 } });
  await admin.raw(`CREATE DATABASE "${name}"`);
  await admin.destroy();

  const url = new URL(server);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  process.env.PGSSL ??= 'disable';

  return async () => {
    const drop = knexFactory({ client: 'pg', connection: server, pool: { min: 0, max: 1 } });
    await drop.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await drop.destroy();
  };
}
