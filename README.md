<p align="center"><img src="docs/assets/banner.png" alt="Forklings" width="100%"></p>

<p align="center"><b>A tiny pixel pet for developers. Hatch one, look after it, coach it, and let it battle while you code.</b><br>
<a href="https://forklings.dev">Play at forklings.dev</a> · <a href="docs/claude-code.md">Play from Claude Code</a> · <a href="docs/strategy-scripts.md">Strategy scripts</a> · <a href="docs/architecture.md">Architecture</a></p>

<p align="center"><img src="docs/assets/lineup.gif" alt="Seven Forklings idling, blinking and swaying" width="100%"></p>

Every Forkling is a 32×32 creature built from code: no hand-drawn sprites and no image model. The art above comes straight from the game's generator (`bun scripts/art.ts`).

## How it works

- **Hatch.** Your egg's seed is a hash of your handle, the second you pressed Hatch and a server-side salt. The same seed always gives the same creature, but nobody can aim for a rare one.
- **Look after it.** Fullness, mood and energy drift over time, even while you're away. Feed, play, pat and nap to keep it happy. Care and battles earn XP, and it evolves from Sprout to Junior to Prime.
- **Dress it up.** Hats, glasses and scarves are cosmetic. One held item gives a small battle edge, capped at +6% to one stat.
- **Coach it.** Set tactics with a few sliders, or write a [strategy script](docs/strategy-scripts.md) such as `when hp < 40 and ready heal: heal`.
- **Battle.** Fights are automatic and deterministic. Each one is a seed plus two snapshots, so every replay is exact. A ladder of clearly marked NPCs plays around the clock.
- **Ranked play** is for GitHub accounts at least 30 days old. Demo players and newer accounts battle NPCs and house bots without a rating. GitHub is used only for identity: the game never reads your repositories or activity.

| Home | Battle | Phone |
| --- | --- | --- |
| <img src="docs/assets/screens/desktop-home.png" alt="Home screen with a Forkling in its room, needs and wardrobe"> | <img src="docs/assets/screens/desktop-battle.png" alt="An auto-battle against an NPC"> | <img src="docs/assets/screens/phone-home.png" alt="Home screen on a phone" width="200"> |

## Play from your terminal

Forklings has an MCP server at `https://forklings.dev/mcp` and a Claude Code plugin:

```text
/plugin marketplace add tvdavies/forklings
/plugin install forklings@forklings
/mcp                         # pick forklings, Authenticate, sign in with GitHub
/forklings:forkling feed
```

There's no token to paste: your tool signs in through the browser with OAuth, and you choose what it may do. Connected tools are listed, and can be disconnected, on the site's **API** tab. [docs/claude-code.md](docs/claude-code.md) covers Codex, Pi, other MCP clients, personal tokens for scripts and the status line.

## Quick start

You need Node 22+ and [Bun](https://bun.sh).

```sh
npm install
npm run typecheck && npm run lint && npm test
npm run dev            # wrangler dev on http://localhost:8787
```

For local development, put the secrets in `.dev.vars`, which git ignores:

```sh
HATCH_SALT=<any long random string>
SESSION_SECRET=<another long random string>
PUBLIC_ORIGIN=http://localhost:8787
```

Apply the D1 migrations to the local database with `npx wrangler d1 migrations apply forklings-db --local`.

Run `bun scripts/art.ts` to regenerate the README art, and `bun test/e2e/run.ts` to check a deployed copy in a real browser. `bun test/e2e/oauth.ts http://localhost:8787` checks MCP sign-in end to end against a local `npm run dev`: discovery, registration, consent, PKCE, scopes, refresh and revocation, using the MCP TypeScript SDK as the client. It signs up a demo player, and with `CHROMIUM` set it screenshots the consent page.

## Deploy your own

It runs on one Cloudflare Worker with SQLite-backed Durable Objects and one D1 database.

```sh
npx wrangler d1 create forklings-db         # put the new database_id in wrangler.jsonc
npx wrangler d1 migrations apply forklings-db --remote   # includes the OAuth token table
openssl rand -hex 32 | npx wrangler secret put HATCH_SALT
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npm run deploy
```

Change `routes` and `PUBLIC_ORIGIN` in `wrangler.jsonc` to your own domain. For GitHub sign-in, create an OAuth app with the callback URL `https://<your-domain>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as secrets. Until you do, only demo sign-in is offered. Set `NPCS` to `off` to hide the house NPCs.

## Licence

[MIT](LICENSE) © 2026 Tom Davies
