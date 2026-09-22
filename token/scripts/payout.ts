/**
 * Settle queued redemptions on-chain.
 *
 *   npm run payout -w @snooker/token                          # dry run, prints what it would send
 *   npm run payout -w @snooker/token -- --send                # actually sends
 *   npm run payout -w @snooker/token -- --mark-sent <id> [tx] # after checking the explorer: it landed
 *   npm run payout -w @snooker/token -- --requeue <id>        # after checking the explorer: it did not
 *
 * Deliberately a separate operator-run script rather than something the API
 * does inline: paying out is the only step that moves real value, and it should
 * be something a person chooses to run after looking at the numbers.
 *
 * Payouts mint new tokens, which is why mint authority is retained. Total
 * emission is bounded by the per-period budget the backend enforces, and this
 * script refuses to send for any period whose committed total exceeds it.
 *
 * A mint that may have been broadcast is never retried automatically — see
 * src/settlement.ts for the states and why.
 */
import { Address } from '@ton/core';
import { getDb, closeDb } from '@snooker/db';
import {
  openTreasury, treasuryBalance, explorerUrl, explorerTxUrl, waitForSeqno,
  accountCursor, findSentTransaction,
} from '../src/client.js';
import { jettonMaster, toUnits, network } from '../src/env.js';
import {
  claimForSending, releaseClaim, markSent, markFailed, markUnconfirmed,
  resolveByOperator, budgetChecks, NEEDS_CHECK, type RedemptionRow,
} from '../src/settlement.js';

const SEND = process.argv.includes('--send');
const MIN_TREASURY_GRAM = 100_000_000n; // 0.1 GRAM: each mint costs gas

const flagValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? '';
};

/** The second argument after a flag, for `--mark-sent <id> <tx>`. */
const flagValue2 = (flag: string) => {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? undefined : process.argv[i + 2];
  return v === undefined || v.startsWith('--') ? null : v;
};

async function resolveCommand(): Promise<boolean> {
  const sent = flagValue('--mark-sent');
  const requeue = flagValue('--requeue');
  if (sent === null && requeue === null) return false;
  const id = Number(sent ?? requeue);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pass a redemption id, e.g. --mark-sent 12');
  // The hash the operator read off the explorer, when they pass it. Checked for
  // shape, so a pasted URL or a half-copied hash is not stored as an audit trail.
  const txHash = sent !== null ? flagValue2('--mark-sent') : null;
  if (txHash !== null && !/^[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error(`not a transaction hash: ${txHash} (expected 64 hex characters, or leave it off)`);
  }

  const result = await resolveByOperator(getDb(), id, sent !== null ? 'sent' : 'pending', txHash);
  if (!result.ok) throw new Error(result.reason);
  console.log(`#${id} is now ${sent !== null ? 'sent' : 'pending (will be sent on the next --send)'}.`);
  return true;
}

async function main() {
  if (await resolveCommand()) return;

  const knex = getDb();
  const net = network();

  // Anything a previous run could not confirm has to be checked by a person
  // first. Sending more while those are unresolved is how double payments hide.
  const needsCheck: RedemptionRow[] = await knex('redemptions')
    .whereIn('status', NEEDS_CHECK)
    .andWhere({ network: net })
    .orderBy('id', 'asc');
  if (needsCheck.length > 0) {
    console.log('These redemptions may or may not have been minted. Check each recipient on the explorer:\n');
    for (const row of needsCheck) {
      console.log(`  #${row.id} ${row.status} · ${Number(row.tokens).toFixed(6)} → ${row.address}${row.error ? ` (${row.error})` : ''}`);
    }
    console.log('\nthen resolve each with --mark-sent <id> (it landed) or --requeue <id> (it did not).');
  }

  const pending: RedemptionRow[] = await knex('redemptions')
    .where({ status: 'pending' })
    .andWhere({ network: net })
    .orderBy('created_at', 'asc');

  if (pending.length === 0) {
    console.log(needsCheck.length ? '\nnothing pending.' : 'nothing pending.');
    return;
  }

  const checks = await budgetChecks(knex, pending.map((r) => r.period_id));
  const overBudget = new Set(checks.filter((c) => c.over).map((c) => c.periodId));

  const total = pending.reduce((sum, r) => sum + Number(r.tokens), 0);
  console.log(`\nnetwork:  ${net}`);
  console.log(`pending:  ${pending.length} redemptions, ${total.toFixed(6)} tokens total\n`);
  for (const row of pending) {
    const flag = overBudget.has(row.period_id) ? '  ✗ period over budget' : '';
    console.log(`  #${row.id} user ${row.user_id} · period ${row.period_id} · ${Number(row.tokens).toFixed(6)} → ${row.address}${flag}`);
  }
  for (const c of checks.filter((x) => x.over)) {
    console.log(`\n✗ period ${c.periodId}: ${c.committed} tokens committed against a budget of ${c.budget}. `
      + 'Its redemptions will not be sent — investigate before settling.');
  }

  if (!SEND) {
    console.log('\ndry run. re-run with --send to settle these.');
    return;
  }
  if (needsCheck.length > 0) {
    console.error('\nrefusing to send while redemptions above are unresolved.');
    process.exitCode = 1;
    return;
  }

  const treasury = await openTreasury();
  const master = Address.parse(jettonMaster());
  const minter = treasury.sdk.openJetton(master);
  console.log(`treasury: ${treasury.address}`);

  const balance = await treasuryBalance(treasury);
  if (balance < MIN_TREASURY_GRAM) {
    console.error(`\ntreasury has ${Number(balance) / 1e9} GRAM — not enough gas. Top it up first.`);
    process.exit(1);
  }

  /**
   * The transaction this send produced, or null if none has appeared. A lookup
   * that throws is reported and then read as null: not knowing is the same as
   * not confirmed, and the row is left for a person to resolve.
   */
  const settledTx = async (id: number, mark: { lt: bigint } | null) => {
    try {
      return await findSentTransaction(treasury, mark);
    } catch (err) {
      console.log(`  #${id} could not be looked up (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  };

  console.log('\nsending…\n');

  const tally = { sent: 0, failed: 0, unconfirmed: 0, skipped: 0 };

  for (const row of pending) {
    if (overBudget.has(row.period_id)) {
      tally.skipped += 1;
      continue;
    }
    // Atomic claim: if another run got here first, leave the row to it.
    if (!(await claimForSending(knex, row.id))) {
      console.log(`  #${row.id} skipped (another run claimed it)`);
      tally.skipped += 1;
      continue;
    }

    // --- before broadcast: any failure here means nothing was sent ---------
    let recipient: Address;
    let units: bigint;
    let seqno: number;
    let before: { lt: bigint } | null;
    try {
      recipient = Address.parse(row.address);
      units = toUnits(Number(row.tokens).toFixed(9));
    } catch (err) {
      await markFailed(knex, row.id, `bad redemption: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  #${row.id} failed: unusable address or amount`);
      tally.failed += 1;
      continue;
    }
    if (units <= 0n) {
      await markFailed(knex, row.id, 'amount rounded to zero');
      console.log(`  #${row.id} zero amount — marked failed`);
      tally.failed += 1;
      continue;
    }
    // Both reads mark where the account stood before this send, which is how
    // the transaction is identified afterwards. A failure here is still
    // pre-broadcast, so the row goes back to pending. Sending without the mark
    // is the case worth avoiding: the search would then be free to match an
    // older send and record its hash against this redemption.
    try {
      seqno = await treasury.wallet.getSeqno();
      before = await accountCursor(treasury);
    } catch (err) {
      await releaseClaim(knex, row.id, `pre-send read failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  #${row.id} not sent (could not read the account) — left pending`);
      tally.skipped += 1;
      continue;
    }

    // --- broadcast: from here on, an error does not prove nothing landed ---
    //
    // Both outcomes below ask the chain the question an operator would: did a
    // transaction appear after our mark? A yes settles the row with the real
    // hash. Anything else leaves it `unconfirmed`, so the lookup can only move
    // a row towards `sent` and never back to `pending`: a false negative costs
    // one manual check, and a false positive is not reachable.
    try {
      await minter.sendMint(treasury.sender, recipient, units);
      const landed = await waitForSeqno(treasury, seqno);
      const tx = await settledTx(row.id, before);
      if (landed || tx) {
        await markSent(knex, row.id, tx ? tx.hash : `mint:${recipient.toString()}`);
        const where = tx
          ? ` ${explorerTxUrl(treasury.network, tx.hash)}`
          : ' (landed, but no transaction hash came back; recorded the recipient)';
        console.log(`  #${row.id} sent ✓${where}`);
        tally.sent += 1;
      } else {
        await markUnconfirmed(knex, row.id, 'confirmation timed out; check the explorer before resolving');
        console.log(`  #${row.id} UNCONFIRMED — check the explorer, then --mark-sent or --requeue`);
        tally.unconfirmed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tx = await settledTx(row.id, before);
      if (tx) {
        // It landed in spite of the error, so this is not a case for a person.
        await markSent(knex, row.id, tx.hash);
        console.log(`  #${row.id} sent ✓ (the send reported "${message}", but the transaction is on chain)`);
        console.log(`      ${explorerTxUrl(treasury.network, tx.hash)}`);
        tally.sent += 1;
      } else {
        await markUnconfirmed(knex, row.id, `error during send: ${message}`);
        console.log(`  #${row.id} UNCONFIRMED (error during send: ${message}) — check the explorer before resolving`);
        tally.unconfirmed += 1;
      }
    }
  }

  console.log(`\ndone: ${tally.sent} sent, ${tally.failed} failed, ${tally.unconfirmed} unconfirmed, ${tally.skipped} skipped.`);
  if (tally.unconfirmed) console.log('unconfirmed rows block the next --send until resolved.');
  console.log(explorerUrl(treasury.network, master.toString()));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
