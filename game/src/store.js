/**
 * The store screen: cues, cue balls and coin packs (docs/store-plan.md).
 *
 * Everything shown comes from GET /api/store, and every change goes back
 * through the server: the client never prices an item, never decides what is
 * owned, and redraws from the server's answer after a buy or an equip.
 *
 * Built from DOM nodes, so no server value is ever parsed as HTML. The only
 * markup strings are the confirmation sheets, and they escape what they quote.
 */
import catalog from '@snooker/cosmetics/cosmetics.json';
import * as api from './api.js';
import { itemSvg, svgDataUrl } from './skinLoader.js';
import {
  showBackButton, haptic, canPayInvoices, openInvoice, openExternal, deviceKind,
} from './telegram.js';
import {
  historyLabel, formatDelta, formatWhen, ownedByKind, equippedPair,
} from './inventory.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString('en');
const myr = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const catalogItems = new Map([...catalog.cues, ...catalog.cueBalls].map((item) => [item.id, item]));

/** Tier label colours live in CSS (.tier-classic …); this is the order they rank in. */
const TIERS = ['Starter', 'Classic', 'Rare', 'Epic'];

/** A coin icon, the same drawing as the lobby chip (#coin-mark in index.html). */
function coin() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'coin');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#coin-mark');
  svg.append(use);
  return svg;
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

let els = null;
function elements() {
  els ??= {
    root: $('store'),
    back: $('store-back'),
    coins: $('store-coins'),
    coinsValue: $('store-coins-value'),
    tabs: [...document.querySelectorAll('#store .store-tab')],
    list: $('store-list'),
    note: $('store-note'),
  };
  return els;
}

/** The open screen's state. Null when the store is closed. */
let session = null;

/**
 * Open the store over the lobby.
 *
 * @param {object} opts
 * @param {import('./hud.js').Hud} opts.hud
 * @param {'cue'|'ball'|'coins'|'inventory'} [opts.tab]
 * @param {string} [opts.orderId] a TNG / card payment to follow (back from RM's checkout)
 * @param {(change: {balance: number, equipped?: object}) => void} [opts.onChange]
 *        after every server answer, so the lobby chip and the drawn skins follow
 * @param {() => void} [opts.onClose]
 */
export async function openStore({
  hud, tab = 'cue', orderId = null, onChange, onClose,
} = {}) {
  const el = elements();
  session = {
    hud, tab, data: null, busy: false, onChange, onClose,
    // The Inventory tab's own reads, fetched when it is first shown.
    inv: null, invError: null, hist: null, histBusy: false,
  };
  session.hideBack = showBackButton(closeStore);
  el.back.onclick = closeStore;
  for (const button of el.tabs) button.onclick = () => selectTab(button.dataset.tab);

  el.root.hidden = false;
  el.root.scrollTop = 0;
  paint();
  await reload();
  if (orderId) watchOrder(session, orderId);
}

export function closeStore() {
  if (!session) return;
  const { hideBack, onClose } = session;
  session = null;
  hideBack?.();
  elements().root.hidden = true;
  onClose?.();
}

async function reload() {
  const s = session;
  try {
    adopt(await api.store());
  } catch (err) {
    if (s !== session) return;
    s.error = err.offline ? 'No connection. The store needs one.' : `Could not load the store: ${err.message}`;
    paint();
  }
}

/** Take the server's store as the truth and redraw. */
function adopt(data) {
  if (!session) return;
  // Owned and equipped may have moved: the inventory is re-read when next shown,
  // and the history too if the balance changed.
  if (session.data && session.data.balance !== data.balance) session.hist = null;
  session.inv = null;
  session.data = data;
  session.error = null;
  session.onChange?.({ balance: data.balance, equipped: data.equipped });
  paint();
}

function selectTab(tab) {
  if (!session) return;
  session.tab = tab;
  if (tab === 'inventory') session.invError = null; // coming back to it retries a failed load
  elements().list.scrollTop = 0;
  paint();
}

/** The Inventory tab's data: owned items and the first page of history. */
async function loadInventory() {
  const s = session;
  if (!s || s.invLoading) return;
  s.invLoading = true;
  try {
    const [inv, hist] = await Promise.all([api.inventory(), s.hist ? null : api.coinHistory()]);
    if (s !== session) return;
    s.inv = inv;
    s.invError = null;
    if (hist) s.hist = hist;
  } catch (err) {
    if (s !== session) return;
    s.invError = err.offline ? 'No connection. The inventory needs one.' : `Could not load your inventory: ${err.message}`;
  } finally {
    s.invLoading = false;
  }
  if (s === session && s.tab === 'inventory') paint();
}

async function loadMoreHistory() {
  const s = session;
  if (!s?.hist?.next || s.histBusy) return;
  s.histBusy = true;
  paint();
  try {
    const page = await api.coinHistory(s.hist.next);
    if (s !== session) return;
    s.hist = { entries: [...s.hist.entries, ...page.entries], next: page.next };
  } catch (err) {
    if (s === session) s.hud.toast(err.offline ? 'No connection.' : err.message, 'foul', 3000);
  } finally {
    s.histBusy = false;
    if (s === session) paint();
  }
}

/* ---------- drawing ---------- */

function paint() {
  const el = elements();
  const { tab, data, error } = session;

  for (const button of el.tabs) {
    const on = button.dataset.tab === tab;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  }

  el.coinsValue.textContent = data ? fmt(data.balance) : '–';
  el.coins.classList.toggle('neg', Boolean(data && data.balance < 0));

  if (!data) {
    el.list.replaceChildren(node('li', 'store-empty', error ?? 'Loading…'));
    el.note.textContent = '';
    return;
  }

  if (tab === 'inventory') {
    paintInventory(el);
    return;
  }

  if (tab === 'coins') {
    el.list.replaceChildren(...data.packs.map(packRow));
    el.note.textContent = 'Coins buy cues and cue balls, and nothing else: they never affect matches or rewards. '
      + payNote(data);
    return;
  }

  const rows = data.items
    .filter((item) => item.kind === tab)
    // The catalog's own order within a tier; cheapest tier first.
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  el.list.replaceChildren(...rows.map(itemRow));
  el.note.textContent = data.balance < 0
    ? 'Your balance is below zero after a refund. Buying is paused until it is back above zero.'
    : 'Purchases are final. Your equipped cue and cue ball are what your opponent sees on your turns.';
}

function preview(item) {
  const known = catalogItems.get(item.id);
  const svg = known ? itemSvg(known) : null;
  const img = node('img', item.kind === 'cue' ? 'cue-preview' : 'ball-preview');
  img.alt = '';
  img.draggable = false;
  if (svg) img.src = svgDataUrl(svg);
  return img;
}

function itemRow(item) {
  const li = node('li', `store-item item-${item.kind}${item.equipped ? ' is-equipped' : ''}`);
  const meta = node('div', 'item-meta');
  meta.append(node('span', 'item-name', item.name), node('span', `tier tier-${item.tier.toLowerCase()}`, item.tier));

  const action = node('div', 'item-action');
  if (item.equipped) {
    action.append(node('span', 'item-state', 'Equipped'));
  } else if (item.owned) {
    const equip = node('button', 'item-btn', 'Equip');
    equip.onclick = () => equipItem(item);
    action.append(equip);
  } else {
    const buy = node('button', 'item-btn buy');
    buy.append(coin(), node('span', null, fmt(item.price)));
    buy.setAttribute('aria-label', `Buy ${item.name} for ${fmt(item.price)} coins`);
    buy.onclick = () => confirmBuy(item);
    action.append(buy);
  }

  if (item.kind === 'cue') {
    // A cue is long and thin: the picture takes the full width, the rest goes under it.
    const line = node('div', 'item-line');
    line.append(meta, action);
    li.append(preview(item), line);
  } else {
    li.append(preview(item), meta, action);
  }
  return li;
}

/** One coin pack: a ringgit button (TNG / card through Revenue Monster) and a Stars button, where each is on. */
function packRow(pack) {
  const li = node('li', 'store-item item-pack');
  const amount = node('div', 'pack-amount');
  amount.append(coin(), node('span', null, `${fmt(pack.coins)} coins`));
  const action = node('div', 'item-action pack-prices');
  const data = session.data;

  const rm = data?.rmEnabled && pack.myrSen;
  if (rm) {
    const pay = node('button', 'item-btn', myr(pack.myrSen));
    pay.setAttribute('aria-label', `Buy ${fmt(pack.coins)} coins for ${myr(pack.myrSen)}`);
    pay.onclick = () => buyPackRm(pack);
    action.append(pay);
  }

  const buy = node('button', 'item-btn', pack.stars ? `⭐ ${fmt(pack.stars)}` : 'Soon');
  const why = !pack.stars ? 'Not on sale yet' : starsNote(data);
  buy.disabled = Boolean(why);
  if (why) buy.title = why;
  else {
    buy.setAttribute('aria-label', `Buy ${fmt(pack.coins)} coins for ${fmt(pack.stars)} Stars`);
    buy.onclick = () => buyPack(pack);
  }
  // With ringgit on, an unusable Stars button is noise: leave it out.
  if (!(why && rm)) action.append(buy);
  li.append(amount, action);
  return li;
}

/** The line under the coin packs: how they are paid for. */
function payNote(data) {
  const stars = !starsNote(data);
  if (data?.rmEnabled && stars) return "Pay in ringgit with Touch 'n Go, or with Telegram Stars. Purchases are final; see /terms in the bot.";
  if (data?.rmEnabled) return "Paid in ringgit with Touch 'n Go, on a secure payment page. Purchases are final; see /terms in the bot.";
  return starsNote(data) ?? 'Paid with Telegram Stars. Purchases are final; see /terms in the bot.';
}

/** Why Stars can't be used here, or null when they can. */
function starsNote(data) {
  if (!data?.starsEnabled) return 'Buying coins with Telegram Stars is coming soon.';
  if (!canPayInvoices()) return 'Open the game in Telegram to buy coins with Stars.';
  return null;
}

/* ---------- inventory ---------- */

function sectionHead(text) {
  return node('li', 'inv-head', text);
}

/** The equipped cue lined up on the equipped cue ball, as the table draws them. */
function setupCard(inv) {
  const { cue, ball } = equippedPair(inv);
  const li = node('li', 'store-item inv-setup');
  const pic = node('div', 'inv-setup-pic');
  if (cue) pic.append(preview(cue));
  if (ball) pic.append(preview(ball));
  const names = node('div', 'item-meta');
  names.append(
    node('span', 'tier', 'Your setup'),
    node('span', 'item-name', [cue?.name, ball?.name].filter(Boolean).join(' · ')),
  );
  li.append(pic, names);
  return li;
}

function emptyCard() {
  const li = node('li', 'store-item inv-empty');
  li.append(node('span', 'inv-empty-text', 'No items yet'));
  const go = node('button', 'item-btn buy', 'Visit the store');
  go.onclick = () => selectTab('cue');
  li.append(go);
  return li;
}

function historyRow(entry) {
  const li = node('li', 'inv-tx');
  const what = node('div', 'inv-tx-what');
  what.append(node('span', 'inv-tx-label', historyLabel(entry)), node('span', 'inv-tx-when', formatWhen(entry.at)));
  const amount = node('div', 'inv-tx-amount');
  amount.append(
    node('span', `inv-tx-delta ${entry.delta > 0 ? 'up' : 'down'}`, formatDelta(entry.delta)),
    node('span', 'inv-tx-after', `Balance ${fmt(entry.balanceAfter)}`),
  );
  li.append(what, amount);
  return li;
}

function paintInventory(el) {
  const s = session;
  if (!s.inv) {
    el.list.replaceChildren(node('li', 'store-empty', s.invError ?? 'Loading…'));
    el.note.textContent = '';
    if (!s.invError) loadInventory();
    return;
  }
  const inv = s.inv;
  const owned = ownedByKind(inv.items);
  // Everything owned is equippable here, so itemRow never shows a price.
  const row = (item) => itemRow({ ...item, owned: true, price: 0 });
  const rows = [setupCard(inv)];
  if (inv.boughtCount === 0) rows.push(emptyCard());
  rows.push(sectionHead('Cues'), ...owned.cue.map(row), sectionHead('Cue balls'), ...owned.ball.map(row));

  rows.push(sectionHead('Coin history'));
  const entries = s.hist?.entries ?? [];
  if (!s.hist) rows.push(node('li', 'store-empty', 'Loading…'));
  else if (entries.length === 0) rows.push(node('li', 'store-empty', 'No coin activity yet.'));
  else {
    const box = node('li', 'inv-history');
    const list = node('ul', 'inv-tx-list');
    list.append(...entries.map(historyRow));
    box.append(list);
    if (s.hist.next) {
      const more = node('button', 'item-btn inv-more', s.histBusy ? 'Loading…' : 'Show older');
      more.disabled = s.histBusy;
      more.onclick = loadMoreHistory;
      box.append(more);
    }
    rows.push(box);
  }
  el.list.replaceChildren(...rows);
  el.note.textContent = 'Everything here is yours for good. Your equipped cue and cue ball are what your opponent sees on your turns.';
}

/* ---------- actions ---------- */

function confirmBuy(item) {
  const { hud, data } = session;
  const balance = data.balance;
  if (balance < 0 || balance < item.price) {
    notEnough(item, balance);
    return;
  }
  hud.modal({
    title: `Buy ${item.name}?`,
    body: `<div class="row"><span>Price</span><b>${fmt(item.price)} coins</b></div>
           <div class="row"><span>Balance after</span><b>${fmt(balance - item.price)} coins</b></div>
           <p class="note">Purchases are final. ${esc(item.name)} stays yours for good.</p>`,
    actions: [
      { label: `Buy for ${fmt(item.price)}`, kind: 'primary', onClick: () => buy(item) },
      { label: 'Cancel', onClick: () => hud.closeModal() },
    ],
  });
}

function notEnough(item, balance) {
  const { hud } = session;
  hud.modal({
    title: 'Not enough coins',
    body: balance < 0
      ? `<p>Your balance is ${fmt(balance)} coins after a refund. Buying is paused until it is back above zero.</p>`
      : `<p>${esc(item.name)} costs ${fmt(item.price)} coins. You have ${fmt(balance)}, so you need
         ${fmt(item.price - balance)} more.</p>`,
    actions: [
      { label: 'See coin packs', kind: 'primary', onClick: () => { hud.closeModal(); selectTab('coins'); } },
      { label: 'Close', onClick: () => hud.closeModal() },
    ],
  });
}

async function buy(item) {
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  s.hud.closeModal();
  try {
    const res = await api.buyItem(item.id);
    if (s !== session) return;
    adopt(res.store);
    haptic('success');
    s.hud.modal({
      title: res.status === 'owned' ? 'Already yours' : `${item.name} is yours`,
      body: `<p>Equip it now to use it in your next frame.</p>`,
      actions: [
        { label: 'Equip now', kind: 'primary', onClick: () => { s.hud.closeModal(); equipItem(item); } },
        { label: 'Later', onClick: () => s.hud.closeModal() },
      ],
    });
  } catch (err) {
    if (s !== session) return;
    haptic('error');
    if (err.body?.status === 'insufficient' || err.body?.status === 'negative_balance') {
      // The balance changed since the screen was drawn: redraw, then explain.
      await reload();
      notEnough(item, err.body.balance ?? 0);
    } else {
      s.hud.toast(err.offline ? 'No connection. Nothing was charged.' : err.message, 'foul', 4000);
    }
  } finally {
    s.busy = false;
  }
}

/**
 * Buy a coin pack with Stars. The server makes the invoice and Telegram takes
 * the payment; the coins arrive when the bot tells the server, a moment later.
 * The screen waits for the balance to move rather than trusting 'paid' alone.
 */
async function buyPack(pack) {
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  try {
    const { invoiceLink } = await api.starsInvoice(pack.id);
    if (s !== session) return;
    const before = s.data.balance;
    const status = await openInvoice(invoiceLink);
    if (s !== session) return;
    if (status === 'cancelled') return;
    if (status === 'failed') {
      haptic('error');
      s.hud.toast('The payment did not go through. No Stars were taken.', 'foul', 4000);
      return;
    }
    haptic('success');
    s.hud.toast(status === 'paid' ? 'Paid. Adding your coins…' : 'Payment pending. Your coins will follow.', 'good', 3000);
    await waitForCoins(s, before);
  } catch (err) {
    if (s !== session) return;
    haptic('error');
    s.hud.toast(err.offline ? 'No connection. Nothing was charged.' : err.message, 'foul', 4000);
  } finally {
    s.busy = false;
  }
}

/**
 * Buy a coin pack in ringgit: the server opens a Revenue Monster checkout and
 * the player pays on RM's page in the browser (TNG app on a phone, QR on a
 * computer). RM sends them back to the Mini App (startapp=store_<orderId>), but
 * this screen already follows the order in case they just switch back instead.
 */
async function buyPackRm(pack) {
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  try {
    const { orderId, url } = await api.rmOrder(pack.id, deviceKind());
    if (s !== session) return;
    openExternal(url);
    watchOrder(s, orderId, url);
  } catch (err) {
    if (s !== session) return;
    haptic('error');
    s.hud.toast(err.offline ? 'No connection. Nothing was charged.' : err.message, 'foul', 4000);
  } finally {
    s.busy = false;
  }
}

/** Order states that will not change any more. */
const SETTLED = new Set(['paid', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded', 'disputed']);

/**
 * Show "waiting for payment" and ask the server about the order every few
 * seconds until it settles, the store closes, or ten minutes pass. The sheet
 * can be closed; the watch keeps going under it.
 */
async function watchOrder(s, orderId, url = null) {
  if (s.watching === orderId) return;
  s.watching = orderId;
  let sheetOpen = false;
  const waiting = () => {
    sheetOpen = true;
    s.hud.modal({
      title: 'Waiting for your payment',
      body: `<p>Finish paying on the payment page. Your coins show up here as soon as the payment is confirmed.</p>
             <p class="note">Came back without paying? Nothing is charged; the order simply lapses.</p>`,
      actions: [
        ...(url ? [{ label: 'Open payment page', kind: 'primary', onClick: () => openExternal(url) }] : []),
        { label: 'Close', onClick: () => { sheetOpen = false; s.hud.closeModal(); } },
      ],
    });
  };
  waiting();

  const deadline = Date.now() + 10 * 60_000;
  let order = null;
  while (s === session && s.watching === orderId && Date.now() < deadline) {
    try {
      order = await api.paymentOrder(orderId);
    } catch (err) {
      if (err.status === 404) break;
      // A dropped poll changes nothing: try again.
    }
    if (s !== session) return;
    if (order && SETTLED.has(order.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (s !== session || s.watching !== orderId) return;
  s.watching = null;
  if (sheetOpen) s.hud.closeModal();

  if (order?.status === 'paid') {
    haptic('success');
    await reload();
    s.hud.toast(`+${fmt(order.coins)} coins`, 'good', 3000);
  } else if (order && ['failed', 'cancelled', 'expired'].includes(order.status)) {
    haptic('error');
    s.hud.modal({
      title: 'Payment not completed',
      body: '<p>No coins were added. If money was taken, it is refunded. You can try again any time.</p>',
      actions: [{ label: 'OK', kind: 'primary', onClick: () => s.hud.closeModal() }],
    });
  } else if (order?.status === 'disputed') {
    s.hud.modal({
      title: 'We are checking this payment',
      body: '<p>Something about this payment needs a person to look at it. Use /paysupport in the bot and we will sort it out.</p>',
      actions: [{ label: 'OK', kind: 'primary', onClick: () => s.hud.closeModal() }],
    });
  } else if (order) {
    s.hud.toast('Still waiting for the payment. Your coins will show here once it is confirmed.', '', 5000);
  }
}

/** Reload until the balance goes up (the credit has landed), for up to ~30 s. */
async function waitForCoins(s, before) {
  for (let i = 0; i < 15; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    if (s !== session) return;
    try {
      const data = await api.store();
      if (s !== session) return;
      adopt(data);
      if (data.balance > before) {
        s.hud.toast(`+${fmt(data.balance - before)} coins`, 'good', 2500);
        return;
      }
    } catch {
      // Keep waiting: a dropped poll changes nothing.
    }
  }
  s.hud.toast('Your coins are on their way. They will show here within a few minutes.', '', 5000);
}

async function equipItem(item) {
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  try {
    const res = await api.equipItem(item.kind, item.id);
    if (s !== session) return;
    haptic('light');
    // Only the equipped marks change: redraw from the known store rather than
    // fetching it again.
    const data = {
      ...s.data,
      equipped: res.equipped,
      items: s.data.items.map((i) => ({ ...i, equipped: res.equipped[i.kind] === i.id })),
    };
    const inv = s.inv && {
      ...s.inv,
      equipped: res.equipped,
      items: s.inv.items.map((i) => ({ ...i, equipped: res.equipped[i.kind] === i.id })),
    };
    // Only the equipped marks moved: update both views in place, no re-read.
    s.data = data;
    s.inv = inv;
    s.onChange?.({ balance: data.balance, equipped: data.equipped });
    paint();
    s.hud.toast(`${item.name} equipped`, 'good', 2200);
  } catch (err) {
    if (s !== session) return;
    s.hud.toast(err.offline ? 'No connection. Equip needs one.' : err.message, 'foul', 4000);
    await reload();
  } finally {
    s.busy = false;
  }
}
