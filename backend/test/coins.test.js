import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('coins');
process.env.NODE_ENV = 'test';

const { getDb, closeDb, migrate, upsertUser } = await import('@snooker/db');
const { catalog, items, itemById, defaultItem, TIER_PRICES } = await import('@snooker/cosmetics');
const {
  balanceOf, recordEntry, grantCoins, buyItem, ownedItemIds, MAX_GRANT,
} = await import('../src/services/coins.js');

await migrate();
const knex = getDb();
const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

test.after(async () => {
  await closeDb();
  await dropTestDatabase();
});

let nextTg = 5000;
const newUser = async () => {
  const tg = nextTg++;
  return upsertUser({ id: tg, first_name: `C${tg}` });
};
const give = (user, amount) => grantCoins({ userId: user.id, amount, actor: 'test', note: 'test grant' });
const ledgerRows = (user) => knex('coin_ledger').where({ user_id: user.id });

/* ---------- the catalog ---------- */

test('every item is priced by its tier, and only Starter items are free', () => {
  assert.equal(items.length, 10);
  for (const item of items) {
    assert.equal(item.price, TIER_PRICES[item.tier], `${item.id}: ${item.tier} should cost ${TIER_PRICES[item.tier]}`);
    assert.equal(item.price === 0, item.tier === 'Starter', item.id);
    assert.equal(item.price === 0, item.default === true, `${item.id}: free exactly when it is the default`);
  }
  assert.deepEqual(TIER_PRICES, { Starter: 0, Classic: 250, Rare: 500, Epic: 1000 });
});

test('item ids are unique, and lookups never throw on odd input', () => {
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.equal(itemById('crimson-crown').kind, 'cue');
  assert.equal(itemById('pearl').kind, 'ball');
  for (const odd of [undefined, null, 42, '', '__proto__', 'constructor', { id: 'pearl' }]) assert.equal(itemById(odd), null);
  assert.equal(defaultItem('cue').id, 'club-ash');
  assert.equal(defaultItem('ball').id, 'club-white');
  assert.equal(catalog.cues.length + catalog.cueBalls.length, items.length);
});

/* ---------- the ledger ---------- */

test('a new player has 0 coins; grants add up', async () => {
  const u = await newUser();
  assert.equal(await balanceOf(u.id), 0);
  await give(u, 100);
  await give(u, 550);
  assert.equal(await balanceOf(u.id), 650);
});

test('the same ref is recorded once, however many times it is attempted', async () => {
  const u = await newUser();
  const entry = { userId: u.id, delta: 550, reason: 'purchase', ref: `stars:test-charge-${u.id}` };
  const results = await Promise.all(Array.from({ length: 5 }, () => recordEntry(entry)));
  assert.equal(results.filter((r) => r.status === 'recorded').length, 1);
  assert.equal(results.filter((r) => r.status === 'duplicate').length, 4);
  assert.equal((await ledgerRows(u)).length, 1);
  assert.equal(await balanceOf(u.id), 550);
});

test('a ref reused with different content is refused, and the first entry stands', async () => {
  const u = await newUser();
  const other = await newUser();
  const ref = `stars:reused-${u.id}`;
  await recordEntry({ userId: u.id, delta: 100, reason: 'purchase', ref });
  await assert.rejects(recordEntry({ userId: u.id, delta: 1200, reason: 'purchase', ref }), /different entry/);
  await assert.rejects(recordEntry({ userId: other.id, delta: 100, reason: 'purchase', ref }), /different entry/);
  assert.equal(await balanceOf(u.id), 100);
  assert.equal(await balanceOf(other.id), 0);
});

test('each reason only moves coins its own way', async () => {
  const u = await newUser();
  const bad = [
    { delta: -5, reason: 'purchase' }, { delta: -5, reason: 'grant' },
    { delta: 5, reason: 'spend' }, { delta: 5, reason: 'refund' },
    { delta: 0, reason: 'grant' }, { delta: 1.5, reason: 'grant' }, { delta: 5, reason: 'bonus' },
    { delta: 5, reason: 'constructor' },
  ];
  for (const [i, b] of bad.entries()) {
    await assert.rejects(recordEntry({ userId: u.id, ref: `bad:${u.id}:${i}`, ...b }), undefined, JSON.stringify(b));
  }
  await assert.rejects(recordEntry({ userId: u.id, delta: 5, reason: 'grant', ref: '' }));
  assert.equal((await ledgerRows(u)).length, 0);
});

test('a refund can take the balance below zero', async () => {
  const u = await newUser();
  await recordEntry({ userId: u.id, delta: 550, reason: 'purchase', ref: `stars:neg-${u.id}` });
  await give(u, 0 + 50); // 600
  assert.equal((await buyItem(u.id, 'crimson-crown')).status, 'bought'); // 100 left
  await recordEntry({ userId: u.id, delta: -550, reason: 'refund', ref: `stars-refund:neg-${u.id}` });
  assert.equal(await balanceOf(u.id), -450);
  assert.deepEqual(await ownedItemIds(u.id), ['crimson-crown'], 'items bought stay owned after a refund');
});

test('grants: whole numbers from 1 to the cap, with a who and a why', async () => {
  const u = await newUser();
  for (const amount of [0, -1, 1.5, MAX_GRANT + 1, '100', NaN]) {
    await assert.rejects(grantCoins({ userId: u.id, amount, actor: 'test', note: 'x' }), undefined, String(amount));
  }
  await assert.rejects(grantCoins({ userId: u.id, amount: 10, actor: '', note: 'x' }));
  await assert.rejects(grantCoins({ userId: u.id, amount: 10, actor: 'test', note: '' }));
  const { entry, balance } = await grantCoins({ userId: u.id, amount: MAX_GRANT, actor: 'nick', note: 'demo' });
  assert.equal(balance, MAX_GRANT);
  assert.equal(entry.actor, 'nick');
  assert.equal(entry.note, 'demo');
  assert.match(entry.ref, /^grant:[0-9a-f-]{36}$/);
});

/* ---------- buying ---------- */

test('buying charges the catalog price once and the item is owned', async () => {
  const u = await newUser();
  await give(u, 1200);
  const r = await buyItem(u.id, 'obsidian-gold');
  assert.deepEqual(r, { status: 'bought', balance: 200, price: 1000 });
  assert.equal(await balanceOf(u.id), 200);
  assert.deepEqual(await ownedItemIds(u.id), ['obsidian-gold']);
  const spend = await knex('coin_ledger').where({ user_id: u.id, reason: 'spend' });
  assert.equal(spend.length, 1);
  assert.equal(spend[0].ref, `buy:${u.id}:obsidian-gold`);
  const owned = await knex('user_items').where({ user_id: u.id }).first();
  assert.equal(Number(owned.ledger_id), Number(spend[0].id), 'the item points at the entry that paid for it');
});

test('a double tap, or five racing requests, charge once', async () => {
  const u = await newUser();
  await give(u, 1200);
  const results = await Promise.all(Array.from({ length: 5 }, () => buyItem(u.id, 'gold-band')));
  assert.equal(results.filter((r) => r.status === 'bought').length, 1);
  assert.equal(results.filter((r) => r.status === 'owned').length, 4);
  assert.equal(await balanceOf(u.id), 700);
  assert.equal((await knex('user_items').where({ user_id: u.id })).length, 1);
});

test('two different items racing for the same coins: only one is bought', async () => {
  const u = await newUser();
  await give(u, 600);
  const results = await Promise.all([buyItem(u.id, 'pearl'), buyItem(u.id, 'emerald-hall')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['bought', 'insufficient']);
  assert.equal(await balanceOf(u.id), 100);
});

test('not enough coins: refused, nothing written', async () => {
  const u = await newUser();
  await give(u, 499);
  assert.deepEqual(await buyItem(u.id, 'pearl'), { status: 'insufficient', balance: 499, price: 500 });
  assert.equal((await ledgerRows(u)).length, 1);
  assert.deepEqual(await ownedItemIds(u.id), []);
});

test('a negative balance blocks buying, even something cheap enough to cover', async () => {
  const u = await newUser();
  await recordEntry({ userId: u.id, delta: 100, reason: 'purchase', ref: `stars:block-${u.id}` });
  await recordEntry({ userId: u.id, delta: -150, reason: 'refund', ref: `stars-refund:block-${u.id}` });
  assert.equal((await buyItem(u.id, 'ebony-points')).status, 'negative_balance');
  await give(u, 300); // 250: positive again
  assert.equal((await buyItem(u.id, 'ebony-points')).status, 'bought');
  assert.equal(await balanceOf(u.id), 0);
});

test('Starter items and unknown ids cannot be bought', async () => {
  const u = await newUser();
  await give(u, 5000);
  assert.equal((await buyItem(u.id, 'club-ash')).status, 'not_for_sale');
  assert.equal((await buyItem(u.id, 'club-white')).status, 'not_for_sale');
  for (const id of ['nope', '', null, undefined, '__proto__', 7]) {
    assert.equal((await buyItem(u.id, id)).status, 'unknown_item', String(id));
  }
  assert.equal(await balanceOf(u.id), 5000);
});

/* ---------- the boundary ---------- */

test('coins never reach rewards, matches or the sim', () => {
  const src = path.join(here, '..', 'src');
  const files = [
    path.join(src, 'services', 'rewards.js'),
    path.join(src, 'services', 'matchService.js'),
    path.join(src, 'services', 'matchmaking.js'),
    path.join(src, 'routes', 'rewards.js'),
    ...fs.readdirSync(path.join(here, '..', '..', 'shared', 'sim', 'src')).map((f) => path.join(here, '..', '..', 'shared', 'sim', 'src', f)),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /coin_ledger|user_items|coins\.js|@snooker\/cosmetics|balanceOf/, path.basename(file));
  }
});

/* ---------- the grant script ---------- */

const script = path.join(here, '..', 'scripts', 'grant-coins.js');
const grantCli = (...args) => run(process.execPath, [script, ...args], { env: process.env });

test('grant script: a dry run changes nothing; --yes grants once', async () => {
  const u = await newUser();
  const dry = await grantCli(String(u.telegram_id), '250', '--note', 'demo account');
  assert.match(dry.stdout, /DRY RUN: would grant 250 coins/);
  assert.equal(await balanceOf(u.id), 0);

  const real = await grantCli(String(u.telegram_id), '250', '--note', 'demo account', '--by', 'owner', '--yes');
  assert.match(real.stdout, /Granted 250 coins .* balance now 250/);
  const [row] = await ledgerRows(u);
  assert.equal(row.actor, 'owner');
  assert.equal(row.note, 'demo account');

  const bal = await grantCli(String(u.telegram_id));
  assert.match(bal.stdout, /: 250 coins/);
});

test('grant script: refuses a missing note, a bad amount or an unknown player', async () => {
  const u = await newUser();
  const tg = String(u.telegram_id);
  const fails = async (args, pattern) => {
    const err = await grantCli(...args).then(() => null, (e) => e);
    assert.ok(err, `${args.join(' ')} should fail`);
    assert.match(err.stderr, pattern);
  };
  await fails([tg, '100', '--yes'], /--note/);
  await fails([tg, '0', '--note', 'x', '--yes'], /whole number/);
  await fails([tg, '-5', '--note', 'x', '--yes'], /whole number/);
  await fails([tg, String(MAX_GRANT + 1), '--note', 'x', '--yes'], /whole number/);
  await fails(['999999999', '100', '--note', 'x', '--yes'], /no player/);
  await fails(['@someone', '100'], /usage/);
  assert.equal(await balanceOf(u.id), 0);
});
