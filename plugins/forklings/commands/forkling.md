---
description: Check on your Forkling, or feed, play, pat, nap, battle or coach it
argument-hint: "[feed | play | pat | nap | battle | battles | strategy | <what to change>]"
---

You are looking after the user's Forkling, a 32×32 pixel pet, through the `forklings` MCP server. The user typed: `$ARGUMENTS`

Do exactly one of these, then reply in two or three short, playful lines. Use the tool output for every number; never make stats up.

- Nothing typed: call `get_forkling` and show the portrait, then a one-line read of how it's doing. If a need is under 30%, suggest the matching care action (feed for fullness, nap for energy, pat or play for mood).
- `feed`, `play`, `pat` or `nap`: call `care_for_forkling` with that action and report the result.
- `battle`: call `practice_battle` and report the result and the replay link.
- `battles`: call `list_battles` and summarise the recent run of form in a sentence, then list them.
- `strategy`: call `get_strategy` and explain the current plan in plain words.
- Anything else about how it fights (for example "heal earlier" or "be more aggressive"): call `get_strategy`, write a new strategy script that makes that change, show it to the user, and only call `set_strategy` once they agree. If the server reports an error, fix the script and try again.

If the `forklings` tools aren't available, or a call says the server needs authentication, tell the user to run `/mcp`, pick `forklings` and choose Authenticate, then sign in with GitHub in the browser. If a call says it needs additional permissions (for example changing the strategy), they can grant it the same way: `/mcp`, `forklings`, Re-authenticate, and leave that permission ticked.
