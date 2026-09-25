/**
 * Inventory: what a player owns, and their coin history. Read only.
 *
 * Owning and equipping stay where they were (coins.js buys, store.js equips);
 * this file only reads user_items and coin_ledger for the Inventory tab.
 *
 * The history never shows a ledger row as stored: `ref`, `actor` and `note`
 * are internal (a grant's note says why the owner gave coins, a ref carries a
 * payment provider's transaction id). Each row is reduced to what happened,
 * when, and by how much.
 */
import { getDb } from '@snooker/db';
import { items, itemById } from '@snooker/cosmetics';
import { balanceOf } from './coins.js';
import { equippedIds } from './equipped.js';

export const HISTORY_PAGE = 20;
export const HISTORY_PAGE_MAX = 50;

const iso = (t) => (t instanceof Date ? t : new Date(t)).toISOString();

/**
 * Owned cues and cue balls, Starter items included (everyone owns those),
 * each with when it was bought (null for Starter items).
 */
export async function inventoryView(userId) {
  const db = getDb();
  const [user, balance, rows] = await Promise.all([
    db('users').where({ id: userId }).first(),
    balanceOf(userId),
    db('user_items').where({ user_id: userId }).select('item_id', 'acquired_at'),
  ]);
  const acquired = new Map(rows.map((r) => [r.item_id, r.acquired_at]));
  const equipped = equippedIds(user);
  const owned = items
    .filter((item) => item.price === 0 || acquired.has(item.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      tier: item.tier,
      starter: item.price === 0,
      acquiredAt: acquired.has(item.id) ? iso(acquired.get(item.id)) : null,
      equipped: equipped[item.kind] === item.id,
    }));
  return {
    balance,
    equipped,
    items: owned,
    // Only the free Starter items: the screen offers the store instead.
    boughtCount: owned.filter((i) => !i.starter).length,
  };
}

/**
 * What one ledger row means to the player. The ref prefix says where it came
 * from (see migration 20260923_000005_store for the ref shapes).
 */
export function describeEntry(row) {
  const ref = String(row.ref);
  // Only Stars is named: the Mini App never mentions a payment made outside
  // Telegram (docs/topup-web-plan.md), so an RM pack reads as a plain "Coin pack".
  const via = ref.startsWith('stars') ? 'stars' : null;
  if (row.reason === 'spend') {
    const itemId = ref.split(':')[2] ?? null;
    return { type: 'item', itemId, itemName: itemById(itemId)?.name ?? null };
  }
  if (row.reason === 'purchase') return { type: 'pack', via };
  if (row.reason === 'refund') return { type: 'refund', via };
  if (row.reason === 'grant') return { type: 'grant' };
  return { type: 'other' };
}

/**
 * One page of the player's coin history, newest first, with the balance after
 * each entry. Keyset-paged on the ledger id: pass the previous page's `next`
 * as `before`. Returns { entries, next } — next is null on the last page.
 */
export async function coinHistory(userId, { before = null, limit = HISTORY_PAGE } = {}) {
  const db = getDb();
  const size = Math.min(HISTORY_PAGE_MAX, Math.max(1, limit));
  let q = db('coin_ledger').where({ user_id: userId });
  if (before != null) q = q.andWhere('id', '<', before);
  const rows = await q.orderBy('id', 'desc').limit(size + 1)
    .select('id', 'delta', 'reason', 'ref', 'created_at');
  const page = rows.slice(0, size);
  if (page.length === 0) return { entries: [], next: null };

  // The balance just after the newest row on this page; walk down from there.
  const top = await db('coin_ledger').where({ user_id: userId }).andWhere('id', '<=', page[0].id)
    .sum({ total: 'delta' }).first();
  let after = Number(top?.total ?? 0);
  const entries = page.map((row) => {
    const entry = {
      id: Number(row.id),
      at: iso(row.created_at),
      delta: Number(row.delta),
      balanceAfter: after,
      ...describeEntry(row),
    };
    after -= Number(row.delta);
    return entry;
  });
  return { entries, next: rows.length > size ? Number(page.at(-1).id) : null };
}
