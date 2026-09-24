import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onPreCheckout, onSuccessfulPayment, onRefundedPayment, CHECK_UNAVAILABLE,
} from '../src/payments.js';

/** A grammY context with just what the handlers touch, recording what they send. */
function fakeCtx(update) {
  const sent = { answers: [], replies: [] };
  return {
    sent,
    from: { id: 777 },
    ...update,
    answerPreCheckoutQuery: async (ok, other) => { sent.answers.push({ ok, ...other }); },
    reply: async (text, other) => { sent.replies.push({ text, ...other }); },
  };
}

const preCheckout = () => fakeCtx({
  preCheckoutQuery: {
    id: 'q1', from: { id: 777 }, currency: 'XTR', total_amount: 100, invoice_payload: 'st0123456789abcdef012345',
  },
});
const successful = () => fakeCtx({
  message: {
    successful_payment: {
      currency: 'XTR', total_amount: 100, invoice_payload: 'st0123456789abcdef012345', telegram_payment_charge_id: 'ch-1',
    },
  },
});

test('pre-checkout passes the query to the backend and answers with its verdict', async () => {
  const seen = [];
  const ok = preCheckout();
  await onPreCheckout(ok, { api: { starsCheck: async (b) => { seen.push(b); return { ok: true }; } } });
  assert.deepEqual(seen, [{
    orderId: 'st0123456789abcdef012345', telegramId: 777, currency: 'XTR', totalAmount: 100,
  }]);
  assert.deepEqual(ok.sent.answers, [{ ok: true }]);

  const no = preCheckout();
  await onPreCheckout(no, { api: { starsCheck: async () => ({ ok: false, error: 'This invoice has expired.' }) } });
  assert.deepEqual(no.sent.answers, [{ ok: false, error_message: 'This invoice has expired.' }]);
});

test('pre-checkout refuses when the backend cannot be reached: an unanswered query would fail anyway', async () => {
  const ctx = preCheckout();
  await onPreCheckout(ctx, { api: { starsCheck: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.deepEqual(ctx.sent.answers, [{ ok: false, error_message: CHECK_UNAVAILABLE }]);
});

test('a successful payment is passed on with its charge id, and the player is told their balance', async () => {
  const seen = [];
  const ctx = successful();
  await onSuccessfulPayment(ctx, {
    api: { starsPaid: async (b) => { seen.push(b); return { status: 'credited', coins: 100, balance: 350 }; } },
  });
  assert.deepEqual(seen, [{
    orderId: 'st0123456789abcdef012345', telegramId: 777, currency: 'XTR', totalAmount: 100, chargeId: 'ch-1',
  }]);
  assert.equal(ctx.sent.replies.length, 1);
  assert.match(ctx.sent.replies[0].text, /100 coins added/);
  assert.match(ctx.sent.replies[0].text, /350 coins/);
});

test('a backend that is down is retried; after the last try the player is told the coins are coming', async () => {
  let tries = 0;
  const waits = [];
  const recovers = successful();
  await onSuccessfulPayment(recovers, {
    api: { starsPaid: async () => { tries += 1; if (tries < 3) throw new Error('down'); return { status: 'credited', coins: 100, balance: 100 }; } },
    wait: async (ms) => { waits.push(ms); },
    delays: [1, 2, 3],
  });
  assert.equal(tries, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.match(recovers.sent.replies[0].text, /coins added/);

  let calls = 0;
  const never = successful();
  await onSuccessfulPayment(never, {
    api: { starsPaid: async () => { calls += 1; throw new Error('down'); } },
    wait: async () => {},
    delays: [1, 2, 3],
  });
  assert.equal(calls, 4, 'the first try and three retries');
  assert.equal(never.sent.replies.length, 1);
  assert.match(never.sent.replies[0].text, /within a few minutes/, 'the reconciler will credit it');
});

test('an unmatched payment is not retried and points the player to /paysupport', async () => {
  let calls = 0;
  const ctx = successful();
  await onSuccessfulPayment(ctx, {
    api: { starsPaid: async () => { calls += 1; return { status: 'unknown_order' }; } },
    wait: async () => {},
  });
  assert.equal(calls, 1);
  assert.match(ctx.sent.replies[0].text, /\/paysupport/);
});

test('a refund Telegram reports is passed on by charge id', async () => {
  const seen = [];
  const ctx = fakeCtx({ message: { refunded_payment: { telegram_payment_charge_id: 'ch-9', total_amount: 100, currency: 'XTR' } } });
  await onRefundedPayment(ctx, { api: { starsRefunded: async (b) => { seen.push(b); return { status: 'debited' }; } } });
  assert.deepEqual(seen, [{ chargeId: 'ch-9' }]);
});
