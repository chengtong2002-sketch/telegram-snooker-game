/**
 * TON Connect nonces, moved out of backend process memory.
 *
 * The nonce has to survive a restart and be visible to every replica: it is
 * issued by whichever instance serves /wallet/challenge and consumed by
 * whichever one serves /wallet/link, and those need not be the same process.
 *
 * One row per (user, purpose) — issuing a new challenge replaces the old one,
 * so a user can never hold two live nonces at once.
 */
export async function up(knex) {
  await knex.schema.createTable('auth_challenges', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('purpose', 24).notNullable().defaultTo('ton_proof');
    t.string('payload', 128).notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'purpose']);
    t.index(['expires_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('auth_challenges');
}
