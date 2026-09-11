import { Router } from 'express';
import { leaderboard } from '@snooker/db';
import { requireAuth } from '../auth.js';
import { currentPeriod, lastClosedPeriod } from '../services/rewards.js';

const router = Router();

/**
 * Two views of the same table. `scope=period` is the one that matters for
 * rewards; `scope=all-time` is vanity. Both are PvP-only by construction —
 * practice results never produce an eligible_breaks row.
 */
router.get('/', requireAuth, async (req, res) => {
  const scope = req.query.scope === 'all-time' ? 'all-time' : 'period';
  const limit = Math.min(50, Number(req.query.limit) || 10);

  let period = null;
  if (scope === 'period') {
    period = req.query.closed === '1' ? await lastClosedPeriod() : await currentPeriod();
  }

  const rows = await leaderboard({ periodId: period?.id ?? null, limit });
  res.json({
    scope,
    period: period
      ? { id: period.id, kind: period.kind, startsAt: period.starts_at, endsAt: period.ends_at }
      : null,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      userId: r.id,
      name: r.username ? `@${r.username}` : (r.first_name ?? 'Player'),
      bestBreak: Number(r.best_break),
      totalPoints: Number(r.total_points),
      matches: Number(r.matches),
      you: Number(r.id) === Number(req.user.id),
    })),
  });
});

export default router;
