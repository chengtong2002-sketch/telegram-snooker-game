import { Router } from '../asyncRouter.js';
import { requireInternal } from '../auth.js';
import { userByTelegramId, upsertUser, activeWallet } from '@snooker/db';
import { joinQueue, leaveQueue, queueStatus } from '../services/matchmaking.js';
import { activeMatchesFor } from '../services/matchService.js';
import { currentPeriod, quote, claimablePeriods } from '../services/rewards.js';
import { checkPreCheckout, recordStarsPayment, recordStarsRefund } from '../services/stars.js';

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
  const claims = await claimablePeriods(user.id);
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
    claims,
  });
});

/**
 * Stars payments, from the bot. Telegram sends these updates to the bot, which
 * has 10 s to answer a pre-checkout and passes each one straight on.
 */
router.post('/payments/stars/check', async (req, res) => {
  const {
    orderId, telegramId, currency, totalAmount,
  } = req.body ?? {};
  res.json(await checkPreCheckout({
    orderId, telegramId, currency, totalAmount,
  }));
});

router.post('/payments/stars/paid', async (req, res) => {
  const {
    orderId, telegramId, currency, totalAmount, chargeId,
  } = req.body ?? {};
  const result = await recordStarsPayment({
    orderId, telegramId, currency, totalAmount, chargeId, source: 'bot',
  });
  // Only a malformed call is an error: an unmatched payment is logged for a
  // refund, and retrying it would change nothing.
  res.status(result.status === 'bad_request' ? 400 : 200).json(result);
});

/** Telegram reported a refund (refunded_payment), however it was made. */
router.post('/payments/stars/refunded', async (req, res) => {
  const chargeId = req.body?.chargeId;
  if (typeof chargeId !== 'string' || !chargeId) return res.status(400).json({ error: 'chargeId is required' });
  return res.json(await recordStarsRefund({ chargeId, source: 'bot' }));
});

export default router;
