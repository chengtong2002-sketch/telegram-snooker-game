# Store — plan

**Status:** approved by the user 2026-09-23, with decision 4 changed (below). Target **Oct 10**. Phase 1 in progress.
**Scope:** coins, buying coin packs with **Telegram Stars**, buying and equipping cues and cue balls.
Revenue Monster comes after, on the same tables (`docs/rm-payments-plan.md`).

## Decisions (approved)

| # | Decision | Approved |
|---|---|---|
| 1 | Item prices, in coins, by tier | Starter **free** (owned by everyone), Classic **250**, Rare **500**, Epic **1,000**. With the packs (100 / 550 / 1,200) the 550 pack buys one Rare, and the 1,200 pack buys one Epic. Prices live in `cosmetics.json` (`price`, currently `null`), read by the server. The client never sends a price. |
| 2 | Stars price per pack | **100 / 400 / 800 ⭐**, in server config next to the MYR prices, so it changes without a code change. Roughly in line with the MYR prices; tune once real Stars pricing is checked. |
| 3 | How coins are earned | **Only by buying them, or an owner grant** (audited CLI script, for the demo and support). Never from matches, so coins and the token rewards never touch. |
| 4 | Whose skins show | **Skins follow the shooter** (changed by the user). On a player's turn both players see *that player's* equipped cue **and** cue ball; nothing owned → Club Ash / Club White. The cue-ball skin swaps only at turn start, once every ball is at rest, never mid-shot. Practice vs AI uses the player's own skins throughout. Each seat's equipped ids travel in the match state as cosmetic ids only; nothing reaches physics or scoring, and the sim guard stays green. |
| 5 | Where "equipped" is stored | **On the server** (`users.equipped_cue`, `users.equipped_ball`, null = the default), and copied to localStorage so practice offline still draws it. |
| 6 | Are purchases final? | **Yes.** An item is owned for good; there is no item refund. A Stars refund takes the coins back through the ledger, and a negative balance blocks buying until it is positive again (same rule as RM, decision 2). |
| 7 | Offline | Store button and coin chip **disabled offline**, like Rewards; the chip shows the last known balance. Equip needs the server too. |
| 8 | Buy confirmation | **One in-page confirm step** ("Buy Crimson Crown for 500 coins?"). No Telegram popup. |
| 9 | Telegram's payment rules | Add **`/paysupport`** and **`/terms`** to the bot. Telegram requires them for Stars. Short HTML texts in `messages.js`. |
| 10 | Demo without real Stars | Telegram's **test environment** supports Stars, or the owner grants coins with the script. Default: the grant script for the demo, and Stars proven once on the test environment. |

## Data (one migration; the coin and order tables match the RM plan)

- `coin_ledger` (append-only, `UNIQUE(ref)`): purchase `stars:<chargeId>`, spend `buy:<userId>:<itemId>`,
  refund `stars-refund:<chargeId>`, grant `grant:<id>`. Balance = `SUM(delta)`.
- `payment_orders` and `payment_events`: exactly as in the RM plan, with `provider = 'stars'`, `currency = 'XTR'`.
- `user_items`: `user_id`, `item_id`, `acquired_at`, `ledger_id`, `UNIQUE(user_id, item_id)`.
- `users.equipped_cue`, `users.equipped_ball`: nullable item ids.

## API

- `GET /api/store` → items (with price, owned, equipped), balance, and the packs on offer.
- `POST /api/store/buy {itemId}` → one transaction: lock the user, check balance ≥ price and balance ≥ 0,
  not already owned → spend row + `user_items` row. A double tap gets "already owned", never a second charge.
- `POST /api/store/equip {kind, itemId}` → owned or default only.
- `POST /api/payments/stars/invoice {packId}` → order row + `createInvoiceLink` (Bot API, `currency: XTR`,
  payload = our order id). The Mini App opens it with `Telegram.WebApp.openInvoice`, so the player never
  leaves Telegram.
- Bot: `pre_checkout_query` → backend `/internal/payments/stars/check` (order open, price matches; answer
  within Telegram's 10 s) → `successful_payment` → `/internal/payments/stars/paid` → credit once on
  `telegram_payment_charge_id`. Refund: owner script → `refundStarPayment` → ledger debit.

## Lobby (as specified by the user)

- **Coin chip** in the card header, right of the name. Tap it to open the store. Offline, the Offline chip
  takes its place. A negative balance shows in amber.
- **Bottom row: Store | Rewards | How to play | ⚙.** The gear stays a fixed 46px square; the other three share
  the rest. Store is **outlined in gold, not filled**: PLAY stays the only filled button. The gold is the
  cue rings' `#d4ad52`, not the amber `--warn` (#e2b23c), so it never reads as a warning.
- Below ~340px wide the Store and Rewards icons drop and only the labels stay, so four buttons fit at 320px.

Phone width (390px):

```
┌──────────────────────────────────────┐
│             ● SNOOKER                │
│ ┌──────────────────────────────────┐ │
│ │ (NI)  Nicholas          ╭──────╮ │ │
│ │       Ready to play     │◉ 550 │ │ │  ← coin chip, taps to store
│ │                         ╰──────╯ │ │
│ │ ┌────────┐ ┌────────┐ ┌────────┐ │ │
│ │ │ 1,284  │ │ 37/52  │ │   64   │ │ │
│ │ │ POINTS │ │  WON   │ │ BREAK  │ │ │
│ │ └────────┘ └────────┘ └────────┘ │ │
│ │ 11 matches left today            │ │
│ │ ██████████████████░░░░░░░░       │ │
│ │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │ │
│ │ ┃            PLAY              ┃ │ │  ← only filled button
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │          Practice            │ │ │
│ │ └──────────────────────────────┘ │ │
│ │ ╔═══════╗┌───────┐┌────────┐┌──┐ │ │
│ │ ║◇ Store║│◉ Rew. ││How to  ││⚙ │ │ │  ← Store: gold outline
│ │ ╚═══════╝└───────┘│ play   │└──┘ │ │
│ │                   └────────┘     │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

**Store screen** (a full-screen sheet like Rewards, with the Telegram back button):

```
┌──────────────────────────────────────┐
│ ‹ Store                    ◉ 550     │
│ [ Cues ] [ Cue balls ] [ Coins ]     │
│ ┌──────────────────────────────────┐ │
│ │ ══════════════▰▰▰▰  Club Ash     │ │
│ │ STARTER                 Equipped │ │
│ ├──────────────────────────────────┤ │
│ │ ══════════════▰▰▰▰  Crimson Crown│ │
│ │ RARE                   ◉ 500 Buy │ │
│ ├──────────────────────────────────┤ │
│ │ ══════════════▰▰▰▰  Ebony Points │ │
│ │ CLASSIC                    Equip │ │  ← owned
│ └──────────────────────────────────┘ │
│ Coins tab: 100 ◉ 100⭐ · 550 ◉ 400⭐    │
│            1,200 ◉ 800⭐              │
└──────────────────────────────────────┘
```

Previews are the real SVGs, drawn side-on for cues and as the ball image for cue balls.

## Tests

Buy is exactly once (double tap, two racing requests on Postgres); an insufficient or negative balance is
refused; you can't equip an item you don't own; a Stars payment credits once (a repeated `successful_payment`
and a replayed internal call both give one row); a price mismatch at `pre_checkout_query` is refused; a refund
debits once; a player can't reach grant or refund; rewards and matches never read coins; the lobby fits at
320 / 360 / 390 wide and 844×390 with no overflow (screenshots); `smoke:store` covers buy → equip → the cue
changes in practice, with Stars stubbed.

## Phases

| Phase | Scope | Days |
|---|---|---|
| 1 | Migration, `coins.js` (credit, debit, spend), catalog prices, grant script | 1 |
| 2 | Store API (list, buy, equip) and the loader reading the equipped items | 1 |
| 3 | Stars: invoice, pre-checkout, paid, refund script, `/paysupport`, `/terms` | 1.5 |
| 4 | Lobby chip + Store button, store screen, `smoke:store`, screenshots | 1.5 |
| | **Total** | **about 5 days** (Oct 10 has room for it) |
