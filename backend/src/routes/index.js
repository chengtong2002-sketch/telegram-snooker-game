import { Router } from '../asyncRouter.js';
import authRoutes from './auth.js';
import matchRoutes from './match.js';
import walletRoutes from './wallet.js';
import leaderboardRoutes from './leaderboard.js';
import rewardRoutes from './rewards.js';
import statsRoutes from './stats.js';
import syncRoutes from './sync.js';
import storeRoutes from './store.js';
import paymentRoutes from './payments.js';
import topupRoutes from './topup.js';
import internalRoutes from './internal.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

router.use('/auth', authRoutes);
router.use('/match', matchRoutes);
router.use('/wallet', walletRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/rewards', rewardRoutes);
router.use('/stats', statsRoutes);
router.use('/sync', syncRoutes);
router.use('/store', storeRoutes);
router.use('/payments', paymentRoutes);
// The web top-up page (outside Telegram), not the Mini App.
router.use('/topup', topupRoutes);

export { internalRoutes };
export default router;
