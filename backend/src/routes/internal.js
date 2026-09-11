import { Router } from 'express';
import { requireInternal } from '../auth.js';
import { userByTelegramId, upsertUser, activeWallet } from '@snooker/db';
import { joinQueue, leaveQueue, queueStatus } from '../services/matchmaking.js';
import { activeMatchesFor } from '../services/matchService.js';
import { currentPeriod, quote } from '../services/rewards.js';

const router = Router();

router.use(requireInternal);

async function resolveUser(body) {
  if (body?.telegramUser?.id) return upsertUser(body.telegramUser);
  if (body?.telegramId) return userByTelegramId(body.telegramId);
  return null;
}

/** /play in the bot lands here. */
router.post('/queue/join', async (req, res) => {
  const user = await resolveUser(req.body);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  return res.json(await joinQueue(user.id));
});

router.post('/queue/leave', async (req, res) => {
  const user = await resolveUser(req.body);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  return res.json(await leaveQueue(user.id));
});

router.post('/status', async (req, res) => {
  const user = await resolveUser(req.body);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  const [queue, matches, wallet, period] = await Promise.all([
    queueStatus(user.id),
    activeMatchesFor(user.id),
    activeWallet(user.id),
    currentPeriod(),
  ]);
  const rewards = await quote(user.id, period.id);
  return res.json({
    user: {
      id: user.id,
      bestBreak: user.best_break,
      framesWon: user.frames_won,
      framesPlayed: user.frames_played,
    },
    queue,
    matches,
    wallet: wallet ? { address: wallet.address, network: wallet.network } : null,
    rewards,
  });
});

export default router;
