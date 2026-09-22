/**
 * Redemption state for the payout script, kept apart from the chain calls so
 * the parts that decide "is it safe to send this?" can be tested on SQLite.
 *
 *   pending ──claim──▶ sending ──landed──▶ sent
 *      ▲                  │                 ▲
 *      │ (nothing was     ├──bad address / zero amount──▶ failed
 *      │  broadcast)      │                 │ (found on chain)
 *      └────release───────┤                 │
 *                         └──timeout / error during send──▶ unconfirmed
 *
 * The payout script reads the treasury account back before giving up, so a send
 * that landed despite a timeout or an error settles as `sent` with its real
 * transaction hash. That check only ever moves a row towards `sent`: a row it
 * cannot confirm stays `unconfirmed` and waits for a person.
 *
 * The rule the whole thing exists for: once a mint *may* have been broadcast,
 * the row never goes back to `pending` automatically. `unconfirmed` (or a
 * `sending` row left by a crashed run) waits for an operator to check the
 * chain and resolve it with --mark-sent or --requeue. A slow confirmation used
 * to leave the row `pending`, so the next run minted it a second time.
 */
import type { Knex } from 'knex';

export type RedemptionStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unconfirmed';

export interface RedemptionRow {
  id: number;
  user_id: number;
  period_id: number;
  points: number;
  tokens: string | number;
  address: string;
  network: string;
  status: RedemptionStatus;
  error?: string | null;
}

/** Rows that need a person to look at the chain before anything else happens. */
export const NEEDS_CHECK: RedemptionStatus[] = ['sending', 'unconfirmed'];

/**
 * Take a pending row for sending. Atomic: the UPDATE only matches while the row
 * is still `pending`, so two overlapping runs cannot both claim it.
 */
export async function claimForSending(knex: Knex, id: number): Promise<boolean> {
  const updated = await knex('redemptions')
    .where({ id, status: 'pending' })
    .update({ status: 'sending', error: null });
  return updated === 1;
}

/** Nothing was broadcast (e.g. seqno lookup failed): safe to try again later. */
export const releaseClaim = (knex: Knex, id: number, error: string) => knex('redemptions')
  .where({ id, status: 'sending' })
  .update({ status: 'pending', error: error.slice(0, 500) });

export const markSent = (knex: Knex, id: number, txRef: string) => knex('redemptions')
  .where({ id, status: 'sending' })
  .update({ status: 'sent', error: null, tx_hash: txRef, settled_at: new Date() });

/** Rejected before any broadcast, for a reason retrying will not fix. */
export const markFailed = (knex: Knex, id: number, error: string) => knex('redemptions')
  .where({ id, status: 'sending' })
  .update({ status: 'failed', error: error.slice(0, 500), settled_at: new Date() });

/** The mint may or may not have landed. Never retried without a person checking. */
export const markUnconfirmed = (knex: Knex, id: number, error: string) => knex('redemptions')
  .where({ id, status: 'sending' })
  .update({ status: 'unconfirmed', error: error.slice(0, 500) });

/**
 * Operator resolution after checking the explorer.
 *  - `sent`:    the mint is on-chain.
 *  - `pending`: it definitely is not, so it may be sent again.
 *
 * `txHash` is the transaction the operator was looking at when they decided.
 * It is optional, because they may have only the recipient to go on, but a row
 * resolved without one says so rather than implying a hash nobody holds.
 */
export async function resolveByOperator(
  knex: Knex,
  id: number,
  outcome: 'sent' | 'pending',
  txHash?: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const row: RedemptionRow | undefined = await knex('redemptions').where({ id }).first();
  if (!row) return { ok: false, reason: `no redemption #${id}` };
  if (!NEEDS_CHECK.includes(row.status)) {
    return { ok: false, reason: `#${id} is ${row.status}; only sending/unconfirmed rows can be resolved` };
  }
  const patch = outcome === 'sent'
    ? { status: 'sent', error: null, tx_hash: txHash || 'confirmed-by-operator', settled_at: new Date() }
    : { status: 'pending', error: null };
  const updated = await knex('redemptions').where({ id, status: row.status }).update(patch);
  return updated === 1 ? { ok: true } : { ok: false, reason: `#${id} changed while resolving; re-run` };
}

export interface BudgetCheck {
  periodId: number;
  budget: number;
  committed: number;
  over: boolean;
}

/**
 * Tokens already committed to each period (everything except failed rows)
 * against that period's budget. The backend's rate formula should make this
 * impossible to exceed; the payout script checks anyway because it is the one
 * step that moves value.
 */
export async function budgetChecks(knex: Knex, periodIds: number[]): Promise<BudgetCheck[]> {
  const out: BudgetCheck[] = [];
  for (const periodId of [...new Set(periodIds)]) {
    const period = await knex('reward_periods').where({ id: periodId }).first();
    const row = await knex('redemptions')
      .where({ period_id: periodId })
      .whereNot({ status: 'failed' })
      .sum({ tokens: 'tokens' })
      .count({ n: 'id' })
      .first();
    const budget = Number(period?.budget_tokens ?? 0);
    const committed = Number(row?.tokens ?? 0);
    // Each quote is rounded to 9 decimals, so allow that much per row.
    const slack = Number(row?.n ?? 0) * 1e-9;
    out.push({ periodId, budget, committed, over: !period || committed > budget + slack });
  }
  return out;
}
