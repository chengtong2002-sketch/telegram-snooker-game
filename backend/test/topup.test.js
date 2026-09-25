/**
 * The web top-up page's API (docs/topup-web-plan.md): the Telegram Login
 * Widget check, the narrow top-up session, the order options, and the Mini App
 * no longer offering MYR at all. The money path itself (webhook, reconciler,
 * refunds) runs through these same routes in rmPayments.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { useTestDatabase } from '@snooker/db/testing';
import { signWidget, widgetLoginFor } from './helpers/widgetLogin.js';

const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const ours = pem();
const rmServer = pem();

const dropTestDatabase = await useTestDatabase('topup');
const BOT_TOKEN = '515151:TOPUP-test-token';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.BOT_NOTIFY_URL = 'http://127.0.0.1:1/internal/notify';
process.env.PAYMENTS_RM_ENABLED = 'true';
process.env.RM_CLIENT_ID = 'client-id';
process.env.RM_CLIENT_SECRET = 'client-secret';
process.env.RM_STORE_ID = '1234567890';
process.env.RM_PRIVATE_KEY = ours.privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.RM_SERVER_PUBLIC_KEY = rmServer.publicKey.export({ type: 'spki', format: 'pem' });
process.env.PUBLIC_BACKEND_URL = 'https://backend.example';
process.env.RM_WEB_RETURN_URL = 'https://game.example/topup/done';
process.env.RM_WEB_METHODS = 'TNG_MY';

const { closeDb, migrate, getDb } = await import('@snooker/db');
const { buildApp } = await import('../src/app.js');
const { config, rmConfigProblems } = await import('../src/config.js');
const { verifyLoginWidget, MAX_LOGIN_AGE_SEC } = await import('../src/services/webLogin.js');
const { verifyInitData } = await import('../src/auth.js');
const { checkoutType, useRmFetch } = await import('../src/services/rm/payments.js');
const { RM_OAUTH_URL, RM_OPEN_URL } = await import('../src/services/rm/client.js');

/* A fake RM that only has to take checkouts: what we sent is what is checked. */
const checkouts = new Map();
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
useRmFetch(async (url, init = {}) => {
  if (url === `${RM_OAUTH_URL}/token`) return reply({ accessToken: 'tok', expiresIn: 2_591_999 });
  if (url === `${RM_OPEN_URL}/payment/online`) {
    const body = JSON.parse(init.body);
    checkouts.set(body.order.id, body);
    return reply({ item: { checkoutId: 'co', url: `https://sb-pg.revenuemonster.my/checkout?id=${body.order.id}` }, code: 'SUCCESS' });
  }
  return new Response('{}', { status: 404 });
});

await migrate();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  await dropTestDatabase();
});

async function call(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

let nextTg = 71_000;
/** Someone who has opened the Mini App once: they have an account and an app token. */
async function appPlayer() {
  const tg = nextTg++;
  const { body } = await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `T${tg}` } } });
  return { tg, userId: body.user.id, appToken: body.token };
}
const webLogin = (tg, opts) => call('/api/topup/login', { method: 'POST', body: widgetLoginFor(tg, BOT_TOKEN, opts) });
async function webPlayer() {
  const p = await appPlayer();
  const res = await webLogin(p.tg);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { ...p, token: res.body.token };
}

/* ---------- the widget check ---------- */

test('a login signed as Telegram signs it passes, with the account\'s id', () => {
  const r = verifyLoginWidget(widgetLoginFor(123456789, BOT_TOKEN), { botToken: BOT_TOKEN });
  assert.equal(r.ok, true);
  assert.equal(r.telegramId, '123456789');
  // Only some fields present (no username, no photo) still passes: the hash covers what came.
  const bare = signWidget({ id: '5', first_name: 'A', auth_date: String(Math.floor(Date.now() / 1000)) }, BOT_TOKEN);
  assert.equal(verifyLoginWidget(bare, { botToken: BOT_TOKEN }).ok, true);
});

test('a wrong hash, a changed field, a removed field or another bot\'s signature is refused', () => {
  const good = widgetLoginFor(42, BOT_TOKEN);
  const bad = (data, reason = 'bad signature') => assert.deepEqual(verifyLoginWidget(data, { botToken: BOT_TOKEN }), { ok: false, reason });
  bad({ ...good, hash: 'a'.repeat(64) });
  bad({ ...good, id: '43' });
  bad({ ...good, first_name: 'Mallory' });
  const { username: _gone, ...fewer } = good;
  bad(fewer);
  bad(widgetLoginFor(42, '999:other-bot'));
  bad({ ...good, hash: 'nothex' }, 'missing hash');
  const { hash: _h, ...unsigned } = good;
  bad(unsigned, 'missing hash');
});

test('a field the widget never sends is refused before any hashing', () => {
  const r = verifyLoginWidget(signWidget({ ...widgetLoginFor(42, BOT_TOKEN), order: 'rm1' }, BOT_TOKEN), { botToken: BOT_TOKEN });
  assert.deepEqual(r, { ok: false, reason: 'unexpected login field' });
  assert.deepEqual(verifyLoginWidget({ ...widgetLoginFor(42, BOT_TOKEN), id: { $gt: 0 } }, { botToken: BOT_TOKEN }),
    { ok: false, reason: 'unexpected login field' });
  assert.equal(verifyLoginWidget(null, { botToken: BOT_TOKEN }).ok, false);
  assert.equal(verifyLoginWidget([1], { botToken: BOT_TOKEN }).ok, false);
});

test('a login older than ten minutes, or from the future, is refused', () => {
  const now = Date.now();
  const at = (secondsAgo) => widgetLoginFor(42, BOT_TOKEN, { authDate: Math.floor(now / 1000) - secondsAgo });
  assert.equal(verifyLoginWidget(at(MAX_LOGIN_AGE_SEC - 5), { botToken: BOT_TOKEN, now }).ok, true);
  assert.deepEqual(verifyLoginWidget(at(MAX_LOGIN_AGE_SEC + 5), { botToken: BOT_TOKEN, now }), { ok: false, reason: 'login expired' });
  assert.deepEqual(verifyLoginWidget(at(-600), { botToken: BOT_TOKEN, now }), { ok: false, reason: 'login expired' });
  assert.equal(verifyLoginWidget(at(-30), { botToken: BOT_TOKEN, now }).ok, true, 'a phone clock a little ahead');
});

test('Mini App initData and widget data are signed differently: neither passes the other\'s check', () => {
  const widget = widgetLoginFor(42, BOT_TOKEN);
  const asInitData = new URLSearchParams(widget).toString();
  assert.equal(verifyInitData(asInitData, BOT_TOKEN).ok, false);
  // Mini App style: secret = HMAC("WebAppData", token). Build one and offer it to the widget check.
  const fields = { auth_date: widget.auth_date, id: '42', first_name: 'W42' };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  assert.deepEqual(verifyLoginWidget({ ...fields, hash }, { botToken: BOT_TOKEN }), { ok: false, reason: 'bad signature' });
});

/* ---------- login over HTTP ---------- */

test('login gives a 30-minute top-up session and the balance, for an account that already plays', async () => {
  const p = await appPlayer();
  const res = await webLogin(p.tg);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.balance, 0);
  assert.equal(res.body.user.firstName, `T${p.tg}`);
  const claims = jwt.decode(res.body.token);
  assert.equal(claims.scope, 'topup');
  assert.equal(claims.sub, String(p.userId));
  assert.ok(claims.exp - claims.iat <= 30 * 60);
  assert.ok(Math.abs(Date.parse(res.body.expiresAt) - claims.exp * 1000) < 5000);
});

test('someone who never opened the bot gets no account from the web', async () => {
  const before = Number((await getDb()('users').count({ n: '*' }).first()).n);
  const res = await webLogin(9_999_001);
  assert.equal(res.status, 404);
  assert.equal(res.body.status, 'no_account');
  assert.equal(Number((await getDb()('users').count({ n: '*' }).first()).n), before);
});

test('a banned account cannot log in, and a session it already had stops working', async () => {
  const p = await webPlayer();
  await getDb()('users').where({ id: p.userId }).update({ banned: true });
  assert.equal((await webLogin(p.tg)).status, 403);
  assert.equal((await call('/api/topup/me', { token: p.token })).status, 403);
});

test('a forged login is 401 over HTTP', async () => {
  const p = await appPlayer();
  const res = await call('/api/topup/login', { method: 'POST', body: { ...widgetLoginFor(p.tg, BOT_TOKEN), first_name: 'x' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.token, undefined);
});

/* ---------- the session's scope ---------- */

test('a top-up token opens nothing the Mini App uses', async () => {
  const p = await webPlayer();
  const routes = [
    ['GET', '/api/auth/me'], ['GET', '/api/store'], ['POST', '/api/store/buy'], ['POST', '/api/store/equip'],
    ['GET', '/api/stats'], ['GET', '/api/match/active'], ['POST', '/api/match/queue'],
    ['GET', '/api/wallet'], ['POST', '/api/wallet/link'], ['GET', '/api/rewards/claimable'], ['POST', '/api/rewards/redeem'],
    ['POST', '/api/payments/stars/invoice'], ['GET', '/api/sync/pending'],
  ];
  for (const [method, path] of routes) {
    const res = await call(path, { method, token: p.token, body: method === 'POST' ? {} : undefined });
    assert.ok([401, 404].includes(res.status), `${method} ${path} answered ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  // …and the same routes do open for the Mini App's token (the check is the scope, not the route).
  assert.equal((await call('/api/store', { token: p.appToken })).status, 200);
  assert.equal((await call('/api/stats', { token: p.appToken })).status, 200);
});

test('the Mini App\'s token opens none of the top-up routes', async () => {
  const p = await appPlayer();
  assert.equal((await call('/api/topup/me', { token: p.appToken })).status, 401);
  assert.equal((await call('/api/topup/orders', { method: 'POST', token: p.appToken, body: { packId: 'coins-100' } })).status, 401);
  assert.equal((await call('/api/topup/orders/rm0000000000000000000000', { token: p.appToken })).status, 401);
});

/* ---------- orders ---------- */

test('a phone gets MOBILE_PAYMENT, anything else the QR page; TNG only; price and coins from config', async () => {
  const p = await webPlayer();
  const sent = async (body) => {
    const res = await call('/api/topup/orders', { method: 'POST', token: p.token, body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { res: res.body, rm: checkouts.get(res.body.orderId) };
  };
  const mobile = await sent({ packId: 'coins-100', device: 'mobile' });
  assert.equal(mobile.rm.type, 'MOBILE_PAYMENT');
  const desktop = await sent({ packId: 'coins-100', device: 'desktop' });
  assert.equal(desktop.rm.type, 'WEB_PAYMENT');
  const junk = await sent({
    packId: 'coins-1200', device: 'MOBILE_PAYMENT', coins: 99999, myrSen: 1, method: ['FPX_MY'], type: 'MOBILE_PAYMENT',
  });
  assert.equal(junk.rm.type, 'WEB_PAYMENT', 'only the word "mobile" picks the app');
  assert.deepEqual(junk.rm.method, ['TNG_MY']);
  assert.equal(junk.rm.order.amount, 3990);
  assert.equal(junk.res.coins, 1200);
  assert.equal(junk.rm.redirectUrl, `https://game.example/topup/done?order=${junk.res.orderId}`);
  for (const d of [undefined, null, 'Mobile', 'tablet', 1]) assert.equal(checkoutType(d), 'WEB_PAYMENT', String(d));
  assert.equal(checkoutType('mobile'), 'MOBILE_PAYMENT');
});

test('the methods follow RM_WEB_METHODS', async () => {
  const p = await webPlayer();
  const saved = config.rm.webMethods;
  config.rm.webMethods = ['TNG_MY', 'BOOST_MY'];
  try {
    const res = await call('/api/topup/orders', { method: 'POST', token: p.token, body: { packId: 'coins-100' } });
    assert.deepEqual(checkouts.get(res.body.orderId).method, ['TNG_MY', 'BOOST_MY']);
  } finally {
    config.rm.webMethods = saved;
  }
});

test('packs are public and show only MYR prices from config', async () => {
  const res = await call('/api/topup/packs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.packs, [
    { id: 'coins-100', coins: 100, myrSen: 490 },
    { id: 'coins-550', coins: 550, myrSen: 1990 },
    { id: 'coins-1200', coins: 1200, myrSen: 3990 },
  ]);
});

test('an unknown pack is 404, and nobody sees another player\'s order', async () => {
  const p = await webPlayer();
  const q = await webPlayer();
  assert.equal((await call('/api/topup/orders', { method: 'POST', token: p.token, body: { packId: 'coins-7' } })).status, 404);
  const { body } = await call('/api/topup/orders', { method: 'POST', token: p.token, body: { packId: 'coins-100' } });
  assert.equal((await call(`/api/topup/orders/${body.orderId}`, { token: p.token })).status, 200);
  assert.equal((await call(`/api/topup/orders/${body.orderId}`, { token: q.token })).status, 404);
});

/* ---------- the Mini App offers Stars only ---------- */

test('the Mini App\'s store has no MYR price or switch, and its RM routes are gone', async () => {
  const p = await appPlayer();
  const store = await call('/api/store', { token: p.appToken });
  assert.equal(store.status, 200);
  assert.equal('rmEnabled' in store.body, false);
  for (const pack of store.body.packs) assert.equal('myrSen' in pack, false, pack.id);
  assert.doesNotMatch(JSON.stringify(store.body), /myr|ringgit|topup|revenue/i);
  assert.equal((await call('/api/payments/rm/orders', { method: 'POST', token: p.appToken, body: { packId: 'coins-100' } })).status, 404);
  assert.equal((await call('/api/payments/orders/rm0000000000000000000000', { token: p.appToken })).status, 404);
});

/* ---------- the flag and the config ---------- */

test('with RM off every top-up route is 404, login included', async () => {
  const p = await webPlayer();
  config.rm.enabled = false;
  try {
    for (const [method, path, token] of [
      ['GET', '/api/topup/packs'], ['POST', '/api/topup/login'], ['GET', '/api/topup/me', p.token],
      ['POST', '/api/topup/orders', p.token], ['GET', '/api/topup/orders/rm0000000000000000000000', p.token],
    ]) {
      const res = await call(path, { method, token, body: method === 'POST' ? widgetLoginFor(p.tg, BOT_TOKEN) : undefined });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  } finally {
    config.rm.enabled = true;
  }
});

test('RM on without a web return URL, or with a bad method code, refuses to start', () => {
  const full = { ...config.rm };
  assert.deepEqual(rmConfigProblems(full), []);
  assert.equal(rmConfigProblems({ ...full, webReturnUrl: '' }).length, 1);
  assert.equal(rmConfigProblems({ ...full, webReturnUrl: 'http://game.example/topup/done' }).length, 1);
  assert.equal(rmConfigProblems({ ...full, webReturnUrl: 'https://game.example/topup/done?x=1' }).length, 1);
  assert.equal(rmConfigProblems({ ...full, webMethods: ['tng_my'] }).length, 1);
  assert.equal(rmConfigProblems({ ...full, webMethods: [] }).length, 1);
  assert.equal(rmConfigProblems({ ...full, webMethods: ['TNG_MY', 'BOOST_MY'] }).length, 0);
});
