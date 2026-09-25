import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { createStarsInvoice } from '../services/stars.js';

/*
 * The Mini App's coin payments: Telegram Stars only. Telegram requires Stars
 * for digital goods inside a Mini App, so MYR (Revenue Monster) is offered only
 * on the web top-up page (routes/topup.js), never here.
 */
const router = Router();

// Each call creates an invoice with Telegram; a person needs a few.
// Per player, not per IP: players on one network must not share a limit.
const invoiceLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, keyGenerator: (req) => `user:${req.user.id}`,
});

const ORDER_HTTP = {
  created: 200, disabled: 503, unknown_pack: 404, too_many_open: 429, daily_limit: 429, provider_error: 502,
};
const INVOICE_ERRORS = {
  unknown_pack: 'no such coin pack',
  daily_limit: 'that is the most coin orders for today',
  disabled: 'buying coins with Stars is not switched on',
  too_many_open: 'you have unpaid invoices open; pay or wait for one to expire',
  provider_error: 'Telegram did not create the invoice; try again',
};

router.use(requireAuth);

/** A Stars invoice for one pack. Only the pack id is read: the price is the server's. */
router.post('/stars/invoice', invoiceLimiter, async (req, res) => {
  const packId = req.body?.packId;
  const result = await createStarsInvoice(req.user.id, typeof packId === 'string' ? packId : null);
  const code = ORDER_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: INVOICE_ERRORS[result.status] });
  return res.json(result);
});

export default router;
