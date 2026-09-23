/**
 * Coins, owned cosmetics, and payment orders (docs/store-plan.md,
 * docs/rm-payments-plan.md).
 *
 * coin_ledger — append-only. A balance is SUM(delta); rows are never updated
 *   or deleted, so the ledger is its own audit trail. UNIQUE(ref) is what
 *   makes every credit and debit happen exactly once: a replayed webhook, a
 *   double tap or two racing requests all carry the same ref, and the second
 *   insert is ignored. Refs: `buy:<userId>:<itemId>`, `grant:<uuid>`,
 *   `stars:<chargeId>`, `rm:<transactionId>`, and their refund forms.
 *   actor/note say who and why, for grants and refunds.
 * user_items — what a player owns beyond the Starter items everyone has.
 * users.equipped_cue / equipped_ball — null means the default item.
 * payment_orders / payment_events — one row per attempt to buy a coin pack,
 *   and an append-only log of everything that happened to it. Created now so
 *   Stars and Revenue Monster share one schema; nothing writes them yet.
 *   provider_txn_id is UNIQUE but nullable: both engines allow many NULLs.
 */
export async function up(knex) {
  await knex.schema.createTable('coin_ledger', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('delta').notNullable();
    t.string('reason', 16).notNullable(); // purchase | refund | spend | grant
    t.string('ref', 128).notNullable().unique();
    t.string('actor', 64);
    t.string('note', 200);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
  });

  await knex.schema.createTable('user_items', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('item_id', 40).notNullable();
    t.bigInteger('ledger_id').references('id').inTable('coin_ledger');
    t.timestamp('acquired_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'item_id']);
  });

  await knex.schema.alterTable('users', (t) => {
    t.string('equipped_cue', 40);
    t.string('equipped_ball', 40);
  });

  await knex.schema.createTable('payment_orders', (t) => {
    t.string('id', 24).primary(); // ours; Revenue Monster's order.id limit is 24
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('provider', 8).notNullable(); // stars | rm
    t.string('pack_id', 32).notNullable();
    t.integer('coins').notNullable();
    t.bigInteger('amount').notNullable(); // minor units: sen, or Stars
    t.string('currency', 3).notNullable(); // XTR | MYR
    t.string('status', 20).notNullable().defaultTo('created');
    t.string('provider_checkout_id', 128);
    t.string('provider_txn_id', 128).unique();
    t.bigInteger('refunded_amount').notNullable().defaultTo(0);
    t.string('failure_reason', 200);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at');
    t.timestamp('paid_at');
    t.timestamp('last_checked_at');
    t.index(['user_id', 'status']);
    t.index(['status']);
  });

  await knex.schema.createTable('payment_events', (t) => {
    t.bigIncrements('id').primary();
    t.timestamp('at').notNullable().defaultTo(knex.fn.now());
    t.string('order_id', 24); // null for a forged or unknown notification
    t.string('source', 16).notNullable(); // api | webhook | return | reconcile | admin | bot
    t.string('event', 32).notNullable();
    t.boolean('signature_ok');
    t.text('payload'); // JSON, secrets and headers removed
    t.string('outcome', 32);
    t.index(['order_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('payment_events');
  await knex.schema.dropTable('payment_orders');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('equipped_ball');
    t.dropColumn('equipped_cue');
  });
  await knex.schema.dropTable('user_items');
  await knex.schema.dropTable('coin_ledger');
}
