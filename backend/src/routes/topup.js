/**
 * The web top-up page's API (docs/topup-web-plan.md): Telegram login, the MYR
 * packs, and Revenue Monster orders. The only way to start an RM checkout.
 *
 * Every route answers 404 while PAYMENTS_RM_ENABLED is off, as if it did not
 * exist. Coins are still credited only by RM's verified webhook or the
 * reconciler (services/rm/payments.js); nothing here credits anything.
 */
import rateLimit from 'express-rate-limit';
import { Router } from '../asyncRouter.js';
import { userByTelegramId } from '@snooker/db';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { issueTopupSession, requireTopupAuth } from '../auth.js';
import { balanceOf } from '../services/coins.js';
import { createRmOrder, orderForUser } from '../services/rm/payments.js';
import { verifyLoginWidget } from '../services/webLogin.js';

const router = Router();

router.use((req, res, next) => (config.rm.enabled ? next() : res.status(404).json({ error: `no route ${req.method} ${req.path}` })));

// Per IP: nobody is signed in yet. Loose, because mobile carriers put many
// players behind one address (CGNAT); the hash check is what keeps forgeries out.
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true });
// Each order is a request to RM; a person needs a few. Per player, not per IP.
const orderLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, keyGenerator: (req) => `user:${req.user.id}`,
});

/** The packs with a MYR price. Public: the page shows them before login, and only server prices. */
router.get('/packs', (_req, res) => {
  res.json({
    packs: config.store.packs.filter((p) => p.myrSen > 0).map((p) => ({ id: p.id, coins: p.coins, myrSen: p.myrSen })),
  });
});

/** The widget's fields → a 30-minute top-up session for an account that already exists. */
router.post('/login', loginLimiter, async (req, res) => {
  const check = verifyLoginWidget(req.body);
  if (!check.ok) {
    logger.warn({ reason: check.reason }, 'topup login rejected');
    return res.status(401).json({ error: check.reason });
  }
  const user = await userByTelegramId(check.telegramId);
  // Coins only ever go to an account that plays: none is made from the web.
  if (!user) return res.status(404).json({ error: 'open @snookerPlayBot once first, then come back', status: 'no_account' });
  if (user.banned) return res.status(403).json({ error: 'account suspended' });
  const { token, expiresAt } = issueTopupSession(user);
  return res.json({
    token,
    expiresAt,
    user: { firstName: user.first_name, username: user.username },
    balance: await balanceOf(user.id),
  });
});

router.get('/me', requireTopupAuth, async (req, res) => {
  res.json({
    user: { firstName: req.user.first_name, username: req.user.username },
    balance: await balanceOf(req.user.id),
  });
});

const ORDER_HTTP = {
  created: 200, disabled: 404, unknown_pack: 404, unknown_method: 400, too_many_open: 429, daily_limit: 429, provider_error: 502,
};
const ORDER_ERRORS = {
  unknown_pack: 'no such coin pack',
  too_many_open: 'you have unpaid checkouts open; pay or wait for one to expire',
  daily_limit: 'that is the most coin orders for today',
  provider_error: 'the payment page could not be opened; try again',
};

/** An RM checkout for one pack. Only the pack id and the device are read: the price is the server's. */
router.post('/orders', requireTopupAuth, orderLimiter, async (req, res) => {
  const packId = typeof req.body?.packId === 'string' ? req.body.packId : null;
  const device = req.body?.device === 'mobile' ? 'mobile' : 'desktop';
  const result = await createRmOrder(req.user.id, packId, { device });
  const code = ORDER_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: ORDER_ERRORS[result.status] ?? 'not available' });
  return res.json(result);
});

/** One of the player's own orders, for the done screen. Read-only: it never asks RM. */
router.get('/orders/:id', requireTopupAuth, async (req, res) => {
  const order = await orderForUser(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'no such order' });
  return res.json(order);
});

export default router;
