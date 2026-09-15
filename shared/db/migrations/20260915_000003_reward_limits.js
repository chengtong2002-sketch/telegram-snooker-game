/**
 * Columns for the daily reward limits and the wallet-change claim cooldown.
 *
 * eligible_breaks.award_day / opponent_id — the UTC calendar day a break was
 *   awarded and who it was made against, so "eligible matches today" and
 *   "eligible matches against this opponent today" are plain indexed counts.
 *   The day is a 'YYYY-MM-DD' string computed in JS: timestamp arithmetic
 *   differs between SQLite and Postgres, a string compares the same on both.
 * matches.ineligible_reason — why a finished PvP match's break did not count
 *   (a limit was hit). The match itself still happened and still counts for
 *   frames and the win; only the reward is withheld. Kept for operator review.
 * users.wallet_changed_at — when the active payout wallet last changed.
 */
export async function up(knex) {
  await knex.schema.alterTable('eligible_breaks', (t) => {
    t.bigInteger('opponent_id');
    t.string('award_day', 10);
    t.index(['user_id', 'award_day']);
    t.index(['award_day']);
  });
  await knex.schema.alterTable('matches', (t) => {
    t.string('ineligible_reason', 32);
  });
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('wallet_changed_at');
  });

  // Backfill existing breaks. SQLite's CURRENT_TIMESTAMP is a UTC
  // 'YYYY-MM-DD HH:MM:SS' string; Postgres hands back a Date.
  const rows = await knex('eligible_breaks as eb')
    .join('matches as m', 'm.id', 'eb.match_id')
    .select('eb.id', 'eb.user_id', 'eb.created_at', 'm.player_a', 'm.player_b');
  for (const row of rows) {
    const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    const opponent = Number(row.player_a) === Number(row.user_id) ? row.player_b : row.player_a;
    await knex('eligible_breaks').where({ id: row.id }).update({
      award_day: created.slice(0, 10),
      opponent_id: opponent ?? null,
    });
  }
}

export async function down(knex) {
  await knex.schema.alterTable('users', (t) => t.dropColumn('wallet_changed_at'));
  await knex.schema.alterTable('matches', (t) => t.dropColumn('ineligible_reason'));
  await knex.schema.alterTable('eligible_breaks', (t) => {
    t.dropIndex(['user_id', 'award_day']);
    t.dropIndex(['award_day']);
    t.dropColumn('award_day');
    t.dropColumn('opponent_id');
  });
}
