import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { createStarsInvoice } from '../services/stars.js';
import { createRmOrder, orderForUser } from '../services/rm/payments.js';

const router = Router();

// Each call creates an order and a request to the provider; a person needs a few.
// Per player, not per IP: players on one network must not share a limit.
const orderLimiter = () => rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, keyGenerator: (req) => `user:${req.user.id}`,
});
const invoiceLimiter = orderLimiter();
const rmOrderLimiter = orderLimiter();

const ORDER_HTTP = {
  created: 200, disabled: 503, unknown_pack: 404, too_many_open: 429, daily_limit: 429, provider_error: 502,
};
const COMMON_ERRORS = {
  unknown_pack: 'no such coin pack',
  daily_limit: 'that is the most coin orders for today',
};
const INVOICE_ERRORS = {
  ...COMMON_ERRORS,
  disabled: 'buying coins with Stars is not switched on',
  too_many_open: 'you have unpaid invoices open; pay or wait for one to expire',
  provider_error: 'Telegram did not create the invoice; try again',
};
const RM_ERRORS = {
  ...COMMON_ERRORS,
  disabled: 'buying coins in MYR is not switched on',
  too_many_open: 'you have unpaid checkouts open; pay or wait for one to expire',
  provider_error: 'the payment page could not be opened; try again',
};

const reply = (res, result, errors) => {
  const code = ORDER_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: errors[result.status] });
  return res.json(result);
};

router.use(requireAuth);

/** A Stars invoice for one pack. Only the pack id is read: the price is the server's. */
router.post('/stars/invoice', invoiceLimiter, async (req, res) => {
  const packId = req.body?.packId;
  return reply(res, await createStarsInvoice(req.user.id, typeof packId === 'string' ? packId : null), INVOICE_ERRORS);
});

/** A Revenue Monster checkout (MYR) for one pack. Same rule: only the pack id is read. */
router.post('/rm/orders', rmOrderLimiter, async (req, res) => {
  const packId = req.body?.packId;
  return reply(res, await createRmOrder(req.user.id, typeof packId === 'string' ? packId : null), RM_ERRORS);
});

/** One of the player's own orders, for the store's "waiting for payment" state. */
router.get('/orders/:id', async (req, res) => {
  const order = await orderForUser(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'no such order' });
  return res.json(order);
});

export default router;
