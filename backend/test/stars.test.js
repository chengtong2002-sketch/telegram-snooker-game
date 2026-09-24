import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useTestDatabase } from '@snooker/db/testing';

/* A stand-in for the Bot API: records every call, answers from `botApi.reply`. */
const botApi = {
  calls: [],
  transactions: [],
  refunded: new Set(),
  failInvoice: false,
};
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const params = JSON.parse(body || '{}');
    botApi.calls.push({ method, params, url: req.url });
    const send = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (method === 'createInvoiceLink') {
      if (botApi.failInvoice) return send({ ok: false, error_code: 400, description: 'Bad Request: CURRENCY_INVALID' });
      return send({ ok: true, result: `https://t.me/$invoice-${params.payload}` });
    }
    if (method === 'refundStarPayment') {
      if (botApi.refunded.has(params.telegram_payment_charge_id)) {
        return send({ ok: false, error_code: 400, description: 'Bad Request: CHARGE_ALREADY_REFUNDED' });
      }
      botApi.refunded.add(params.telegram_payment_charge_id);
      return send({ ok: true, result: true });
    }
    if (method === 'getStarTransactions') return send({ ok: true, result: { transactions: botApi.transactions } });
    return send({ ok: false, error_code: 404, description: 'Not Found' });
  });
}).listen(0);
await new Promise((r) => stub.once('listening', r));

const dropTestDatabase = await useTestDatabase('stars');
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.BOT_TOKEN = '123456:TEST';
process.env.PAYMENTS_STARS_ENABLED = 'true';
// Parsed for real below: an allowlist that parses to nothing fails closed and silently.
process.env.PAYMENTS_STARS_ALLOW_TELEGRAM_IDS = ' 7625262769, 42 ,not-an-id,';
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${stub.address().port}`;
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { balanceOf, buyItem } = await import('../src/services/coins.js');
const {
  refundStarsOrder, reconcileStars, OPEN_ORDER_LIMIT,
} = await import('../src/services/stars.js');

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  stub.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(p, { method = 'GET', body, token, internal = false } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(internal ? { 'x-internal-key': config.internalApiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let nextTg = 52_000;
async function player() {
  const tg = nextTg++;
  const { body } = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `S${tg}` } } });
  return { token: body.token, userId: body.user.id, tg };
}

const invoice = (p, packId = 'coins-100', extra = {}) => call('/api/payments/stars/invoice', {
  method: 'POST', token: p.token, body: { packId, ...extra },
});
const check = (body) => call('/internal/payments/stars/check', { method: 'POST', internal: true, body });
const paid = (body) => call('/internal/payments/stars/paid', { method: 'POST', internal: true, body });
const ledgerRefs = (userId) => getDb()('coin_ledger').where({ user_id: userId }).orderBy('id').pluck('ref');

/** Invoice, pre-checkout and payment for one pack, as Telegram would run them. */
async function buyPack(p, packId = 'coins-100', chargeId = `charge-${Math.random().toString(36).slice(2)}`) {
  const inv = await invoice(p, packId);
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const pre = await check({
    orderId: inv.body.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: inv.body.stars,
  });
  assert.equal(pre.body.ok, true, JSON.stringify(pre.body));
  const done = await paid({
    orderId: inv.body.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: inv.body.stars, chargeId,
  });
  return { inv: inv.body, done: done.body, chargeId };
}

test('an invoice is priced by the server, for our order id, in Stars', async () => {
  const p = await player();
  botApi.calls.length = 0;
  const res = await invoice(p, 'coins-550', { stars: 1, coins: 999999, price: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.coins, 550);
  assert.equal(res.body.stars, 400, 'the pack price, whatever the body said');
  assert.match(res.body.orderId, /^st[0-9a-f]{22}$/);
  const [sent] = botApi.calls;
  assert.equal(sent.method, 'createInvoiceLink');
  assert.equal(sent.params.payload, res.body.orderId);
  assert.equal(sent.params.currency, 'XTR');
  assert.deepEqual(sent.params.prices, [{ label: '550 coins', amount: 400 }]);
  assert.ok(!('provider_token' in sent.params) || sent.params.provider_token === '', 'Stars take no provider token');
  const order = await getDb()('payment_orders').where({ id: res.body.orderId }).first();
  assert.equal(order.status, 'pending');
  assert.equal(Number(order.amount), 400);
  assert.equal(order.currency, 'XTR');
  assert.equal(await balanceOf(p.userId), 0, 'an invoice alone credits nothing');
});

test('a payment credits once, however many times it is reported', async () => {
  const p = await player();
  const { inv, done, chargeId } = await buyPack(p);
  assert.equal(done.status, 'credited');
  assert.equal(done.balance, 100);

  const again = await paid({
    orderId: inv.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: 100, chargeId,
  });
  assert.equal(again.body.status, 'duplicate');
  // Two at once, as a bot retry racing the reconciler would.
  const racing = await Promise.all([1, 2].map(() => paid({
    orderId: inv.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: 100, chargeId,
  })));
  assert.deepEqual(racing.map((r) => r.body.status).sort(), ['duplicate', 'duplicate']);
  assert.equal(await balanceOf(p.userId), 100);
  assert.deepEqual(await ledgerRefs(p.userId), [`stars:${chargeId}`]);

  const order = await getDb()('payment_orders').where({ id: inv.orderId }).first();
  assert.equal(order.status, 'paid');
  assert.equal(order.provider_txn_id, chargeId);

  const reuse = await check({
    orderId: inv.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: 100,
  });
  assert.equal(reuse.body.ok, false, 'a paid invoice cannot be paid again');
});

test('pre-checkout refuses anything that does not match the order', async () => {
  const p = await player();
  const other = await player();
  const { body: inv } = await invoice(p);
  const base = {
    orderId: inv.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: 100,
  };
  assert.equal((await check(base)).body.ok, true);
  for (const [label, body] of [
    ['wrong price', { ...base, totalAmount: 1 }],
    ['wrong currency', { ...base, currency: 'USD' }],
    ['another player', { ...base, telegramId: other.tg }],
    ['unknown order', { ...base, orderId: 'st0000000000000000000000' }],
    ['not an order id', { ...base, orderId: { $ne: null } }],
  ]) {
    const res = await check(body);
    assert.equal(res.body.ok, false, label);
    assert.ok(res.body.error.length > 0 && res.body.error.length < 100, `${label}: a short reason for Telegram to show`);
  }
  await getDb()('payment_orders').where({ id: inv.orderId }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal((await check(base)).body.ok, false, 'expired');
});

test('a payment that is not ours, or not the owner\'s, credits nothing', async () => {
  const p = await player();
  const other = await player();
  const { body: inv } = await invoice(p);
  const wrongUser = await paid({
    orderId: inv.orderId, telegramId: other.tg, currency: 'XTR', totalAmount: 100, chargeId: 'c-wrong-user',
  });
  assert.equal(wrongUser.body.status, 'wrong_user');
  const unknown = await paid({
    orderId: 'st1111111111111111111111', telegramId: p.tg, currency: 'XTR', totalAmount: 100, chargeId: 'c-unknown',
  });
  assert.equal(unknown.body.status, 'unknown_order');
  assert.equal((await paid({ orderId: inv.orderId, telegramId: p.tg })).status, 400, 'no charge id');
  assert.equal(await balanceOf(p.userId), 0);
  assert.equal(await balanceOf(other.userId), 0);
  const logged = await getDb()('payment_events').whereIn('outcome', ['wrong_user', 'unknown_order']).count({ n: '*' }).first();
  assert.ok(Number(logged.n) >= 2, 'both are in the audit log, for a refund');
});

test('a refund takes the coins back once, even below zero, and pauses buying', async () => {
  const p = await player();
  const { inv, chargeId } = await buyPack(p, 'coins-550');
  assert.equal((await buyItem(p.userId, 'ebony-points')).status, 'bought', 'spent 250 of the 550');

  const first = await refundStarsOrder(inv.orderId, { actor: 'test' });
  assert.equal(first.status, 'debited');
  assert.equal(first.balance, -250);
  const refundCall = botApi.calls.filter((c) => c.method === 'refundStarPayment').at(-1);
  assert.deepEqual(refundCall.params, { user_id: p.tg, telegram_payment_charge_id: chargeId });

  // Again from the script (Telegram: already refunded), and as the bot's refunded_payment.
  assert.equal((await refundStarsOrder(inv.orderId, { actor: 'test' })).status, 'duplicate');
  const viaBot = await call('/internal/payments/stars/refunded', { method: 'POST', internal: true, body: { chargeId } });
  assert.equal(viaBot.body.status, 'duplicate');
  assert.equal(await balanceOf(p.userId), -250);
  assert.equal((await getDb()('payment_orders').where({ id: inv.orderId }).first()).status, 'refunded');
  assert.equal((await buyItem(p.userId, 'crimson-crown')).status, 'negative_balance');
  const owned = await getDb()('user_items').where({ user_id: p.userId }).pluck('item_id');
  assert.deepEqual(owned, ['ebony-points'], 'what was bought stays owned');
});

test('a payment the bot never passed on is credited by the reconciler, once', async () => {
  const p = await player();
  const { body: inv } = await invoice(p, 'coins-1200');
  botApi.transactions = [
    {
      id: 'c-missed', amount: 800, date: 0, source: { type: 'user', user: { id: p.tg }, invoice_payload: inv.orderId },
    },
    { id: 'c-other', amount: 50, date: 0, source: { type: 'user', user: { id: p.tg }, invoice_payload: 'not-ours' } },
    { id: 'c-out', amount: 5, date: 0, receiver: { type: 'user', user: { id: p.tg } } },
  ];
  assert.equal((await reconcileStars()).credited, 1);
  assert.equal((await reconcileStars()).credited, 0, 'the second run finds nothing new');
  assert.equal(await balanceOf(p.userId), 1200);
  // The bot's copy arriving late changes nothing.
  const late = await paid({
    orderId: inv.orderId, telegramId: p.tg, currency: 'XTR', totalAmount: 800, chargeId: 'c-missed',
  });
  assert.equal(late.body.status, 'duplicate');
  assert.equal(await balanceOf(p.userId), 1200);
  botApi.transactions = [];
});

test('unpaid invoices expire, and a player can hold only a few open at once', async () => {
  const p = await player();
  const ids = [];
  for (let i = 0; i < OPEN_ORDER_LIMIT; i += 1) ids.push((await invoice(p)).body.orderId);
  const over = await invoice(p);
  assert.equal(over.status, 429);
  assert.equal(over.body.status, 'too_many_open');

  await getDb()('payment_orders').whereIn('id', ids).update({ expires_at: new Date(Date.now() - 11 * 60_000) });
  const { expired } = await reconcileStars();
  assert.ok(expired >= OPEN_ORDER_LIMIT);
  assert.equal((await getDb()('payment_orders').where({ id: ids[0] }).first()).status, 'expired');
  assert.equal((await invoice(p)).status, 200, 'expired ones no longer count as open');
});

test('Telegram refusing the invoice marks the order failed and credits nothing', async () => {
  const p = await player();
  botApi.failInvoice = true;
  try {
    const res = await invoice(p);
    assert.equal(res.status, 502);
    const order = await getDb()('payment_orders').where({ user_id: p.userId }).first();
    assert.equal(order.status, 'failed');
    assert.match(order.failure_reason, /CURRENCY_INVALID/);
    assert.ok(!order.failure_reason.includes(process.env.BOT_TOKEN), 'the token never lands in the database');
  } finally {
    botApi.failInvoice = false;
  }
});

test('switched off, no invoice is made; unknown packs are refused', async () => {
  const p = await player();
  assert.equal((await invoice(p, 'coins-9999')).status, 404);
  config.store.starsEnabled = false;
  try {
    const res = await invoice(p);
    assert.equal(res.status, 503);
    assert.equal((await call('/api/store', { token: p.token })).body.starsEnabled, false);
  } finally {
    config.store.starsEnabled = true;
  }
});

test('PAYMENTS_STARS_ALLOW_TELEGRAM_IDS parses to the numeric ids, ignoring junk', () => {
  assert.deepEqual([...config.store.starsAllowTelegramIds].sort(), ['42', '7625262769']);
});

test('switched off, only allowlisted Telegram ids may buy, and they get the whole flow', async () => {
  const owner = await player();
  const other = await player();
  config.store.starsEnabled = false;
  config.store.starsAllowTelegramIds = new Set([String(owner.tg)]);
  try {
    assert.equal((await call('/api/store', { token: owner.token })).body.starsEnabled, true);
    assert.equal((await call('/api/store', { token: other.token })).body.starsEnabled, false);
    assert.equal((await invoice(other)).status, 503, 'everyone else still sees it switched off');

    const inv = await invoice(owner);
    assert.equal(inv.status, 200);
    const chargeId = `allow-${owner.tg}`;
    assert.equal((await check({ orderId: inv.body.orderId, telegramId: owner.tg, currency: 'XTR', totalAmount: inv.body.stars })).body.ok, true);
    const body = { orderId: inv.body.orderId, telegramId: owner.tg, currency: 'XTR', totalAmount: inv.body.stars, chargeId };
    assert.equal((await paid(body)).body.status, 'credited');
    assert.equal((await paid(body)).body.status, 'duplicate', 'credited once');
    assert.equal(await balanceOf(owner.userId), 100);

    const back = await call('/internal/payments/stars/refunded', { method: 'POST', internal: true, body: { chargeId } });
    assert.equal(back.body.status, 'debited');
    assert.equal(await balanceOf(owner.userId), 0, 'the refund takes the coins back');
    assert.deepEqual(await ledgerRefs(owner.userId), [`stars:${chargeId}`, `stars-refund:${chargeId}`]);
  } finally {
    config.store.starsEnabled = true;
    config.store.starsAllowTelegramIds = new Set();
  }
});

test('players cannot reach the bot-only or owner-only paths', async () => {
  const p = await player();
  for (const path of ['/internal/payments/stars/check', '/internal/payments/stars/paid', '/internal/payments/stars/refunded']) {
    const res = await call(path, { method: 'POST', token: p.token, body: { chargeId: 'x', orderId: 'x' } });
    assert.equal(res.status, 401, path);
  }
  const refund = await fetch(`${base}/api/payments/stars/refund`, {
    method: 'POST', headers: { authorization: `Bearer ${p.token}` },
  });
  assert.equal(refund.status, 404, 'there is no refund route');
  assert.equal((await call('/api/payments/stars/invoice', { method: 'POST', body: { packId: 'coins-100' } })).status, 401);
});
