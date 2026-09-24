/**
 * matches.turn_notice_a / turn_notice_b — a "your shot" message has gone to
 * that seat and the player has not opened the app since.
 *
 * While it is set, further "your shot" messages to that seat are held back, so
 * a player who has walked away gets one ping, not one every shot clock. Opening
 * the match (or signing in) clears it. Kept out of the match state on purpose:
 * it changes on reads, and must not bump the version that guards every shot.
 */
export async function up(knex) {
  await knex.schema.alterTable('matches', (t) => {
    t.boolean('turn_notice_a').notNullable().defaultTo(false);
    t.boolean('turn_notice_b').notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('matches', (t) => {
    t.dropColumn('turn_notice_a');
    t.dropColumn('turn_notice_b');
  });
}
