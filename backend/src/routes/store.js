import { Router } from '../asyncRouter.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { buyItem } from '../services/coins.js';
import { storeView, equipItem } from '../services/store.js';
import { inventoryView, coinHistory, HISTORY_PAGE_MAX } from '../services/inventory.js';

const router = Router();

// A person taps Buy a few times a minute at most; this only stops scripts.
const buyLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true });

const BUY_HTTP = {
  bought: 200,
  owned: 200, // a double tap: nothing charged, and nothing to show as an error
  unknown_item: 404,
  not_for_sale: 400,
  insufficient: 409,
  negative_balance: 409,
};

const BUY_ERRORS = {
  unknown_item: 'no such item',
  not_for_sale: 'this item is free and already yours',
  insufficient: 'not enough coins',
  negative_balance: 'your coin balance is below zero after a refund; top up before buying',
};

const EQUIP_HTTP = { equipped: 200, bad_kind: 400, unknown_item: 404, not_owned: 403 };
const EQUIP_ERRORS = {
  bad_kind: 'kind must be "cue" or "ball"',
  unknown_item: 'no such item of that kind',
  not_owned: 'you do not own this item',
};

router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await storeView(req.user.id));
});

/**
 * Buy one item with coins. Only the item id is read from the body: the price
 * comes from the catalog, whatever the client sends. Success answers with the
 * whole store, so the screen redraws from one response.
 */
router.post('/buy', buyLimiter, async (req, res) => {
  const itemId = req.body?.itemId;
  const result = await buyItem(req.user.id, typeof itemId === 'string' ? itemId : null);
  const code = BUY_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: BUY_ERRORS[result.status] });
  return res.json({ ...result, store: await storeView(req.user.id) });
});

/** Owned cues and cue balls (Starter items included), with what is equipped. Read only. */
router.get('/inventory', async (req, res) => {
  res.json(await inventoryView(req.user.id));
});

/**
 * The coin history, newest first. ?before=<id> is the previous page's
 * `next`; ?limit= up to HISTORY_PAGE_MAX. Anything else is a 400.
 */
router.get('/history', async (req, res) => {
  const { before, limit } = req.query;
  const int = (v) => (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : NaN);
  if (before !== undefined && !Number.isSafeInteger(int(before))) return res.status(400).json({ error: 'before must be a ledger id' });
  if (limit !== undefined && !(int(limit) <= HISTORY_PAGE_MAX)) {
    return res.status(400).json({ error: `limit must be 1 to ${HISTORY_PAGE_MAX}` });
  }
  return res.json(await coinHistory(req.user.id, {
    before: before === undefined ? null : int(before),
    limit: limit === undefined ? undefined : int(limit),
  }));
});

router.post('/equip', async (req, res) => {
  const { kind, itemId } = req.body ?? {};
  const result = await equipItem(req.user.id, kind, itemId);
  const code = EQUIP_HTTP[result.status] ?? 500;
  if (code !== 200) return res.status(code).json({ ...result, error: EQUIP_ERRORS[result.status] });
  return res.json(result);
});

export default router;
