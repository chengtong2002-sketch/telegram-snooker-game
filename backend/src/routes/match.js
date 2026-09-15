import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import {
  loadMatch, applyShot, concede, continueMatch, publicMatchForClient, activeMatchesFor,
} from '../services/matchService.js';
import { joinQueue, leaveQueue, queueStatus } from '../services/matchmaking.js';

const router = Router();

// A shot takes seconds of real time to play; this only stops abuse.
const shotLimiter = rateLimit({ windowMs: 10_000, limit: 10, standardHeaders: true });

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
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

/** End the match now, at the current frame score. `via` is for logs only. */
router.post('/:id/concede', async (req, res) => {
  const result = await concede({
    matchId: req.params.id, userId: req.user.id, via: req.body?.via,
  });
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

/** Between frames: carry on to the next frame. */
router.post('/:id/continue', async (req, res) => {
  const result = await continueMatch({ matchId: req.params.id, userId: req.user.id });
  if (result.status === 'error') {
    return res.status(result.code ?? 400).json({ error: result.reason });
  }
  return res.json(result);
});

export default router;
