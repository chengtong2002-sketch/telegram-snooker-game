# Creator Studio — plan

**Status:** approved 2026-09-23. **Post-demo phase — not started.** It depends on the store
(coins, `store_items`, Stars payments) landing first, and the catalog-to-DB step is shared with
store phase 1. Earliest start: after the Oct 16 demo and the two-device playtest.

Curators upload cue and cue-ball designs (SVG) from the Mini App, preview them on the table,
and submit them. The owner approves or rejects from the bot and sets a price. Approved designs
appear in the store without a redeploy.

## Decisions

| # | Decision | Status |
|---|---|---|
| 1 | Cleaned SVG text is stored **in Postgres** (`cosmetic_items.svg`) and served by the backend at an immutable, content-hashed URL. No object storage for now; revisit only for large raster art. | Decided by the user |
| 2 | Uploads with scripts, event handlers, external refs, `foreignObject`, `<image>`, `<use>`, SMIL, CSS/`style` or a DOCTYPE are **rejected with reasons, never stripped**. Only benign editor clutter (comments, `metadata`, inkscape/sodipodi namespaces) is dropped silently. | Decided by the user |
| 3 | The owner is granted only by a CLI script (`grant-owner`). `/addcurator` can only ever create curators; no Telegram path creates an owner. | Approved with the plan |
| 4 | Removing a curator auto-rejects their pending items ("curator removed"); their approved items stay in the store. | Approved with the plan |
| 5 | Removing an item from the store stops it being sold. Players who already own it keep it and can still equip it. | Approved with the plan |
| 6 | Approved items can't be edited. A fix is a new submission, so a purchase never changes after the fact. | Approved with the plan |
| 7 | Uploading requires "I made this / hold the rights". Creators earn nothing: coins can't be transferred, so a revenue share is ruled out. | Approved with the plan |

## 1. Roles

- Table `user_roles`: `telegram_id` (so a curator can be added before first sign-in), `user_id` (nullable,
  filled on first sign-in), `role` (`owner` | `curator`), `granted_by`, `granted_at`, `revoked_at`.
  No active row = player.
- `requireRole('curator' | 'owner')` reads the DB **on every request**, not the session token, so a
  removal takes effect on the next request. The session still comes only from verified initData.
- Bot `/addcurator <telegram_id>` and `/removecurator <telegram_id>`: the bot forwards the *sender's*
  Telegram id to `/internal/roles/*`, and the backend decides. A non-owner gets the generic
  "unknown command" reply, so the commands can't be discovered. Ids are checked as numeric.
  Adding an owner or yourself is refused. A new curator gets a message with a link to the Studio.

## 2. The catalog moves into the database (shared with store phase 1)

Table `cosmetic_items`: `id` (slug), `kind` (`cue` | `cue_ball`), `name`, `creator_user_id`,
`status` (`draft` | `pending` | `approved` | `rejected` | `removed`), `price_coins` (null until approved),
`svg` (cleaned text only; the original upload is never stored), `svg_sha256`, `bytes`, `report` (json),
`rights_confirmed_at`, `submitted_at`, `reviewed_by`, `reviewed_at`, `reject_reason`, `removed_at`.

- A migration seeds the current 10 designs from `shared/cosmetics/` as `approved`, owned by the owner.
- `cosmetics.json` stops being the source of truth. `GET /api/store` lists approved items from the DB.
  SVGs are served from `GET /api/cosmetics/:id/:sha.svg`: long immutable cache,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`.
  `skinLoader.js` fetches from there instead of bundling.

## 3. Upload checking (`backend/src/services/svgSafety.js`)

- Parsed with a real XML parser (`@xmldom/xmldom`), never regexes. A DOCTYPE or entity is refused
  **before** parsing, which closes off XXE and entity bombs.
- **Allowed elements:** `svg defs g path polygon polyline line rect circle ellipse linearGradient radialGradient stop clipPath`.
- **Allowed attributes:** geometry, `fill`, `stroke*`, `opacity`, `transform`, gradient and stop attributes, `id`,
  and `clip-path`/`fill`/`stroke` pointing only at `url(#local-id)` inside the same file. Refused: every `on*`,
  every `href`/`xlink:href`, `style`, and any `data:`, `javascript:` or `http(s):` value.
- Anything outside the allowlist is **rejected with a precise reason** (element, attribute, line), per decision 2.
- The stored file is **rebuilt from the checked tree**; no original bytes survive.
- **Limits:** at most 32 KB, at most 400 elements, depth at most 8, numbers finite and within the viewBox.
  20 uploads a day per curator.
- **Shape rules:**
  - **Cue:** viewBox `0 0 1000 36`, the taper `clipPath`, and every element understood by `parseCueSvg`,
    so the preview is exactly what the game draws. We publish a template SVG and a one-page spec.
  - **Cue ball:** viewBox `0 0 100 100`, the ball a circle of radius 48 at the centre.
- **Cue-ball brightness rule, on rendered pixels** (server-side raster via `@resvg/resvg-wasm`; WASM to avoid a
  native build, per 7e257a3): at least 60% of the ball near white; average colour at least 4.5:1 against the
  cloth; nearest ball colour is the cue ball's. The same rule as `game/test/skins.test.js`, but it also catches
  art where a big dark decoration covers the ball.

## 4. API

- `POST /api/studio/validate {kind, svg}` → `{cleanSvg, report}`. Nothing is saved; the Studio preview uses `cleanSvg`.
- `POST /api/studio/items {kind, name, svg, rightsConfirmed}` → draft (re-validated on the server).
- `POST /api/studio/items/:id/submit` → `pending`, and the owner is notified through the bot.
- `GET /api/studio/items` → your items and their status (the owner sees all).
- `DELETE /api/studio/items/:id` → withdraw a draft or pending item.
- Internal, owner only (the bot calls them): `review/approve {itemId, price}`, `review/reject {itemId, reason}`,
  `items/:id/remove`, `roles/grant`, `roles/revoke`.

## 5. Owner review in the bot

- On submit, the backend renders a preview PNG (the item on a patch of cloth, beside a stock ball or cue for scale)
  and sends it through the existing `/internal/notify` path. The bot posts it to the owner with the name, creator
  and size, and **Approve** / **Reject** buttons (`cr:a:<id>`, well under Telegram's 64-byte limit).
- **Approve** → price buttons (300 / 600 / 900 / 1,500, or Custom → reply with a number). Only then does it go live.
  A pending Custom question is saved in `review_prompts` in the DB, so it survives a redeploy.
- **Reject** → reason buttons (breaks spec / quality / duplicate / other, plus optional text). The curator is told the reason.
- Every button press is re-checked on the backend (sender is owner, item still `pending`). A double tap or two
  owners racing gets "already approved".

## 6. Audit log

Table `cosmetic_audit`, never edited or deleted: `at`, `actor_user_id`, `actor_role`, `action`
(`upload` `submit` `approve` `reject` `remove` `withdraw` `role_grant` `role_revoke` `price_set`),
`item_id`, `details` json. Written in the same transaction as the change it records.
The owner can view it with `/audit [n]` in the bot, plus a backend script for a full export.

## 7. UI (phone-first)

- Entry: a "Creator Studio" row in Settings, shown only when `/api/auth/me` returns a curator or owner role
  (the server enforces access anyway).
- **Studio home:** "My designs" with each item's status (draft / pending / approved with its price / rejected
  with the reason), plus **New cue** / **New cue ball**.
- **Upload:** file picker (`accept=".svg"`), with paste-as-text as a fallback for webviews where the picker is
  unreliable; name; the rights tick box; links to the template and spec.
- **Preview:** the **cleaned** SVG on a mini table using the real renderer, with the cue laid across the cloth
  and the ball among other balls, and report messages alongside. Submit is disabled until the checks pass.
- After submitting: "Sent for review", and the bot tells the curator when the owner decides.

## 8. Tests

- **Upload safety:** a corpus of known attacks (script, `onload`, `href`/`xlink:href` to http, `javascript:`,
  `data:`, `<use>` pointing outside the file, `<style>` with `@import`/`url()`, `foreignObject`, `<image>`,
  `animate`/`set` rewriting a link, DOCTYPE and entity bombs, oversize, deep nesting), each refused with the
  right reason. A randomised test checks every cleaned file re-parses and contains only allowed elements and attributes.
- **Shape rules:** the 10 current designs pass; broken cue and ball files are each refused; a ball covered by
  a dark design fails the brightness rule.
- **Roles:** a player can't reach Studio endpoints; a curator can't approve, reject or remove; a removed curator
  is locked out on the next request; the bot can't create an owner; non-owner `/addcurator` gets the generic reply.
- **Review:** approve and reject are idempotent; two racing approvals produce exactly one; a price is required
  before an item goes live; button presses from non-owners are refused.
- **Catalog:** an approved item appears in `GET /api/store` with no redeploy; approved SVGs can't be changed;
  a removed item can't be bought but its owners keep it.
- **Audit:** exactly one row per action, in the same transaction; a failed action writes none.
- The sim guard stays green; `smoke:studio` covers upload → preview → submit with the bot stubbed.

## 9. Phases

| Phase | Scope | Days |
|---|---|---|
| 0 | Check that `resvg-wasm` renders and fits in memory on Railway's Nixpacks image | 0.5 |
| 1 | Roles, audit log, `grant-owner` script, `/addcurator` / `/removecurator` | 1.5 |
| 2 | Catalog into the DB, SVG serving, loader fetches from the API, seed the 10 | 1.5 |
| 3 | Upload checking, shape rules, pixel brightness, preview images, attack-corpus tests | 2.5 |
| 4 | Studio UI: upload, preview, submit, my designs | 2 |
| 5 | Bot review: photo, buttons, price, reject reasons, curator notices | 1.5 |
| 6 | Remove from store, `/audit`, `smoke:studio`, docs | 1 |
| | **Total** | **about 10.5 days** |
