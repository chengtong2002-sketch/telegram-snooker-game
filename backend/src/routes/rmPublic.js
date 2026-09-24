/**
 * Revenue Monster's webhook, outside /api: RM's server calls it, without our
 * session. It is the only route that credits coins for an RM payment, and only
 * after RM's signature verifies (services/rm/payments.js).
 *
 * Answers 404 while PAYMENTS_RM_ENABLED is off, as if it did not exist.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Router } from '../asyncRouter.js';
import { config } from '../config.js';
import { handleRmWebhook } from '../services/rm/payments.js';

const router = Router();

// Per route, not router.use: this router is mounted at the root, beside /api.
const enabled = (req, res, next) => (config.rm.enabled ? next() : res.status(404).json({ error: `no route ${req.method} ${req.path}` }));

// RM itself sends a handful per payment; this only stops a flood of forgeries.
const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });

// The raw body: the signature is over RM's exact JSON, before any parsing.
router.post('/webhooks/rm', enabled, limiter, express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const { http, body } = await handleRmWebhook({ rawBody, headers: req.headers });
  res.status(http).json(body);
});

export default router;
