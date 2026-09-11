import { getDb } from '@snooker/db';
import { createPvpMatch, activeMatchesFor } from './matchService.js';
import { notifyMatched } from './notify.js';
import { logger } from '../logger.js';

/**
 * FIFO open queue: the two players who have been waiting longest get paired.
 * No rating maths for the MVP — with a demo-sized player pool, Elo pairing
 * would mostly just mean nobody ever finds an opponent.
 */
export async function joinQueue(userId) {
  const knex = getDb();

  const existing = await activeMatchesFor(userId);
  if (existing.length > 0) {
    return { status: 'already-playing', match: existing[0] };
  }

  const paired = await knex.transaction(async (trx) => {
    const opponent = await trx('matchmaking_queue')
      .whereNot('user_id', userId)
      .orderBy('joined_at', 'asc')
      .first();

    if (!opponent) {
      await trx('matchmaking_queue')
        .insert({ user_id: userId, joined_at: new Date() })
        .onConflict('user_id')
        .merge({ joined_at: new Date() });
      return null;
    }

    await trx('matchmaking_queue').whereIn('user_id', [userId, opponent.user_id]).del();
    return opponent.user_id;
  });

  if (!paired) {
    const waiting = await knex('matchmaking_queue').count({ n: 'user_id' }).first();
    return { status: 'queued', queueSize: Number(waiting?.n ?? 1) };
  }

  // The player who was already waiting breaks the first frame.
  const { row, state } = await createPvpMatch(paired, userId);
  logger.info({ matchId: row.id, players: state.players }, 'pvp match created');

  for (const player of state.players) {
    await notifyMatched(row, player, {
      opponentId: state.players.find((p) => p !== player),
      yourTurn: Number(player) === Number(state.players[0]),
    });
  }

  return { status: 'matched', matchId: row.id };
}

export async function leaveQueue(userId) {
  const removed = await getDb()('matchmaking_queue').where({ user_id: userId }).del();
  return { status: removed ? 'left' : 'not-queued' };
}

export async function queueStatus(userId) {
  const knex = getDb();
  const row = await knex('matchmaking_queue').where({ user_id: userId }).first();
  const total = await knex('matchmaking_queue').count({ n: 'user_id' }).first();
  const active = await activeMatchesFor(userId);
  return {
    queued: !!row,
    joinedAt: row?.joined_at ?? null,
    queueSize: Number(total?.n ?? 0),
    activeMatches: active,
  };
}
