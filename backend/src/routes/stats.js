import { Router } from '../asyncRouter.js';
import { requireAuth } from '../auth.js';
import { getDb } from '@snooker/db';
import { dailyEligibleUsage } from '../services/rewards.js';
import { balanceOf } from '../services/coins.js';

const router = Router();

router.use(requireAuth);

/**
 * Career totals for one player, counted from completed PvP matches.
 *
 * `users` tracks frames, not matches, so these two are derived. Practice is
 * excluded: those matches never reach the server, and counting them would let a
 * player pad a record the leaderboard reads as competitive.
 */
async function matchRecord(userId, db = getDb()) {
  const rows = await db('matches')
    .where({ mode: 'pvp', status: 'completed' })
    .andWhere((q) => q.where('player_a', userId).orWhere('player_b', userId))
    .select('winner_id');
  return {
    matchesPlayed: rows.length,
    // A concede still records a winner, so conceded matches count as losses.
    matchesWon: rows.filter((r) => String(r.winner_id) === String(userId)).length,
  };
}

/** Everything the lobby shows, in one call so the first screen paints once. */
router.get('/', async (req, res) => {
  const [record, daily, coins] = await Promise.all([
    matchRecord(req.user.id),
    dailyEligibleUsage(req.user.id),
    balanceOf(req.user.id),
  ]);
  res.json({
    ...record,
    framesWon: req.user.frames_won,
    framesPlayed: req.user.frames_played,
    bestBreak: req.user.best_break,
    lifetimeEligiblePoints: req.user.lifetime_eligible_points,
    daily,
    // The lobby's coin chip. Only read here: coins.js owns the ledger.
    coins,
  });
});

export default router;
