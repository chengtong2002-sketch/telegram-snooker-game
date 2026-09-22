/**
 * findSentTransaction decides whether a payout row may be marked `sent`, so the
 * question it has to get right is "is this transaction mine?" — not "is there a
 * transaction?". These drive it against a stubbed account history; the live
 * chain is exercised by running a real payout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSentTransaction, accountCursor, explorerTxUrl } from '../src/client.js';
import type { Treasury } from '../src/client.js';

const hashOf = (n: number) => Buffer.alloc(32, n);

/** A transaction as much as the lookup looks at it. */
const tx = (lt: bigint, kind: 'external-in' | 'internal', id: number) => ({
  lt,
  inMessage: { info: { type: kind } },
  hash: () => hashOf(id),
});

/**
 * @param history newest first, as the v4 API returns it.
 */
function stubTreasury(history: ReturnType<typeof tx>[], opts: { last?: boolean } = {}): Treasury {
  const newest = history[0];
  return {
    network: 'testnet',
    wallet: { address: 'EQtreasury' },
    api: {
      getLastBlock: async () => ({ last: { seqno: 1 } }),
      getAccountLite: async () => ({
        account: {
          last: opts.last === false || !newest
            ? null
            : { lt: newest.lt.toString(), hash: hashOf(0).toString('base64') },
        },
      }),
      getAccountTransactions: async () => history.map((t) => ({ tx: t })),
    },
  } as unknown as Treasury;
}

test('finds the external-in the treasury signed after the mark', async () => {
  const treasury = stubTreasury([
    tx(300n, 'internal', 3), // the jetton wallet answering back
    tx(200n, 'external-in', 2), // our send
    tx(100n, 'external-in', 1), // an older send
  ]);
  const found = await findSentTransaction(treasury, { lt: 150n });
  assert.equal(found?.hash, hashOf(2).toString('hex'));
  assert.equal(found?.lt, '200');
});

test('an older send is never claimed as this one', async () => {
  // Nothing new has landed: the only external-in predates the mark.
  const treasury = stubTreasury([tx(100n, 'external-in', 1)]);
  assert.equal(await findSentTransaction(treasury, { lt: 150n }), null);
});

test('incoming traffic alone does not count as a send', async () => {
  // The account moved after the mark, but only because something paid it.
  const treasury = stubTreasury([tx(300n, 'internal', 3)]);
  assert.equal(await findSentTransaction(treasury, { lt: 150n }), null);
});

test('with no mark, the newest external-in is taken', async () => {
  // A treasury whose cursor could not be read before sending: sinceLt is 0.
  const treasury = stubTreasury([tx(200n, 'external-in', 2), tx(100n, 'external-in', 1)]);
  assert.equal((await findSentTransaction(treasury, null))?.hash, hashOf(2).toString('hex'));
});

test('an account with no transactions at all reads as nothing landed', async () => {
  const treasury = stubTreasury([], { last: false });
  assert.equal(await findSentTransaction(treasury, null), null);
  assert.equal(await accountCursor(treasury), null);
});

test('the cursor is the account last pointer, decoded for the API', async () => {
  const cursor = await accountCursor(stubTreasury([tx(300n, 'internal', 3)]));
  assert.equal(cursor?.lt, 300n);
  assert.ok(Buffer.isBuffer(cursor?.hash));
});

test('a recorded hash links to the right explorer', () => {
  const hash = 'a37688e6a7539206b03ea34b6e81c459c519ecb9fc11f8c6d2995f519d7099e2';
  assert.equal(explorerTxUrl('testnet', hash), `https://testnet.tonviewer.com/transaction/${hash}`);
  assert.equal(explorerTxUrl('mainnet', hash), `https://tonviewer.com/transaction/${hash}`);
});
