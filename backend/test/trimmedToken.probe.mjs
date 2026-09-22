/**
 * Run by productionConfig.test.js in a child process, because config.js reads
 * BOT_TOKEN once at import time. Exits non-zero with a message on failure.
 *
 * BOT_TOKEN is set with surrounding whitespace; everything here signs with the
 * clean token, so it only passes if config trimmed what it read.
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { verifyInitData } from '../src/auth.js';

const CLEAN = '123456:TEST-token';

if (config.botToken !== CLEAN) {
  throw new Error(`config.botToken was not trimmed: ${JSON.stringify(config.botToken)}`);
}

const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":7}' };
const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
const secret = crypto.createHmac('sha256', 'WebAppData').update(CLEAN).digest();
const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');

const result = verifyInitData(new URLSearchParams({ ...fields, hash }).toString());
if (!result.ok) throw new Error(`initData rejected: ${result.reason}`);
