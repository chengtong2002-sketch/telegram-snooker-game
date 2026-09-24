/**
 * Inventory: the words and grouping the Inventory tab shows. Pure (no DOM),
 * so node --test covers it; store.js draws it.
 *
 * Everything comes from the server (GET /api/store/inventory and
 * /api/store/history): this only decides how an entry reads.
 */

const fmt = (n) => Number(n ?? 0).toLocaleString('en');

const VIA = { stars: 'Telegram Stars', card: 'card or e-wallet' };

/** One history entry as a line a player understands. */
export function historyLabel(entry) {
  switch (entry.type) {
    case 'item': return `Bought ${entry.itemName ?? 'an item'}`;
    case 'pack': return entry.via ? `Coin pack · ${VIA[entry.via]}` : 'Coin pack';
    case 'refund': return entry.via ? `Refund · ${VIA[entry.via]}` : 'Refund';
    case 'grant': return 'Coins from Snooker';
    default: return 'Balance adjustment';
  }
}

/** "+1,200" / "−500" (a real minus sign), for the amount column. */
export const formatDelta = (delta) => (delta > 0 ? `+${fmt(delta)}` : `−${fmt(Math.abs(delta))}`);

/**
 * "24 Sep, 13:05" in the player's locale; the year only when it is not this
 * year, so a long history still reads unambiguously.
 */
export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

/**
 * Owned items by kind, equipped first, then the order the server listed them
 * (the catalog's). Returns { cue: [...], ball: [...] }.
 */
export function ownedByKind(items = []) {
  const out = { cue: [], ball: [] };
  for (const item of items) out[item.kind]?.push(item);
  for (const list of Object.values(out)) list.sort((a, b) => Number(b.equipped) - Number(a.equipped));
  return out;
}

/** The equipped pair, as items from the inventory (null where unknown). */
export function equippedPair(inv) {
  const byId = new Map((inv?.items ?? []).map((i) => [i.id, i]));
  return { cue: byId.get(inv?.equipped?.cue) ?? null, ball: byId.get(inv?.equipped?.ball) ?? null };
}
