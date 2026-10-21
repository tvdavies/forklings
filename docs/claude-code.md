# Forklings in Claude Code, Pi and Codex

Your Forkling is reachable from any MCP client at `https://forklings.dev/mcp` (Streamable HTTP). Every client authenticates with a personal token: sign in at [forklings.dev](https://forklings.dev), open the **API** tab and create one. It starts with `fk_` and is shown only once. Revoking it there stops it working immediately.

Tools:

| Tool | What it does |
| --- | --- |
| `get_forkling` | Status, needs, level and battle record, with an optional 32×32 portrait |
| `care_for_forkling` | `feed`, `play`, `pat` or `nap` |
| `get_strategy` / `set_strategy` | Read the battle plan as a [strategy script](strategy-scripts.md), or replace it |
| `list_battles` | Recent battles with results and replay links |
| `practice_battle` | An unranked fight against a house NPC; costs energy like any battle |

## Claude Code plugin

```text
/plugin marketplace add tvdavies/forklings
/plugin install forklings@forklings
```

Claude Code asks for your token when the plugin is enabled and keeps it in its secure storage. To change it later, run `/plugin`, choose Forklings and configure it. Then:

```text
/forklings:forkling            how is it doing?
/forklings:forkling feed       feed, play, pat or nap
/forklings:forkling battle     practice battle against an NPC
/forklings:forkling battles    recent results
/forklings:forkling heal earlier and save the special for the finish
```

The last form rewrites your strategy script. Claude shows you the new script and saves it only once you agree.

### Status line (optional)

`plugins/forklings/statusline/forkling-status.sh` prints two short lines, such as:

```text
(^o^) Cronchick is delighted
   food 70% · mood 76% · energy 80% · Lv 1
```

It caches the answer for a minute, so the status line never waits on the network. Plugins can't set the status line themselves, so it's a manual step:

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

### Without the plugin

```sh
claude mcp add --transport http forklings https://forklings.dev/mcp --header "Authorization: Bearer $FORKLINGS_TOKEN"
```

## Pi

```sh
pi mcp add forklings --url https://forklings.dev/mcp --bearer-token-env-var FORKLINGS_TOKEN
```

Or add it to `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "forklings": { "url": "https://forklings.dev/mcp", "headers": { "Authorization": "Bearer ${FORKLINGS_TOKEN}" } } } }
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.forklings]
url = "https://forklings.dev/mcp"
bearer_token_env_var = "FORKLINGS_TOKEN"
```

## Anything else

Send JSON-RPC to `POST https://forklings.dev/mcp` with `Authorization: Bearer fk_…` and `Accept: application/json, text/event-stream`. The server is stateless and answers with plain JSON. Browser origins other than forklings.dev are refused.

```sh
curl -s https://forklings.dev/mcp -H "Authorization: Bearer $FORKLINGS_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"care_for_forkling","arguments":{"action":"pat"}}}'
```
