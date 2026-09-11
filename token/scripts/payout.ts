/**
 * Settle queued redemptions on-chain.
 *
 *   npm run payout -w @snooker/token            # dry run, prints what it would send
 *   npm run payout -w @snooker/token -- --send  # actually sends
 *
 * Deliberately a separate operator-run script rather than something the API
 * does inline: paying out is the only step that moves real value, and it should
 * be something a person chooses to run after looking at the numbers.
 *
 * Payouts mint new tokens, which is why mint authority is retained. Total
 * emission is bounded by the per-period budget the backend enforces, so the
 * amount minted in a period can never exceed REWARD_BUDGET_TOKENS.
 */
import { Address } from '@ton/core';
import { getDb, closeDb } from '@snooker/db';
import { openTreasury, treasuryBalance, explorerUrl, waitForSeqno } from '../src/client.js';
import { jettonMaster, toUnits, network } from '../src/env.js';

const SEND = process.argv.includes('--send');
const MIN_TREASURY_GRAM = 100_000_000n; // 0.1 GRAM: each mint costs gas

interface RedemptionRow {
  id: number;
  user_id: number;
  period_id: number;
  points: number;
  tokens: string | number;
  address: string;
  network: string;
  status: string;
}

async function main() {
  const treasury = await openTreasury();
  const knex = getDb();
  const master = Address.parse(jettonMaster());
  const minter = treasury.sdk.openJetton(master);

  const pending: RedemptionRow[] = await knex('redemptions')
    .where({ status: 'pending' })
    .andWhere({ network: network() })
    .orderBy('created_at', 'asc');

  if (pending.length === 0) {
    console.log('nothing pending.');
    return;
  }

  const total = pending.reduce((sum, r) => sum + Number(r.tokens), 0);
  console.log(`network:  ${treasury.network}`);
  console.log(`treasury: ${treasury.address}`);
  console.log(`pending:  ${pending.length} redemptions, ${total.toFixed(6)} tokens total\n`);

  for (const row of pending) {
    console.log(`  #${row.id} user ${row.user_id} · ${Number(row.tokens).toFixed(6)} → ${row.address}`);
  }

  if (!SEND) {
    console.log('\ndry run. re-run with --send to settle these.');
    return;
  }

  const balance = await treasuryBalance(treasury);
  if (balance < MIN_TREASURY_GRAM) {
    console.error(`\ntreasury has ${Number(balance) / 1e9} GRAM — not enough gas. Top it up first.`);
    process.exit(1);
  }

  console.log('\nsending…\n');
  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    // Re-check inside the loop: a long run could overlap with another operator.
    const fresh = await knex('redemptions').where({ id: row.id }).first();
    if (!fresh || fresh.status !== 'pending') {
      console.log(`  #${row.id} skipped (status is now ${fresh?.status})`);
      continue;
    }

    try {
      const recipient = Address.parse(row.address);
      const units = toUnits(Number(row.tokens).toFixed(9));
      if (units <= 0n) {
        await knex('redemptions').where({ id: row.id })
          .update({ status: 'failed', error: 'amount rounded to zero', settled_at: new Date() });
        console.log(`  #${row.id} zero amount — marked failed`);
        failed += 1;
        continue;
      }

      const seqno = await treasury.wallet.getSeqno();
      await minter.sendMint(treasury.sender, recipient, units);
      const landed = await waitForSeqno(treasury, seqno);

      await knex('redemptions').where({ id: row.id }).update({
        status: landed ? 'sent' : 'pending',
        error: landed ? null : 'confirmation timed out; will be retried',
        settled_at: landed ? new Date() : null,
        // TonClient4 does not hand back a message hash here; the recipient's
        // address is the practical audit trail, so record that.
        tx_hash: landed ? `mint:${recipient.toString()}` : null,
      });

      console.log(`  #${row.id} ${landed ? 'sent ✓' : 'unconfirmed — left pending'}`);
      if (landed) sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await knex('redemptions').where({ id: row.id })
        .update({ status: 'failed', error: message.slice(0, 500), settled_at: new Date() });
      console.log(`  #${row.id} failed: ${message}`);
      failed += 1;
    }
  }

  console.log(`\ndone: ${sent} sent, ${failed} failed, ${pending.length - sent - failed} left pending.`);
  console.log(explorerUrl(treasury.network, master.toString()));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
