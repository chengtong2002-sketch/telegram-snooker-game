import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('store');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { grantCoins, recordEntry, balanceOf } = await import('../src/services/coins.js');
const { createPvpMatch } = await import('../src/services/matchService.js');
const { parsePacks, DEFAULT_PACKS } = await import('../src/packs.js');

await migrate();
const knex = getDb();

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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let nextTg = 7000;
/** A fresh signed-in player: { token, user } where user is the login payload. */
async function newPlayer() {
  const tg = nextTg++;
  const res = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `S${tg}` } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user, id: res.body.user.id };
}
const give = (p, amount) => grantCoins({ userId: p.id, amount, actor: 'test', note: 'store test' });
const buy = (p, itemId, extra = {}) => call('/api/store/buy', { method: 'POST', token: p.token, body: { itemId, ...extra } });
const equip = (p, kind, itemId) => call('/api/store/equip', { method: 'POST', token: p.token, body: { kind, itemId } });
const store = (p) => call('/api/store', { token: p.token });

/* ---------- listing ---------- */

test('the store needs a session', async () => {
  assert.equal((await call('/api/store')).status, 401);
  assert.equal((await call('/api/store/buy', { method: 'POST', body: { itemId: 'pearl' } })).status, 401);
  assert.equal((await call('/api/store/equip', { method: 'POST', body: { kind: 'cue', itemId: 'club-ash' } })).status, 401);
});

test('a new player: 0 coins, owns and wears only the defaults, sees the packs', async () => {
  const p = await newPlayer();
  const { status, body } = await store(p);
  assert.equal(status, 200);
  assert.equal(body.balance, 0);
  assert.deepEqual(body.equipped, { cue: 'club-ash', ball: 'club-white' });
  assert.equal(body.items.length, 10);
  for (const item of body.items) {
    assert.equal(item.owned, item.price === 0, item.id);
    assert.equal(item.equipped, item.id === 'club-ash' || item.id === 'club-white', item.id);
    assert.ok(['cue', 'ball'].includes(item.kind));
  }
  // MYR prices from config; no Stars (removed Sep 26).
  assert.deepEqual(body.packs, DEFAULT_PACKS.map(({ id, coins, myrSen }) => ({ id, coins, myrSen })));
  assert.equal('starsEnabled' in body, false);
});

/* ---------- buying ---------- */

test('buying with too few coins is refused and charges nothing', async () => {
  const p = await newPlayer();
  await give(p, 499);
  const res = await buy(p, 'crimson-crown');
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'insufficient');
  assert.equal(res.body.price, 500);
  assert.equal(await balanceOf(p.id), 499);
  assert.equal(await knex('user_items').where({ user_id: p.id }).first(), undefined);
});

test('a purchase charges the catalog price once, whatever price the client sends', async () => {
  const p = await newPlayer();
  await give(p, 1200);
  const res = await buy(p, 'crimson-crown', { price: 1, coins: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'bought');
  assert.equal(res.body.balance, 700);
  assert.equal(res.body.store.balance, 700);
  const item = res.body.store.items.find((i) => i.id === 'crimson-crown');
  assert.equal(item.owned, true);
  assert.equal(item.equipped, false, 'buying does not equip');

  // A double tap: nothing more is charged, and it is not an error.
  const again = await buy(p, 'crimson-crown');
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'owned');
  assert.equal(await balanceOf(p.id), 700);
  assert.equal((await knex('coin_ledger').where({ user_id: p.id, reason: 'spend' })).length, 1);
});

test('racing buy requests for one item charge once', async () => {
  const p = await newPlayer();
  await give(p, 1000);
  const results = await Promise.all(Array.from({ length: 6 }, () => buy(p, 'obsidian-gold')));
  assert.equal(results.filter((r) => r.body.status === 'bought').length, 1);
  assert.ok(results.every((r) => r.status === 200), 'the rest see "owned"');
  assert.equal(await balanceOf(p.id), 0);
});

test('free, unknown and malformed items are refused', async () => {
  const p = await newPlayer();
  await give(p, 1000);
  assert.equal((await buy(p, 'club-ash')).status, 400);
  for (const itemId of ['nope', '', null, 42, { id: 'pearl' }, ['pearl']]) {
    const res = await buy(p, itemId);
    assert.equal(res.status, 404, JSON.stringify(itemId));
    assert.equal(res.body.status, 'unknown_item');
  }
  assert.equal(await balanceOf(p.id), 1000);
});

test('a negative balance blocks buying until it is positive again', async () => {
  const p = await newPlayer();
  await give(p, 300);
  await recordEntry({ userId: p.id, delta: -400, reason: 'refund', ref: `stars-refund:store-test-${p.id}` });
  const res = await buy(p, 'ebony-points');
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'negative_balance');
  assert.equal((await store(p)).body.balance, -100);
  await give(p, 350);
  assert.equal((await buy(p, 'ebony-points')).body.status, 'bought');
});

test('the lobby stats carry the coin balance', async () => {
  const p = await newPlayer();
  assert.equal((await call('/api/stats', { token: p.token })).body.coins, 0);
  await give(p, 550);
  assert.equal((await call('/api/stats', { token: p.token })).body.coins, 550);
});

/* ---------- equipping ---------- */

test('only an owned item or a default can be equipped', async () => {
  const p = await newPlayer();
  const refused = await equip(p, 'cue', 'emerald-hall');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.status, 'not_owned');

  await give(p, 500);
  await buy(p, 'emerald-hall');
  const ok = await equip(p, 'cue', 'emerald-hall');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.equipped, { cue: 'emerald-hall', ball: 'club-white' });
  const listed = (await store(p)).body;
  assert.deepEqual(listed.equipped, ok.body.equipped);
  assert.deepEqual(listed.items.filter((i) => i.equipped).map((i) => i.id).sort(), ['club-white', 'emerald-hall']);

  // Back to the default, which is stored as null.
  const back = await equip(p, 'cue', 'club-ash');
  assert.deepEqual(back.body.equipped, { cue: 'club-ash', ball: 'club-white' });
  assert.equal((await knex('users').where({ id: p.id }).first()).equipped_cue, null);
});

test('equip refuses a wrong kind, a bad kind and an unknown item', async () => {
  const p = await newPlayer();
  assert.equal((await equip(p, 'ball', 'club-ash')).status, 404, 'a cue is not a ball');
  assert.equal((await equip(p, 'table', 'club-ash')).status, 400);
  assert.equal((await equip(p, 'cue', 'nope')).status, 404);
  assert.equal((await equip(p, 'cue', null)).status, 404);
  assert.equal((await equip(p, '__proto__', 'club-ash')).status, 400);
});

test('sign-in carries the equipped items, so practice can draw them offline', async () => {
  const p = await newPlayer();
  assert.deepEqual(p.user.equipped, { cue: 'club-ash', ball: 'club-white' });
  await give(p, 500);
  await buy(p, 'gold-band');
  await equip(p, 'ball', 'gold-band');
  const again = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: p.user.telegram_id } } });
  assert.deepEqual(again.body.user.equipped, { cue: 'club-ash', ball: 'gold-band' });
});

/* ---------- skins in the match payload ---------- */

test('a match payload carries each seat\'s skins, and a stale id falls back to the default', async () => {
  const a = await newPlayer();
  const b = await newPlayer();
  await give(a, 1500);
  await buy(a, 'crimson-crown');
  await buy(a, 'pearl');
  await equip(a, 'cue', 'crimson-crown');
  await equip(a, 'ball', 'pearl');
  // An id that left the catalog (or never was in it) must not reach the client.
  await knex('users').where({ id: b.id }).update({ equipped_cue: 'retired-cue', equipped_ball: 'crimson-crown' });

  const { row } = await createPvpMatch(a.id, b.id);
  for (const viewer of [a, b]) {
    const res = await call(`/api/match/${row.id}`, { token: viewer.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.match.skins, [
      { cue: 'crimson-crown', ball: 'pearl' },
      { cue: 'club-ash', ball: 'club-white' },
    ]);
    assert.equal(res.body.match.playerNames.length, 2);
  }
  // Skins are payload only: the stored match state never holds them.
  const stored = await knex('matches').where({ id: row.id }).first();
  assert.doesNotMatch(String(stored.state), /crimson-crown|pearl|club-ash/);
});

/* ---------- pack config ---------- */

test('pack config: empty means the defaults; anything malformed stops the server', () => {
  assert.equal(parsePacks(undefined), DEFAULT_PACKS);
  assert.equal(parsePacks('  '), DEFAULT_PACKS);
  assert.deepEqual(DEFAULT_PACKS.map((p) => [p.coins, p.myrSen]), [[100, 1990], [550, 3990], [1200, 5990]]);

  const custom = parsePacks('[{"id":"coins-50","coins":50,"myrSen":100}]');
  assert.deepEqual(custom, [{ id: 'coins-50', coins: 50, myrSen: 100 }]);
  // A Stars price left in COIN_PACKS from before Sep 26 is ignored, not an error.
  assert.deepEqual(parsePacks('[{"id":"coins-50","coins":50,"stars":40,"myrSen":100}]'), custom);

  for (const bad of [
    'nope', '{}', '[]',
    '[{"id":"a","coins":0,"myrSen":1}]',
    '[{"id":"a","coins":10,"myrSen":1.5}]',
    '[{"id":"a","coins":10,"myrSen":"4.90"}]',
    '[{"id":"A B","coins":10}]',
    '[{"id":"a","coins":10},{"id":"a","coins":20}]',
  ]) assert.throws(() => parsePacks(bad), undefined, bad);
});
