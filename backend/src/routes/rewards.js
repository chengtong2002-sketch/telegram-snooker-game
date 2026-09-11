import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getDb } from '@snooker/db';
import {
  currentPeriod, lastClosedPeriod, quote, redeem, periodTotals,
} from '../services/rewards.js';
import { config } from '../config.js';

const router = Router();

router.use(requireAuth);

/** What this period looks like right now, and what the player would get. */
router.get('/period', async (req, res) => {
  const closed = req.query.closed === '1';
  const period = closed ? await lastClosedPeriod() : await currentPeriod();
  if (!period) return res.json({ period: null });
  const q = await quote(req.user.id, period.id);
  return res.json({
    ...q,
    // The rate is provisional until the period closes: more eligible points
    // from other players will dilute it.
    provisional: !q.closed,
    network: config.ton.network,
    jettonMaster: config.ton.jettonMaster || null,
  });
});

router.get('/history', async (req, res) => {
  const rows = await getDb()('redemptions')
    .where({ user_id: req.user.id })
    .orderBy('created_at', 'desc')
    .limit(25);
  res.json({
    redemptions: rows.map((r) => ({
      id: r.id,
      periodId: r.period_id,
      points: r.points,
      tokens: Number(r.tokens),
      status: r.status,
      txHash: r.tx_hash,
      address: r.address,
      network: r.network,
      createdAt: r.created_at,
      settledAt: r.settled_at,
    })),
  });
});

/**
 * Queue a payout for the last closed period. Redemptions are queued, not sent
 * inline: the actual Jetton transfer is a treasury operation (see /token) and
 * must not block an HTTP request.
 */
router.post('/redeem', async (req, res) => {
  const { requestId } = req.body ?? {};
  if (!requestId || typeof requestId !== 'string' || requestId.length > 64) {
    return res.status(400).json({ error: 'requestId is required' });
  }
  const period = await lastClosedPeriod();
  if (!period) return res.status(409).json({ error: 'no closed reward period yet' });

  const result = await redeem({ userId: req.user.id, periodId: period.id, requestId });
  if (result.status === 'error') return res.status(409).json({ error: result.reason });
  return res.json(result);
});

/** Public-ish transparency: how the budget is being split this period. */
router.get('/pool', async (_req, res) => {
  const period = await currentPeriod();
  const totals = await periodTotals(period.id);
  res.json({
    periodId: period.id,
    kind: period.kind,
    startsAt: period.starts_at,
    endsAt: period.ends_at,
    budget: totals.budget,
    totalEligiblePoints: totals.totalPoints,
    rate: totals.rate,
    maxSharePerPlayer: config.rewards.maxShare,
  });
});

export default router;
