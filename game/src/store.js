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
import { showBackButton, haptic } from './telegram.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString('en');
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
 * @param {'cue'|'ball'|'coins'} [opts.tab]
 * @param {(change: {balance: number, equipped?: object}) => void} [opts.onChange]
 *        after every server answer, so the lobby chip and the drawn skins follow
 * @param {() => void} [opts.onClose]
 */
export async function openStore({ hud, tab = 'cue', onChange, onClose } = {}) {
  const el = elements();
  session = { hud, tab, data: null, busy: false, onChange, onClose };
  session.hideBack = showBackButton(closeStore);
  el.back.onclick = closeStore;
  for (const button of el.tabs) button.onclick = () => selectTab(button.dataset.tab);

  el.root.hidden = false;
  el.root.scrollTop = 0;
  paint();
  await reload();
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
  session.data = data;
  session.error = null;
  session.onChange?.({ balance: data.balance, equipped: data.equipped });
  paint();
}

function selectTab(tab) {
  if (!session) return;
  session.tab = tab;
  elements().list.scrollTop = 0;
  paint();
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

  if (tab === 'coins') {
    el.list.replaceChildren(...data.packs.map(packRow));
    el.note.textContent = 'Coins buy cues and cue balls, and nothing else: they never affect matches or rewards. '
      + 'Buying coins with Telegram Stars arrives in the next update.';
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

function packRow(pack) {
  const li = node('li', 'store-item item-pack');
  const amount = node('div', 'pack-amount');
  amount.append(coin(), node('span', null, `${fmt(pack.coins)} coins`));
  const action = node('div', 'item-action');
  const buy = node('button', 'item-btn', pack.stars ? `⭐ ${fmt(pack.stars)}` : 'Soon');
  buy.disabled = true;
  buy.title = 'Coming in the next update';
  action.append(buy);
  li.append(amount, action);
  return li;
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
    adopt(data);
    s.hud.toast(`${item.name} equipped`, 'good', 2200);
  } catch (err) {
    if (s !== session) return;
    s.hud.toast(err.offline ? 'No connection. Equip needs one.' : err.message, 'foul', 4000);
    await reload();
  } finally {
    s.busy = false;
  }
}
