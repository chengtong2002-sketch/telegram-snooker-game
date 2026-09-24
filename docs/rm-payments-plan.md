# Revenue Monster payments (sandbox) — plan

**Status:** decisions 1–4 taken by the user 2026-09-23 (below); decision 5 (sandbox account) still open.
**Built 2026-09-24: phases 1–4, against a fake RM.** Phase 0 (a real sandbox account) is the only thing left,
and it must tick every box in "Phase 0 checklist" at the end before the flag is switched on anywhere.
**Scope:** buy coin packs with MYR through Revenue Monster's hosted web checkout, **sandbox only**,
behind `PAYMENTS_RM_ENABLED` (default off everywhere). Telegram Stars stays in the design as the
second provider behind the same order and ledger tables.

There are no coins in the codebase yet. This plan introduces `coin_ledger` and `payment_orders`, which
the store slice (buy/equip) then builds on.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | SDK or REST? | **REST** with `node:crypto` + `fetch` (decided by the user). `rm-api-sdk` 1.0.13 pins `axios ^0.18.0` (known CVEs) and has no webhook verification. |
| 2 | A refund after the coins are spent | **Ledger debit anyway; the balance may go negative, and purchases are blocked until it is positive again** (decided by the user). Items already bought stay owned. |
| 3 | Coin packs | **Placeholders (decided by the user): 100 coins RM 4.90, 550 RM 19.90, 1,200 RM 39.90.** Stars prices TBD. Packs, coin amounts and both prices live in server config (env/JSON), never hardcoded and never sent by the client. A pack with no price for a provider is simply not offered through it. |
| 4 | Return from checkout | **Straight into the Mini App store** (decided by the user): `https://t.me/snookerPlayBot/play?startapp=store_<orderId>`. Needs a Mini App with short name `play` created in BotFather (`/newapp`). The game maps `start_param` `store_<orderId>` to the store screen showing that order. |
| 5 | RM sandbox merchant account? | **Open.** Needed for phase 0: client id/secret, store id, our key pair uploaded, and RM's server public key. |

**Token expiry:** the brief says 2 h; RM's client-credentials doc says `expiresIn` ≈ 2,591,999 s (30 days).
The cache honours whatever `expiresIn` the response carries and refreshes at 80% of it (or 10 min before,
whichever is earlier), so both readings work.

## Policy flags (not code)

- **Telegram requires Stars for digital goods sold inside a Mini App.** Coins for cosmetics are digital
  goods. The RM path is therefore sandbox-only by construction (section 1); going live with it needs a
  separate decision, possibly limited to outside-Telegram web or physical goods. Stars shares every table
  here, so switching is a provider flag, not a rewrite.
- **The legal boundary still holds:** coins buy cosmetics only. They never buy PvP entry, never affect
  eligibility or the token reward budget, can't be transferred or cashed out. A test asserts that nothing
  in `rewards.js` / `matchService.js` reads `coin_ledger`.

## 1. Config and the flag

- `PAYMENTS_RM_ENABLED` (default `false`). Off → every RM route (API, return page, webhook) answers 404
  and the store UI hides the MYR option.
- **Hosts are hardcoded to `sb-oauth.revenuemonster.my` / `sb-open.revenuemonster.my`.** There is no env
  var to point at production; going live is a code change and a review.
- Secrets from env only: `RM_CLIENT_ID`, `RM_CLIENT_SECRET`, `RM_PRIVATE_KEY` (PEM, ours),
  `RM_SERVER_PUBLIC_KEY` (PEM, RM's), `RM_STORE_ID`, `PUBLIC_BACKEND_URL` (for notify/return URLs).
  Flag on + any missing → the backend refuses to start (same fail-closed rule as 0b0550d). Keys are
  never logged; PEMs accept `\n`-escaped single-line values for Railway.

## 2. RM client (`backend/src/services/rm/client.js`)

- **Token:** `POST /v1/token`, `Basic base64(clientId:clientSecret)`, `{grantType:"client_credentials"}`.
  In-memory cache, single-flight (N concurrent callers → one token request), refresh early as above,
  one retry with a fresh token on 401. The refresh token is not needed: client credentials can
  always be re-requested.
- **Signing every request** (RM signature algorithm): body JSON with keys sorted recursively, compact,
  `<` `>` `&` escaped as `\u003c` `\u003e` `\u0026`, base64 →
  `data=…&method=post&nonceStr=…&requestUrl=…&signType=sha256&timestamp=…`, RSA-SHA256 with our
  private key → headers `X-Signature: sha256 <sig>`, `X-Nonce-Str` (random, 32 chars), `X-Timestamp`.
- Calls used: create hosted checkout `POST /v3/payment/online`, query `GET /v3/payment/transaction/order/{id}`,
  refund `POST /v3/payment/refund`. 15 s timeout each; `fetch` is injected so tests mock it.

## 3. Data (one migration)

- **`payment_orders`**: `id` (ours, ≤ 24 chars, RM's `order.id` limit: `snk` + 20 random base32),
  `user_id`, `provider` (`rm` | `stars`), `pack_id`, `coins`, `amount` (integer minor units: sen, or Stars),
  `currency` (`MYR` | `XTR`), `status` (`created` `pending` `paid` `failed` `cancelled` `expired`
  `refunded` `partially_refunded` `disputed`), `provider_checkout_id`, `provider_txn_id` **UNIQUE**,
  `refunded_amount`, `failure_reason`, `created_at`, `expires_at`, `paid_at`, `last_checked_at`.
- **`coin_ledger`**, append-only: `id`, `user_id`, `delta` (int, signed), `reason` (`purchase`
  `refund` `spend` `grant`), `ref` (e.g. `rm:<txnId>`, `rm-refund:<txnId>:<n>`, `stars:<chargeId>`),
  `created_at`. **UNIQUE(`ref`)** is what makes crediting exactly-once, even with two webhooks racing on
  Postgres. Balance = `SUM(delta)`.
- **`payment_events`**, the audit log, never updated or deleted: `at`, `order_id` (nullable for forged
  or unknown), `source` (`api` `webhook` `return` `reconcile` `admin`), `event`, `signature_ok`,
  `payload` (JSON, with secrets and headers removed), `outcome`. Written in the same transaction as the
  change it records; a rejected webhook still gets a row, written outside any rolled-back transaction.

## 4. Flow

1. **Create:** `POST /api/payments/rm/orders {packId}` (signed-in user). Pack, price and coins come from
   server config. Limits: 3 open orders per user, 20 a day. Row `created` → RM checkout (`type:
   WEB_PAYMENT`, `layoutVersion: v4`, `redirectUrl` = `/pay/rm/return`, `notifyUrl` = `/webhooks/rm`,
   `order.additionalData` = our order id) → store `checkoutId`, status `pending`, return `{orderId, url}`.
   An RM error leaves the order `failed` with the reason; no coins either way.
2. **Pay:** the Mini App calls `Telegram.WebApp.openLink(url)` (external browser; RM's page does not
   belong inside the webview), then shows "Waiting for payment…" and polls `GET /api/payments/orders/:id`.
3. **Return:** `GET /pay/rm/return?status&orderId`. **The query string is never trusted**: it only
   triggers a server-side query of that order (below). A small HTML page says "Coins added" /
   "Payment not completed" and opens the Mini App store on that order (decision 4). The bot also sends "N coins added".
4. **Webhook** `POST /webhooks/rm` (mounted with `express.raw`, 64 KB, before the global JSON parser):
   1. Verify `X-Signature` over the re-sorted body with `RM_SERVER_PUBLIC_KEY`, using `X-Nonce-Str`
      and `X-Timestamp` (callbacks omit `requestUrl`). Bad or missing → 401, audit row, nothing else.
   2. Find the order by `data.order.id`. Unknown → 200 (so RM stops retrying), audit, owner alert.
   3. Check `data.status === SUCCESS`, `order.amount === our amount`, `currencyType === our currency`.
      A mismatch → order `disputed`, **no credit**, audit, owner alert.
   4. Credit in one transaction: lock the order row, insert the ledger row (`ref = rm:<transactionId>`),
      order → `paid`. A unique violation = already credited → 200 `duplicate`.
   5. A DB failure → 500, so RM retries; everything else answers 200.
   A SUCCESS for an order we had already marked `expired` is still credited: the money was taken.
5. **Reconciler** (runs on the existing sweeper tick). **RM only notifies on success**; failure,
   cancellation, expiry and refunds send nothing. So:
   - `pending` orders older than 2 min → query by order id. SUCCESS → the same credit function as the
     webhook (same ledger `ref`, so a webhook arriving later is a no-op). FAILED / CANCELLED / EXPIRED /
     REVERSED → that status. Nothing after the checkout lifetime (confirmed in phase 0) → `expired`.
   - `paid` orders from the last 30 days → re-queried once a day. FULL_REFUNDED / PARTIAL_REFUNDED →
     ledger debit for the newly refunded share (`ref = rm-refund:<txnId>:<refunded total>`), order
     `refunded` / `partially_refunded`. This catches refunds done in RM's portal.
6. **Refund we start:** backend script `npm run refund -w @snooker/backend -- <orderId> --reason "…"`
   (owner only, no HTTP route) → RM refund API → the same debit path, audited as `admin`.

The client never credits itself: no endpoint takes a coin amount, and `coin_ledger` is written only by
the credit/debit functions in `services/coins.js`.

## 5. Stars (designed now, built with the store)

Same `payment_orders` (`provider: stars`, `currency: XTR`) and the same `creditOrder()`. The bot sends
`createInvoiceLink` with our order id as the payload; `pre_checkout_query` → the backend confirms the
order is still open and the price matches; `successful_payment` → bot forwards to
`/internal/payments/stars` → credit with `ref = stars:<telegram_payment_charge_id>`. Refunds through
`refundStarPayment`, same debit path.

## 6. Tests (mocked RM, `node --test`, SQLite and Postgres)

- **Signing:** our request signature verifies with the matching public key; the canonical JSON sorts nested
  keys and escapes `<>&`; golden vector checked against the sandbox in phase 0.
- **Token:** 10 concurrent calls → 1 token request; refreshed before expiry; a 401 retries once.
- **Forged webhook:** wrong key, tampered body, tampered amount, missing or garbled headers,
  signature from a different nonce → 401, no ledger row, one audit row each.
- **Duplicate webhook:** replayed 5×, and two racing (Postgres) → exactly one ledger row; webhook then
  reconciler and reconciler then webhook → one row.
- **Amount / currency mismatch:** → `disputed`, no credit, owner alert sent.
- **Unknown order, other user's order, non-SUCCESS status in a signed webhook** → no credit.
- **Failed / cancelled / expired / reversed** via the reconciler; return-page parameters claiming
  SUCCESS for an unpaid order change nothing.
- **Refunds:** full and partial debits once each; a re-query doesn't debit twice; a refund after spending
  follows decision 2.
- **Flag off:** every RM route 404s; the backend starts without RM secrets. Flag on without them →
  refuses to start. No production RM host appears anywhere in the source.
- **Boundary:** rewards and matches never read coins.

## 7. Phases

| Phase | Scope | Days |
|---|---|---|
| 0 | Sandbox account + keys; sign one request by hand; confirm webhook signing, retry behaviour, checkout lifetime | 0.5 |
| 1 | Config + flag, RM client (token, signing, 3 calls), unit tests | 1 |
| 2 | Migration (orders, ledger, events), `coins.js` credit/debit, webhook, return page | 1.5 |
| 3 | Reconciler, refund script, bot "coins added" message, owner alerts | 1 |
| 4 | Mini App: pack picker, openLink, waiting state; smoke with RM mocked | 1 |
| | **Total** | **about 5 days** |

The store slice (buy/equip with coins, Stars) targets Oct 10. This work adds about 5 days on top of it.
Either the RM work goes after the store, or the store is built on these tables first (phases 1–2 above
minus the RM client), with RM added once the store works.

## As built (2026-09-24)

Code: `backend/src/services/rm/client.js` (REST, signing, token), `backend/src/services/rm/payments.js`
(orders, webhook, reconciler, refunds), `backend/src/routes/rmPublic.js` (`/webhooks/rm`),
`POST /api/payments/rm/orders`, `GET /api/payments/orders/:id`, `npm run refund:rm -w @snooker/backend`,
the bot's `coins-added` notify, and the store's MYR buttons (`game/src/store.js`). Tests:
`backend/test/rmPayments.test.js` (26, SQLite and Postgres) and `npm run smoke:rm -w @snooker/game`
(14 checks, needs only vite).

The rules, as set by the user on 2026-09-24 (they replace sections 4.3–4.5 above where they differ):

- **Checkout:** `POST /v3/payment/online`, `type: MOBILE_PAYMENT`, `layoutVersion: v4`, amount in cents
  (sen), `order.id` = `rm` + 22 hex (24 characters), body sorted and signed per RM's Signature Algorithm.
- **`redirectUrl` = `https://t.me/snookerPlayBot/play?startapp=store_<orderId>`**: RM sends the player
  straight back into the Mini App's store, which follows the order. Any status RM adds to that trip is
  display-only; nothing reads it. There is no backend return page.
- **`notifyUrl` = `PUBLIC_BACKEND_URL/webhooks/rm`.**
- **Coins are credited only by RM itself, two ways**: the verified webhook (RM's signature must verify),
  or the reconciler's own signed server-to-server query to RM's API (decided by the user later on
  2026-09-24, so a lost webhook doesn't leave a paid player without coins). Either way the status must be
  SUCCESS and the amount, currency and order id must be the order's; otherwise the order is `disputed`
  and no coins move. Both go through one function with one idempotency key, RM's transaction id (ledger
  ref `rm:<transactionId>`, UNIQUE): whichever comes second is a no-op. A late payment for an order we
  had expired still credits: the money was taken.
- **The reconciler** also closes failed/cancelled/expired orders and takes refunds back. It never reads
  the redirect or anything the client says.
- **The Mini App's poll is read-only**: it reads our order row and never asks RM.
- **`PAYMENTS_RM_ENABLED` stays false in production.**

Other details:

- **Callback signatures are accepted with or without requestUrl** in the signed text (RM's docs say it
  "can be" left out). Either form is RM's key over our exact body, nonce and time.
- **Owner alerts are `logger.error` lines** ("rm payment needs a person", "order we do not have"). No other
  alert channel exists yet.
- **Reconciler every 60 s** (its own interval): open orders older than 2 min, expired orders from the
  last day every 30 min, paid orders from the last 30 days once a day.
- **REVERSED** counts as a full refund. **Partial refunds** take back ceil(coins × refunded ÷ price), each
  new refunded total debiting only the difference (ref `rm-refund:<txn>:<total>`).
- A payment refunded before we ever credited it adds and takes nothing (order `refunded`).

## Phase 0 checklist (needs the sandbox account)

Each of these is an assumption in the code, taken from RM's docs, its PHP plugin or its JS SDK where
they disagree. Check each one on the sandbox and fix the code if it is wrong:

1. `X-Timestamp` is UNIX **seconds** (docs and the PHP plugin; the JS SDK sends milliseconds).
2. Our request signature is accepted: create one checkout by hand with `client.js`.
3. A real webhook verifies, and whether its signed text includes `requestUrl`. Its body carries
   `data.status`, `data.transactionId`, `data.order.{id,amount}` and `currencyType` (in `data` or
   `data.order`): the credit reads exactly these. Whether a MOBILE_PAYMENT checkout notifies the same way.
4. Query by order id: `GET /v3/payment/transaction/order/{id}` answers `item.status`, `item.transactionId`,
   `item.order.{id,amount}` and `currencyType` (top level or in `order`); and what it answers before anyone
   pays (the code treats HTTP 404 or a `*NOT_FOUND` code as "no payment").
5. After a **partial** refund, which field holds the refunded amount (`refundedAmount`? `balanceAmount`?).
   Until confirmed, an unreadable partial refund is logged as `refund_unknown` and debits nothing.
6. The status words: SUCCESS, FAILED, CANCELLED, EXPIRED, IN_PROCESS, FULL_REFUNDED, PARTIAL_REFUNDED, REVERSED.
7. The checkout's lifetime (the order expires on our side after 60 min + 10 min grace).
8. RM accepts a `t.me` link as `redirectUrl`, and what it appends to it (`&orderId=…&status=…`?) still
   opens the Mini App with `startapp=store_<orderId>` intact.
9. The refund body: `{transactionId, refund: {type: FULL|PARTIAL, currencyType: MYR, amount}, reason}`.
10. RM's PHP signer also escapes `'`; ours does not, so no field we send may hold an apostrophe (a test checks it).
