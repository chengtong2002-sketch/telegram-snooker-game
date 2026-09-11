/**
 * Initial schema. Written against the knex subset that behaves identically on
 * SQLite and Postgres — no engine-specific types, JSON stored as text.
 */
export async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('telegram_id').notNullable().unique();
    t.string('username');
    t.string('first_name');
    t.string('language_code', 8);
    t.integer('frames_won').notNullable().defaultTo(0);
    t.integer('frames_played').notNullable().defaultTo(0);
    t.integer('best_break').notNullable().defaultTo(0);
    t.integer('lifetime_eligible_points').notNullable().defaultTo(0);
    t.boolean('banned').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('wallets', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('address').notNullable();
    t.string('network', 16).notNullable().defaultTo('testnet');
    t.string('public_key');
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('verified_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'address', 'network']);
    t.index(['user_id', 'active']);
  });

  await knex.schema.createTable('matches', (t) => {
    t.string('id', 40).primary();               // uuid
    t.string('mode', 16).notNullable();          // 'pvp' | 'practice'
    t.bigInteger('player_a').references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('player_b').references('id').inTable('users').onDelete('SET NULL');
    t.string('status', 16).notNullable().defaultTo('waiting'); // waiting|active|completed|abandoned
    t.text('state').notNullable();               // JSON match state (frames, balls, scores)
    t.integer('turn_index').notNullable().defaultTo(0);
    t.bigInteger('turn_user_id');
    t.timestamp('shot_deadline');
    t.integer('frames_won_a').notNullable().defaultTo(0);
    t.integer('frames_won_b').notNullable().defaultTo(0);
    t.integer('high_break_a').notNullable().defaultTo(0);
    t.integer('high_break_b').notNullable().defaultTo(0);
    t.bigInteger('winner_id');
    // Set once at creation from mode; practice can never become eligible.
    t.boolean('crypto_eligible').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at');
    t.index(['status', 'mode']);
    t.index(['turn_user_id', 'status']);
  });

  await knex.schema.createTable('shots', (t) => {
    t.bigIncrements('id').primary();
    // Client-generated, globally unique. The dedupe key for offline replay.
    t.string('result_id', 64).notNullable().unique();
    t.string('match_id', 40).notNullable().references('id').inTable('matches').onDelete('CASCADE');
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('frame_number').notNullable().defaultTo(1);
    t.integer('shot_number').notNullable();
    t.text('shot').notNullable();                // JSON {angle, power, cuePlacement}
    t.text('outcome').notNullable();             // JSON server-resolved outcome
    t.boolean('foul').notNullable().defaultTo(false);
    t.integer('points').notNullable().defaultTo(0);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['match_id', 'shot_number']);
  });

  await knex.schema.createTable('matchmaking_queue', (t) => {
    t.bigInteger('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    t.index(['joined_at']);
  });

  await knex.schema.createTable('reward_periods', (t) => {
    t.bigIncrements('id').primary();
    t.string('kind', 8).notNullable();           // 'daily' | 'weekly'
    t.timestamp('starts_at').notNullable();
    t.timestamp('ends_at').notNullable();
    // Budget in whole tokens for this period. rate = budget / total_eligible_points.
    t.decimal('budget_tokens', 20, 9).notNullable().defaultTo(0);
    t.integer('total_eligible_points').notNullable().defaultTo(0);
    t.decimal('rate', 20, 9);
    t.boolean('finalized').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['kind', 'starts_at']);
    t.index(['kind', 'ends_at']);
  });

  // One row per PvP match: the single highest break in that match, capped at 147.
  await knex.schema.createTable('eligible_breaks', (t) => {
    t.bigIncrements('id').primary();
    t.string('match_id', 40).notNullable().references('id').inTable('matches').onDelete('CASCADE');
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('period_id').notNullable().references('id').inTable('reward_periods').onDelete('CASCADE');
    t.integer('break_value').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['match_id']);                       // one eligible break per match, ever
    t.index(['period_id', 'user_id']);
  });

  await knex.schema.createTable('redemptions', (t) => {
    t.bigIncrements('id').primary();
    t.string('request_id', 64).notNullable().unique(); // idempotency key from the client
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('period_id').notNullable().references('id').inTable('reward_periods').onDelete('CASCADE');
    t.integer('points').notNullable();
    t.decimal('tokens', 20, 9).notNullable();
    t.string('address').notNullable();
    t.string('network', 16).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending'); // pending|sent|failed
    t.string('tx_hash');
    t.text('error');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('settled_at');
    t.unique(['user_id', 'period_id']);           // one redemption per player per period
  });

  // Full match results submitted by the offline queue; dedupe key is result_id.
  await knex.schema.createTable('sync_results', (t) => {
    t.string('result_id', 64).primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('match_id', 40);
    t.string('kind', 24).notNullable();           // 'shot' | 'match-complete' | 'practice-stat'
    t.text('payload').notNullable();
    t.string('status', 16).notNullable().defaultTo('applied'); // applied|rejected
    t.text('note');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'created_at']);
  });
}

export async function down(knex) {
  for (const table of [
    'sync_results', 'redemptions', 'eligible_breaks', 'reward_periods',
    'matchmaking_queue', 'shots', 'matches', 'wallets', 'users',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
