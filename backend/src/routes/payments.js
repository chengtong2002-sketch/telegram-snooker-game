import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { createRmOrder, orderForUser } from '../services/rm/payments.js';

/*
 * The Mini App's coin payments: ringgit through Revenue Monster (TNG / card on
 * RM's page). The user's decisions (Sep 26): MYR in the Mini App, made knowing
 * Telegram asks for Stars for digital goods inside Mini Apps, and no Stars at
 * all. The web top-up page (routes/topup.js) sells the same packs outside Telegram.
 */
const router = Router();

// Each call creates a checkout with RM; a person needs a few.
// Per player, not per IP: players on one network must not share a limit.
const rmOrderLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, keyGenerator: (req) => `user:${req.user.id}`,
});

const ORDER_HTTP = {
  created: 200, disabled: 503, unknown_pack: 404, too_many_open: 429, daily_limit: 429, provider_error: 502,
};
const RM_ERRORS = {
  unknown_pack: 'no such coin pack',
  daily_limit: 'that is the most coin orders for today',
  disabled: 'buying coins is not switched on yet',
  too_many_open: 'you have unpaid checkouts open; pay or wait for one to expire',
  provider_error: 'the payment page could not be opened; try again',
};

router.use(requireAuth);

/**
 * A Revenue Monster checkout (MYR) for one pack. Only the pack id and the
 * device are read: the price is the server's, and the device only picks RM's
 * layout (TNG app on a phone, QR on a computer).
 */
router.post('/rm/orders', rmOrderLimiter, async (req, res) => {
  const packId = typeof req.body?.packId === 'string' ? req.body.packId : null;
  const device = req.body?.device === 'mobile' ? 'mobile' : 'desktop';
  const result = await createRmOrder(req.user.id, packId, { device, from: 'app' });
  const code = ORDER_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: RM_ERRORS[result.status] });
  return res.json(result);
});

/** One of the player's own orders, for the store's "waiting for payment" sheet. Read-only. */
router.get('/orders/:id', async (req, res) => {
  const order = await orderForUser(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'no such order' });
  return res.json(order);
});

export default router;
