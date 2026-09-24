# Telegram Snooker — Mini App with PvP crypto rewards

A full-size snooker game that runs inside Telegram. Play the AI for practice, or
play a real opponent turn by turn; the highest break you make in a PvP match is
worth a share of a capped daily token pool on TON.

```
bot/        grammY bot — the front door: /start /wallet /practice /play /leaderboard
game/       Mini App front-end — canvas table, Matter.js physics, offline queue
backend/    Express — the authority: re-simulates every PvP shot, scores it, pays out
token/      TON Blueprint/SDK tooling — deploy the Jetton, settle redemptions
shared/sim  Snooker physics + rules, imported unchanged by both client and server
shared/db   Knex schema and accessors — SQLite now, Postgres by changing one variable
```

## Why it is built this way

**The server re-plays every PvP shot.** The client sends only what the player
*did* — an angle and a power — never what happened. The backend runs the same
deterministic simulation and its result is the one that counts. A modified client
can send a weird shot, but it cannot send a weird outcome.

**Practice can never pay.** It is not a UI flag. Practice never creates a match
row, and `eligible_breaks` only accepts rows from matches marked
`crypto_eligible`, which only PvP matches ever are. A client claiming a 147 in
practice is recorded as analytics and touches nothing else. There is a test for
exactly that.

**The reward pool cannot be overspent.** `rate = budget ÷ total eligible points
in the period`. More players earning points makes each point worth less; the
budget is fixed. Redemption only opens once a period has closed, so the rate a
player is quoted is the rate they get.

**Nothing is staked.** Players never pay to enter and never lose money. This is
a skill game with a capped prize, deliberately not a wagering product — see
*Legal boundary* below.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env          # then fill it in — see the comments in that file
npm run migrate               # creates ./data/snooker.sqlite
npm test                      # 200 tests: physics, foul rules, rewards, API, wallet proofs
```

### Run it locally

```bash
npm run dev                   # backend :8080, bot (long polling), game :5173
```

The three services can also be run separately with `npm run dev:backend`,
`npm run dev:bot`, `npm run dev:game`.

To play in a browser without Telegram, set `ALLOW_DEV_AUTH=true` and open
<http://localhost:5173?mode=practice>. That switch must be off in production —
it lets anyone log in as anyone.

To test inside Telegram you need an HTTPS URL for the Mini App, because Telegram
will not open `http://`. Expose the Vite dev server with a tunnel:

```bash
cloudflared tunnel --url http://localhost:5173      # or: ngrok http 5173
```

Then set `GAME_URL` to the HTTPS URL it prints, point `VITE_BACKEND_URL` at your
backend, and restart the bot.

### Register the Mini App

1. In [@BotFather](https://t.me/BotFather): `/newbot`, then copy the token into
   `BOT_TOKEN`.
2. `/newapp` → pick the bot → set the Web App URL to your `GAME_URL`.
3. `/setcommands` is handled automatically — the bot registers its own command
   list on boot.

## Build order and where things stand

The project was built in this order, and each stage is working:

1. **Bot skeleton** — all five commands plus `/status`, `/cancel`, `/help`.
2. **Physics and UI, practice first** — Matter.js, full 22-ball table, AI opponent.
3. **Backend, fouls and scoring** — server-side resolution for every PvP shot.
4. **PvP matchmaking** — FIFO open queue, async turns, "your turn" push.
5. **Jetton + wallet** — SNKR deployed on testnet; TON Connect linking with verified proofs.
6. **Offline sync** — IndexedDB + CloudStorage queue, dedupe by result ID.
7. **Integration testing** — 200 automated tests across the stack (202 on Postgres).

Still to do before a demo: deploy the three services to Railway, play a real
two-device match end to end, and drive one reward the whole way on testnet — a
real match, then a claim, then `npm run payout -w @snooker/token -- --send`.
Minting itself has been exercised on testnet from a seeded redemption.

## The game

Full snooker, not a reduced set: 15 reds (1 each), yellow 2, green 3, brown 4,
blue 5, pink 6, black 7, plus the cue ball — 22 balls. That exact configuration
is what makes a 147 possible, which is the ceiling on a reward-eligible break.

Best of 3 frames, with the break alternating as in real snooker: the player who
broke frame 1 breaks frame 3, the other player frame 2, whoever wins. 30-second
shot clock (`SHOT_CLOCK_MS` in shared/sim, the one value the game, server and bot
all use), enforced on the server: if you close the
app mid-turn, a sweeper applies the miss penalty and passes the turn, so nobody
can stall a match forever.

### Fouls

Any foul ends the break and passes the turn. There is no free-ball rule in this
version.

| Foul | Penalty |
|---|---|
| Miss — the cue ball hits nothing | 4 to the opponent |
| Wrong ball first | Value of the ball on or the ball hit, whichever is higher, minimum 4 |
| Cue ball potted | 4, cue ball back in hand |
| Ball off the table | 4, ball respotted |

Two details follow the real rules rather than the table above, because the table
does not cover them: a red potted illegally stays down (there is no red spot),
and if a frame finishes level the black is respotted and the next score or foul
settles it.

With the ball in hand the cue ball goes anywhere in the D that does not touch
another ball. A shot that names no placement plays from where the cue ball was
parked in the D, and only if that spot is clear; otherwise the server refuses it
without using up the turn.

## Rewards

Each finished PvP match contributes exactly one eligible break: the highest
break made in that match, by whoever made it, capped at 147. Those accumulate
over a period (daily by default, `REWARD_PERIOD_KIND=weekly` to change it).

When the period closes:

```
rate            = REWARD_BUDGET_TOKENS ÷ total eligible points that period
your payout     = your points × rate,  capped at REWARD_MAX_SHARE of the budget
```

A player redeems once per period, needs a linked wallet, and needs at least
`REWARD_MIN_POINTS` in that period.

When a period closes its rate and total are stored, and every claim for it is
paid at that stored rate, however late. A result is counted in the period
containing the server's time when it is recorded (a match straddling midnight
counts where it finishes); a result that would land in a period whose rate is
already stored goes to the next period instead. Rewards stay claimable for
`REWARD_CLAIM_WINDOW_DAYS` (default **30**) after their period closes, and one
claim covers every claimable period. If a wallet-change cooldown is still running
at a deadline, the deadline moves to a day after the cooldown ends. Rewards not
claimed in time expire and are never minted; nothing rolls over.

Two daily limits cap how fast rewards can be farmed. A player can be awarded
at most **15** reward-eligible matches per UTC day, and at most **3** between
the same two players. Both reset at 00:00 UTC and are checked when a match
result is recorded, not at matchmaking: a player over a limit keeps playing
normally, their matches just earn nothing, and the bot tells them why. After
the payout wallet changes (including a first link) the bot messages the player
and claims wait **24 hours**. Telegram sign-in data is accepted for one hour.
`REWARD_LIMIT_EXEMPT_TELEGRAM_IDS` lists test accounts that skip the two limits
and the cooldown — keep it empty outside testnet. Redemptions queue in the database; an operator settles them
on-chain by running `npm run payout -w @snooker/token`, which does a dry run
unless passed `--send`. Paying out is deliberately a human-run step, not
something an HTTP request can trigger.

A mint that may have gone out is never retried automatically. If confirmation
times out or the send errors, the payout script reads the treasury account back
to see whether a transaction actually appeared after the send. If one did, the
redemption settles with that transaction hash; if not, it is marked
`unconfirmed` and `--send` refuses to run until someone checks the recipient on
the explorer and resolves it with `-- --mark-sent <id> [tx hash]` (it landed) or
`-- --requeue <id>` (it did not). That lookup can only move a row towards
`sent`, never back to `pending`, so it can cost a manual check but never a
double payment. Rows are claimed atomically, so two overlapping runs cannot pay
the same one, and a period whose committed tokens exceed its budget is not paid.

A settled redemption records the real transaction hash, which is what the
explorer takes: `https://testnet.tonviewer.com/transaction/<hash>`. The SDK
hands nothing back from a send, so the hash comes from reading the account
afterwards and picking the `external-in` the treasury signed.

## Token

Standard TEP-74 Jetton via the no-code path — the reference minter contract from
`@ton-community/assets-sdk`, not a bespoke emission contract. Mint authority is
retained by the treasury wallet, and payouts mint to the winner. Total emission
per period is bounded by the budget the backend enforces.

```bash
# testnet funds first: @testgiver_ton_bot on Telegram
npm run deploy -w @snooker/token     # prints JETTON_MASTER_ADDRESS — put it in .env
npm run info   -w @snooker/token     # supply, admin, stored metadata, treasury balances
npm run info   -w @snooker/token -- <address>        # ...plus that address's balance
npm run mint   -w @snooker/token -- <address> 10     # smoke test: mint new tokens
npm run transfer -w @snooker/token -- <address> 10   # smoke test: move tokens the treasury holds
npm run payout -w @snooker/token     # dry run; add -- --send to settle
```

The testnet master is `kQBqi-yDDeYSILq9fL4nlt_SZg5OnNsfDwZgKSl3sMyUHWkV` (SNKR, 9
decimals, on-chain metadata), admin = the W5 treasury
`0QDzWYEn1r4XzSHoAqLqQJSSWJCApmqRZyKH3CDT5_gxSvvQ`.

The payout script reads the same redemption queue the backend writes, so it needs:

| Variable | Why |
|---|---|
| `DATABASE_URL` | the backend's database (Postgres on Railway; `PGSSL=disable` for a local Postgres) |
| `TON_NETWORK` | `testnet` or `mainnet`; only redemptions recorded for that network are paid |
| `TON_WALLET_MNEMONIC` | the treasury, which is the Jetton admin; only this script holds it |
| `TON_WALLET_VERSION` | `v5r1` (default) or `v4`, matching the wallet app. Same words, different address |
| `JETTON_MASTER_ADDRESS` | the master to mint from |
| `JETTON_DECIMALS` | converts redemption amounts to contract units; must match the deploy (9) |

The backend itself never signs or reads the chain: it only needs `TON_NETWORK` and
`JETTON_MASTER_ADDRESS` to show players where their tokens live. Keep the mnemonic
off the backend and bot services.

Every script that can spend refuses to run against mainnet unless
`I_UNDERSTAND_THIS_IS_MAINNET=yes` is set. Do the whole flow on testnet first.

TON's native coin was renamed from Toncoin to **Gram (GRAM)** in June 2026; the
chain is still TON. Older tutorials will still say Toncoin.

## Offline behaviour

Shots are written to IndexedDB (mirrored into Telegram CloudStorage) with a
client-generated result ID *before* they are sent. If the network drops, the
queue retries on reconnect, on tab focus, and on a slow timer. The backend
dedupes on that result ID, so replaying a queue after a flaky connection cannot
apply a shot twice — it returns the original outcome instead.

## Deployment (Railway)

Three services, all built from the repo root. **Do not set a per-service Root
Directory** — this is an npm workspaces monorepo, and pointing a service at
`backend/` cuts it off from the root `package.json` and from `shared/sim` and
`shared/db`, so the build fails. Instead give each service its own config file:

| Service | Config-as-code path | Listens on |
|---|---|---|
| backend | `backend/railway.json` | `$PORT`, health `/api/health` |
| bot | `bot/railway.json` | `$PORT`, health `/health` |
| game | `game/railway.json` | `$PORT`, static `game/dist` |

In each service: Settings → Config-as-code → set the path above. Root Directory
stays `/`.

All three bind Railway's injected `$PORT`. The bot binds it too (its notification
listener), so its health check passes; `BOT_PORT` overrides only for local dev,
where the backend already holds `PORT`.

### Order of setup

The URLs are circular — the bot needs the game's URL, the game needs the
backend's, and the backend needs the bot's — so do it in two passes.

1. **Create the project and add Postgres.** Railway injects `DATABASE_URL`; the
   same migrations run unchanged. The backend runs them on boot.
2. **Create all three services** from this repo, set the config paths above, and
   let the first deploys fail or come up half-configured. What you want from
   this pass is the three generated domains.
3. **Set the shared variables** on *both* backend and bot — they must match, or
   the bot cannot call the backend and no "your turn" message is ever delivered:

   ```
   DATABASE_URL     (reference the Postgres service)
   INTERNAL_API_KEY (same string on both)
   BOT_TOKEN        (same token on both — the backend verifies initData with it)
   TON_NETWORK=testnet
   ```

4. **Backend only:**
   ```
   NODE_ENV=production
   JWT_SECRET=<32 random bytes, hex>
   ALLOWED_ORIGINS=https://<game-domain>
   BOT_NOTIFY_URL=http://<bot-service>.railway.internal:<port>/internal/notify
   ALLOW_DEV_AUTH=false
   REWARD_PERIOD_KIND=daily
   REWARD_BUDGET_TOKENS=1000
   TONCONNECT_ALLOWED_DOMAINS=<game-domain>
   ```
   The backend refuses to boot when deployed — `NODE_ENV=production` **or** any
   Railway environment variable present, so forgetting `NODE_ENV` does not skip
   it — if `BOT_TOKEN` is unset, `JWT_SECRET` or `INTERNAL_API_KEY` is a default,
   an `.env.example` placeholder or too short, `ALLOWED_ORIGINS` is `*`,
   `ALLOW_DEV_AUTH` is on, or `TONCONNECT_ALLOWED_DOMAINS` is empty. The bot
   applies the same `INTERNAL_API_KEY` rule. That check is deliberate: never
   paste a local `.env` into Railway.

5. **Bot only:**
   ```
   GAME_URL=https://<game-domain>
   BACKEND_URL=https://<backend-domain>
   ```

6. **Game only — set these BEFORE its build**, because Vite inlines them into
   the bundle. Changing them later needs a redeploy, not a restart:
   ```
   VITE_BACKEND_URL=https://<backend-domain>
   VITE_TONCONNECT_MANIFEST_URL=https://<game-domain>/tonconnect-manifest.json
   ```
   Also edit `game/public/tonconnect-manifest.json` and commit it — the `url`
   and `iconUrl` in it must be the real game domain or wallet linking is
   rejected.

7. **Redeploy the game** so the build picks up the Vite variables, then point
   @BotFather's Mini App URL at the game domain.

### Notes

- SQLite is fine for a demo but assumes one machine with a persistent volume.
  Add Postgres before the bot and backend run as separate services, which on
  Railway they always do.
- The bot uses long polling by default, which needs no public URL. To switch to
  webhooks set `BOT_WEBHOOK_URL=https://<bot-domain>/telegram/<INTERNAL_API_KEY>`.
- `ALLOW_DEV_AUTH` must be false in production. It lets anyone log in as anyone.

## Tests

```bash
npm test                              # everything
npm test -w @snooker/sim              # physics determinism, foul table, frame flow
npm test -w @snooker/backend          # rewards maths, PvP API, ton_proof verification
npm test -w @snooker/token            # settlement: no double-send, no overspend
npm run smoke:game                    # drives a practice frame in a real browser
npm run smoke:concede -w @snooker/game   # both PvP concede paths, two players at once
npm run smoke:offline -w @snooker/game   # the offline story; practice makes no requests
npm run smoke:rm -w @snooker/game        # card payments (RM) in the store; needs only vite
npm run smoke:aim -w @snooker/game       # live aim: two browsers, plus the practice AI lining up
```

The smokes are separate because they each need the backend and vite running plus
an installed Chrome. `smoke:game` opens the Mini App, places the cue ball, plays
several shots against the AI, and fails on any console error, uncaught exception
or failed request — the class of bug unit tests cannot see because it only
appears when the renderer, controls and game loop run together.

`smoke:concede` drives two browsers at once through the between-frame checkpoint
and the mid-frame Concede button; it writes match state directly, so point it and
the backend at a throwaway `DATABASE_URL`, never the dev database.
`smoke:offline` drops and restores the connection around the lobby and a
practice frame, counting every `/api` request so a practice frame that quietly
phones home fails the run.
`smoke:rm` is the exception: it answers every `/api` call itself, so it needs only
vite. It drives the store side of a Revenue Monster payment (open the checkout,
wait, get the coins; come back from RM's page into the store) and the price
buttons at 320 wide. The backend side is `backend/test/rmPayments.test.js`.
`smoke:aim` pairs two fresh dev players through the API and checks that the
waiting player's drawn cue follows the shooter's (angle, power, ball in hand),
freezes and dims when updates stall, and that the practice AI's cue stops exactly
on the shot it plays. A PvP table holds its aim stream open, so drivers must not
wait for `networkidle` on a PvP page; it never comes.

The unit suite covers the things that would actually cost money if they broke:
the budget can't be overspent, a player can't exceed their share cap, a
redemption can't be claimed twice, practice can't earn, a replayed shot can't
count twice, and a wallet proof can't be forged to redirect a payout.

## Known limits

- **Physics is MVP-tuned, not simulation-grade.** No spin, no swerve, no throw.
  Matter.js has no continuous collision detection, so the timestep and maximum
  shot speed are chosen together to keep balls from tunnelling — see the comment
  block in `shared/sim/src/constants.js` before changing either.
- **Matchmaking is a plain FIFO queue.** No rating, no rematch, no friend
  challenge — the pool is too small for those to help yet.
- **Best of 3 only.** Best of 5 and ranked play are deliberate fast-follows.

### Live aim (PvP)

While one player aims, the other sees the cue, aim line and power move. The
shooter posts `{angle, power, cue?}` to `POST /api/match/:id/aim` (on change,
at most ~10 a second, plus a 1 s heartbeat); the opponent holds
`GET /api/match/:id/aim-stream` open — server-sent events read with `fetch`, so
the Bearer header travels as usual. The backend relays to the other seat only,
stores nothing and never lets it near the sim: the shot still goes through
`/shot`. Aim from the player who is not on is ignored; each match relays at most
15 a second, each player may post 20 a second and hold 3 streams, and both routes
skip the app-wide 240/min limit. After a shot, concede or continue the stream
also carries `moved`, so the waiting table polls at once.

**The relay is in memory: the backend must run as ONE instance.** With replicas,
two players on different instances would not see each other's aim (moving it to
Postgres LISTEN/NOTIFY would fix that).

## Legal boundary

This is a skill-based game with a capped prize, not a wagering product. Players
never pay to enter and a losing player never loses money. Do not add
pay-per-attempt or RNG-driven payout mechanics — that reclassifies the product
as gambling under Malaysia's Common Gaming Houses Act, and the team is
Malaysia-based.

Marketing the token as an investment rather than an in-game reward carries
separate securities-law exposure. Keep the framing on "earned in play".
