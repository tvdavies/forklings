# Strategy scripts

A strategy script tells your Forkling what to do on each turn of a battle. Write one on the site's **Coach** tab under *Strategy script*, or through the MCP tool `set_strategy`. Saving a script replaces your coaching sliders. Saving the sliders again replaces the script.

```text
# Heal early, finish with the special, otherwise press the attack.
style steady
when hp < 40 and ready heal: heal
when foe_hp < 35: special
when focused or foe_guarding: strike
when chance 70: strike
otherwise: guard
```

On each turn, the rules are tried from top to bottom. The first rule whose condition holds **and** whose action can be used right now wins: a `special` on cooldown or a `heal` with none left falls through to the next rule. If no rule matches, the Forkling strikes.

## Actions

| Action | Effect |
| --- | --- |
| `strike` | The basic attack for your Forkling's type |
| `special` | A stronger signature move; then three turns of cooldown |
| `guard` | Halves the next hit you take, and your next attack does 30% more (`focused`) |
| `heal` | Restores HP; two per battle |

## Style

The optional `style` line sets how your attacks land. It defaults to `balanced`.

| Style | Accuracy | Critical hits | Damage spread | Damage |
| --- | --- | --- | --- | --- |
| `steady` | 97% | 4% | ±5% | ×1.0 |
| `balanced` | 93% | 10% | ±10% | ×1.0 |
| `reckless` | 85% | 20% | ±20% | ×1.1 |

## Conditions

| Condition | True when |
| --- | --- |
| `hp`, `foe_hp` | HP as a percentage, 0–100 |
| `turn` | The round number, from 1 |
| `heals_left`, `foe_heals_left` | Heals remaining, 0–2 |
| `level`, `foe_level` | Forkling levels |
| `ready special`, `ready heal` | That move can be used this turn |
| `focused` | You guarded last turn, so your next attack is powered up |
| `foe_guarding` | The foe guarded last turn |
| `chance N` | A roll from the battle's seeded RNG succeeds N% of the time |

Compare numbers with `<`, `<=`, `>`, `>=`, `==` and `!=`; either side can be a name or a number. Combine conditions with `not`, `and` and `or`, in that order of precedence, and use brackets where you need them. `#` starts a comment.

## Limits

Scripts are parsed by a small hand-written parser and run by an interpreter, never as code. A script may have up to 32 rules and 4,000 characters, with nesting up to 12 levels deep. Each decision gets a budget of 256 steps; a Forkling that runs out strikes. Errors give the line and column, such as `line 1, column 11: expected a number or one of hp, foe_hp, …`.

Battles are deterministic: the same script, opponent and battle seed always play out the same way, which is how replays work.
