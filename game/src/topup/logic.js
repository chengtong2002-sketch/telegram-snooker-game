/**
 * The web top-up page's pure parts (docs/topup-web-plan.md): no DOM, so
 * node --test covers them; page.js draws.
 */

/** The fields Telegram's login widget appends to data-auth-url. The backend refuses any other. */
export const WIDGET_FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'];

/**
 * The widget's login from a URL's query, or null when there is none. Only the
 * widget's own fields are taken, so the page's own params (order) never ride
 * along into the signed data.
 */
export function widgetLogin(search) {
  const params = new URLSearchParams(search);
  if (!params.get('id') || !params.get('hash')) return null;
  const login = {};
  for (const key of WIDGET_FIELDS) {
    const value = params.get(key);
    if (value !== null) login[key] = value;
  }
  return login;
}

/** The same query without the widget's fields: what the address bar keeps after login. */
export function withoutWidgetFields(search) {
  const params = new URLSearchParams(search);
  for (const key of WIDGET_FIELDS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Phone or desktop, for RM's checkout: a phone gets MOBILE_PAYMENT (opens the
 * TNG app), a desktop WEB_PAYMENT (shows a TNG QR to scan). An iPad reports
 * itself as a Mac, so touch points tell it apart.
 */
export function deviceKind(userAgent = '', maxTouchPoints = 0) {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return 'mobile';
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'mobile';
  return 'desktop';
}

/** "RM 4.90" from 490 sen. */
export const myr = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

/** "1,200" */
export const fmt = (n) => Number(n ?? 0).toLocaleString('en');

/** A stored session, or null once it has expired (or is unreadable). */
export function liveSession(saved, now = Date.now()) {
  if (!saved || typeof saved.token !== 'string' || !saved.expiresAt) return null;
  const ends = Date.parse(saved.expiresAt);
  // A minute's margin: a token about to run out would fail mid-checkout.
  return Number.isFinite(ends) && ends - 60_000 > now ? saved : null;
}

/** The order id on the done screen, if it looks like one of ours. */
export function orderFromQuery(search) {
  const id = new URLSearchParams(search).get('order');
  return id && /^rm[0-9a-f]{22}$/.test(id) ? id : null;
}

/** Order states that will not change any more. */
export const SETTLED = new Set(['paid', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded', 'disputed']);

/** What the done screen says about an order: { kind, title, text }. */
export function orderMessage(order, { timedOut = false } = {}) {
  if (!order) return { kind: 'wait', title: 'Checking your payment…', text: 'This takes a few seconds.' };
  switch (order.status) {
    case 'paid':
      return { kind: 'good', title: `+${fmt(order.coins)} coins`, text: `Your new balance is ${fmt(order.balance)} coins.` };
    case 'refunded':
    case 'partially_refunded':
      return { kind: 'info', title: 'This payment was refunded', text: `Your balance is ${fmt(order.balance)} coins.` };
    case 'failed':
    case 'cancelled':
    case 'expired':
      return {
        kind: 'bad',
        title: 'Payment not completed',
        text: 'No coins were added. If money was taken, it is refunded. You can try again.',
      };
    case 'disputed':
      return {
        kind: 'info',
        title: 'We are checking this payment',
        text: 'Something about it needs a person to look at it. Message the bot\'s /paysupport with the time of payment and we will sort it out.',
      };
    default:
      return timedOut
        ? {
          kind: 'info',
          title: 'Your payment is being confirmed',
          text: 'Coins arrive by themselves once it is, even if you close this page.',
        }
        : { kind: 'wait', title: 'Waiting for your payment…', text: 'Finish paying in Touch \'n Go. This page updates by itself.' };
  }
}
