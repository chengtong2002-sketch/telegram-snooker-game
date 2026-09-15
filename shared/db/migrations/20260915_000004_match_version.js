/**
 * matches.version — optimistic lock for match state.
 *
 * Every write to a match (a shot, a concede, a checkpoint continue, the shot
 * clock sweeper) loads the row, changes the state in JS and writes it back.
 * Without a guard two of those running at once both write, so one turn could
 * take several shots and a match could complete (and pay out its break) twice.
 * A write now only lands if the version is still the one it read.
 */
export async function up(knex) {
  await knex.schema.alterTable('matches', (t) => {
    t.integer('version').notNullable().defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('matches', (t) => t.dropColumn('version'));
}
