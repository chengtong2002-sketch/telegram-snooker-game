/**
 * The store as the Mini App sees it: the catalog with this player's prices,
 * ownership and equipped items, their balance, and the coin packs on sale.
 *
 * Buying goes through coins.js, the only code that writes the ledger. This file
 * reads it, and writes nothing but users.equipped_cue / equipped_ball.
 */
import { getDb } from '@snooker/db';
import { items, itemById } from '@snooker/cosmetics';
import { config } from '../config.js';
import { balanceOf, ownedItemIds } from './coins.js';
import { equippedIds, EQUIPPED_COLUMN } from './equipped.js';
import { starsEnabledFor } from './stars.js';

export const KINDS = Object.freeze(['cue', 'ball']);

/** Packs as the client sees them: ids, coins and prices, no internal fields. */
export const packsOnSale = () => config.store.packs.map((p) => ({
  id: p.id, coins: p.coins, stars: p.stars, myrSen: p.myrSen,
}));

export async function storeView(userId) {
  const db = getDb();
  const [user, balance, bought] = await Promise.all([
    db('users').where({ id: userId }).first(),
    balanceOf(userId),
    ownedItemIds(userId),
  ]);
  const owned = new Set(bought);
  const equipped = equippedIds(user);
  return {
    balance,
    equipped,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      tier: item.tier,
      price: item.price,
      owned: item.price === 0 || owned.has(item.id),
      equipped: equipped[item.kind] === item.id,
    })),
    packs: packsOnSale(),
    starsEnabled: starsEnabledFor(user),
    rmEnabled: config.rm.enabled,
  };
}

/**
 * Equip an item the player owns, or a default. Returns { status, equipped? }:
 *   equipped      done (also when it was already equipped)
 *   bad_kind      kind is not 'cue' or 'ball'
 *   unknown_item  no such item, or not of that kind
 *   not_owned     a paid item this player has not bought
 */
export async function equipItem(userId, kind, itemId) {
  if (!KINDS.includes(kind)) return { status: 'bad_kind' };
  const item = itemById(itemId);
  if (!item || item.kind !== kind) return { status: 'unknown_item' };

  const db = getDb();
  if (item.price > 0) {
    const owned = await db('user_items').where({ user_id: userId, item_id: item.id }).first();
    if (!owned) return { status: 'not_owned' };
  }
  // The default is stored as null, so "nothing chosen" has one representation.
  await db('users').where({ id: userId }).update({ [EQUIPPED_COLUMN[kind]]: item.default ? null : item.id });
  const user = await db('users').where({ id: userId }).first();
  return { status: 'equipped', equipped: equippedIds(user) };
}
