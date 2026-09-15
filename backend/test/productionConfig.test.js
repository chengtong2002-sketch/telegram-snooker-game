import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeployed, productionConfigProblems } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const good = {
  botToken: '123:abc',
  jwtSecret: 'a'.repeat(64),
  internalApiKey: 'b'.repeat(48),
  allowedOrigins: ['https://game.example'],
  allowDevAuth: false,
  tonConnect: { allowedDomains: ['game.example'] },
};

test('running on Railway counts as deployed even without NODE_ENV=production', () => {
  assert.equal(isDeployed({ NODE_ENV: 'production' }), true);
  assert.equal(isDeployed({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'production' }), true);
  assert.equal(isDeployed({ RAILWAY_PROJECT_ID: 'p1' }), true);
  assert.equal(isDeployed({ NODE_ENV: 'development' }), false);
  assert.equal(isDeployed({}), false);
});

test('a complete production config has no problems', () => {
  assert.deepEqual(productionConfigProblems(good), []);
});

test('every unsafe setting is reported', () => {
  const cases = [
    [{ botToken: '' }, /BOT_TOKEN/],
    [{ jwtSecret: 'dev-only-insecure-secret' }, /JWT_SECRET/],
    [{ jwtSecret: 'change-me-openssl-rand-hex-32' }, /JWT_SECRET/],
    [{ jwtSecret: 'short' }, /JWT_SECRET/],
    [{ internalApiKey: 'dev-internal-key' }, /INTERNAL_API_KEY/],
    [{ internalApiKey: 'change-me-too' }, /INTERNAL_API_KEY/],
    [{ internalApiKey: '' }, /INTERNAL_API_KEY/],
    [{ allowedOrigins: ['*'] }, /ALLOWED_ORIGINS/],
    [{ allowDevAuth: true }, /ALLOW_DEV_AUTH/],
    [{ tonConnect: { allowedDomains: [] } }, /TONCONNECT_ALLOWED_DOMAINS/],
  ];
  for (const [patch, expected] of cases) {
    const problems = productionConfigProblems({ ...good, ...patch });
    assert.equal(problems.length, 1, `${JSON.stringify(patch)} -> ${problems}`);
    assert.match(problems[0], expected);
  }
});

test('the backend refuses to boot on Railway with a pasted local .env', () => {
  // The exact failure the old check missed: NODE_ENV=development, dev auth on,
  // placeholder secrets — but running on Railway.
  const result = spawnSync(process.execPath, [path.join(here, '../src/index.js')], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      RAILWAY_ENVIRONMENT_NAME: 'production',
      NODE_ENV: 'development',
      ALLOW_DEV_AUTH: 'true',
      BOT_TOKEN: '123:abc',
      JWT_SECRET: 'change-me-openssl-rand-hex-32',
      INTERNAL_API_KEY: 'change-me-too',
      ALLOWED_ORIGINS: '*',
      TONCONNECT_ALLOWED_DOMAINS: '',
      DATABASE_URL: 'file::memory:',
      PORT: '0',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  const output = result.stdout + result.stderr;
  for (const name of ['ALLOW_DEV_AUTH', 'JWT_SECRET', 'INTERNAL_API_KEY', 'ALLOWED_ORIGINS', 'TONCONNECT_ALLOWED_DOMAINS']) {
    assert.match(output, new RegExp(name), `${name} is named in the refusal`);
  }
});
