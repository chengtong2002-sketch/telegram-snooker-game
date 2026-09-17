import { Router } from '../asyncRouter.js';
import { requireAuth } from '../auth.js';
import { getDb } from '@snooker/db';
import {
  currentPeriod, lastClosedPeriod, quote, periodTotals, claimablePeriods, redeemClaimable,
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
 * Every closed period the player can still claim, with its reward and the date
 * it expires. Below-minimum periods are listed as not claimable.
 */
router.get('/claimable', async (req, res) => {
  res.json(await claimablePeriods(req.user.id));
});

/**
 * Claim every claimable period. Redemptions are queued, not sent inline: the
 * actual Jetton mint is a treasury operation (see /token) and must not block an
 * HTTP request. Status is `queued`, `duplicate` (this requestId already ran)
 * or `nothing` (no claimable period).
 */
router.post('/redeem', async (req, res) => {
  const { requestId } = req.body ?? {};
  // Each queued row gets `<requestId>:<periodId>`, which must fit in 64 characters.
  if (!requestId || typeof requestId !== 'string' || requestId.length > 44) {
    return res.status(400).json({ error: 'requestId is required (at most 44 characters)' });
  }
  const result = await redeemClaimable({ userId: req.user.id, requestId });
  if (result.status === 'error') {
    return res.status(409).json({ error: result.reason, unlocksAt: result.unlocksAt });
  }
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
