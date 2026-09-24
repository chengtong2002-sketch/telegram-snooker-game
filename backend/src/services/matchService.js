import { v4 as uuid } from 'uuid';
import { getDb, toJson, fromJson, toBool } from '@snooker/db';
import {
  newMatch, resolveShot, resolveTimeout, advanceMatch, matchHighBreak, concedeMatch,
  cuePlacementProblem, MAX_BREAK,
} from '@snooker/sim';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  notifyYourTurn, notifyMatchOver, notifyFrameCheckpoint, notifyMatchAbandoned,
} from './notify.js';
import { recordEligibleBreak, DAILY_ELIGIBLE_MATCH_CAP, DAILY_PAIR_MATCH_CAP } from './rewards.js';
import { equippedIds } from './equipped.js';

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

/** Shot clocks a player can let run out in a row before they forfeit the match. */
export const IDLE_FORFEIT_TIMEOUTS = 3;

/**
 * Timeouts in a row, across both players, that mean nobody is playing. A
 * timeout always passes the turn, so a run alternates seats: 4 is two each.
 * Left alone, two idle players would trade 4-point fouls forever.
 */
export const IDLE_ABANDON_RUN = 4;

/**
 * Count one turn towards the idle limits and say whether it ends the match.
 * `state.idle.seats` is each seat's timeouts in a row (their own real shot
 * resets it; the opponent's does not), `run` the match's timeouts in a row.
 * Returns 'abandon', 'forfeit' or null. Abandon is checked first: at 4 in a
 * row both players have 2, and neither has reached 3.
 */
function countTurn(state, striker, timedOut) {
  const idle = state.idle ?? { seats: [0, 0], run: 0 };
  if (timedOut) {
    idle.seats[striker] += 1;
    idle.run += 1;
  } else {
    idle.seats[striker] = 0;
    idle.run = 0;
  }
  state.idle = idle;
  if (!timedOut || state.ended) return null;
  if (idle.run >= IDLE_ABANDON_RUN) return 'abandon';
  if (idle.seats[striker] >= IDLE_FORFEIT_TIMEOUTS) return 'forfeit';
  return null;
}

/**
 * End the match for idleness. A forfeit is a concede by the idle player, so it
 * goes through the same path: opponent wins, breaks already made are kept and
 * meet the normal reward limits (a timeout itself scores no break). An
 * abandoned match has no winner and never pays anything.
 */
function endForIdle(state, striker, verdict) {
  if (verdict === 'forfeit') return { ...concedeMatch(state, striker), forfeit: 'idle' };
  const next = structuredClone(state);
  next.ended = true;
  next.winner = null;
  next.abandoned = 'idle';
  delete next.checkpoint;
  return next;
}

/** persist() options for a match that may have just been abandoned. */
const abandonedWrite = (state) => (state.abandoned
  ? { status: 'abandoned', extra: { ineligible_reason: 'abandoned-idle', crypto_eligible: false } }
  : {});

/** Tell both players, once, that the match was called off. */
async function announceAbandoned(row, state) {
  logger.info({ matchId: row.id, scores: state.frame.scores }, 'pvp match abandoned: both players idle');
  for (const userId of state.players) {
    await notifyMatchAbandoned(row, userId, { framesWon: state.framesWon, timeouts: IDLE_ABANDON_RUN });
  }
}

/**
 * Send "your shot" to whoever's turn it is — unless they have not opened the
 * app since the last one. Claiming the flag is one conditional update, so two
 * writers racing for the same turn cannot both send.
 */
async function noticeYourTurn(row, state, extra) {
  const seat = state.frame.turn;
  const column = seat === 0 ? 'turn_notice_a' : 'turn_notice_b';
  const claimed = await getDb()('matches').where({ id: row.id, [column]: false }).update({ [column]: true });
  if (!claimed) {
    logger.info({ matchId: row.id, seat }, 'your-turn notify held: not opened since the last one');
    return;
  }
  await notifyYourTurn(row, state.players[seat], { opponentId: state.players[1 - seat], ...extra });
}

/**
 * The player has the app open: the next "your shot" may be sent again. With a
 * match id, that match only; without, every active match of theirs (sign-in).
 */
export async function markTurnNoticesSeen(userId, matchId = null) {
  const knex = getDb();
  const scope = (q) => (matchId ? q.where({ id: matchId }) : q.where({ status: 'active' }));
  await scope(knex('matches')).where({ player_a: userId, turn_notice_a: true }).update({ turn_notice_a: false });
  await scope(knex('matches')).where({ player_b: userId, turn_notice_b: true }).update({ turn_notice_b: false });
}

const displayName = (u) => (u?.username ? `@${u.username}` : (u?.first_name ?? 'Player'));

/**
 * Names and skins for both seats: the HUD labels the avatars, and the renderer
 * draws each shooter's own cue and cue ball. Skins are cosmetic ids read from
 * users when the payload is built, never stored in the match state, so the sim
 * never sees them.
 */
async function seatInfo(state) {
  const ids = state.players.map(Number).filter(Number.isFinite);
  const rows = ids.length === 0 ? [] : await getDb()('users').whereIn('id', ids)
    .select('id', 'username', 'first_name', 'equipped_cue', 'equipped_ball');
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const seats = state.players.map((id) => byId.get(Number(id)));
  return {
    playerNames: seats.map(displayName),
    skins: seats.map(equippedIds),
  };
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
    forfeit: state.forfeit ?? null,
    abandoned: state.abandoned ?? null,
    checkpoint: state.checkpoint ?? null,
    turnUserId: row.turn_user_id,
    shotDeadline: row.shot_deadline,
    shotClockSeconds: config.shotClockSeconds,
    // The client counts down relative to this, not its own clock (see localDeadline in shared/sim).
    serverNow: Date.now(),
  };
}

/** publicMatch plus each seat's name and skins. Use this wherever a client sees it. */
export async function publicMatchForClient(row, state) {
  return { ...publicMatch(row, state), ...await seatInfo(state) };
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

/** Returned when another write got to the match between our read and our write. */
const STALE_MATCH = { status: 'error', code: 409, reason: 'the match moved on before this arrived' };

class StaleMatchError extends Error {}

/**
 * Write the match back, but only if nobody else has since it was loaded:
 * `version` must still be the one on `row`. Returns the updated row, or null
 * when the write lost a race — the caller must then do nothing further (no
 * notifications, no match completion), because the winner already did it.
 * Pass `trx` to make the write part of a transaction.
 */
async function persist(row, state, { status, extra = {}, trx } = {}) {
  const knex = getDb();
  const db = trx ?? knex;
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
    version: Number(row.version) + 1,
    ...extra,
  };
  if (state.ended) {
    patch.winner_id = state.winner == null ? null : state.players[state.winner]; // abandoned: nobody
    patch.completed_at = knex.fn.now();
  }
  const changed = await db('matches').where({ id: row.id, version: row.version }).update(patch);
  if (!changed) return null;
  return db('matches').where({ id: row.id }).first();
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
  const limited = eligible?.ineligibleReason ?? null;
  logger.info(
    {
      matchId: row.id, winnerId, highBreak: matchHighBreak(state), eligible: !!eligible && !limited, limited,
    },
    'pvp match completed',
  );

  for (const userId of state.players) {
    const isOwner = eligible && Number(eligible.userId) === Number(userId);
    await notifyMatchOver(row, userId, {
      won: Number(userId) === Number(winnerId),
      framesWon: state.framesWon,
      highBreak: Math.min(MAX_BREAK, matchHighBreak(state)),
      eligibleBreak: isOwner && !limited ? eligible.breakValue : 0,
      // Only the player whose break was withheld needs to hear why.
      rewardLimit: isOwner && limited
        ? {
          reason: limited,
          breakValue: eligible.blockedBreak,
          limit: limited === 'daily-pair-cap' ? DAILY_PAIR_MATCH_CAP : DAILY_ELIGIBLE_MATCH_CAP,
        }
        : null,
      conceded: state.concededBy != null,
      youConceded: state.concededBy != null && Number(state.players[state.concededBy]) === Number(userId),
      forfeit: state.forfeit ?? null, // 'idle': the concede was the shot clock running out
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
  if (!updatedRow) return null;
  await noticeYourTurn(updatedRow, state, {
    scores: state.frame.scores,
    newFrame: state.frame.frame,
    secondsToShoot: config.shotClockSeconds,
  });
  return updatedRow;
}

/**
 * Is `shot` for `matchId` the same one already stored under this resultId? The
 * stored shot is the cleaned one, which keeps a cue placement only when the
 * ball was in hand, so a placement is compared only when one was stored.
 */
function sameShot(stored, matchId, shot) {
  const was = fromJson(stored.shot);
  if (String(stored.match_id) !== String(matchId)) return false;
  if (was.angle !== shot?.angle || was.power !== shot?.power) return false;
  if (!was.cuePlacement) return true;
  return shot?.cuePlacement?.x === was.cuePlacement.x && shot?.cuePlacement?.y === was.cuePlacement.y;
}

/**
 * What to answer for a resultId that was already applied, or null if it was
 * not. An exact replay is a duplicate and gets the original outcome. The same
 * id carrying a different shot is a conflict: the first one stands, and this
 * one is refused rather than passed off as the same result.
 */
async function alreadyApplied(resultId, matchId, shot) {
  const dup = await getDb()('shots').where({ result_id: resultId }).first();
  if (!dup) return null;
  const { row, state } = await loadMatch(dup.match_id);
  const original = {
    outcome: fromJson(dup.outcome),
    match: await publicMatchForClient(row, state),
  };
  if (!sameShot(dup, matchId, shot)) {
    return {
      status: 'error',
      code: 409,
      conflict: true,
      reason: 'this resultId was already used for a different shot; the first one stands',
      ...original,
    };
  }
  return { status: 'duplicate', ...original };
}

/**
 * Resolve one PvP shot. The client already animated its own prediction; this is
 * the version that counts. Dedupe is by the client's result_id so an offline
 * replay of the same shot is a no-op that returns the original outcome.
 */
export async function applyShot({ matchId, userId, resultId, shot }) {
  const knex = getDb();

  const dup = await alreadyApplied(resultId, matchId, shot);
  if (dup) return dup;

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
  await markTurnNoticesSeen(userId, row.id);

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
  } else if (state.frame.inHand) {
    // No placement: the shot plays from where the cue ball was parked in the D,
    // which a ball may have come to rest on. Same rule, and the turn is not used up.
    const cue = state.frame.balls.find((b) => b.id === 'cue');
    const problem = cuePlacementProblem(state.frame, { x: cue.x, y: cue.y });
    if (problem) {
      return { status: 'error', code: 400, reason: `ball in hand, no placement sent: ${problem}` };
    }
  }

  // Shot clock: an overdue shot is scored as a miss regardless of what was sent.
  // Overdue means past the deadline plus the grace for the request's transit;
  // the sweeper uses the same line, so the two never disagree.
  const overdue = row.shot_deadline
    && new Date(row.shot_deadline).getTime() + config.shotClockGraceMs < Date.now();
  const { state: nextFrame, outcome } = overdue
    ? resolveTimeout(state.frame)
    : resolveShot(state.frame, cleanShot);

  const frameNumber = state.frame.frame;
  const shotNumber = state.frame.shotNumber + 1;
  state = advanceMatch(state, nextFrame);
  // A shot sent after the clock ran out is scored as a timeout, and counts as one.
  const idleVerdict = countTurn(state, idx, !!overdue);
  if (idleVerdict) state = endForIdle(state, idx, idleVerdict);
  const checkpointOpened = openCheckpointIfDue(state, frameNumber);

  // The shot row and the match update commit together or not at all, so a
  // shot that loses a race to another write leaves nothing behind.
  let updatedRow;
  try {
    updatedRow = await knex.transaction(async (trx) => {
      await trx('shots').insert({
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
      const written = await persist(row, state, { trx, ...abandonedWrite(state) });
      if (!written) throw new StaleMatchError();
      return written;
    });
  } catch (err) {
    // The same resultId arriving twice at once: the second insert hits the
    // unique key once the first commits. That is a replay, not a failure.
    const replay = await alreadyApplied(resultId, matchId, shot);
    if (replay) return replay;
    if (err instanceof StaleMatchError) return STALE_MATCH;
    throw err;
  }

  if (state.abandoned) {
    await announceAbandoned(updatedRow, state);
  } else if (state.ended) {
    await onMatchComplete(updatedRow, state);
  } else if (checkpointOpened) {
    await announceCheckpoint(updatedRow, state);
  } else if (state.frame.turn !== idx) {
    // Turn passed — or a frame ended level (1-1) and the other player breaks
    // the decider, which outcome.turnPassed alone does not cover.
    await noticeYourTurn(updatedRow, state, {
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

// 'quit' is the pause menu's Quit match: the same concede, then the client
// goes back to the lobby.
const CONCEDE_VIA = new Set(['unrecoverable', 'checkpoint', 'menu', 'quit']);

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
  if (!updatedRow) return STALE_MATCH;
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

  await markTurnNoticesSeen(userId, row.id);

  if (!state.checkpoint || idx !== state.checkpoint.trailing) {
    return { status: 'ok', started: false, match: await publicMatchForClient(row, state) };
  }
  const updatedRow = await startNextFrame(row, state);
  if (!updatedRow) {
    // Someone else moved the match on first (the sweeper, or a second tap).
    // Continuing is idempotent, so report where the match is now.
    const now = await loadMatch(matchId);
    return { status: 'ok', started: false, match: await publicMatchForClient(now.row, now.state) };
  }
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
      // A shot may still be in flight for the grace period after the deadline
      // (applyShot accepts it); a checkpoint's decision window has no grace.
      if (!state.checkpoint
        && new Date(row.shot_deadline).getTime() + config.shotClockGraceMs >= Date.now()) {
        continue;
      }
      if (state.checkpoint) {
        // Nobody answered between frames: carry on, never concede for them.
        if (!(await startNextFrame(row, state))) continue; // the trailing player answered first
        logger.info({ matchId: row.id }, 'frame checkpoint timed out, next frame started');
        continue;
      }
      const frameNumber = state.frame.frame;
      const striker = state.frame.turn;
      const { state: nextFrame } = resolveTimeout(state.frame);
      state = advanceMatch(state, nextFrame);
      const idleVerdict = countTurn(state, striker, true);
      if (idleVerdict) state = endForIdle(state, striker, idleVerdict);
      const checkpointOpened = openCheckpointIfDue(state, frameNumber);
      const updatedRow = await persist(row, state, abandonedWrite(state));
      if (!updatedRow) continue; // a shot or concede landed while we swept
      logger.info({ matchId: row.id, idle: state.idle }, 'shot clock expired, turn passed');
      if (state.abandoned) {
        await announceAbandoned(updatedRow, state);
      } else if (state.ended) {
        if (state.forfeit) logger.info({ matchId: row.id, seat: striker }, 'pvp match forfeited: idle');
        await onMatchComplete(updatedRow, state);
      } else if (checkpointOpened) {
        await announceCheckpoint(updatedRow, state);
      } else {
        await noticeYourTurn(updatedRow, state, {
          scores: state.frame.scores,
          lastShot: { foul: true, foulReasons: ['shot-clock-expired'], penalty: 4 },
          secondsToShoot: config.shotClockSeconds,
        });
      }
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
