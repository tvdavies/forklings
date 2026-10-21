# Forklings in Claude Code, Pi and Codex

Your Forkling is reachable from any MCP client at `https://forklings.dev/mcp` (Streamable HTTP). You add the server, your tool opens the browser, you sign in to Forklings with GitHub and choose what the tool may do. There's no token to copy. Forklings is the OAuth 2.1 authorization server: tools find it from the server's `401`, register themselves (a [Client ID Metadata Document](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) or Dynamic Client Registration) and sign in with PKCE.

Tools, and the permission each needs:

| Tool | What it does | Permission |
| --- | --- | --- |
| `get_forkling` | Status, needs, level and battle record, with an optional 32×32 portrait | `pet:read` |
| `care_for_forkling` | `feed`, `play`, `pat` or `nap` | `pet:care` |
| `get_strategy` | Read the battle plan as a [strategy script](strategy-scripts.md) | `strategy:read` |
| `set_strategy` | Replace the battle plan | `strategy:write` (coaching) |
| `list_battles` | Recent battles with results and replay links | `battle:read` |
| `practice_battle` | An unranked fight against a house NPC; costs energy like any battle | `battle:spar` |

`pet:read` is always granted. Everything else is a box on the consent page that you can untick; coaching is its own section, so you can let a tool look after your Forkling without letting it touch the strategy. A tool sees only the tools it may call. No permission lets a tool pick ranked opponents or act during a battle. `battle:simulate` is reserved for a dry-run tool that doesn't exist yet.

Connected tools are listed on the site's **API** tab with what each may do and when it was last active. **Disconnect** revokes one at once: its access and refresh tokens stop working on the next request. Sign-ins last while the tool keeps using them: access tokens live 8 hours and refresh tokens rotate, expiring after 30 days unused.

## Claude Code plugin

```text
/plugin marketplace add tvdavies/forklings
/plugin install forklings@forklings
```

Then run `/mcp`, pick **forklings** and choose **Authenticate**. Claude Code opens the browser; sign in with GitHub and press **Connect**. Claude Code also lists servers that need signing in when it starts.

```text
/forklings:forkling            how is it doing?
/forklings:forkling feed       feed, play, pat or nap
/forklings:forkling battle     practice battle against an NPC
/forklings:forkling battles    recent results
/forklings:forkling heal earlier and save the special for the finish
```

The last form rewrites your strategy script. Claude shows you the new script and saves it only once you agree. If you unticked coaching, Claude Code says the server needs additional permissions; run `/mcp`, choose **Re-authenticate** and leave coaching ticked.

Upgrading from plugin 1.0: the plugin no longer asks for a token. Sign in from `/mcp` as above, then revoke the old token on the **API** tab unless the status line uses it.

### Without the plugin

```sh
claude mcp add --transport http forklings https://forklings.dev/mcp
```

Then `/mcp` → **forklings** → **Authenticate**.

## Codex

```sh
codex mcp add forklings --url https://forklings.dev/mcp
codex mcp login forklings
```

Or in `~/.codex/config.toml`, then `codex mcp login forklings`:

```toml
[mcp_servers.forklings]
url = "https://forklings.dev/mcp"
```

## Pi

```sh
pi mcp add forklings --url https://forklings.dev/mcp
pi mcp login forklings
```

Inside a Pi session, `/mcp login forklings` does the same.

## Personal tokens: scripts, CI and the status line

Where nobody can sign in in a browser, use a personal token instead. Create one on the **API** tab; it starts with `fk_` and is shown only once. It can do everything (every permission above, plus the JSON API), so keep it secret, and revoke it there when you're done. Most headless runs don't need one: a `claude -p` run uses the sign-in you made interactively.

```sh
claude mcp add --transport http forklings https://forklings.dev/mcp --header "Authorization: Bearer $FORKLINGS_TOKEN"
codex mcp add forklings --url https://forklings.dev/mcp --bearer-token-env-var FORKLINGS_TOKEN
pi mcp add forklings --url https://forklings.dev/mcp --bearer-token-env-var FORKLINGS_TOKEN
```

A server configured with a token header doesn't offer browser sign-in, so use one or the other.

### Status line (optional)

`plugins/forklings/statusline/forkling-status.sh` prints two short lines, such as:

```text
(^o^) Cronchick is delighted
   food 70% · mood 76% · energy 80% · Lv 1
```

It caches the answer for a minute, so the status line never waits on the network. It runs outside Claude Code's MCP sign-in, so it needs a personal token. Plugins can't set the status line themselves, so it's a manual step:

```sh
mkdir -p ~/.config/forklings
curl -fsSL https://raw.githubusercontent.com/tvdavies/forklings/main/plugins/forklings/statusline/forkling-status.sh -o ~/.config/forklings/status.sh
chmod +x ~/.config/forklings/status.sh
printf '%s' 'fk_your_token' > ~/.config/forklings/token && chmod 600 ~/.config/forklings/token
```

Then add this to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "~/.config/forklings/status.sh" } }
```

The script reads `$FORKLINGS_TOKEN` first, then `~/.config/forklings/token`.

## Anything else

Any MCP client with OAuth support finds everything from the `401` on `POST https://forklings.dev/mcp`:

| | |
| --- | --- |
| Protected resource metadata | `https://forklings.dev/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `https://forklings.dev/.well-known/oauth-authorization-server` |
| Authorize, token, registration | `/authorize`, `/oauth/token`, `/oauth/register` |

Authorization code with PKCE (S256) only, public or confidential clients, refresh-token rotation, and RFC 8707 resource indicators: tokens are issued for `https://forklings.dev/mcp` and nothing else. A call that needs a permission the token lacks gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`, naming the scopes to ask for.

Or send JSON-RPC with a personal token and `Accept: application/json, text/event-stream`. The server is stateless and answers with plain JSON. Browser origins other than forklings.dev are refused.

```sh
curl -s https://forklings.dev/mcp -H "Authorization: Bearer $FORKLINGS_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"care_for_forkling","arguments":{"action":"pat"}}}'
```
