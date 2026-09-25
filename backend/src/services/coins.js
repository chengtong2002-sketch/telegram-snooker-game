/**
 * Coins: the only code that writes coin_ledger or user_items.
 *
 * Coins buy cosmetics and nothing else. They are bought (Stars, later Revenue
 * Monster) or granted by the owner — never earned from matches — and nothing in
 * rewards.js or matchService.js reads them, so they can never touch PvP entry,
 * reward eligibility or the token budget (test/coins.test.js checks this).
 *
 * Every entry carries a ref, and coin_ledger.ref is UNIQUE, so each credit or
 * debit happens exactly once however many times it is attempted: a replayed
 * payment notification, a double tap on Buy, two requests racing.
 *
 * A balance can go below zero: a refund of coins that were already spent is
 * still taken back (docs/rm-payments-plan.md, decision 2). Nothing can be
 * bought until it is positive again. Items already bought stay owned.
 */
import { randomUUID } from 'node:crypto';
import { getDb, isPostgres } from '@snooker/db';
import { itemById } from '@snooker/cosmetics';

/** The sign each reason's delta must have. */
const SIGN = Object.freeze({ purchase: 1, grant: 1, spend: -1, refund: -1 });

/** A grant bigger than this is almost certainly a typo (an extra zero or two). */
export const MAX_GRANT = 100_000;

export async function balanceOf(userId, db = getDb()) {
  const row = await db('coin_ledger').where({ user_id: userId }).sum({ total: 'delta' }).first();
  return Number(row?.total ?? 0);
}

/**
 * Write one ledger entry, once. Returns { status: 'recorded' | 'duplicate', entry }.
 * The same ref with different content throws: that is a bug, never a retry, and
 * the first entry stands.
 */
export async function recordEntry({ userId, delta, reason, ref, actor = null, note = null }, db = getDb()) {
  const sign = Object.hasOwn(SIGN, reason) ? SIGN[reason] : 0;
  if (!sign) throw new Error(`unknown ledger reason: ${reason}`);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.sign(delta) !== sign) {
    throw new Error(`a ${reason} entry needs a ${sign > 0 ? 'positive' : 'negative'} whole number, got ${delta}`);
  }
  if (typeof ref !== 'string' || !ref || ref.length > 255) throw new Error('a ledger entry needs a ref of 1-255 characters'); // varchar(255), migration 000007

  const inserted = await db('coin_ledger')
    .insert({ user_id: userId, delta, reason, ref, actor, note })
    .onConflict('ref').ignore()
    .returning('id');
  const entry = await db('coin_ledger').where({ ref }).first();
  if (inserted.length) return { status: 'recorded', entry };

  const same = Number(entry.user_id) === Number(userId) && entry.delta === delta && entry.reason === reason;
  if (!same) throw new Error(`ledger ref ${ref} already holds a different entry`);
  return { status: 'duplicate', entry };
}

/** Owner grant, from scripts/grant-coins.js. Each call is a new grant. */
export async function grantCoins({ userId, amount, actor, note }) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_GRANT) {
    throw new Error(`a grant must be a whole number from 1 to ${MAX_GRANT.toLocaleString('en')}`);
  }
  if (!actor || !note) throw new Error('a grant needs an actor and a note (who, and why)');
  const { entry } = await recordEntry({ userId, delta: amount, reason: 'grant', ref: `grant:${randomUUID()}`, actor, note });
  return { entry, balance: await balanceOf(userId) };
}

/** Item ids this player has bought. Starter items are owned by everyone and are not listed. */
export async function ownedItemIds(userId, db = getDb()) {
  const rows = await db('user_items').where({ user_id: userId }).select('item_id');
  return rows.map((r) => r.item_id);
}

/**
 * Buy a catalog item with coins. The price comes from the catalog, never from
 * the caller. Returns { status, balance, price? }, where status is one of:
 *   bought            charged once, now owned
 *   owned             already owned: nothing charged (a double tap lands here)
 *   not_for_sale      a Starter item, which everyone already owns
 *   unknown_item      no such item
 *   negative_balance  a refund left the balance below zero
 *   insufficient      not enough coins
 *
 * The user's row is locked for the transaction on Postgres, so two purchases by
 * the same player run one after the other and can't both spend the same coins.
 * SQLite runs one transaction at a time already.
 */
export async function buyItem(userId, itemId) {
  const item = itemById(itemId);
  if (!item) return { status: 'unknown_item' };
  if (!(item.price > 0)) return { status: 'not_for_sale' };

  return getDb().transaction(async (trx) => {
    const lock = trx('users').where({ id: userId });
    const user = await (isPostgres() ? lock.forUpdate() : lock).first();
    if (!user) throw new Error(`no user ${userId}`);

    const balance = await balanceOf(userId, trx);
    const owned = await trx('user_items').where({ user_id: userId, item_id: item.id }).first();
    if (owned) return { status: 'owned', balance };
    if (balance < 0) return { status: 'negative_balance', balance, price: item.price };
    if (balance < item.price) return { status: 'insufficient', balance, price: item.price };

    const { entry } = await recordEntry({
      userId, delta: -item.price, reason: 'spend', ref: `buy:${userId}:${item.id}`,
    }, trx);
    await trx('user_items').insert({ user_id: userId, item_id: item.id, ledger_id: entry.id });
    return { status: 'bought', balance: balance - item.price, price: item.price };
  });
}
