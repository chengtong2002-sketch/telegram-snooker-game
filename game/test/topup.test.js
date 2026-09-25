import test from 'node:test';
import assert from 'node:assert/strict';
import {
  widgetLogin, withoutWidgetFields, deviceKind, myr, liveSession, orderFromQuery, orderMessage,
} from '../src/topup/logic.js';

test('the widget\'s login is read from the query, and only its own fields', () => {
  assert.equal(widgetLogin('?order=rm1'), null);
  assert.equal(widgetLogin('?id=5'), null, 'no hash, no login');
  assert.deepEqual(
    widgetLogin('?order=rm0123&id=5&first_name=A%20B&auth_date=10&hash=ab&evil=1'),
    { id: '5', first_name: 'A B', auth_date: '10', hash: 'ab' },
  );
});

test('after login the address bar keeps the page\'s own params only', () => {
  assert.equal(withoutWidgetFields('?order=rm1&id=5&hash=ab&auth_date=1&username=x'), '?order=rm1');
  assert.equal(withoutWidgetFields('?id=5&hash=ab'), '');
  assert.equal(withoutWidgetFields(''), '');
});

test('phones (iPad included) get the app checkout, computers the QR', () => {
  const ua = {
    android: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
  };
  assert.equal(deviceKind(ua.android, 5), 'mobile');
  assert.equal(deviceKind(ua.iphone, 5), 'mobile');
  assert.equal(deviceKind(ua.ipad, 5), 'mobile', 'iPadOS says Macintosh but has touch');
  assert.equal(deviceKind(ua.ipad, 0), 'desktop', 'a real Mac');
  assert.equal(deviceKind(ua.windows, 10), 'desktop', 'a touch laptop still gets the QR');
  assert.equal(deviceKind(), 'desktop');
});

test('prices read in ringgit from sen', () => {
  assert.equal(myr(490), 'RM 4.90');
  assert.equal(myr(3990), 'RM 39.90');
  assert.equal(myr(100000), 'RM 1000.00');
});

test('a stored session is used only while it has more than a minute left', () => {
  const now = Date.parse('2026-09-25T10:00:00Z');
  const s = (at) => ({ token: 't', expiresAt: at });
  assert.deepEqual(liveSession(s('2026-09-25T10:20:00Z'), now), s('2026-09-25T10:20:00Z'));
  assert.equal(liveSession(s('2026-09-25T10:00:30Z'), now), null);
  assert.equal(liveSession(s('nonsense'), now), null);
  assert.equal(liveSession({ expiresAt: '2030-01-01T00:00:00Z' }, now), null);
  assert.equal(liveSession(null, now), null);
});

test('only an order id of ours is followed', () => {
  assert.equal(orderFromQuery('?order=rm0123456789abcdef012345'), 'rm0123456789abcdef012345');
  assert.equal(orderFromQuery('?order=rm0123456789abcdef012345&status=SUCCESS'), 'rm0123456789abcdef012345');
  assert.equal(orderFromQuery('?order=../../x'), null);
  assert.equal(orderFromQuery(''), null);
});

test('the done screen reads the order, never RM\'s return params', () => {
  assert.equal(orderMessage({ status: 'paid', coins: 550, balance: 1500 }).title, '+550 coins');
  assert.match(orderMessage({ status: 'paid', coins: 550, balance: 1500 }).text, /1,500 coins/);
  assert.equal(orderMessage({ status: 'pending' }).kind, 'wait');
  assert.equal(orderMessage({ status: 'pending' }, { timedOut: true }).kind, 'info');
  for (const s of ['failed', 'cancelled', 'expired']) assert.equal(orderMessage({ status: s }).kind, 'bad', s);
  assert.equal(orderMessage({ status: 'disputed' }).kind, 'info');
  assert.equal(orderMessage(null).kind, 'wait');
});
