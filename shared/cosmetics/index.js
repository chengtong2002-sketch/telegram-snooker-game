/**
 * The catalog for Node (the backend and its scripts). The game imports
 * cosmetics.json directly through Vite and never loads this file.
 *
 * Prices are in coins and live here, not in the client: the store trusts only
 * this file for what an item costs. Starter items cost 0 and every player owns
 * them from the start; they can be equipped but never bought.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const catalog = JSON.parse(fs.readFileSync(path.join(here, 'cosmetics.json'), 'utf8'));

/** Coins per tier, as approved in docs/store-plan.md. cosmetics.json must agree. */
export const TIER_PRICES = Object.freeze({ Starter: 0, Classic: 250, Rare: 500, Epic: 1000 });

/** Every item, flattened, with its kind: 'cue' | 'ball'. */
export const items = Object.freeze([
  ...catalog.cues.map((item) => Object.freeze({ ...item, kind: 'cue' })),
  ...catalog.cueBalls.map((item) => Object.freeze({ ...item, kind: 'ball' })),
]);

const byId = new Map(items.map((item) => [item.id, item]));

/** The item with this id, or null. Never throws on odd input. */
export const itemById = (id) => (typeof id === 'string' ? byId.get(id) ?? null : null);

/** The default item of a kind (Club Ash, Club White). */
export const defaultItem = (kind) => items.find((item) => item.kind === kind && item.default) ?? null;
