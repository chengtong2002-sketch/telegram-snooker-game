import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from '@snooker/db/testing';

const dropTestDatabase = await useTestDatabase('challenge');
process.env.ALLOW_DEV_AUTH = 'true';
process.env.NODE_ENV = 'test';

const { closeDb, migrate, getDb, upsertUser, issueChallenge, consumeChallenge, purgeExpiredChallenges } =
  await import('@snooker/db');
const { buildApp } = await import('../src/app.js');

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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const loginAs = async (id, name) => {
  const res = await call('/api/auth/telegram', {
    method: 'POST',
    body: { devUser: { id, first_name: name, username: name.toLowerCase() } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
};

const newUser = async (telegramId, name) => {
  const user = await upsertUser({ id: telegramId, first_name: name });
  return user.id;
};

test('a challenge survives in the DB, not in backend process memory', async () => {
  const token = await loginAs(3001, 'Cal');
  const res = await call('/api/wallet/challenge', { token });
  assert.equal(res.status, 200);
  assert.match(res.body.payload, /^[0-9a-f]{48}$/);

  // The nonce is readable by any replica, because it is a row.
  const row = await getDb()('auth_challenges').where({ payload: res.body.payload }).first();
  assert.ok(row, 'challenge should be persisted');
  assert.equal(row.purpose, 'ton_proof');
});

test('requesting a second challenge replaces the first — never two live nonces', async () => {
  const userId = await newUser(3002, 'Dee');
  await issueChallenge(userId, { payload: 'first-nonce', ttlMs: 60_000 });
  await issueChallenge(userId, { payload: 'second-nonce', ttlMs: 60_000 });

  const rows = await getDb()('auth_challenges').where({ user_id: userId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload, 'second-nonce');
});

test('a nonce is single-use: the second read gets nothing', async () => {
  const userId = await newUser(3003, 'Eve');
  await issueChallenge(userId, { payload: 'one-shot', ttlMs: 60_000 });

  assert.equal(await consumeChallenge(userId), 'one-shot');
  assert.equal(await consumeChallenge(userId), null);
});

test('two concurrent /link attempts cannot both consume the same nonce', async () => {
  const userId = await newUser(3004, 'Fay');
  await issueChallenge(userId, { payload: 'contested', ttlMs: 60_000 });

  const results = await Promise.all([consumeChallenge(userId), consumeChallenge(userId)]);
  assert.deepEqual(results.filter((r) => r === 'contested').length, 1);
  assert.deepEqual(results.filter((r) => r === null).length, 1);
});

test('an expired nonce is refused and swept away', async () => {
  const userId = await newUser(3005, 'Gus');
  await issueChallenge(userId, { payload: 'stale', ttlMs: -1000 });

  assert.equal(await consumeChallenge(userId), null, 'expired nonce must not verify');

  // A nonce nobody came back for is left behind; the reaper clears it.
  await issueChallenge(userId, { payload: 'abandoned', ttlMs: -1000 });
  assert.equal(await purgeExpiredChallenges(), 1);
  assert.equal(await getDb()('auth_challenges').where({ user_id: userId }).first(), undefined);
});

test('linking without a challenge is rejected before any proof is parsed', async () => {
  const token = await loginAs(3006, 'Hal');
  const res = await call('/api/wallet/link', { method: 'POST', token, body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no active challenge/);
});
