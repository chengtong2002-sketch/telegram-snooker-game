import { v4 as uuid } from 'uuid';
import { getDb, toJson, fromJson, toBool } from '@snooker/db';
import {
  newMatch, resolveShot, resolveTimeout, advanceMatch, matchHighBreak,
  MAX_BREAK, TABLE, BALL_RADIUS,
} from '@snooker/sim';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyYourTurn, notifyMatchOver } from './notify.js';
import { recordEligibleBreak } from './rewards.js';

const shotDeadline = () => new Date(Date.now() + config.shotClockSeconds * 1000);

const displayName = (u) => (u?.username ? `@${u.username}` : (u?.first_name ?? 'Player'));

/** Names for both seats, so the Mini App HUD can label the avatars. */
async function playerNames(state) {
  const ids = state.players.map(Number).filter(Number.isFinite);
  if (ids.length === 0) return ['Player', 'Player'];
  const rows = await getDb()('users').whereIn('id', ids).select('id', 'username', 'first_name');
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return state.players.map((id) => displayName(byId.get(Number(id))));
}

export function publicMatch(row, state) {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    cryptoEligible: toBool(row.crypto_eligible),
    players: state.players,
    framesWon: state.framesWon,
    highBreaks: state.highBreaks,
    frameHistory: state.frameHistory,
    frame: state.frame,
    ended: state.ended,
    winner: state.winner,
    turnUserId: row.turn_user_id,
    shotDeadline: row.shot_deadline,
    shotClockSeconds: config.shotClockSeconds,
  };
}

/** publicMatch plus the two display names. Use this wherever a client sees it. */
export async function publicMatchForClient(row, state) {
  return { ...publicMatch(row, state), playerNames: await playerNames(state) };
}

export async function createPvpMatch(userIdA, userIdB) {
  const knex = getDb();
  const id = uuid();
  const state = newMatch([Number(userIdA), Number(userIdB)]);
  await knex('matches').insert({
    id,
    mode: 'pvp',
    player_a: userIdA,
    player_b: userIdB,
    status: 'active',
    state: toJson(state),
    turn_index: 0,
    turn_user_id: userIdA,
    shot_deadline: shotDeadline(),
    crypto_eligible: true, // PvP only; practice never creates a match row
  });
  const row = await knex('matches').where({ id }).first();
  return { row, state };
}

export async function loadMatch(id) {
  const row = await getDb()('matches').where({ id }).first();
  if (!row) return null;
  return { row, state: fromJson(row.state) };
}

function participantIndex(state, userId) {
  return state.players.findIndex((p) => Number(p) === Number(userId));
}

async function persist(row, state, { status, extra = {} } = {}) {
  const knex = getDb();
  const turnUserId = state.ended ? null : state.players[state.frame.turn];
  const patch = {
    state: toJson(state),
    turn_index: state.frame.turn,
    turn_user_id: turnUserId,
    frames_won_a: state.framesWon[0],
    frames_won_b: state.framesWon[1],
    high_break_a: state.highBreaks[0],
    high_break_b: state.highBreaks[1],
    shot_deadline: state.ended ? null : shotDeadline(),
    status: status ?? (state.ended ? 'completed' : 'active'),
    updated_at: knex.fn.now(),
    ...extra,
  };
  if (state.ended) {
    patch.winner_id = state.players[state.winner];
    patch.completed_at = knex.fn.now();
  }
  await knex('matches').where({ id: row.id }).update(patch);
  return knex('matches').where({ id: row.id }).first();
}

async function onMatchComplete(row, state) {
  const knex = getDb();
  const winnerId = state.players[state.winner];

  for (const [idx, userId] of state.players.entries()) {
    await knex('users').where({ id: userId })
      .increment('frames_played', state.frameHistory.length)
      .increment('frames_won', state.framesWon[idx]);
  }

  const eligible = await recordEligibleBreak(row, state);
  logger.info(
    { matchId: row.id, winnerId, highBreak: matchHighBreak(state), eligible: !!eligible },
    'pvp match completed',
  );

  for (const userId of state.players) {
    await notifyMatchOver(row, userId, {
      won: Number(userId) === Number(winnerId),
      framesWon: state.framesWon,
      highBreak: Math.min(MAX_BREAK, matchHighBreak(state)),
      eligibleBreak: eligible && Number(eligible.userId) === Number(userId)
        ? eligible.breakValue : 0,
    });
  }
}

/**
 * Resolve one PvP shot. The client already animated its own prediction; this is
 * the version that counts. Dedupe is by the client's result_id so an offline
 * replay of the same shot is a no-op that returns the original outcome.
 */
export async function applyShot({ matchId, userId, resultId, shot }) {
  const knex = getDb();

  const dup = await knex('shots').where({ result_id: resultId }).first();
  if (dup) {
    const { row, state } = await loadMatch(dup.match_id);
    return {
      status: 'duplicate',
      outcome: fromJson(dup.outcome),
      match: await publicMatchForClient(row, state),
    };
  }

  const loaded = await loadMatch(matchId);
  if (!loaded) return { status: 'error', code: 404, reason: 'match not found' };
  const { row } = loaded;
  let { state } = loaded;

  if (row.status !== 'active') return { status: 'error', code: 409, reason: 'match is not active' };

  const idx = participantIndex(state, userId);
  if (idx === -1) return { status: 'error', code: 403, reason: 'not a participant' };
  if (idx !== state.frame.turn) return { status: 'error', code: 409, reason: 'not your turn' };

  // Must be actual finite numbers. Number() would turn null into 0, which is a
  // perfectly legal angle — a malformed shot would silently become a real one.
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const angle = shot?.angle;
  const power = shot?.power;
  if (!isNum(angle) || !isNum(power) || power <= 0 || power > 1) {
    return { status: 'error', code: 400, reason: 'invalid shot' };
  }
  const cleanShot = { angle, power };
  if (state.frame.inHand && shot.cuePlacement) {
    const { x, y } = shot.cuePlacement;
    if (isNum(x) && isNum(y)) {
      // Clamp into the playing surface so a crafted placement cannot put the
      // cue ball inside a cushion or off the table.
      cleanShot.cuePlacement = {
        x: Math.min(TABLE.width - BALL_RADIUS, Math.max(BALL_RADIUS, x)),
        y: Math.min(TABLE.height - BALL_RADIUS, Math.max(BALL_RADIUS, y)),
      };
    }
  }

  // Shot clock: an overdue shot is scored as a miss regardless of what was sent.
  const overdue = row.shot_deadline && new Date(row.shot_deadline).getTime() < Date.now();
  const { state: nextFrame, outcome } = overdue
    ? resolveTimeout(state.frame)
    : resolveShot(state.frame, cleanShot);

  const frameNumber = state.frame.frame;
  const shotNumber = state.frame.shotNumber + 1;
  state = advanceMatch(state, nextFrame);

  await knex('shots').insert({
    result_id: resultId,
    match_id: row.id,
    user_id: userId,
    frame_number: frameNumber,
    shot_number: shotNumber,
    shot: toJson(cleanShot),
    outcome: toJson({ ...outcome, overdue: !!overdue, events: undefined }),
    foul: outcome.foul,
    points: outcome.pointsScored,
  });

  const updatedRow = await persist(row, state);

  if (state.ended) {
    await onMatchComplete(updatedRow, state);
  } else if (outcome.turnPassed) {
    await notifyYourTurn(updatedRow, state.players[state.frame.turn], {
      opponentId: state.players[1 - state.frame.turn],
      scores: state.frame.scores,
      lastShot: {
        foul: outcome.foul,
        foulReasons: outcome.foulReasons,
        penalty: outcome.penalty,
        potted: outcome.potted,
        breakValue: outcome.breakValue,
      },
      secondsToShoot: config.shotClockSeconds,
    });
  }

  return {
    status: 'ok',
    outcome: { ...outcome, overdue: !!overdue },
    match: await publicMatchForClient(updatedRow, state),
  };
}

/** Concede the match. The opponent takes the remaining frames. */
export async function concede({ matchId, userId }) {
  const loaded = await loadMatch(matchId);
  if (!loaded) return { status: 'error', code: 404, reason: 'match not found' };
  const { row } = loaded;
  const state = structuredClone(loaded.state);
  if (row.status !== 'active') return { status: 'error', code: 409, reason: 'match is not active' };

  const idx = participantIndex(state, userId);
  if (idx === -1) return { status: 'error', code: 403, reason: 'not a participant' };

  state.ended = true;
  state.winner = 1 - idx;
  state.framesWon[1 - idx] = Math.max(state.framesWon[1 - idx], 2);

  const updatedRow = await persist(row, state, { status: 'completed' });
  await onMatchComplete(updatedRow, state);
  return { status: 'ok', match: await publicMatchForClient(updatedRow, state) };
}

/**
 * Background sweep: any active match whose shot clock has run out gets the
 * miss penalty applied and the turn handed over, so a player who closes the app
 * cannot stall a match forever.
 */
export async function sweepShotClocks() {
  const knex = getDb();
  const overdue = await knex('matches')
    .where({ status: 'active' })
    .whereNotNull('shot_deadline')
    .where('shot_deadline', '<', new Date())
    .limit(25);

  for (const row of overdue) {
    try {
      let state = fromJson(row.state);
      const { state: nextFrame } = resolveTimeout(state.frame);
      state = advanceMatch(state, nextFrame);
      const updatedRow = await persist(row, state);
      if (state.ended) {
        await onMatchComplete(updatedRow, state);
      } else {
        await notifyYourTurn(updatedRow, state.players[state.frame.turn], {
          opponentId: state.players[1 - state.frame.turn],
          scores: state.frame.scores,
          lastShot: { foul: true, foulReasons: ['shot-clock-expired'], penalty: 4 },
          secondsToShoot: config.shotClockSeconds,
        });
      }
      logger.info({ matchId: row.id }, 'shot clock expired, turn passed');
    } catch (err) {
      logger.error({ err: err.message, matchId: row.id }, 'shot clock sweep failed');
    }
  }
  return overdue.length;
}

export async function activeMatchesFor(userId) {
  const rows = await getDb()('matches')
    .where({ status: 'active' })
    .andWhere((q) => q.where('player_a', userId).orWhere('player_b', userId))
    .orderBy('updated_at', 'desc');
  return Promise.all(rows.map((row) => publicMatchForClient(row, fromJson(row.state))));
}
