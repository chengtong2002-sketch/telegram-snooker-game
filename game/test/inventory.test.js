import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyLabel, formatDelta, formatWhen, ownedByKind, equippedPair,
} from '../src/inventory.js';

test('every history type reads as a plain line', () => {
  assert.equal(historyLabel({ type: 'item', itemName: 'Pearl' }), 'Bought Pearl');
  assert.equal(historyLabel({ type: 'item', itemName: null }), 'Bought an item');
  assert.equal(historyLabel({ type: 'pack', via: 'stars' }), 'Coin pack · Telegram Stars');
  assert.equal(historyLabel({ type: 'pack', via: 'card' }), 'Coin pack · card or e-wallet');
  assert.equal(historyLabel({ type: 'pack', via: null }), 'Coin pack');
  assert.equal(historyLabel({ type: 'refund', via: 'stars' }), 'Refund · Telegram Stars');
  assert.equal(historyLabel({ type: 'grant' }), 'Coins from Snooker');
  assert.equal(historyLabel({ type: 'something-new' }), 'Balance adjustment');
});

test('amounts are signed, with a real minus and thousands separators', () => {
  assert.equal(formatDelta(1200), '+1,200');
  assert.equal(formatDelta(-500), '−500');
  assert.equal(formatDelta(-12345), '−12,345');
});

test('dates show the year only when it is not this year', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  assert.ok(!formatWhen('2026-09-24T13:05:00Z', now).includes('2026'));
  assert.ok(formatWhen('2025-12-31T10:00:00Z', now).includes('2025'));
});

test('owned items split by kind, equipped first, otherwise the server order', () => {
  const items = [
    { id: 'club-ash', kind: 'cue', equipped: false },
    { id: 'pearl', kind: 'ball', equipped: false },
    { id: 'crimson-crown', kind: 'cue', equipped: true },
    { id: 'ebony-points', kind: 'cue', equipped: false },
    { id: 'club-white', kind: 'ball', equipped: true },
  ];
  const { cue, ball } = ownedByKind(items);
  assert.deepEqual(cue.map((i) => i.id), ['crimson-crown', 'club-ash', 'ebony-points']);
  assert.deepEqual(ball.map((i) => i.id), ['club-white', 'pearl']);
  assert.deepEqual(ownedByKind(), { cue: [], ball: [] });
});

test('the equipped pair comes from the inventory, null when missing', () => {
  const inv = {
    equipped: { cue: 'crimson-crown', ball: 'club-white' },
    items: [{ id: 'crimson-crown', kind: 'cue' }, { id: 'club-white', kind: 'ball' }],
  };
  assert.deepEqual(Object.values(equippedPair(inv)).map((i) => i.id), ['crimson-crown', 'club-white']);
  assert.deepEqual(equippedPair(null), { cue: null, ball: null });
});
