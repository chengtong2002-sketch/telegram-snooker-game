import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { linkWallet, activeWallet, getDb, issueChallenge, consumeChallenge } from '@snooker/db';
import { verifyTonProof, newProofPayload } from '../services/tonProof.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const router = Router();

// Nonces live in the DB (auth_challenges), not in this process: /challenge and
// /link are separate requests and may land on different replicas.
const PAYLOAD_TTL_MS = 10 * 60 * 1000;

router.use(requireAuth);

/** Step 1: the Mini App asks for a nonce to embed in the TON Connect request. */
router.get('/challenge', async (req, res) => {
  const payload = await issueChallenge(req.user.id, {
    payload: newProofPayload(),
    ttlMs: PAYLOAD_TTL_MS,
  });
  res.json({
    payload,
    network: config.ton.network,
    manifestUrl: config.tonConnect.manifestUrl,
  });
});

router.get('/', async (req, res) => {
  const wallet = await activeWallet(req.user.id);
  res.json({
    wallet: wallet
      ? { address: wallet.address, network: wallet.network, verifiedAt: wallet.verified_at }
      : null,
    expectedNetwork: config.ton.network,
  });
});

/** Step 2: the wallet's signed ton_proof comes back and is verified server-side. */
router.post('/link', async (req, res) => {
  const expectedPayload = await consumeChallenge(req.user.id);
  if (!expectedPayload) {
    return res.status(400).json({ error: 'no active challenge — request /wallet/challenge first' });
  }

  const check = verifyTonProof(req.body, { expectedPayload });
  if (!check.ok) {
    logger.warn({ userId: req.user.id, reason: check.reason }, 'ton_proof rejected');
    return res.status(400).json({ error: check.reason });
  }
  if (check.network !== config.ton.network) {
    return res.status(400).json({
      error: `wallet is on ${check.network}, this deployment pays out on ${config.ton.network}`,
    });
  }

  const wallet = await linkWallet(req.user.id, {
    address: check.address,
    network: check.network,
    publicKey: check.publicKey,
  });
  logger.info({ userId: req.user.id, address: check.address }, 'wallet linked');
  return res.json({ wallet: { address: wallet.address, network: wallet.network } });
});

router.delete('/', async (req, res) => {
  await getDb()('wallets').where({ user_id: req.user.id }).update({ active: false });
  res.json({ ok: true });
});

export default router;
