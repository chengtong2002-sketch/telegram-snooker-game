import { Router } from 'express';
import { verifyInitData, issueSession, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { activeWallet } from '@snooker/db';
import { activeMatchesFor } from '../services/matchService.js';

const router = Router();

/** Exchange Telegram WebApp initData for a session token. */
router.post('/telegram', async (req, res) => {
  const { initData } = req.body ?? {};

  if (!initData && config.allowDevAuth && req.body?.devUser?.id) {
    const { token, user } = await issueSession(req.body.devUser);
    return res.json({ token, user, dev: true });
  }

  const check = verifyInitData(initData);
  if (!check.ok) {
    // Field names and the bot id only (the token's public half) — never values.
    // Enough to tell a changed payload shape from a wrong BOT_TOKEN.
    logger.warn({
      reason: check.reason,
      fields: typeof initData === 'string' ? [...new URLSearchParams(initData).keys()].sort() : typeof initData,
      botId: config.botToken.split(':')[0] || null,
    }, 'telegram sign-in rejected');
    return res.status(401).json({ error: check.reason });
  }

  const { token, user } = await issueSession(check.user);
  return res.json({
    token,
    user: {
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      bestBreak: user.best_break,
    },
  });
});

router.get('/me', requireAuth, async (req, res) => {
  const wallet = await activeWallet(req.user.id);
  const matches = await activeMatchesFor(req.user.id);
  res.json({
    user: {
      id: req.user.id,
      telegramId: req.user.telegram_id,
      username: req.user.username,
      firstName: req.user.first_name,
      framesWon: req.user.frames_won,
      framesPlayed: req.user.frames_played,
      bestBreak: req.user.best_break,
      lifetimeEligiblePoints: req.user.lifetime_eligible_points,
    },
    wallet: wallet ? { address: wallet.address, network: wallet.network } : null,
    activeMatches: matches,
  });
});

export default router;
