import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { Address, Cell, loadStateInit } from '@ton/core';
import { config } from '../config.js';

const PROOF_PREFIX = Buffer.from('ton-proof-item-v2/');
const CONNECT_PREFIX = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect')]);
const MAX_PROOF_AGE_SEC = 15 * 60;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/**
 * Pull the wallet's public key out of its stateInit data cell.
 * Layouts differ between wallet versions, so try the known ones rather than
 * assuming v4 — a v5 wallet is otherwise silently rejected.
 */
function publicKeyFromStateInit(stateInitCell) {
  const stateInit = loadStateInit(stateInitCell.beginParse());
  if (!stateInit.data) return [];
  const candidates = [];
  // v3/v4: seqno(32) wallet_id(32) pubkey(256)
  // v5:    is_signature_allowed(1) seqno(32) wallet_id(32) pubkey(256)
  for (const skipBits of [64, 65]) {
    try {
      const slice = stateInit.data.beginParse();
      slice.skip(skipBits);
      candidates.push(Buffer.from(slice.loadBuffer(32)));
    } catch {
      // Layout does not match; try the next one.
    }
  }
  return candidates;
}

/**
 * Verify a TON Connect `ton_proof`.
 *
 * The stateInit is what binds the signing key to the claimed address: its hash
 * must equal the address hash, and the public key that signed the proof must be
 * the one stored inside it. Without that binding a player could sign with their
 * own key and name someone else's address as the payout target.
 *
 * @param {{address:string, network?:string, publicKey?:string, proof:{timestamp:number,domain:{lengthBytes:number,value:string},payload:string,signature:string}, walletStateInit:string}} input
 * @param {{expectedPayload?:string}} [opts]
 * @returns {{ok:true, address:string, network:string, publicKey:string} | {ok:false, reason:string}}
 */
export function verifyTonProof(input, opts = {}) {
  const { address, proof, walletStateInit } = input ?? {};
  if (!address || !proof?.signature || !walletStateInit) {
    return { ok: false, reason: 'incomplete ton_proof payload' };
  }

  let parsed;
  try {
    parsed = Address.parse(address);
  } catch {
    return { ok: false, reason: 'unparseable TON address' };
  }

  const age = Math.abs(Date.now() / 1000 - Number(proof.timestamp ?? 0));
  if (!proof.timestamp || age > MAX_PROOF_AGE_SEC) {
    return { ok: false, reason: 'proof expired' };
  }

  const domain = proof.domain?.value ?? '';
  if (config.tonConnect.allowedDomains.length && !config.tonConnect.allowedDomains.includes(domain)) {
    return { ok: false, reason: `domain ${domain} not allowed` };
  }

  if (opts.expectedPayload && proof.payload !== opts.expectedPayload) {
    return { ok: false, reason: 'proof payload mismatch' };
  }

  let stateInitCell;
  try {
    stateInitCell = Cell.fromBase64(walletStateInit);
  } catch {
    return { ok: false, reason: 'unparseable walletStateInit' };
  }
  if (!stateInitCell.hash().equals(parsed.hash)) {
    return { ok: false, reason: 'walletStateInit does not match address' };
  }

  const wc = Buffer.alloc(4);
  wc.writeInt32BE(parsed.workChain);
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(proof.domain?.lengthBytes ?? Buffer.byteLength(domain));
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(proof.timestamp));

  const message = Buffer.concat([
    PROOF_PREFIX,
    wc,
    parsed.hash,
    domainLen,
    Buffer.from(domain),
    ts,
    Buffer.from(proof.payload ?? ''),
  ]);
  const signed = sha256(Buffer.concat([CONNECT_PREFIX, sha256(message)]));
  const signature = Buffer.from(proof.signature, 'base64');

  const keys = publicKeyFromStateInit(stateInitCell);
  if (keys.length === 0) return { ok: false, reason: 'no public key in walletStateInit' };

  const match = keys.find((key) => nacl.sign.detached.verify(signed, signature, key));
  if (!match) return { ok: false, reason: 'signature does not verify' };

  return {
    ok: true,
    address: parsed.toString({ urlSafe: true, bounceable: false, testOnly: config.ton.network === 'testnet' }),
    network: input.network === '-3' || input.network === 'testnet' ? 'testnet' : 'mainnet',
    publicKey: match.toString('hex'),
  };
}

/** Random nonce the client must echo back inside the signed proof. */
export const newProofPayload = () => crypto.randomBytes(24).toString('hex');
