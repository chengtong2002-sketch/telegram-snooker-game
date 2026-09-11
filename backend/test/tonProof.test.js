import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { beginCell, storeStateInit, Address } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';

process.env.TON_NETWORK = 'testnet';
process.env.TONCONNECT_ALLOWED_DOMAINS = 'snooker.example';

const { verifyTonProof } = await import('../src/services/tonProof.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const DOMAIN = 'snooker.example';

/** Build a genuine ton_proof the way a real TON Connect wallet would. */
function makeProof({ payload = 'nonce-123', domain = DOMAIN, timestamp = Math.floor(Date.now() / 1000), signWith } = {}) {
  const seed = crypto.createHash('sha256').update('deterministic-test-wallet').digest();
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const publicKey = Buffer.from(keyPair.publicKey);

  const wallet = WalletContractV4.create({ workchain: 0, publicKey });
  const stateInitCell = beginCell().store(storeStateInit(wallet.init)).endCell();
  const address = wallet.address;

  const wc = Buffer.alloc(4);
  wc.writeInt32BE(address.workChain);
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(Buffer.byteLength(domain));
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestamp));

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    wc,
    address.hash,
    domainLen,
    Buffer.from(domain),
    ts,
    Buffer.from(payload),
  ]);
  const signed = sha256(Buffer.concat([
    Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256(message),
  ]));

  const secret = signWith ?? keyPair.secretKey;
  const signature = Buffer.from(nacl.sign.detached(signed, secret));

  return {
    input: {
      address: address.toString({ urlSafe: true, bounceable: false, testOnly: true }),
      network: 'testnet',
      publicKey: publicKey.toString('hex'),
      walletStateInit: stateInitCell.toBoc().toString('base64'),
      proof: {
        timestamp,
        domain: { lengthBytes: Buffer.byteLength(domain), value: domain },
        payload,
        signature: signature.toString('base64'),
      },
    },
    address,
    publicKey,
    stateInitCell,
  };
}

test('a genuine ton_proof verifies and yields the signing wallet address', () => {
  const { input, publicKey } = makeProof();
  const result = verifyTonProof(input, { expectedPayload: 'nonce-123' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.publicKey, publicKey.toString('hex'));
  assert.equal(result.network, 'testnet');
});

test('a signature from a different key is rejected', () => {
  const attacker = nacl.sign.keyPair.fromSeed(crypto.createHash('sha256').update('attacker').digest());
  const { input } = makeProof({ signWith: attacker.secretKey });
  const result = verifyTonProof(input, { expectedPayload: 'nonce-123' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /signature does not verify/);
});

test('claiming someone else\'s address is rejected: stateInit must hash to it', () => {
  const { input } = makeProof();
  // Same valid proof, but pointing the payout at a different wallet.
  const victim = WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(nacl.sign.keyPair.fromSeed(crypto.createHash('sha256').update('victim').digest()).publicKey),
  });
  const result = verifyTonProof(
    { ...input, address: victim.address.toString({ urlSafe: true, bounceable: false, testOnly: true }) },
    { expectedPayload: 'nonce-123' },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match address/);
});

test('a replayed nonce from an earlier challenge is rejected', () => {
  const { input } = makeProof({ payload: 'old-nonce' });
  const result = verifyTonProof(input, { expectedPayload: 'the-current-nonce' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /payload mismatch/);
});

test('a stale proof is rejected', () => {
  const { input } = makeProof({ timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const result = verifyTonProof(input, { expectedPayload: 'nonce-123' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test('a proof signed for another site\'s domain is rejected', () => {
  const { input } = makeProof({ domain: 'evil.example' });
  const result = verifyTonProof(input, { expectedPayload: 'nonce-123' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not allowed/);
});

test('a malformed payload is rejected rather than throwing', () => {
  for (const bad of [null, {}, { address: 'nonsense' }, { address: 'EQ', proof: {}, walletStateInit: 'x' }]) {
    const result = verifyTonProof(bad, { expectedPayload: 'n' });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string');
  }
});
