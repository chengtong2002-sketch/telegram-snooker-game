/**
 * Coin packs on sale: how many coins, and the price in ringgit (Revenue Monster).
 *
 * Server config only (docs/store-plan.md, decision 2; docs/rm-payments-plan.md,
 * decision 3), so a price changes without a code change and the client never
 * sends one. A pack with no MYR price is not on sale. (Stars were removed on
 * Sep 26; a "stars" key in COIN_PACKS is ignored.)
 *
 * COIN_PACKS overrides the defaults with a JSON array of the same shape:
 *   [{"id":"coins-100","coins":100,"myrSen":490}, ...]
 * myrSen is in sen (RM 4.90 = 490), so no price is ever a float.
 */

export const DEFAULT_PACKS = Object.freeze([
  Object.freeze({ id: 'coins-100', coins: 100, myrSen: 490 }),
  Object.freeze({ id: 'coins-550', coins: 550, myrSen: 1990 }),
  Object.freeze({ id: 'coins-1200', coins: 1200, myrSen: 3990 }),
]);

const positiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const priceOrNull = (v) => v === undefined || v === null || positiveInt(v);

/**
 * Parse COIN_PACKS. Empty means the defaults. Anything malformed throws, so a
 * typo stops the server at boot instead of selling a pack at the wrong price.
 */
export function parsePacks(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PACKS;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('COIN_PACKS is not valid JSON');
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('COIN_PACKS must be a non-empty array');
  const seen = new Set();
  return Object.freeze(list.map((p, i) => {
    const where = `COIN_PACKS[${i}]`;
    if (!p || typeof p !== 'object') throw new Error(`${where} must be an object`);
    if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p.id)) throw new Error(`${where}.id must be 1-32 of a-z, 0-9, -`);
    if (seen.has(p.id)) throw new Error(`${where}.id "${p.id}" is repeated`);
    seen.add(p.id);
    if (!positiveInt(p.coins)) throw new Error(`${where}.coins must be a positive whole number`);
    if (!priceOrNull(p.myrSen)) throw new Error(`${where}.myrSen must be a positive whole number of sen or null`);
    return Object.freeze({ id: p.id, coins: p.coins, myrSen: p.myrSen ?? null });
  }));
}
