/**
 * Room for Telegram's Stars charge ids.
 *
 * A real telegram_payment_charge_id is about 140 characters (first live one,
 * Sep 25), and Telegram documents no limit. coin_ledger.ref holds
 * `stars:<id>` / `stars-refund:<id>` and payment_orders.provider_txn_id holds
 * the id itself, both varchar(128) until now, so the first real payment could
 * not be recorded. 255 leaves room over the 200 that stars.js accepts.
 *
 * Postgres only: SQLite does not enforce varchar lengths (which is how tests
 * missed this). Widening keeps the UNIQUE indexes and NOT NULL as they are.
 */
export async function up(knex) {
  if (knex.client.config.client !== 'pg') return;
  await knex.raw('ALTER TABLE coin_ledger ALTER COLUMN ref TYPE varchar(255)');
  await knex.raw('ALTER TABLE payment_orders ALTER COLUMN provider_txn_id TYPE varchar(255)');
  await knex.raw('ALTER TABLE payment_orders ALTER COLUMN provider_checkout_id TYPE varchar(255)');
}

export async function down(knex) {
  if (knex.client.config.client !== 'pg') return;
  await knex.raw('ALTER TABLE payment_orders ALTER COLUMN provider_checkout_id TYPE varchar(128)');
  await knex.raw('ALTER TABLE payment_orders ALTER COLUMN provider_txn_id TYPE varchar(128)');
  await knex.raw('ALTER TABLE coin_ledger ALTER COLUMN ref TYPE varchar(128)');
}
