# Architecture

Forklings is one Cloudflare Worker. Each player's state lives in their own SQLite-backed Durable Object. D1 holds only what crosses players: the handle directory, leaderboard, API tokens, OAuth grants and battle analytics. No global tick runs: needs and growth are worked out from timestamps when someone looks.

```
browser / PWA ──┐                     ┌─ PlayerDO (one per player, SQLite)
Claude Code ────┼─ Worker ────────────┤    creature, needs, inventory, tactics,
MCP clients ────┘  /api /auth /mcp    │    script, battle log, replays
                   static assets      ├─ BattleDO (short-lived, one per battle)
                   cron */20          │    runs the simulation, writes results
                                      └─ D1  players · battles · battle_sides ·
                                             battle_moves · api_tokens
```

## Code layout

| Path | What it does |
| --- | --- |
| `src/shared/` | Pure, deterministic game logic, used by the Worker, the browser and the tests |
| `src/shared/rng.ts` | SHA-256 seeding and the `mulberry` PRNG |
| `src/shared/genome.ts` | Seed → genome: palette, body parts, type, rarity, name, base stats |
| `src/shared/compose.ts` | Genome + pose → 32×32 pixels, plus wardrobe items and the egg |
| `src/shared/state.ts` | Lazy needs, XP and evolution, and care actions |
| `src/shared/strategy.ts` | The strategy AST and its fuel-limited interpreter |
| `src/shared/script.ts` | Tokeniser and parser for strategy scripts |
| `src/shared/battle.ts` | The battle simulation, held-item effects and per-turn summaries |
| `src/shared/economy.ts` | Bits: prices, level locks, rewards, the classics and NPC shopping |
| `src/shared/shopgen.ts`, `distinct.ts` | The nightly item generator and the distinctness test it applies |
| `src/shared/verdict.ts` | One reason a battle was won or lost, for the result card |
| `src/shared/npcs.ts`, `bots.ts` | The house NPC roster and the fallback bots |
| `src/worker/` | HTTP routing, auth, the two Durable Objects, the MCP server and the cron |
| `src/client/` | The web app: canvas renderer, scenes (sign-in meadow, room, hatch, battle, evolution) and UI |
| `scripts/icon-art.ts` | The hand-drawn pixel maps behind the favicons, app icons and brand mark (`bun scripts/icons.ts`) |
| `plugins/forklings/` | The Claude Code plugin, published by `.claude-plugin/marketplace.json` |

## Hatching

`seed = sha256(handle | hatch time to the second | HATCH_SALT)`. The salt is a Worker secret and is never logged or sent to clients. The seed is stored with the creature, so any hatch can be replayed for testing. Clients get the seed so they can draw the creature themselves. Knowing a seed reveals nothing about the next one.

## Lazy state

`advance(state, now)` in `src/shared/state.ts` steps needs forward from the last saved time in capped steps, applying drift, napping and passive XP. `PlayerDO` calls it on every read and write. An idle player costs nothing.

## Battles

A battle is `simulate(seed, snapshotA, snapshotB)`. Snapshots carry stats, gear and strategy. The same inputs always give the same turns, so a replay is just the seed and two snapshots. The browser re-runs it for the animation.

1. The Worker picks an opponent from D1: a ranked player near your rating, an NPC or a house bot. A player's first three battles are gentler (`src/shared/matchmaking.ts`): first a tutorial bot at your XP that guards on turn 2, then only NPCs at your level or lower, or a bot at your XP.
2. A fresh `BattleDO` takes snapshots from both `PlayerDO`s, simulates, applies XP, loot and ratings to each side, and writes one `battles` row, two `battle_sides` rows and one `battle_moves` row per move used.
3. `sim_version` is stored with each battle, so the analytics stay comparable when the rules change.

**Ranked play** needs a GitHub account at least 30 days old (`gh_created_at`, captured at sign-in). Both sides must be eligible for a ranked match. NPCs count as eligible, so the ladder has opponents from day one. Newer accounts fight NPCs and bots without a rating, and the leaderboard lists them separately as the practice bracket. It lists NPCs apart from players too, and pins the viewer's own place at the top (`me` in `/api/leaderboard`, from `src/worker/leaderboard.ts`).

**Held items** are the only gear that affects battles: one slot, at most +6% to one stat. Head, face, neck and body items are cosmetic. Generated items carry their definition in the snapshot, so a replay draws them and applies their effect exactly as on the day.

## Bits and the shop

Each `PlayerDO` keeps its bits in an append-only ledger in its own SQLite. Every entry has a unique key, so a retried battle, care action or purchase pays or charges once. A purchase debits and grants the item in one transaction. D1 gets a copy of each entry in `bits_events` for analytics. Shop items are generated nightly from the day and a secret salt: by the `5 0 * * *` cron, or by the first shop request if the cron hasn't run. They are stored in `shop_items` and `shop_days`. The numbers, the generator and its measured cost are in [economy.md](economy.md).

### Balancing queries

```sql
-- Win rate by held item, players only
SELECT held, AVG(won) AS win_rate, COUNT(*) AS n
FROM battle_sides WHERE won IS NOT NULL AND bot = 0 AND npc = 0 GROUP BY held;

-- Damage per use by move
SELECT move, SUM(dmg) * 1.0 / SUM(uses) AS dmg_per_use, SUM(crits) * 1.0 / SUM(hits) AS crit_rate
FROM battle_moves GROUP BY move ORDER BY dmg_per_use DESC;

-- Fighting style against outcome
SELECT style, strategy_source, AVG(won) AS win_rate, COUNT(*) AS n
FROM battle_sides WHERE won IS NOT NULL GROUP BY style, strategy_source;
```

## Strategy

Coaching tactics and [strategy scripts](strategy-scripts.md) both compile to the same `Strategy`: a style plus an ordered list of `when <condition>: <action>` rules. `decide()` walks the rules with a fuel budget of 256 steps per decision. Nothing is ever evaluated as JavaScript. Scripts are parsed and validated by `PlayerDO.setScript` before they're saved, and battles run on the stored AST.

## NPCs

`src/shared/npcs.ts` lists 14 house players (`npc-` handles, flagged `npc = 1`). They are real players: hatched with the normal seed recipe, stored in their own `PlayerDO`s, and fighting through the normal battle path. Every 20 minutes the cron cares for them, acknowledges evolutions and runs a few of their battles. Set `NPCS` to `off` to hide them from matchmaking and the leaderboard. `scripts/npcs-remove.sql` deletes them from D1 entirely. Analytics can exclude them with `npc = 0`.

## Auth

- **GitHub OAuth** is the only way to sign in, and it's for identity only: the scope is empty, and the game reads only the user's id, login and account creation date. The access token is used once and never stored. `src/worker/github.ts` maps every way the round trip can fail (cancelled, expired, refused, GitHub unreachable, no OAuth app) to a reason code; the Worker sends the player back to `/?signin=<reason>` and the sign-in page shows a friendly message.
- **Sessions** are HMAC-signed cookies (`SESSION_SECRET`) and only ever name a GitHub player (`gh:<id>`). Anything else fails closed: the cookie is cleared and the page says the session ended.
- **OAuth for MCP clients** (`src/worker/oauth.ts`): Forklings is an OAuth 2.1 authorization server for `/mcp`, built on `@cloudflare/workers-oauth-provider`. Clients discover it from the `401` (RFC 9728 protected resource metadata, RFC 8414 server metadata), identify themselves with a Client ID Metadata Document or Dynamic Client Registration (capped per IP by the free Workers Rate Limiting binding, `src/worker/ratelimit.ts`), and sign in with PKCE (S256 only) and a resource indicator. `/authorize` is our own page: sign in with the existing GitHub session, then a consent page naming the app (its verified domain, or *unverified* for a self-registered name), where the access goes (a loopback address is called out as *your computer*), the Forkling and each scope. Consent is remembered for 30 days per app and player, for the same or fewer scopes. Access tokens last 8 hours; refresh tokens rotate and lapse after 30 days unused. The API tab lists connected apps and revokes them.
- **Scopes** (`src/worker/scopes.ts`): `pet:read` (always granted), `pet:care`, `strategy:read`, `strategy:write` (implies `strategy:read`), `battle:read`, `battle:spar` and `battle:simulate` (reserved; no tool yet). Each MCP tool needs one; `tools/list` hides the rest, and calling one returns `403 insufficient_scope` with the scopes to ask for.
- **OAuth storage**: the library stores clients, grants and tokens through a KV interface. `src/worker/d1kv.ts` implements that interface on the D1 table `oauth_kv`, so there's no KV namespace: D1 writes are a fifth of KV's price, and revocation is immediate because D1 is consistent. Secrets are stored as hashes and grant props are encrypted by the library. The hourly cron deletes expired rows.
- **API tokens** (`fk_…`) are stored only as SHA-256 hashes, capped at 5 per player and revocable from the API tab. They're for headless use (scripts, CI and the status line): they authorise the JSON API and `/mcp` with every scope, and only work for GitHub players. OAuth access tokens are accepted only on `/mcp`.
- **Retired demo accounts.** Forklings once had an unverified demo sign-in. It's gone: `/auth/demo` returns 404, and old `demo:` sessions, API tokens and MCP grants are refused. Their D1 rows (`verified = 0`, `npc = 0`) stay so past battles and analytics keep both sides, but they're hidden from the leaderboard and never matched. The old `demo_signups` table is no longer written to.

## MCP

`/mcp` implements Streamable HTTP in its stateless JSON-response form: `initialize`, `ping`, `tools/list` and `tools/call` on POST; GET returns 405; a missing or bad token returns 401 with the OAuth discovery challenge. Its tools are `get_forkling` (with an optional PNG portrait), `care_for_forkling`, `get_strategy`, `set_strategy`, `list_battles` and `practice_battle`.

## Costs

Every request runs on the Workers plan the account already has. D1 rows are small, and reads stay within the included quota at hobby scale. An idle player does no work at all. The cron does a bounded amount of NPC work every 20 minutes. A connected MCP client costs about three D1 row writes per 8 hours of use: a refresh writes its grant and a new access token, and the cron later deletes the expired one. The paid plan includes 50 million row writes a month. Making a night's shop items takes about 10 ms of CPU in a warm isolate and 50–70 ms in a cold one, and stays about flat as the catalogue grows. That needs the Workers Paid plan's CPU allowance, not the Free plan's 10 ms (see [economy.md](economy.md#capacity-and-cpu)).
