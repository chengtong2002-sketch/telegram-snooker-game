import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import {
  loadMatch, applyShot, concede, continueMatch, publicMatchForClient, activeMatchesFor,
  markTurnNoticesSeen,
} from '../services/matchService.js';
import { joinQueue, leaveQueue, queueStatus } from '../services/matchmaking.js';
import { aimRelay } from '../services/aimRelay.js';

const router = Router();

// A shot takes seconds of real time to play; this only stops abuse.
const shotLimiter = rateLimit({ windowMs: 10_000, limit: 10, standardHeaders: true });

// Live aim is exempt from the app-wide /api limit (see isAimPath): an aiming
// player sends ~10 a second. These cap it per player instead; the relay also
// caps each match (AIM_RATE_PER_SEC).
const byUser = (req) => `u${req.user.id}`;
const aimLimiter = rateLimit({
  windowMs: 1_000, limit: 20, standardHeaders: true, keyGenerator: byUser,
});
const aimStreamLimiter = rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: true, keyGenerator: byUser,
});

/** The live-aim routes, which skip the app-wide /api limiter. Paths as seen under /api. */
export const isAimPath = (path) => /^\/match\/[^/]+\/aim(-stream)?$/.test(path);

router.use(requireAuth);

router.post('/queue', async (req, res) => {
  res.json(await joinQueue(req.user.id));
});

router.delete('/queue', async (req, res) => {
  res.json(await leaveQueue(req.user.id));
});

router.get('/queue', async (req, res) => {
  res.json(await queueStatus(req.user.id));
});

router.get('/active', async (req, res) => {
  res.json({ matches: await activeMatchesFor(req.user.id) });
});

router.get('/:id', async (req, res) => {
  const loaded = await loadMatch(req.params.id);
  if (!loaded) return res.status(404).json({ error: 'match not found' });
  const { row, state } = loaded;
  if (!state.players.some((p) => Number(p) === Number(req.user.id))) {
    return res.status(403).json({ error: 'not a participant' });
  }
  // The table polls this while it is open: the player can see whose turn it is.
  await markTurnNoticesSeen(req.user.id, row.id);
  return res.json({ match: await publicMatchForClient(row, state) });
});

/**
 * Submit a shot. The body carries what the player *did* (angle, power), never
 * what they think happened — the server re-simulates and its outcome is final.
 */
router.post('/:id/shot', shotLimiter, async (req, res) => {
  const { resultId, shot } = req.body ?? {};
  if (!resultId || typeof resultId !== 'string' || resultId.length > 64) {
    return res.status(400).json({ error: 'resultId is required' });
  }
  const result = await applyShot({
    matchId: req.params.id,
    userId: req.user.id,
    resultId,
    shot,
  });
  if (result.status !== 'error') aimRelay.announceMove(req.params.id);
  else aimRelay.forgetTurn(req.params.id);
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

/**
 * Where the shooter's cue points right now. Display only: relayed to the
 * opponent's stream, never stored, never read by the sim. 204 whether it was
 * relayed, dropped by the match's rate limit, or ignored because it is not
 * this player's shot — the shooter has nothing to do differently either way.
 */
router.post('/:id/aim', aimLimiter, async (req, res) => {
  const result = await aimRelay.publish(req.params.id, req.user.id, req.body);
  if (result.status === 'error') return res.status(result.code).json({ error: result.reason });
  res.set('x-aim', result.status);
  return res.status(204).end();
});

/** The opponent's aim as server-sent events, for as long as the table is open. */
router.get('/:id/aim-stream', aimStreamLimiter, async (req, res) => {
  const result = await aimRelay.subscribe(req.params.id, req.user.id, req, res);
  if (result.status === 'error') return res.status(result.code).json({ error: result.reason });
  return undefined;
});

/** End the match now, at the current frame score. `via` is for logs only. */
router.post('/:id/concede', async (req, res) => {
  const result = await concede({
    matchId: req.params.id, userId: req.user.id, via: req.body?.via,
  });
  if (result.status !== 'error') aimRelay.announceMove(req.params.id);
  else aimRelay.forgetTurn(req.params.id);
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

/** Between frames: carry on to the next frame. */
router.post('/:id/continue', async (req, res) => {
  const result = await continueMatch({ matchId: req.params.id, userId: req.user.id });
  if (result.status !== 'error') aimRelay.announceMove(req.params.id);
  else aimRelay.forgetTurn(req.params.id);
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

export default router;
