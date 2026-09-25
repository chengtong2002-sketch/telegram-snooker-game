import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('inventory');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { grantCoins, recordEntry } = await import('../src/services/coins.js');
const { describeEntry, HISTORY_PAGE, HISTORY_PAGE_MAX } = await import('../src/services/inventory.js');

await migrate();

const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let nextTg = 8100;
async function newPlayer() {
  const tg = nextTg++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `I${tg}` } } });
  return { token: res.body.token, id: res.body.user.id };
}
const give = (p, amount, note = 'inventory test') => grantCoins({ userId: p.id, amount, actor: 'test', note });
const inventory = (p) => call('/api/store/inventory', { token: p.token });
const history = (p, q = '') => call(`/api/store/history${q}`, { token: p.token });
const buy = (p, itemId) => call('/api/store/buy', { method: 'POST', token: p.token, body: { itemId } });
const equip = (p, kind, itemId) => call('/api/store/equip', { method: 'POST', token: p.token, body: { kind, itemId } });

test('inventory and history need a session', async () => {
  assert.equal((await call('/api/store/inventory')).status, 401);
  assert.equal((await call('/api/store/history')).status, 401);
});

test('a new player owns exactly the two Starter items, both equipped, and has no history', async () => {
  const p = await newPlayer();
  const { status, body } = await inventory(p);
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => [i.id, i.kind, i.starter, i.equipped, i.acquiredAt]), [
    ['club-ash', 'cue', true, true, null],
    ['club-white', 'ball', true, true, null],
  ]);
  assert.equal(body.boughtCount, 0);
  assert.deepEqual(body.equipped, { cue: 'club-ash', ball: 'club-white' });
  assert.deepEqual((await history(p)).body, { entries: [], next: null });
});

test('bought items appear with their date; only this player’s; equip marks move', async () => {
  const p = await newPlayer();
  const other = await newPlayer();
  await give(p, 2000);
  await give(other, 2000);
  assert.equal((await buy(p, 'pearl')).status, 200);
  assert.equal((await buy(p, 'crimson-crown')).status, 200);
  assert.equal((await buy(other, 'obsidian-gold')).status, 200);

  let { body } = await inventory(p);
  assert.deepEqual(body.items.map((i) => i.id).sort(), ['club-ash', 'club-white', 'crimson-crown', 'pearl']);
  assert.equal(body.boughtCount, 2);
  const pearl = body.items.find((i) => i.id === 'pearl');
  assert.ok(pearl.acquiredAt && !Number.isNaN(Date.parse(pearl.acquiredAt)));
  assert.equal(pearl.equipped, false);

  assert.equal((await equip(p, 'ball', 'pearl')).status, 200);
  ({ body } = await inventory(p));
  assert.equal(body.items.find((i) => i.id === 'pearl').equipped, true);
  assert.equal(body.items.find((i) => i.id === 'club-white').equipped, false);
  assert.deepEqual(body.equipped, { cue: 'club-ash', ball: 'pearl' });
});

test('equipping from the inventory is still server-checked: an unowned item is refused', async () => {
  const p = await newPlayer();
  const res = await equip(p, 'cue', 'obsidian-gold');
  assert.equal(res.status, 403);
  assert.deepEqual((await inventory(p)).body.equipped, { cue: 'club-ash', ball: 'club-white' });
});

test('history: newest first, typed, with the running balance, and nothing internal', async () => {
  const p = await newPlayer();
  await give(p, 1200, 'SECRET owner note');
  await buy(p, 'gold-band'); // 500
  await recordEntry({ userId: p.id, delta: 100, reason: 'purchase', ref: `stars:charge-${p.id}` });
  await recordEntry({ userId: p.id, delta: -100, reason: 'refund', ref: `stars-refund:charge-${p.id}`, actor: 'admin', note: 'refund of x' });
  await recordEntry({ userId: p.id, delta: 550, reason: 'purchase', ref: `rm:txn-${p.id}` });

  const { status, body } = await history(p);
  assert.equal(status, 200);
  assert.equal(body.next, null);
  assert.deepEqual(body.entries.map((e) => [e.type, e.via ?? e.itemId ?? null, e.delta, e.balanceAfter]), [
    ['pack', null, 550, 1250],
    ['refund', 'stars', -100, 700],
    ['pack', 'stars', 100, 800],
    ['item', 'gold-band', -500, 700],
    ['grant', null, 1200, 1200],
  ]);
  assert.equal(body.entries[3].itemName, 'Gold Band');
  for (const e of body.entries) {
    assert.ok(!Number.isNaN(Date.parse(e.at)));
    assert.deepEqual(Object.keys(e).filter((k) => ['ref', 'note', 'actor', 'user_id', 'reason'].includes(k)), []);
  }
  assert.ok(!JSON.stringify(body).includes('SECRET'), 'a grant note never reaches the player');
  assert.ok(!JSON.stringify(body).includes('charge-'), 'nor a provider transaction id');
});

test('history pages by id: every entry exactly once, balances continue across pages', async () => {
  const p = await newPlayer();
  for (let i = 1; i <= 45; i += 1) await give(p, i);
  const seen = [];
  let q = '';
  let pages = 0;
  for (;;) {
    const { status, body } = await history(p, q);
    assert.equal(status, 200);
    pages += 1;
    assert.ok(body.entries.length <= HISTORY_PAGE);
    seen.push(...body.entries);
    if (!body.next) break;
    q = `?before=${body.next}`;
  }
  assert.equal(pages, Math.ceil(45 / HISTORY_PAGE));
  assert.deepEqual(seen.map((e) => e.delta), Array.from({ length: 45 }, (_, i) => 45 - i));
  assert.equal(new Set(seen.map((e) => e.id)).size, 45);
  // Running balance: each entry's balance minus its delta is the next (older) entry's balance.
  for (let i = 0; i < seen.length - 1; i += 1) assert.equal(seen[i].balanceAfter - seen[i].delta, seen[i + 1].balanceAfter);
  assert.equal(seen[0].balanceAfter, (45 * 46) / 2);
  assert.equal(seen.at(-1).balanceAfter, 1);
  assert.equal((await history(p, '?limit=5')).body.entries.length, 5);
});

test('history refuses a bad cursor or limit', async () => {
  const p = await newPlayer();
  for (const q of ['?before=abc', '?before=-1', '?before=0', '?before=1.5', `?limit=${HISTORY_PAGE_MAX + 1}`, '?limit=0', '?limit=x']) {
    assert.equal((await history(p, q)).status, 400, q);
  }
});

test('another player’s ledger never shows up, even with their ids as the cursor', async () => {
  const p = await newPlayer();
  const other = await newPlayer();
  await give(other, 777);
  const theirs = await getDb()('coin_ledger').where({ user_id: other.id }).first();
  const { body } = await history(p, `?before=${Number(theirs.id) + 1}`);
  assert.deepEqual(body.entries, []);
});

test('describeEntry: unknown shapes do not break the list', () => {
  assert.deepEqual(describeEntry({ reason: 'spend', ref: 'buy:1:no-such-item' }), { type: 'item', itemId: 'no-such-item', itemName: null });
  assert.deepEqual(describeEntry({ reason: 'mystery', ref: 'x' }), { type: 'other' });
});
