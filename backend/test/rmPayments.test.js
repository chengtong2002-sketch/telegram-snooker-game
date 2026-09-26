import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { useTestDatabase } from '@snooker/db/testing';
import { widgetLoginFor } from './helpers/widgetLogin.js';

/* Two key pairs, as in real life: ours signs requests to RM, RM's signs its webhooks. */
const pemPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    private: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    public: publicKey.export({ type: 'spki', format: 'pem' }),
  };
};
const ours = pemPair();
const rmServer = pemPair();

const dropTestDatabase = await useTestDatabase('rm');
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';
process.env.PAYMENTS_RM_ENABLED = 'true';
process.env.RM_CLIENT_ID = 'client-id';
process.env.RM_CLIENT_SECRET = 'client-secret';
process.env.RM_STORE_ID = '1234567890';
// One line with \n escapes, the way Railway holds it.
process.env.RM_PRIVATE_KEY = ours.private.replace(/\n/g, '\\n');
process.env.RM_SERVER_PUBLIC_KEY = rmServer.public;
process.env.PUBLIC_BACKEND_URL = 'https://backend.example/';
process.env.RM_WEB_RETURN_URL = 'https://game.example/topup/done';
delete process.env.RM_WEB_METHODS; // the default: TNG and card (MASTERCARD_MY)
const BOT_TOKEN = '424242:RM-test-token';
process.env.BOT_TOKEN = BOT_TOKEN;

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config, rmConfigProblems } = await import('../src/config.js');
const { balanceOf, buyItem } = await import('../src/services/coins.js');
const client = await import('../src/services/rm/client.js');
const rmPay = await import('../src/services/rm/payments.js');

const {
  RM_OAUTH_URL, RM_OPEN_URL, canonicalJson, signingString, sign, verify, createRmClient,
} = client;

/* ---------- a fake Revenue Monster ---------- */

const rm = {
  tokens: 0,
  expiresIn: 2_591_999,
  valid: new Set(),
  checkouts: new Map(), // orderId -> the payload we sent
  txns: new Map(), // orderId -> what a query answers (null / missing = no payment)
  refunds: [],
  badSignatures: 0,
  failCheckout: false,
  failQuery: false,
  calls: [],
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeRm(url, init = {}) {
  const method = (init.method ?? 'GET').toLowerCase();
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  rm.calls.push({ url, method });
  if (url === `${RM_OAUTH_URL}/token`) {
    const expected = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;
    if (headers.authorization !== expected) return json(401, { error: { code: 'UNAUTHORIZED' } });
    rm.tokens += 1;
    const accessToken = `tok-${rm.tokens}`;
    rm.valid.add(accessToken);
    return json(200, {
      accessToken, tokenType: 'Bearer', expiresIn: rm.expiresIn, refreshToken: 'r',
    });
  }
  if (!url.startsWith(RM_OPEN_URL)) return json(404, { error: { code: 'NO_SUCH_HOST' } });
  if (!rm.valid.has(String(headers.authorization).replace(/^Bearer /, ''))) {
    return json(401, { error: { code: 'INVALID_TOKEN' } });
  }
  // RM checks our signature with the public key we uploaded; so does the fake.
  const body = init.body ? JSON.parse(init.body) : null;
  const sig = /^sha256 (\S+)$/.exec(headers['x-signature'] ?? '')?.[1];
  const good = sig && verify(ours.public, {
    body, method, nonceStr: headers['x-nonce-str'], requestUrl: url, timestamp: headers['x-timestamp'],
  }, sig);
  if (!good) {
    rm.badSignatures += 1;
    return json(400, { error: { code: 'INVALID_SIGNATURE' } });
  }
  const path_ = url.slice(RM_OPEN_URL.length);
  if (path_ === '/payment/online' && method === 'post') {
    if (rm.failCheckout) return json(400, { error: { code: 'STORE_NOT_FOUND', message: 'store' } });
    rm.checkouts.set(body.order.id, body);
    return json(200, { item: { checkoutId: `co-${body.order.id}`, url: `https://sb-pg.revenuemonster.my/checkout?id=${body.order.id}` }, code: 'SUCCESS' });
  }
  const q = /^\/payment\/transaction\/order\/(.+)$/.exec(path_);
  if (q && method === 'get') {
    if (rm.failQuery) return json(500, { error: { code: 'INTERNAL' } });
    const txn = rm.txns.get(decodeURIComponent(q[1]));
    if (!txn) return json(404, { error: { code: 'TRANSACTION_NOT_FOUND' } });
    return json(200, { item: txn, code: 'SUCCESS' });
  }
  if (path_ === '/payment/refund' && method === 'post') {
    rm.refunds.push(body);
    return json(200, { item: { status: 'SUCCESS' }, code: 'SUCCESS' });
  }
  return json(404, { error: { code: 'NOT_FOUND' } });
}
rmPay.useRmFetch(fakeRm);

/** RM's answer for a paid order (plus overrides). */
const txnFor = (orderId, amount, over = {}) => ({
  transactionId: `txn-${orderId}`,
  status: 'SUCCESS',
  currencyType: 'MYR',
  order: {
    id: orderId, title: 'x', additionalData: orderId, amount,
  },
  balanceAmount: amount,
  ...over,
});

/* ---------- the app ---------- */

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(p, {
  method = 'GET', body, token, raw, headers = {},
} = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // HTML
  }
  return { status: res.status, body: parsed };
}

let nextTg = 61_000;
/**
 * A player who has opened the Mini App once (appToken) and then logged in on
 * the web top-up page (token): RM orders start only there.
 */
async function player() {
  const tg = nextTg++;
  const { body } = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `R${tg}` } } });
  const web = await call('/api/topup/login', { method: 'POST', body: widgetLoginFor(tg, BOT_TOKEN) });
  assert.equal(web.status, 200, JSON.stringify(web.body));
  return {
    token: web.body.token, appToken: body.token, userId: body.user.id, tg,
  };
}

const order = (p, packId = 'coins-100', extra = {}) => call('/api/topup/orders', {
  method: 'POST', token: p.token, body: { packId, ...extra },
});
const ledger = (userId) => getDb()('coin_ledger').where({ user_id: userId }).orderBy('id');
const orderRow = (id) => getDb()('payment_orders').where({ id }).first();

/** A webhook as RM sends it: signed with RM's key, over this exact body. */
function signedWebhook(body, { key = rmServer.private, withUrl = false, tamper = null } = {}) {
  const nonceStr = randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(key, {
    body, method: 'post', nonceStr, timestamp, requestUrl: withUrl ? 'https://backend.example/webhooks/rm' : undefined,
  });
  let raw = JSON.stringify(body);
  if (tamper) raw = tamper(raw);
  return {
    raw,
    headers: { 'x-signature': `sha256 ${signature}`, 'x-nonce-str': nonceStr, 'x-timestamp': timestamp },
  };
}
const notifyBody = (orderId, amount, { status = 'SUCCESS', currency = 'MYR', txn = `txn-${orderId}` } = {}) => ({
  eventType: 'PAYMENT_WEB_ONLINE',
  data: {
    transactionId: txn, status, currencyType: currency, order: { id: orderId, amount, title: 'x' },
  },
});
const postWebhook = ({ raw, headers }) => call('/webhooks/rm', { method: 'POST', raw, headers });

/** An order, paid: RM's verified webhook for it, exactly as RM would send it. */
async function paidOrder(p, packId = 'coins-100') {
  const res = await order(p, packId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  rm.txns.set(res.body.orderId, txnFor(res.body.orderId, res.body.myrSen));
  const hook = await postWebhook(signedWebhook(notifyBody(res.body.orderId, res.body.myrSen)));
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  return res.body;
}

/* ---------- signing ---------- */

test('canonical JSON sorts keys at every depth, keeps arrays, escapes < > &', () => {
  const text = canonicalJson({
    b: 1, a: { d: '<x&y>', c: [{ z: 1, y: 2 }, 'q'] }, method: [],
  });
  assert.equal(text, '{"a":{"c":[{"y":2,"z":1},"q"],"d":"\\u003cx\\u0026y\\u003e"},"b":1,"method":[]}');
  assert.deepEqual(JSON.parse(text).a.d, '<x&y>', 'still the same JSON value');
});

test('the signed text follows RM: data only with a body, requestUrl only when given, method in lower case', () => {
  const withBody = signingString({
    body: { b: 2, a: 1 }, method: 'POST', nonceStr: 'n', requestUrl: 'https://u', timestamp: '10',
  });
  assert.equal(withBody, `data=${Buffer.from('{"a":1,"b":2}').toString('base64')}&method=post&nonceStr=n&requestUrl=https://u&signType=sha256&timestamp=10`);
  assert.equal(
    signingString({
      body: null, method: 'get', nonceStr: 'n', requestUrl: 'https://u', timestamp: '10',
    }),
    'method=get&nonceStr=n&requestUrl=https://u&signType=sha256&timestamp=10',
  );
  assert.equal(
    signingString({ body: { a: 1 }, method: 'post', nonceStr: 'n', timestamp: '10' }),
    `data=${Buffer.from('{"a":1}').toString('base64')}&method=post&nonceStr=n&signType=sha256&timestamp=10`,
  );
  const parts = {
    body: { a: 1 }, method: 'post', nonceStr: 'n', requestUrl: 'https://u', timestamp: '10',
  };
  const sig = sign(ours.private, parts);
  assert.equal(verify(ours.public, parts, sig), true);
  assert.equal(verify(ours.public, { ...parts, body: { a: 2 } }, sig), false);
  assert.equal(verify(rmServer.public, parts, sig), false, 'another key does not verify it');
});

/* ---------- token ---------- */

test('ten callers at once make one token request; it is renewed before it runs out; a 401 retries once', async () => {
  let now = 1_000_000;
  let tokenCalls = 0;
  let revokeFirst = true;
  const fetchStub = async (url, init) => {
    if (url.endsWith('/token')) {
      tokenCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return json(200, { accessToken: `t${tokenCalls}`, expiresIn: 7200 });
    }
    if (revokeFirst && init.headers.authorization === 'Bearer t1') {
      revokeFirst = false;
      return json(401, { error: { code: 'INVALID_TOKEN' } });
    }
    return json(200, { item: { ok: true, auth: init.headers.authorization } });
  };
  const c = createRmClient({
    clientId: 'a', clientSecret: 'b', privateKey: ours.private, fetch: fetchStub, now: () => now,
  });
  const tokens = await Promise.all(Array.from({ length: 10 }, () => c.token()));
  assert.equal(tokenCalls, 1);
  assert.ok(tokens.every((t) => t === 't1'));

  now += 5_000 * 1000; // 5,000 s: before 80% of 7,200 s
  assert.equal(await c.token(), 't1');
  now += 800 * 1000; // 5,800 s: past 5,760 s
  assert.equal(await c.token(), 't2');
  assert.equal(tokenCalls, 2);

  // A 401 on a call: one new token, one retry.
  revokeFirst = true;
  const c2 = createRmClient({
    clientId: 'a', clientSecret: 'b', privateKey: ours.private, fetch: fetchStub, now: () => now,
  });
  tokenCalls = 0;
  const answer = await c2.createCheckout({ x: 1 });
  assert.equal(answer.auth, 'Bearer t2');
  assert.equal(tokenCalls, 2);
});

/* ---------- creating an order ---------- */


test('a top-up is priced by the server in cents and sent to RM as a TNG web checkout, signed', async () => {
  const p = await player();
  rm.badSignatures = 0;
  const res = await order(p, 'coins-550', { myrSen: 1, coins: 999999, amount: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.orderId, /^rm[0-9a-f]{22}$/);
  assert.equal(res.body.orderId.length, 24, 'RM allows order.id up to 24 characters');
  assert.equal(res.body.coins, 550);
  assert.equal(res.body.myrSen, 1990);
  assert.match(res.body.url, /^https:\/\/sb-pg\.revenuemonster\.my\//);

  const sent = rm.checkouts.get(res.body.orderId);
  assert.equal(rm.badSignatures, 0, 'RM accepted our signature over the sorted body');
  assert.equal(rm.calls.find((c) => c.url.endsWith('/payment/online'))?.url, 'https://sb-open.revenuemonster.my/v3/payment/online');
  assert.equal(sent.type, 'WEB_PAYMENT', 'no device said: the QR page');
  assert.deepEqual(sent.method, ['TNG_MY', 'MASTERCARD_MY']); // no pick: RM's page offers both
  assert.equal(sent.layoutVersion, 'v4');
  assert.equal(sent.order.amount, 1990, 'RM 19.90 in cents');
  assert.equal(sent.order.currencyType, 'MYR');
  assert.equal(sent.order.id, res.body.orderId);
  assert.ok(sent.order.title.length <= 32);
  assert.equal(sent.storeId, '1234567890');
  assert.equal(sent.redirectUrl, `https://game.example/topup/done?order=${res.body.orderId}`);
  assert.equal(sent.notifyUrl, 'https://backend.example/webhooks/rm');
  assert.doesNotMatch(JSON.stringify(sent), /'/, 'no apostrophes: RM\'s PHP signer escapes them, JS does not');

  const row = await orderRow(res.body.orderId);
  assert.equal(row.status, 'pending');
  assert.equal(row.provider, 'rm');
  assert.equal(Number(row.amount), 1990);
  assert.equal(await balanceOf(p.userId), 0, 'an order alone credits nothing');
});

test('an RM error fails the order; unknown packs and the open-order limit are refused', async () => {
  const p = await player();
  rm.failCheckout = true;
  const res = await order(p);
  rm.failCheckout = false;
  assert.equal(res.status, 502);
  const [row] = await getDb()('payment_orders').where({ user_id: p.userId });
  assert.equal(row.status, 'failed');
  assert.match(row.failure_reason, /STORE_NOT_FOUND/);

  assert.equal((await order(p, 'coins-nope')).status, 404);
  for (let i = 0; i < 3; i += 1) assert.equal((await order(p)).status, 200);
  const fourth = await order(p);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.status, 'too_many_open');
});

/* ---------- the webhook: the only credit ---------- */

test('a verified webhook credits once, keyed on RM\'s transaction id', async () => {
  const p = await player();
  const o = await paidOrder(p);
  assert.equal(await balanceOf(p.userId), 100);
  const row = await orderRow(o.orderId);
  assert.equal(row.status, 'paid');
  assert.equal(row.provider_txn_id, `txn-${o.orderId}`);
  const [event] = await getDb()('payment_events').where({ order_id: o.orderId, outcome: 'credited' });
  assert.equal(Boolean(event.signature_ok), true);
});

test('duplicate webhooks, replayed or racing, credit once', async () => {
  const p = await player();
  const o = await paidOrder(p);
  const body = notifyBody(o.orderId, o.myrSen);
  // Fresh signatures each time (RM re-signs a retry) and the very same bytes replayed.
  const once = signedWebhook(body);
  for (let i = 0; i < 3; i += 1) assert.equal((await postWebhook(signedWebhook(body))).status, 200);
  for (let i = 0; i < 2; i += 1) assert.equal((await postWebhook(once)).status, 200);
  const racing = await Promise.all([1, 2, 3].map(() => postWebhook(signedWebhook(body))));
  assert.ok(racing.every((r) => r.status === 200));

  const rows = await ledger(p.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, `rm:txn-${o.orderId}`);
  assert.equal(await balanceOf(p.userId), 100);
  const dupes = await getDb()('payment_events').where({ order_id: o.orderId, outcome: 'duplicate' }).count({ n: '*' }).first();
  assert.equal(Number(dupes.n), 8);
});

test('a second, different RM payment for the same order is credited too: the money was taken', async () => {
  const p = await player();
  const o = await paidOrder(p);
  await postWebhook(signedWebhook(notifyBody(o.orderId, o.myrSen, { txn: 'txn-second-payment' })));
  assert.equal(await balanceOf(p.userId), 200);
  assert.equal((await orderRow(o.orderId)).provider_txn_id, `txn-${o.orderId}`, 'the order keeps its first payment');
});

test('a webhook signed with requestUrl in the text is accepted too', async () => {
  const p = await player();
  const { body: o } = await order(p);
  const hook = await postWebhook(signedWebhook(notifyBody(o.orderId, 490), { withUrl: true }));
  assert.equal(hook.status, 200);
  assert.equal(await balanceOf(p.userId), 100);
});

test('forged webhooks are refused with 401, credit nothing, and are each logged', async () => {
  const p = await player();
  const { body: o } = await order(p);
  const body = notifyBody(o.orderId, 490);
  const before = await getDb()('payment_events').where({ outcome: 'bad_signature' }).count({ n: '*' }).first();

  const good = signedWebhook(body);
  const forged = [
    signedWebhook(body, { key: ours.private }), // the wrong key
    signedWebhook(body, { tamper: (raw) => raw.replace('"amount":490', '"amount":49000') }), // amount changed after signing
    signedWebhook(body, { tamper: (raw) => raw.replace(`"txn-${o.orderId}"`, '"txn-other"') }), // transaction id changed
    signedWebhook(notifyBody(o.orderId, 490, { status: 'FAILED' }), { tamper: (raw) => raw.replace('FAILED', 'SUCCESS') }),
    { raw: good.raw, headers: { ...good.headers, 'x-nonce-str': 'another-nonce' } }, // signature from another nonce
    { raw: good.raw, headers: { ...good.headers, 'x-timestamp': '1' } },
    { raw: good.raw, headers: { 'x-nonce-str': good.headers['x-nonce-str'], 'x-timestamp': good.headers['x-timestamp'] } }, // no signature
    { raw: good.raw, headers: { ...good.headers, 'x-signature': 'sha256 bm90IGEgc2lnbmF0dXJl' } }, // garbage
    { raw: good.raw, headers: { ...good.headers, 'x-signature': good.headers['x-signature'].replace('sha256 ', 'md5 ') } },
    { raw: 'not json', headers: good.headers },
  ];
  for (const f of forged) {
    const r = await postWebhook(f);
    assert.equal(r.status, 401, f.raw.slice(0, 80));
  }
  assert.equal((await ledger(p.userId)).length, 0);
  assert.equal((await orderRow(o.orderId)).status, 'pending');
  const after = await getDb()('payment_events').where({ outcome: 'bad_signature' }).count({ n: '*' }).first();
  assert.equal(Number(after.n) - Number(before.n), forged.length);
  const [logged] = await getDb()('payment_events').where({ outcome: 'bad_signature' }).orderBy('id', 'desc').limit(1);
  assert.equal(Boolean(logged.signature_ok), false);
  assert.equal(logged.order_id, null, 'a forged claim is not filed under the order it names');

  // The genuine one still works afterwards.
  assert.equal((await postWebhook(good)).status, 200);
  assert.equal(await balanceOf(p.userId), 100);
});

test('a verified webhook with the wrong amount or currency credits nothing and disputes the order', async () => {
  const cases = [
    { amount: 49, currency: 'MYR' }, // RM 0.49 for a RM 4.90 pack
    { amount: 49000, currency: 'MYR' },
    { amount: 490, currency: 'SGD' },
  ];
  for (const c of cases) {
    const p = await player();
    const { body: o } = await order(p);
    const hook = await postWebhook(signedWebhook(notifyBody(o.orderId, c.amount, { currency: c.currency })));
    assert.equal(hook.status, 200, 'answered, so RM stops retrying');
    assert.equal(await balanceOf(p.userId), 0, JSON.stringify(c));
    assert.equal((await ledger(p.userId)).length, 0);
    const row = await orderRow(o.orderId);
    assert.equal(row.status, 'disputed');
    assert.match(row.failure_reason, new RegExp(`${c.amount} ${c.currency}`));
  }
});

test('verified webhooks that are not a success, or name no order of ours, credit nothing', async () => {
  const p = await player();
  const { body: o } = await order(p);
  for (const status of ['FAILED', 'IN_PROCESS', 'CANCELLED']) {
    assert.equal((await postWebhook(signedWebhook(notifyBody(o.orderId, 490, { status })))).status, 200);
  }
  const noTxn = notifyBody(o.orderId, 490);
  delete noTxn.data.transactionId;
  assert.equal((await postWebhook(signedWebhook(noTxn))).status, 200);
  assert.equal(await balanceOf(p.userId), 0);

  const unknown = `rm${'0'.repeat(22)}`;
  assert.equal((await postWebhook(signedWebhook(notifyBody(unknown, 490)))).status, 200);
  assert.equal(await getDb()('coin_ledger').where({ ref: `rm:txn-${unknown}` }).first(), undefined);
  const logged = await getDb()('payment_events').where({ outcome: 'unknown_order' }).orderBy('id', 'desc').first();
  assert.equal(Boolean(logged.signature_ok), true);
});

/* ---------- the reconciler's own query to RM ---------- */

/** An open order, old enough for the reconciler to ask RM about. */
async function ageForReconcile(orderId) {
  await getDb()('payment_orders').where({ id: orderId }).update({ created_at: new Date(Date.now() - 10 * 60_000) });
}

test('the reconciler credits a paid order RM confirms, then the late webhook is a no-op (one credit)', async () => {
  const p = await player();
  const { body: o } = await order(p);
  rm.txns.set(o.orderId, txnFor(o.orderId, 490));
  await ageForReconcile(o.orderId);
  rm.badSignatures = 0;
  const queriesBefore = rm.calls.filter((c) => c.url.endsWith(`/payment/transaction/order/${o.orderId}`)).length;

  await rmPay.reconcileRm();
  assert.equal(rm.calls.filter((c) => c.url.endsWith(`/payment/transaction/order/${o.orderId}`)).length, queriesBefore + 1, 'asked RM itself');
  assert.equal(rm.badSignatures, 0, 'with a signed request');
  assert.equal(await balanceOf(p.userId), 100);
  const row = await orderRow(o.orderId);
  assert.equal(row.status, 'paid');
  assert.equal(row.provider_txn_id, `txn-${o.orderId}`);

  // RM's webhook for the same payment arrives afterwards, twice.
  for (let i = 0; i < 2; i += 1) assert.equal((await postWebhook(signedWebhook(notifyBody(o.orderId, 490)))).status, 200);
  const rows = await ledger(p.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, `rm:txn-${o.orderId}`, 'one idempotency key for both paths');
  assert.equal(rows[0].actor, 'reconcile');
  assert.equal(await balanceOf(p.userId), 100);
});

test('the webhook credits, then the reconciler runs: nothing more', async () => {
  const p = await player();
  const o = await paidOrder(p); // credited by the webhook
  await getDb()('payment_orders').where({ id: o.orderId }).update({ last_checked_at: new Date(Date.now() - 2 * 24 * 3600_000) });
  await rmPay.reconcileRm();
  await rmPay.checkRmOrder(o.orderId, 'reconcile');
  const rows = await ledger(p.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'webhook');
  assert.equal(await balanceOf(p.userId), 100);
  assert.equal((await orderRow(o.orderId)).status, 'paid');
  const dup = await getDb()('payment_events').where({ order_id: o.orderId, source: 'reconcile', outcome: 'duplicate' }).first();
  assert.ok(dup, 'the reconciler saw it was already credited');
});

test('RM saying FAILED credits nothing and closes the order', async () => {
  const p = await player();
  const { body: o } = await order(p);
  rm.txns.set(o.orderId, txnFor(o.orderId, 490, { status: 'FAILED' }));
  await ageForReconcile(o.orderId);
  await rmPay.reconcileRm();
  assert.equal(await balanceOf(p.userId), 0);
  assert.equal((await ledger(p.userId)).length, 0);
  assert.equal((await orderRow(o.orderId)).status, 'failed');
});

test('RM confirming a different amount, currency or order to the reconciler credits nothing', async () => {
  const cases = [
    { order: { amount: 49 } },
    { currencyType: 'SGD' },
    { order: { id: `rm${'f'.repeat(22)}` } },
  ];
  for (const c of cases) {
    const p = await player();
    const { body: o } = await order(p);
    const txn = txnFor(o.orderId, 490, { ...c, order: undefined });
    txn.order = { ...txnFor(o.orderId, 490).order, ...c.order };
    rm.txns.set(o.orderId, txn);
    await ageForReconcile(o.orderId);
    await rmPay.reconcileRm();
    assert.equal(await balanceOf(p.userId), 0, JSON.stringify(c));
    assert.equal((await orderRow(o.orderId)).status, 'disputed', JSON.stringify(c));
  }
});

test('a payment RM confirms after the order expired is still credited by the reconciler', async () => {
  const p = await player();
  const { body: o } = await order(p);
  await getDb()('payment_orders').where({ id: o.orderId })
    .update({ created_at: new Date(Date.now() - 3 * 3600_000), expires_at: new Date(Date.now() - 2 * 3600_000) });
  await rmPay.reconcileRm();
  assert.equal((await orderRow(o.orderId)).status, 'expired');

  rm.txns.set(o.orderId, txnFor(o.orderId, 490));
  await getDb()('payment_orders').where({ id: o.orderId }).update({ last_checked_at: new Date(Date.now() - 3600_000) });
  await rmPay.reconcileRm();
  assert.equal((await orderRow(o.orderId)).status, 'paid');
  assert.equal(await balanceOf(p.userId), 100);
});

test('the redirect back from RM is display-only: there is no route that takes its status', async () => {
  const p = await player();
  const { body: o } = await order(p);
  for (const path_ of [`/pay/rm/return?orderId=${o.orderId}&status=SUCCESS`, `/webhooks/rm?orderId=${o.orderId}&status=SUCCESS`]) {
    const r = await call(path_);
    assert.equal(r.status, 404, path_);
  }
  assert.equal(await balanceOf(p.userId), 0);
});

test('polling an order is read-only, asks nothing of RM, and only the owner can see it', async () => {
  const p = await player();
  const other = await player();
  const { body: o } = await order(p);
  rm.txns.set(o.orderId, txnFor(o.orderId, 490));
  const callsBefore = rm.calls.length;
  const waiting = await call(`/api/topup/orders/${o.orderId}`, { token: p.token });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.status, 'pending');
  assert.equal(rm.calls.length, callsBefore);
  assert.equal((await call(`/api/topup/orders/${o.orderId}`, { token: other.token })).status, 404);

  await postWebhook(signedWebhook(notifyBody(o.orderId, 490)));
  const done = await call(`/api/topup/orders/${o.orderId}`, { token: p.token });
  assert.equal(done.body.status, 'paid');
  assert.equal(done.body.balance, 100);
});

/* ---------- reconciler ---------- */

test('the reconciler closes what RM never calls back about, and a late webhook still credits', async () => {
  const p = await player();
  const make = async () => (await order(p)).body.orderId;
  const [failed, cancelled, abandoned] = [await make(), await make(), await make()];
  // Past its time; that also frees a place under the open-order limit for one more.
  await getDb()('payment_orders').where({ id: abandoned }).update({ expires_at: new Date(Date.now() - 3600_000) });
  const inTime = await make();
  rm.txns.set(failed, txnFor(failed, 490, { status: 'FAILED' }));
  rm.txns.set(cancelled, txnFor(cancelled, 490, { status: 'CANCELLED' }));
  await getDb()('payment_orders').whereIn('id', [failed, cancelled, abandoned, inTime])
    .update({ created_at: new Date(Date.now() - 10 * 60_000) });

  await rmPay.reconcileRm();
  assert.equal((await orderRow(failed)).status, 'failed');
  assert.equal((await orderRow(cancelled)).status, 'cancelled');
  assert.equal((await orderRow(abandoned)).status, 'expired', 'no payment and past its time');
  assert.equal((await orderRow(inTime)).status, 'pending', 'no payment yet, still in time');
  assert.equal(await balanceOf(p.userId), 0);

  // RM's webhook for the expired order arrives late: the money was taken, so it counts.
  await postWebhook(signedWebhook(notifyBody(abandoned, 490)));
  assert.equal((await orderRow(abandoned)).status, 'paid');
  assert.equal(await balanceOf(p.userId), 100);
});

/* ---------- refunds ---------- */

test('a full refund takes the coins back once, even below zero after they were spent', async () => {
  const p = await player();
  const o = await paidOrder(p, 'coins-550');
  const bought = await buyItem(p.userId, 'ebony-points');
  assert.equal(bought.status, 'bought');
  const spent = bought.price;

  const res = await rmPay.refundRmOrder(o.orderId, { actor: 'test', reason: 'test refund' });
  assert.equal(res.status, 'debited');
  assert.equal(rm.refunds.at(-1).refund.type, 'FULL');
  assert.equal(rm.refunds.at(-1).refund.amount, 1990);
  assert.equal(await balanceOf(p.userId), 550 - spent - 550);
  assert.equal((await orderRow(o.orderId)).status, 'refunded');

  // RM's daily answer now says FULL_REFUNDED: nothing more is taken.
  rm.txns.set(o.orderId, txnFor(o.orderId, 1990, { status: 'FULL_REFUNDED', balanceAmount: 0 }));
  await rmPay.checkRmOrder(o.orderId, 'reconcile');
  assert.equal(await balanceOf(p.userId), -spent);
  assert.equal((await rmPay.refundRmOrder(o.orderId, { actor: 'test' })).status, 'not_refundable');
  // And RM repeating the old SUCCESS webhook does not pay it back out.
  await postWebhook(signedWebhook(notifyBody(o.orderId, 1990)));
  assert.equal(await balanceOf(p.userId), -spent);
});

test('a refund made in RM\'s portal is found by the reconciler and debited once per new total', async () => {
  const p = await player();
  const o = await paidOrder(p, 'coins-1200');
  assert.equal(await balanceOf(p.userId), 1200);
  const again = async () => {
    await getDb()('payment_orders').where({ id: o.orderId }).update({ last_checked_at: new Date(Date.now() - 2 * 24 * 3600_000) });
    await rmPay.reconcileRm();
  };

  // RM 10.00 of RM 39.90 back: ceil(1200 * 1000 / 3990) = 301 coins.
  rm.txns.set(o.orderId, txnFor(o.orderId, 3990, { status: 'PARTIAL_REFUNDED', balanceAmount: 2990 }));
  await again();
  await again();
  assert.equal(await balanceOf(p.userId), 1200 - 301);
  assert.equal((await orderRow(o.orderId)).status, 'partially_refunded');

  rm.txns.set(o.orderId, txnFor(o.orderId, 3990, { status: 'FULL_REFUNDED', balanceAmount: 0 }));
  await again();
  await again();
  assert.equal(await balanceOf(p.userId), 0);
  assert.equal((await orderRow(o.orderId)).status, 'refunded');
  const refs = (await ledger(p.userId)).map((r) => r.ref);
  assert.deepEqual(refs, [`rm:txn-${o.orderId}`, `rm-refund:txn-${o.orderId}:1000`, `rm-refund:txn-${o.orderId}:3990`]);
});

test('an order paid and refunded before any webhook credited it adds and takes nothing', async () => {
  const p = await player();
  const { body: o } = await order(p);
  rm.txns.set(o.orderId, txnFor(o.orderId, 490, { status: 'FULL_REFUNDED', balanceAmount: 0 }));
  await rmPay.checkRmOrder(o.orderId, 'reconcile');
  assert.equal(await balanceOf(p.userId), 0);
  assert.equal((await ledger(p.userId)).length, 0);
  assert.equal((await orderRow(o.orderId)).status, 'refunded');
});

/* ---------- the flag, the config, the hosts ---------- */

test('with the flag off the webhook is gone and nothing can be ordered', async () => {
  const p = await player();
  config.rm.enabled = false;
  try {
    assert.equal((await order(p)).status, 404, 'the top-up routes are gone');
    assert.equal((await call('/api/topup/packs')).status, 404);
    assert.equal((await postWebhook(signedWebhook(notifyBody('x', 1)))).status, 404);
    assert.deepEqual(await rmPay.reconcileRm(), { checked: 0 });
    assert.equal((await call('/api/health')).status, 200, 'the rest of the app is untouched');
  } finally {
    config.rm.enabled = true;
  }
});

test('the flag is off unless set, and on without its keys the backend refuses to start', () => {
  const example = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.example'), 'utf8');
  assert.match(example, /^PAYMENTS_RM_ENABLED=false$/m);
  const full = { ...config.rm };
  assert.deepEqual(rmConfigProblems(full), []);
  assert.deepEqual(rmConfigProblems({ enabled: false }), [], 'off needs nothing');
  const problems = rmConfigProblems({
    ...full, clientSecret: '', privateKey: 'nope', serverPublicKey: '', publicBackendUrl: 'http://plain', webReturnUrl: 'x',
  });
  assert.equal(problems.length, 5, problems.join('\n'));
});

test("RM's live hosts are named only in client.js, and only live === true reaches them", async () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    if (path.basename(f) === 'client.js') continue;
    assert.doesNotMatch(fs.readFileSync(path.join(src, f), 'utf8'), /revenuemonster\.my/, f);
  }
  const hostsFor = async (live) => {
    const hosts = [];
    const client = createRmClient({
      clientId: 'id',
      clientSecret: 'secret',
      privateKey: ours.private,
      live,
      fetch: async (url) => {
        hosts.push(new URL(url).host);
        const body = url.endsWith('/token') ? { accessToken: 't', expiresIn: 3600 } : { item: { url: 'https://x' }, code: 'SUCCESS' };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    await client.createCheckout({ order: { id: 'x' } });
    return hosts;
  };
  assert.deepEqual(await hostsFor(true), ['oauth.revenuemonster.my', 'open.revenuemonster.my']);
  for (const notLive of [false, undefined, 'true', 'production', 1]) {
    assert.deepEqual(await hostsFor(notLive), ['sb-oauth.revenuemonster.my', 'sb-open.revenuemonster.my'], String(notLive));
  }
});

test('RM answering with a checkoutId only (as live RM does): the url is built on the right host', async () => {
  const checkoutFor = async (live, checkoutId) => {
    const client = createRmClient({
      clientId: 'id',
      clientSecret: 'secret',
      privateKey: ours.private,
      live,
      fetch: async (url) => {
        const body = url.endsWith('/token') ? { accessToken: 't', expiresIn: 3600 } : { item: { checkoutId }, code: 'SUCCESS' };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    return client.createCheckout({ order: { id: 'x' } });
  };
  assert.equal((await checkoutFor(true, '1790443990123456789')).url, 'https://pg.revenuemonster.my/v4/checkout?checkoutId=1790443990123456789');
  assert.equal((await checkoutFor(false, '1790443990123456789')).url, 'https://sb-pg.revenuemonster.my/v4/checkout?checkoutId=1790443990123456789');
  // Anything that is not a plain id is not trusted into a url (the order then fails as NO_URL).
  for (const odd of ['a/b', 'x?y=1', '', 'https://evil.example']) {
    assert.equal((await checkoutFor(true, odd)).url, undefined, odd);
  }
});
