# Web coin top-up (Revenue Monster, TNG) — plan

**Status:** BUILT 2026-09-25 against a mocked RM, behind `PAYMENTS_RM_ENABLED` (off in production, so the live
page says "Top-up is not available yet"). Proposals 1–4, 6, 7 approved as written; decision 5 and the Mini App
changes as decided by the user. See "As built" at the end. Pre-launch: a custom domain (see the policy note).
**Scope:** a page at `<game domain>/topup`, opened in an ordinary browser (not the Mini App). The player
logs in with Telegram, picks a coin pack, pays with Touch 'n Go (TNG eWallet app on a phone, TNG QR on a
desktop) through Revenue Monster's hosted checkout, and the coins land on the same account they play with.
**Sandbox only**, behind `PAYMENTS_RM_ENABLED`, exactly like the Mini App's RM path (docs/rm-payments-plan.md).

Everything that touches money is reused unchanged: `createRmOrder`'s order row + checkout,
`handleRmWebhook`, `reconcileRm`, `creditOrderInTrx` (ledger ref `rm:<transactionId>`, UNIQUE), refunds,
the order limits and `payment_events`. The new parts are a login, a narrower session, a few order options,
and a static page.

## Decisions for the user

| # | Question | Proposal |
|---|---|---|
| 1 | Which Telegram login? | **The login widget with the hash check, as asked** (`telegram-widget.js`, `/setdomain`, `secret = SHA256(bot_token)`). Telegram has since moved its main docs to an OpenID Connect login (JWT signed by `oauth.telegram.org`, keys from its JWKS) and archived the widget's page as "legacy" — archived, not marked deprecated, no end date. The check lives in one module (`webLogin.js`), so switching to OIDC later touches that file and the page's button only. **Say if you would rather start on OIDC** (+~0.5 day: JWKS fetch/cache, a BotFather client id and allowed URLs). |
| 2 | Widget mode | **Redirect mode** (`data-auth-url=<game>/topup`): Telegram sends the fields back in the URL, the page posts them to the backend and wipes them from the address bar at once. More robust on phones than the popup/callback mode, which depends on third-party cookies. |
| 3 | Someone logs in who has never opened the bot | **Refuse**: "Open @snookerPlayBot once first, then come back." No account is created from the web. Coins always go to an account that already exists, and a banned account gets 403 as it does today. (The alternative is to create the account; say if you want that.) |
| 4 | Web session | **A separate, narrow token**: JWT with `scope: 'topup'`, 30 min. It works ONLY on the top-up routes; every existing route rejects it (so a leaked web token can't play, concede, link a wallet or claim rewards), and top-up routes reject the Mini App's token. Kept in `localStorage` with its expiry, so coming back from the TNG app in another tab still finds it; expired → log in again. |
| 5 | Payment methods | New `RM_WEB_METHODS`, default `TNG_MY`, comma-separated, each checked as `^[A-Z0-9_]+$` at boot (a typo stops the server, same rule as `COIN_PACKS`). Web orders only; the Mini App's MYR checkout keeps `method: []` unchanged. |
| 6 | Desktop or phone | **The page says which** (`device: 'mobile' \| 'desktop'`, from `pointer: coarse` + UA); the server maps it to `MOBILE_PAYMENT` / `WEB_PAYMENT` and treats anything else as `WEB_PAYMENT`. Safe to take from the client: it only changes how RM shows the checkout, never the price, the coins or the account. |
| 7 | Order limits | **Shared with the Mini App's RM orders** (same provider `rm`): 3 open, 20 a day per player across both. |

## Policy note: linking this page from inside the Mini App

**Recommendation: don't link it from anywhere inside Telegram. No button, no URL, no "top up on the web"
text in the Mini App or in bot messages.**

- Telegram's rule (core.telegram.org/bots/payments-stars): *"your bot or mini app must use Telegram Stars
  for the sale of digital goods and services inside Telegram apps, regardless of any other web portals,
  apps, services or payment providers you may have set up outside the Telegram ecosystem."* Coins that buy
  cues and cue balls are digital goods.
- The rule exists because of Apple's and Google's store rules, and steering users from inside the app to an
  outside payment page is exactly what those rules forbid. A Mini App button that opens `/topup` is steering
  whether or not the payment itself happens outside Telegram. Plausible outcomes range from a warning to
  the bot or Mini App being restricted. That would take PvP and rewards down with it, not just the store.
- **What is probably fine**: the page existing and being promoted outside Telegram (a website, social
  posts); the page's "Back to game" link to `t.me/snookerPlayBot/play` (that goes into Telegram, not out);
  coins bought on the web showing up in the game.
- **Grey areas to decide knowingly:**
  - The bot's existing `coins-added` message fires for web purchases too. It's a receipt, not a link, but
    it names the purchase inside Telegram. Proposal: web orders send it with neutral wording ("+550
    coins, balance 1,500") and no mention of the web page, or you turn it off for web orders.
  - The Mini App's own RM/MYR buttons (built Sep 24, flag off) are already on the wrong side of this rule
    if ever switched on in production. This web page is the compliant home for MYR payments. Those buttons
    should stay sandbox-only for good, or be removed.
- Separately (a note, not code): a payment page on `*.up.railway.app` looks phishy to players. A custom
  domain before launch is worth having, and `/setdomain` must then name it.

This is a reading of Telegram's published rules, not legal advice. Telegram can reject or restrict at its
own discretion.

## 1. Login (`backend/src/services/webLogin.js`, `POST /api/topup/login`)

- Body: the widget's fields as sent (`id, first_name, last_name?, username?, photo_url?, auth_date, hash`).
  Only these keys are allowed; any other key → 400, so nothing extra rides into the signed string.
- `secret = SHA256(BOT_TOKEN)`; `data_check_string` = the received fields except `hash`, sorted, `k=v`
  joined by `\n`; compare `hex(HMAC_SHA256(secret, dcs))` to `hash` with `timingSafeEqual`.
  **Not** the Mini App's `WebAppData` key. A test proves Mini App initData fails here and widget data fails
  there.
- `auth_date` no older than 10 min (the page posts it immediately after the redirect), none in the future.
- Look up the user by telegram id (decision 3). Missing → 404 `open the bot first`; banned → 403.
- Rate limit per IP: 20/min.
- Answer: `{ token, expiresAt, user: { firstName, username }, balance }`.
- Needs **one BotFather step by the user**: `/setdomain` for @snookerPlayBot →
  `game-production-1445.up.railway.app` (one domain per bot).

## 2. Session scope (`auth.js`)

- `issueTopupSession(user)` signs `{ sub, tg, scope: 'topup' }`, 30 min.
- `requireAuth` (every existing route) rejects any token with a `scope`. `requireTopupAuth` accepts only
  `scope: 'topup'`. Tests cover both directions on a sample of existing routes.

## 3. Routes (`backend/src/routes/topup.js`, under `/api/topup`)

Each one answers 404 while `PAYMENTS_RM_ENABLED` is off, as `/webhooks/rm` does.

| Route | Does |
|---|---|
| `GET /api/topup/packs` | public: packs with a MYR price (`id, coins, myrSen`), from `config.store.packs`, so the page shows server prices only |
| `POST /api/topup/login` | section 1 |
| `GET /api/topup/me` | name + balance |
| `POST /api/topup/orders` `{packId, device}` | `createRmOrder(user, packId, { channel: 'web', device })` → `{ orderId, url, coins, myrSen }`; same 10/min per-player limiter and error codes as `/api/payments/rm/orders` |
| `GET /api/topup/orders/:id` | the existing read-only `orderForUser` (never asks RM) |

## 4. Order changes (`services/rm/payments.js`) + migration `20260925_000007_order_channel`

- `payment_orders.channel` (`'miniapp' | 'web'`, not null, default `'miniapp'`, so existing rows read
  right). Recorded for audit and support. Nothing about crediting reads it.
- `createRmOrder(userId, packId, { channel = 'miniapp', device } = {})`:
  - `miniapp`: exactly today's body (`MOBILE_PAYMENT`, `method: []`, Mini App redirect). A test pins that.
  - `web`: `type` from `device`, `method: config.rm.webMethods`,
    `redirectUrl: <RM_WEB_RETURN_URL>?order=<orderId>`.
- New config `RM_WEB_RETURN_URL` (e.g. `https://game-production-1445.up.railway.app/topup/done`), https
  required and added to `rmConfigProblems`, so flag on + missing → the backend refuses to start.
- Crediting, webhook, reconciler, refunds: **no change**. The web order is an ordinary `rm` order. The
  `coins-added` bot message follows the policy decision above.

## 5. The page (`game/topup/index.html` + `game/src/topup/*`)

- A second Vite entry (`build.rollupOptions.input`). Its bundle is tiny: no Matter.js, no game, no
  Telegram WebApp SDK. `serve` already answers `/topup` from `dist/topup/index.html`. The Railway check is to
  confirm it's HTML, not the SPA fallback (by Content-Type, per the Sep 23 gotcha).
- States, one screen each:
  1. **Logged out:** title, the pack list with prices (public), the Telegram button. Nothing is buyable
     until logged in.
  2. **Logged in:** "Hi <name> · balance 950 coins", the packs, "Pay with Touch 'n Go".
     A small print line: coins buy cosmetics only, not refundable as cash, not transferable (the store
     plan's legal boundary).
  3. **Pay:** `POST /orders` → `location.href = url`. Desktop: RM shows the TNG QR. Phone: RM opens the
     TNG app.
  4. **`/topup/done?order=<id>`:** polls `GET /orders/:id` every 2 s for up to 2 min. `paid` → "+550
     coins, new balance 1,500" and **Back to game** → `https://t.me/snookerPlayBot/play`. `failed / expired
     / cancelled` → the reason and "Try again". Still pending after 2 min → "Your payment is being
     confirmed. Coins arrive by themselves, even if you close this page." No token (another browser) →
     log in again, then the same poll. **Whatever RM appends to the return URL is never read** (same rule
     as the Mini App).
- Every server string goes in via `textContent`, never `innerHTML`. Phone widths 320/390 and desktop, the
  game's colours, light theme only (it's a checkout page, not the game).

## 6. Tests (mocked RM, `node --test`, SQLite + Postgres)

`backend/test/topup.test.js`, about 22:
- Login: a good widget hash; a wrong hash, a changed field, an extra field, an old `auth_date`, a future
  one; Mini App initData rejected here and widget data rejected at `/api/auth/telegram`; unknown user 404;
  banned 403.
- Scope: a topup token refused by `/api/me`, `/api/store/buy`, `/api/match/*`, `/api/wallet/*`,
  `/api/rewards/*`; a Mini App token refused by `/api/topup/orders`.
- Orders: desktop → `WEB_PAYMENT`, mobile → `MOBILE_PAYMENT`, junk device → `WEB_PAYMENT`;
  `method: ['TNG_MY']`; redirect is `RM_WEB_RETURN_URL?order=…`; `channel = 'web'`; the price and coins
  come from config whatever the body says; the Mini App body is unchanged (pinned).
- **Money path, end to end on a web order:** a signed webhook credits once; a replay and the reconciler
  afterwards are `duplicate`; a wrong amount → `disputed`, no coins; reconciler-only credit works; a refund
  debits. (Same helpers as `rmPayments.test.js`.)
- Flag off → all five routes 404. Config: flag on without `RM_WEB_RETURN_URL` → boot refuses; a bad
  `RM_WEB_METHODS` entry → boot refuses.
- Mutation checks, as for RM: remove the hash compare, drop the scope check, accept any device string as a
  checkout type. Each must turn a test red.

`game`: `smoke:topup` (Playwright, needs only vite, `/api` stubbed like `smoke:rm`): logged out →
fake widget redirect → logged in → pack → the stubbed checkout url → done page paid / pending / failed →
Back to game link. Screenshots at 320, 390 and desktop.

## 7. Phase 0 additions (need the sandbox account)

Add to the RM checklist:
11. `type: WEB_PAYMENT` with `method: ["TNG_MY"]` shows a TNG QR on desktop; `MOBILE_PAYMENT` opens the TNG
    app on Android and iOS, and comes back to `redirectUrl` in the browser.
12. `TNG_MY` is RM's exact method code, and a one-method list skips RM's method picker.
13. A web order notifies and queries exactly like a Mini App one (checklist items 3–4).
14. The widget works on the Railway domain after `/setdomain`, including a phone browser (Telegram asks
    to confirm in the app).

## 8. Estimate

| Part | Days |
|---|---|
| Login verifier + scoped session + routes | 1.25 |
| `createRmOrder` options, migration, config | 0.5 |
| Page: 4 states, Vite entry, styles at 3 widths | 1.5 |
| Backend tests (~22) + mutation checks, on SQLite and Postgres | 1.0 |
| `smoke:topup` + screenshots | 0.75 |
| Docs, Railway (env, `/setdomain` check), deploy with the flag off | 0.25 |
| **Total** | **≈ 5.25 dev days** (5–6) |

Plus about 0.5 day on phase 0 once RM sandbox credentials arrive. OIDC instead of the hash widget: +0.5.

## As built (2026-09-25)

The user's decisions on top of the proposals:
- **The bot's `coins-added` message is fully neutral**: exactly "Your balance was updated: +100 coins", with no
  payment method, no mention of the web and no link or button (`balanceUpdatedMessage`, bot/src/messages.js).
  The Stars receipt (`coinsAddedMessage`) is unchanged.
- **The Mini App offers Stars only.** Removed: the store's MYR buttons, the "waiting for payment" sheet,
  `startapp=store_<orderId>`, `POST /api/payments/rm/orders`, `GET /api/payments/orders/:id`, `rmEnabled`
  and `myrSen` in `GET /api/store`, `RM_RETURN_APP_URL`, `openExternal`, and `smoke:rm`. An RM purchase in
  the Inventory history reads as a plain "Coin pack" (no "card or e-wallet").
- **Nothing in the Mini App or the bot links to /topup.** `/terms` still says coins are bought with Stars.
- **No `channel` migration** (section 4): with the Mini App path gone, every RM order is a web order.

Code:
- `backend/src/services/webLogin.js`: the widget check (`secret = SHA256(BOT_TOKEN)`), known fields only,
  `auth_date` at most 10 min old (60 s of clock slack ahead).
- `backend/src/auth.js`: `issueTopupSession` (30 min, `scope: 'topup'`); `requireAuth` refuses any scoped token,
  `requireTopupAuth` accepts only `topup`. There is one token check for the whole backend.
- `backend/src/routes/topup.js`: `/api/topup/{packs,login,me,orders,orders/:id}`, all 404 while RM is off.
  Login limit 60/min per IP (loose because of carrier CGNAT), orders 10/min per player.
- `services/rm/payments.js`: `createRmOrder(userId, packId, { device })`; `checkoutType` ('mobile' →
  MOBILE_PAYMENT, anything else → WEB_PAYMENT); `method` = `RM_WEB_METHODS` (default `TNG_MY`);
  `redirectUrl` = `RM_WEB_RETURN_URL?order=<id>`. Both new settings are checked by `rmConfigProblems`.
- Page: `game/topup/index.html` + `game/src/topup/{page,logic}.js` + `topup.css`, a second Vite entry
  (about 7 KB JS). The bot username comes from `VITE_BOT_USERNAME` (default `snookerPlayBot`).
- **Serving:** the game now starts with `serve dist` (no `-s`) plus `game/public/serve.json`. `serve -s` puts its
  `**` catch-all before serve.json and serve-handler chains rewrites, so `/topup` became `/index.html` (the
  game, "missing initData"). The catch-all is now `/!(topup)` + `/!(topup)/**` → `/index.html`, after the two
  top-up rules. Railway's start command is `npm start -w @snooker/game`, so the package script is what runs.

Tests: `backend/test/topup.test.js` (18) and `backend/test/rmPayments.test.js` (26, now through the web login
and routes), on SQLite and Postgres; five mutants caught (no hash compare, no scope check, any device → app,
unknown user let in, no age limit). `game/test/topup.test.js` (7). `npm run smoke:topup -w @snooker/game`:
34 checks plus screenshots `game/test/topup-*.png`.

**User actions:** `/setdomain` in @BotFather for @snookerPlayBot → `game-production-1445.up.railway.app`
(needed before the login button works on Railway). Before switching RM on: set `RM_WEB_RETURN_URL`
(`https://<game domain>/topup/done`) on the backend, plus the RM checklist items 11–14 above.
