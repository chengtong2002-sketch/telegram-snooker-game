/**
 * Which cue and cue ball a player has equipped, as catalog ids.
 *
 * Kept apart from store.js on purpose: match payloads need this, and
 * matchService must never reach the coin ledger (test/coins.test.js checks
 * both files). This reads the catalog and a user row, nothing else.
 */
import { itemById, defaultItem } from '@snooker/cosmetics';

export const EQUIPPED_COLUMN = Object.freeze({ cue: 'equipped_cue', ball: 'equipped_ball' });

/**
 * The item ids a user row has equipped, with the default for anything unset.
 * A stored id that is no longer in the catalog (or is the wrong kind) also
 * falls back to the default, so a renamed item can never leave a player with
 * no cue. A missing row gets the defaults.
 */
export function equippedIds(user) {
  const pick = (kind) => {
    const item = itemById(user?.[EQUIPPED_COLUMN[kind]]);
    return item?.kind === kind ? item.id : defaultItem(kind).id;
  };
  return { cue: pick('cue'), ball: pick('ball') };
}
