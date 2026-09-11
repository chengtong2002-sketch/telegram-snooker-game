import knexFactory from 'knex';
import { knexConfig, isPostgres } from './config.js';

let db = null;

export function getDb() {
  if (!db) db = knexFactory(knexConfig());
  return db;
}

export async function closeDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function migrate() {
  await getDb().migrate.latest();
}

export { isPostgres };

// JSON columns are plain text so the same code works on both engines.
export const toJson = (value) => JSON.stringify(value);
export const fromJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/** Booleans come back as 0/1 on SQLite and true/false on Postgres. */
export const toBool = (v) => v === true || v === 1 || v === '1' || v === 't';

// --- users -----------------------------------------------------------------

export async function upsertUser(tg) {
  const knex = getDb();
  const existing = await knex('users').where({ telegram_id: tg.id }).first();
  if (existing) {
    await knex('users').where({ id: existing.id }).update({
      username: tg.username ?? existing.username,
      first_name: tg.first_name ?? existing.first_name,
      language_code: tg.language_code ?? existing.language_code,
      updated_at: knex.fn.now(),
    });
    return { ...existing, username: tg.username ?? existing.username };
  }
  const [row] = await knex('users')
    .insert({
      telegram_id: tg.id,
      username: tg.username ?? null,
      first_name: tg.first_name ?? null,
      language_code: tg.language_code ?? null,
    })
    .returning('*');
  // SQLite's returning gives the row; if a driver returns only an id, re-read.
  if (row && typeof row === 'object' && row.id) return row;
  return knex('users').where({ telegram_id: tg.id }).first();
}

export const userByTelegramId = (telegramId) =>
  getDb()('users').where({ telegram_id: telegramId }).first();

export const userById = (id) => getDb()('users').where({ id }).first();

// --- wallets ---------------------------------------------------------------

export async function linkWallet(userId, { address, network, publicKey }) {
  const knex = getDb();
  await knex('wallets').where({ user_id: userId }).update({ active: false });
  const existing = await knex('wallets').where({ user_id: userId, address, network }).first();
  if (existing) {
    await knex('wallets').where({ id: existing.id })
      .update({ active: true, verified_at: knex.fn.now(), public_key: publicKey ?? existing.public_key });
    return knex('wallets').where({ id: existing.id }).first();
  }
  await knex('wallets').insert({
    user_id: userId, address, network, public_key: publicKey ?? null,
    active: true, verified_at: knex.fn.now(),
  });
  return knex('wallets').where({ user_id: userId, address, network }).first();
}

export const activeWallet = (userId) =>
  getDb()('wallets').where({ user_id: userId, active: true }).first();

// --- leaderboard -----------------------------------------------------------

/**
 * Leaderboard is PvP-only by construction: eligible_breaks only ever receives
 * rows from crypto-eligible (PvP) matches.
 */
export async function leaderboard({ periodId = null, limit = 10 } = {}) {
  const knex = getDb();
  const q = knex('eligible_breaks as eb')
    .join('users as u', 'u.id', 'eb.user_id')
    .select('u.id', 'u.username', 'u.first_name')
    .max({ best_break: 'eb.break_value' })
    .sum({ total_points: 'eb.break_value' })
    .count({ matches: 'eb.id' })
    .groupBy('u.id', 'u.username', 'u.first_name')
    .orderBy('best_break', 'desc')
    .limit(limit);
  if (periodId) q.where('eb.period_id', periodId);
  return q;
}
