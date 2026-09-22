import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('settle');

const { getDb, migrate, closeDb } = await import('@snooker/db');
const s = await import('../src/settlement.js');

await migrate();
const knex = getDb();

test.after(async () => {
  await closeDb();
  await dropTestDatabase();
});

const [{ id: periodId }] = await knex('reward_periods').insert({
  kind: 'daily', starts_at: new Date(0), ends_at: new Date(86_400_000), budget_tokens: 100,
}).returning('id');

let seq = 0;
async function redemption(patch: Record<string, unknown> = {}) {
  seq += 1;
  // One redemption per player per period is a DB constraint, so each row gets its own player.
  const [{ id: userId }] = await knex('users').insert({ telegram_id: seq }).returning('id');
  const [{ id }] = await knex('redemptions').insert({
    request_id: `r${seq}`, user_id: userId, period_id: periodId,
    points: 10, tokens: 25, address: 'EQaddr', network: 'testnet', status: 'pending', ...patch,
  }).returning('id');
  return Number(id);
}
const statusOf = async (id: number) => (await knex('redemptions').where({ id }).first()).status;
const clear = () => knex('redemptions').del();

test('two overlapping runs cannot both claim the same redemption', async () => {
  await clear();
  const id = await redemption();
  const claims = await Promise.all([s.claimForSending(knex, id), s.claimForSending(knex, id)]);
  assert.deepEqual(claims.filter(Boolean).length, 1);
  assert.equal(await statusOf(id), 'sending');
  assert.equal(await s.claimForSending(knex, id), false, 'a claimed row is not claimable again');
});

test('a timed-out confirmation is unconfirmed, never pending — so the next run cannot resend it', async () => {
  await clear();
  const id = await redemption();
  await s.claimForSending(knex, id);
  await s.markUnconfirmed(knex, id, 'confirmation timed out');
  assert.equal(await statusOf(id), 'unconfirmed');
  assert.equal(await s.claimForSending(knex, id), false);
});

test('a late "sent" from a run cannot overwrite an operator decision', async () => {
  await clear();
  const id = await redemption();
  await s.claimForSending(knex, id);
  await s.markUnconfirmed(knex, id, 'timed out');
  await s.resolveByOperator(knex, id, 'pending');
  await s.markSent(knex, id, 'mint:late');
  assert.equal(await statusOf(id), 'pending', 'markSent only applies to a row this run is sending');
});

test('only a failure before broadcast releases the claim back to pending', async () => {
  await clear();
  const id = await redemption();
  await s.claimForSending(knex, id);
  await s.releaseClaim(knex, id, 'seqno lookup failed');
  assert.equal(await statusOf(id), 'pending');
});

test('operator resolution only touches rows that need checking', async () => {
  await clear();
  const unconfirmed = await redemption({ status: 'unconfirmed' });
  const crashed = await redemption({ status: 'sending' });
  const sent = await redemption({ status: 'sent' });
  const pending = await redemption();

  assert.deepEqual(await s.resolveByOperator(knex, unconfirmed, 'sent'), { ok: true });
  assert.equal(await statusOf(unconfirmed), 'sent');
  assert.deepEqual(await s.resolveByOperator(knex, crashed, 'pending'), { ok: true });
  assert.equal(await statusOf(crashed), 'pending');

  assert.equal((await s.resolveByOperator(knex, sent, 'pending')).ok, false, 'a sent row cannot be requeued');
  assert.equal(await statusOf(sent), 'sent');
  assert.equal((await s.resolveByOperator(knex, pending, 'sent')).ok, false);
  assert.equal((await s.resolveByOperator(knex, 99_999, 'sent')).ok, false);
});

test('the budget check counts every non-failed row and flags an overspent period', async () => {
  await clear();
  await redemption({ status: 'sent', tokens: 60 });
  await redemption({ status: 'failed', tokens: 1000 });   // failed rows do not count
  await redemption({ status: 'pending', tokens: 40 });
  let [check] = await s.budgetChecks(knex, [periodId]);
  assert.equal(check.committed, 100);
  assert.equal(check.over, false, 'exactly the budget is fine');

  await redemption({ status: 'pending', tokens: 0.5 });
  [check] = await s.budgetChecks(knex, [periodId]);
  assert.equal(check.over, true);
});

test('an operator resolution records the hash they checked, or says it has none', async () => {
  await clear();
  const withHash = await redemption({ status: 'unconfirmed' });
  const without = await redemption({ status: 'unconfirmed' });
  const hash = 'a37688e6a7539206b03ea34b6e81c459c519ecb9fc11f8c6d2995f519d7099e2';

  assert.deepEqual(await s.resolveByOperator(knex, withHash, 'sent', hash), { ok: true });
  assert.equal((await knex('redemptions').where({ id: withHash }).first()).tx_hash, hash);

  // No hash is honest about being a human call; it must not invent one.
  assert.deepEqual(await s.resolveByOperator(knex, without, 'sent'), { ok: true });
  assert.equal((await knex('redemptions').where({ id: without }).first()).tx_hash, 'confirmed-by-operator');
});
