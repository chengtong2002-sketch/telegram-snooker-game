import { v4 as uuid } from 'uuid';
import { getDb, toJson, fromJson, toBool } from '@snooker/db';
import {
  newMatch, resolveShot, resolveTimeout, advanceMatch, matchHighBreak, concedeMatch,
  cuePlacementProblem, MAX_BREAK,
} from '@snooker/sim';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  notifyYourTurn, notifyMatchOver, notifyFrameCheckpoint,
} from './notify.js';
import { recordEligibleBreak } from './rewards.js';

const shotDeadline = () => new Date(Date.now() + config.shotClockSeconds * 1000);

/**
 * How long the trailing player has to choose Continue or Concede between
 * frames. If they say nothing the next frame starts — the server never
 * concedes on a player's behalf.
 */
export const CHECKPOINT_MS = 60_000;

/**
 * After a frame ends with one player ahead (1-0 / 0-1), hold the match before
 * the next frame so the trailing player can continue or concede. A level score
 * (1-1) goes straight into the decider: nobody is trailing.
 */
function openCheckpointIfDue(state, previousFrameNumber) {
  const frameEnded = !state.ended && state.frame.frame !== previousFrameNumber;
  const [a, b] = state.framesWon;
  if (!frameEnded || a === b) return false;
  state.checkpoint = {
    frame: previousFrameNumber,
    trailing: a < b ? 0 : 1,
    deadline: new Date(Date.now() + CHECKPOINT_MS).toISOString(),
  };
  return true;
}

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
    concededBy: state.concededBy ?? null,
    checkpoint: state.checkpoint ?? null,
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
    // During a checkpoint the deadline is the decision window, so the sweeper
    // auto-continues it instead of charging anyone a shot-clock foul.
    shot_deadline: state.ended ? null
      : (state.checkpoint ? new Date(state.checkpoint.deadline) : shotDeadline()),
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
      conceded: state.concededBy != null,
      youConceded: state.concededBy != null && Number(state.players[state.concededBy]) === Number(userId),
    });
  }
}

/** Tell both players a frame checkpoint is waiting. */
async function announceCheckpoint(row, state) {
  const { checkpoint } = state;
  for (const [idx, userId] of state.players.entries()) {
    await notifyFrameCheckpoint(row, userId, {
      frame: checkpoint.frame,
      framesWon: state.framesWon,
      trailing: idx === checkpoint.trailing,
      seconds: Math.round(CHECKPOINT_MS / 1000),
    });
  }
}

/** Turn a pending checkpoint into the next frame: clear it and start the clock. */
async function startNextFrame(row, state) {
  delete state.checkpoint;
  const updatedRow = await persist(row, state);
  await notifyYourTurn(updatedRow, state.players[state.frame.turn], {
    opponentId: state.players[1 - state.frame.turn],
    scores: state.frame.scores,
    newFrame: state.frame.frame,
    secondsToShoot: config.shotClockSeconds,
  });
  return updatedRow;
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
  if (state.checkpoint) {
    return { status: 'error', code: 409, reason: 'waiting for the between-frame decision' };
  }
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
    // Reject, never clamp: clamping only kept the ball on the table, so a
    // crafted request could take ball-in-hand from anywhere on it.
    const problem = cuePlacementProblem(state.frame, shot.cuePlacement);
    if (problem) return { status: 'error', code: 400, reason: problem };
    cleanShot.cuePlacement = { x: shot.cuePlacement.x, y: shot.cuePlacement.y };
  }

  // Shot clock: an overdue shot is scored as a miss regardless of what was sent.
  const overdue = row.shot_deadline && new Date(row.shot_deadline).getTime() < Date.now();
  const { state: nextFrame, outcome } = overdue
    ? resolveTimeout(state.frame)
    : resolveShot(state.frame, cleanShot);

  const frameNumber = state.frame.frame;
  const shotNumber = state.frame.shotNumber + 1;
  state = advanceMatch(state, nextFrame);
  const checkpointOpened = openCheckpointIfDue(state, frameNumber);

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
  } else if (checkpointOpened) {
    await announceCheckpoint(updatedRow, state);
  } else if (state.frame.turn !== idx) {
    // Turn passed — or a frame ended level (1-1) and the other player breaks
    // the decider, which outcome.turnPassed alone does not cover.
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

const CONCEDE_VIA = new Set(['unrecoverable', 'checkpoint', 'menu']);

/**
 * Concede the match. It ends immediately at the current frame score, with the
 * opponent as the winner. Breaks already made — by either player, including in
 * the unfinished frame — are kept and go through the normal reward check.
 */
export async function concede({ matchId, userId, via = 'menu' }) {
  const loaded = await loadMatch(matchId);
  if (!loaded) return { status: 'error', code: 404, reason: 'match not found' };
  const { row } = loaded;
  if (row.status !== 'active') return { status: 'error', code: 409, reason: 'match is not active' };

  const idx = participantIndex(loaded.state, userId);
  if (idx === -1) return { status: 'error', code: 403, reason: 'not a participant' };

  const state = concedeMatch(loaded.state, idx);
  const updatedRow = await persist(row, state, { status: 'completed' });
  logger.info({
    matchId: row.id, userId, via: CONCEDE_VIA.has(via) ? via : 'menu', framesWon: state.framesWon,
  }, 'pvp match conceded');
  await onMatchComplete(updatedRow, state);
  return { status: 'ok', match: await publicMatchForClient(updatedRow, state) };
}

/**
 * Answer the between-frame checkpoint with "continue". Only the trailing
 * player's answer starts the next frame; the leader's is an acknowledgement.
 * Idempotent: continuing when nothing is pending just returns the match.
 */
export async function continueMatch({ matchId, userId }) {
  const loaded = await loadMatch(matchId);
  if (!loaded) return { status: 'error', code: 404, reason: 'match not found' };
  const { row, state } = loaded;
  if (row.status !== 'active') return { status: 'error', code: 409, reason: 'match is not active' };

  const idx = participantIndex(state, userId);
  if (idx === -1) return { status: 'error', code: 403, reason: 'not a participant' };

  if (!state.checkpoint || idx !== state.checkpoint.trailing) {
    return { status: 'ok', started: false, match: await publicMatchForClient(row, state) };
  }
  const updatedRow = await startNextFrame(row, state);
  return { status: 'ok', started: true, match: await publicMatchForClient(updatedRow, state) };
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
      if (state.checkpoint) {
        // Nobody answered between frames: carry on, never concede for them.
        await startNextFrame(row, state);
        logger.info({ matchId: row.id }, 'frame checkpoint timed out, next frame started');
        continue;
      }
      const frameNumber = state.frame.frame;
      const { state: nextFrame } = resolveTimeout(state.frame);
      state = advanceMatch(state, nextFrame);
      const checkpointOpened = openCheckpointIfDue(state, frameNumber);
      const updatedRow = await persist(row, state);
      if (state.ended) {
        await onMatchComplete(updatedRow, state);
      } else if (checkpointOpened) {
        await announceCheckpoint(updatedRow, state);
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
