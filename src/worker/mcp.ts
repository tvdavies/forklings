// Remote MCP server at /mcp, over Streamable HTTP. Stateless JSON responses (no SSE
// stream, no session id): every request carries the player's personal API token as a
// Bearer token, and each tool call goes to that player's Durable Object, the same
// path the web app uses, so validation and game rules are identical.

import { heldEffect } from '../shared/battle';
import { compose, ITEMS, type ItemDef } from '../shared/compose';
import { describe, type Genome, genome, RARITY, STAGE_NAMES } from '../shared/genome';
import { isRecord, oneOf, prop } from '../shared/json';
import { base64, centreSprite, encodePng, paintSprite } from '../shared/png';
import type { BattleOutcome } from './battle';
import type { Env } from './env';
import type { BattleRow, CareOutcome, PlayerView, ScriptResult, TacticsResult } from './player';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'forklings', title: 'Forklings', version: '1.0.0' };
const INSTRUCTIONS = `Forklings is a virtual pet and auto-battler for developers (https://forklings.dev).
Each player has one Forkling. Its needs (fullness, mood, energy) drift over time; care actions restore them.
Battles are automatic: the Forkling follows its strategy (coaching tactics or a short rule script).
Keep replies short and playful. Never invent stats: read them with get_forkling.`;

const SCRIPT_HELP = `Strategy scripts are ordered rules. The first rule whose condition holds and whose action is usable this turn wins; if none does, the Forkling strikes.
  style steady|balanced|reckless      (optional, default balanced)
  when <condition>: <action>
  otherwise: <action>
Actions: strike, special (has a cooldown), guard (next attack is powered up), heal (two per battle).
Conditions: comparisons of numbers and hp, foe_hp (percent), turn, heals_left, foe_heals_left, level, foe_level with < <= > >= == !=;
chance N (percent); ready special|heal; focused (you guarded last turn); foe_guarding; always; combined with and, or, not and parentheses. Comments start with #.`;

/** The slice of the player's Durable Object stub the tools use. */
export interface McpPlayer {
  view(): Promise<PlayerView>;
  care(action: string): Promise<CareOutcome>;
  setTactics(t: unknown): Promise<TacticsResult>;
  setScript(src: unknown): Promise<ScriptResult>;
  battles(limit: number): Promise<BattleRow[]>;
}
export interface McpDeps {
  player: McpPlayer;
  handle: string;
  practiceBattle(): Promise<{ ok: true; out: BattleOutcome } | { ok: false; error: string }>;
}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const TOOLS = [
  {
    name: 'get_forkling',
    title: 'Check on my Forkling',
    description:
      "Your Forkling's current status: needs, mood, level, evolution progress, wardrobe and strategy, with an optional pixel-art portrait.",
    inputSchema: {
      type: 'object',
      properties: { portrait: { type: 'boolean', description: 'Include a PNG portrait (default true).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'care_for_forkling',
    title: 'Care for my Forkling',
    description: 'Feed, play with, pat, or put your Forkling down for a nap (nap again to wake it). Each action has a short cooldown.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['feed', 'play', 'pat', 'nap'] } },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_strategy',
    title: 'Read battle strategy',
    description:
      "Your Forkling's battle strategy: its coaching tactics and the equivalent script (or the custom script, if one is set), plus the script language reference.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_strategy',
    title: 'Change battle strategy',
    description: `Set either coaching tactics or a strategy script (exactly one). The server validates it the same way the web app does and reports the line and column of any script error.\n\n${SCRIPT_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        tactics: {
          type: 'object',
          properties: {
            aggression: { type: 'integer', minimum: 0, maximum: 100, description: 'Chance to attack rather than guard.' },
            special: { type: 'string', enum: ['open', 'save'], description: 'Lead with the signature move, or save it to finish.' },
            healAt: { type: 'integer', enum: [0, 25, 40, 60], description: 'HP percentage that triggers a heal; 0 never heals.' },
            style: { type: 'string', enum: ['steady', 'balanced', 'reckless'] },
          },
          required: ['aggression', 'special', 'healAt', 'style'],
          additionalProperties: false,
        },
        script: { type: 'string', maxLength: 4000, description: 'A strategy script. Replaces the tactics until tactics are set again.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_battles',
    title: 'Recent battles',
    description: 'Your most recent battles, including ones other players or NPCs started against you, with a one-line summary each.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many (default 8).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'practice_battle',
    title: 'Practice battle',
    description:
      'Fight a practice battle against a house NPC (or a house bot if no NPC is near your level). Costs energy like any battle and earns XP, but never changes your rating.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const pct = (n: number) => Math.round(n);
const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});
const toolError = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

function bar(v: number) {
  const n = Math.round(Math.max(0, Math.min(100, v)) / 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

async function portrait(g: Genome, items: Record<string, string | null>, stage: number, gear: Record<string, ItemDef>) {
  const { cols } = compose({ ...g, items, gear }, { stage });
  return base64(await encodePng(256, 256, paintSprite(centreSprite(cols), 256, 7, '#271d3b')));
}

function outcomeWord(o: string) {
  return o === 'win' ? 'Won' : o === 'loss' ? 'Lost' : 'Drew';
}

/** `args` is the untrusted `params.arguments` object from the client. */
async function callTool(name: string, args: unknown, d: McpDeps): Promise<ToolResult> {
  switch (name) {
    case 'get_forkling': {
      const v = await d.player.view();
      const c = v.creature;
      if (!c) return text('No Forkling yet. Hatch one at https://forklings.dev first.');
      const g = genome(c.seed);
      const s = c.state;
      const nameOf = (id: string) => ITEMS[id]?.name ?? c.gear[id]?.name ?? id;
      const eff = heldEffect(c.items.held, c.gear);
      const held = c.items.held ? `${nameOf(c.items.held)}${eff ? ` (${eff.label})` : ''}` : 'nothing';
      const worn =
        (['head', 'face', 'neck', 'body'] as const)
          .map((k) => {
            const id = c.items[k];
            return id && nameOf(id);
          })
          .filter(Boolean)
          .join(', ') || 'nothing';
      const nap = s.napUntil > Date.now() ? ` Napping for another ${Math.ceil((s.napUntil - Date.now()) / 60000)} min.` : '';
      const lines = [
        `${g.name}, @${d.handle}'s ${RARITY[g.rarity]} ${g.type}-type ${STAGE_NAMES[c.stage]}, level ${c.level}. Mood: ${c.mood}.${nap}`,
        `Fullness ${bar(s.fullness)} ${pct(s.fullness)}%`,
        `Mood     ${bar(s.mood)} ${pct(s.mood)}%`,
        `Energy   ${bar(s.energy)} ${pct(s.energy)}%`,
        `XP ${Math.floor(s.xp)}${c.nextStageXp ? ` / ${c.nextStageXp} to evolve` : ' (fully evolved)'}${c.evolving ? '. Ready to evolve: open forklings.dev to watch it happen!' : ''}`,
        `Wearing ${worn}; holding ${held}.`,
        ...(v.wallet ? [`Bits: ${v.wallet.bits}. The shop restocks at midnight UTC.`] : []),
        `Strategy: ${c.strategy.source === 'script' ? `custom script (${c.strategy.rules} rules)` : `tactics (${c.tactics.style}, aggression ${c.tactics.aggression}%)`}.`,
        `Looks: ${describe(g)}`,
      ];
      const content: ToolContent[] = [{ type: 'text', text: lines.join('\n') }];
      if (prop(args, 'portrait') !== false)
        content.push({ type: 'image', data: await portrait(g, c.items, c.stage, c.gear), mimeType: 'image/png' });
      return {
        content,
        structuredContent: {
          name: g.name,
          rarity: RARITY[g.rarity],
          type: g.type,
          stage: STAGE_NAMES[c.stage],
          level: c.level,
          mood: c.mood,
          fullness: pct(s.fullness),
          moodLevel: pct(s.mood),
          energy: pct(s.energy),
          xp: Math.floor(s.xp),
          nextStageXp: c.nextStageXp,
          readyToEvolve: !!c.evolving,
          napping: s.napUntil > Date.now(),
          items: c.items,
          bits: v.wallet?.bits ?? 0,
          strategySource: c.strategy.source,
        },
      };
    }
    case 'care_for_forkling': {
      const action = String(prop(args, 'action'));
      if (!['feed', 'play', 'pat', 'nap'].includes(action)) return toolError('action must be feed, play, pat or nap.');
      const r = await d.player.care(action);
      const v = await d.player.view();
      const s = v.creature?.state;
      const after = s ? ` Now: fullness ${pct(s.fullness)}%, mood ${pct(s.mood)}%, energy ${pct(s.energy)}%.` : '';
      return r.ok ? text(`${r.message}${r.xpGain ? ` +${r.xpGain} XP.` : ''}${after}`) : toolError(`${r.message}${after}`);
    }
    case 'get_strategy': {
      const v = await d.player.view();
      if (!v.creature) return text('No Forkling yet.');
      const c = v.creature;
      return text(
        `Source: ${c.strategy.source}.\nTactics: aggression ${c.tactics.aggression}%, special ${c.tactics.special}, heal at ${c.tactics.healAt}% HP, style ${c.tactics.style}.\n\n` +
          `Script${c.strategy.source === 'tactics' ? ' (what the tactics compile to)' : ''}:\n${c.strategy.script}\n${SCRIPT_HELP}`,
        { source: c.strategy.source, tactics: c.tactics, script: c.strategy.script },
      );
    }
    case 'set_strategy': {
      const hasT = prop(args, 'tactics') !== undefined,
        hasS = prop(args, 'script') !== undefined;
      if (hasT === hasS) return toolError('Give either tactics or script, not both.');
      if (hasT) {
        const t = await d.player.setTactics(prop(args, 'tactics'));
        if (!t.ok) return toolError(`Not saved: ${t.error}`);
        return text(
          `Tactics saved: aggression ${t.tactics.aggression}%, special ${t.tactics.special}, heal at ${t.tactics.healAt}%, style ${t.tactics.style}.`,
        );
      }
      const s = await d.player.setScript(prop(args, 'script'));
      if (!s.ok) return toolError(`Not saved: ${s.error}`);
      return text(`Script saved (${s.strategy.rules} rules, ${s.strategy.style} style). It fights this way from the next battle.`);
    }
    case 'list_battles': {
      const n = Math.max(1, Math.min(20, Number(prop(args, 'limit')) || 8));
      const rows = await d.player.battles(n);
      if (!rows.length) return text('No battles yet.');
      const lines = rows.map((b) => {
        const when = new Date(b.at).toISOString().slice(0, 16).replace('T', ' ');
        const opp = `@${b.opp_handle}${b.opp_bot ? ' (bot)' : b.opp_handle.startsWith('npc-') ? ' (NPC)' : ''}`;
        const loot = b.loot ? `, found ${ITEMS[b.loot.split(':')[0]]?.name ?? 'an item'}` : '';
        const rating = b.rating_delta ? `, rating ${b.rating_delta > 0 ? '+' : ''}${b.rating_delta}` : '';
        return `${when} UTC  ${outcomeWord(b.outcome)} vs ${opp}${b.side === 1 ? ' (they challenged you)' : ''}: +${b.xp} XP${rating}${loot}`;
      });
      return text(`${lines.join('\n')}\n\nReplays: https://forklings.dev/#battle`, {
        battles: rows.map((b) => ({
          id: b.id,
          at: b.at,
          outcome: b.outcome,
          opponent: b.opp_handle,
          challenged: b.side === 1,
          xp: b.xp,
          ratingDelta: b.rating_delta,
          loot: b.loot,
        })),
      });
    }
    case 'practice_battle': {
      const r = await d.practiceBattle();
      if (!r.ok) return toolError(r.error);
      const o = r.out;
      const result = o.winner === 0 ? 'Won' : o.winner === null ? 'Drew' : 'Lost';
      const opp = `@${o.b.handle}${o.b.bot ? ' (house bot)' : ' (NPC)'}, level ${o.b.level} ${STAGE_NAMES[o.b.stage]}`;
      const loot = o.loot
        ? ` Found ${ITEMS[o.loot]?.name ?? 'an item'}${o.lootNote === 'duplicate' ? ' (a duplicate: +10 XP instead)' : ''}.`
        : '';
      const bits = o.bits ? ` +${o.bits} bits.` : '';
      return text(
        `${result} in ${o.rounds} rounds against ${opp}. +${o.xp} XP.${bits}${loot} Practice battles never change your rating.\nWatch the replay: https://forklings.dev/#battle`,
        { id: o.id, winner: o.winner, rounds: o.rounds, xp: o.xp, bits: o.bits, opponent: o.b.handle, loot: o.loot },
      );
    }
  }
  return toolError(`Unknown tool ${name}.`);
}

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Handle one Streamable HTTP request. `deps` is null when the token is missing or wrong. */
export async function handleMcp(req: Request, env: Env, deps: McpDeps | null): Promise<Response> {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  // Browsers send Origin; refuse other sites (DNS-rebinding guard). CLI clients send none.
  const o = req.headers.get('origin');
  if (o && o !== new URL(req.url).origin && o !== env.PUBLIC_ORIGIN)
    return new Response(JSON.stringify(rpcErr(null, -32600, 'Origin not allowed')), { status: 403, headers });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  if (!deps)
    return new Response(JSON.stringify(rpcErr(null, -32001, 'Missing or invalid token. Create one at https://forklings.dev/#api')), {
      status: 401,
      headers: { ...headers, 'www-authenticate': 'Bearer realm="forklings", error="invalid_token"' },
    });

  let msg: unknown;
  try {
    msg = await req.json<unknown>();
  } catch {
    return new Response(JSON.stringify(rpcErr(null, -32700, 'Parse error')), { status: 400, headers });
  }
  if (Array.isArray(msg)) return new Response(JSON.stringify(rpcErr(null, -32600, 'Batches are not supported')), { status: 400, headers });
  if (!isRecord(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response or malformed message from the client: nothing to answer.
    return new Response(null, { status: 202 });
  }
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notification

  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });
  switch (msg.method) {
    case 'initialize': {
      const asked = prop(msg.params, 'protocolVersion');
      return reply(
        rpc(msg.id, {
          protocolVersion: oneOf(PROTOCOL_VERSIONS, asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case 'ping':
      return reply(rpc(msg.id, {}));
    case 'tools/list':
      return reply(rpc(msg.id, { tools: TOOLS }));
    case 'tools/call': {
      const name = prop(msg.params, 'name');
      // Every tool name is a string, so the typeof check changes nothing; it narrows `name` for callTool.
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) return reply(rpcErr(msg.id, -32602, `Unknown tool: ${name}`));
      try {
        return reply(rpc(msg.id, await callTool(name, prop(msg.params, 'arguments') ?? {}, deps)));
      } catch (e) {
        console.error('mcp tool failed', name, e);
        return reply(rpc(msg.id, toolError('Something went wrong on the Forklings server. Try again.')));
      }
    }
  }
  return reply(rpcErr(msg.id, -32601, `Method not found: ${msg.method}`));
}
