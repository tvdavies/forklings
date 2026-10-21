// One Durable Object per player, on SQLite storage. Holds the creature, its
// lazily-derived needs, the wardrobe, tactics and the player's battle log.
import { DurableObject } from 'cloudflare:workers';
import { type BattleResult, compileTactics, DEFAULT_TACTICS, type Snapshot, sanitiseTactics, type Tactics } from '../shared/battle';
import { ITEMS, type Slot } from '../shared/compose';
import {
  closeFirstDay,
  type FirstDay,
  type FirstDayStep,
  type FirstDayView,
  firstDayView,
  needsReward,
  rewarded,
  rewardFor,
  startFirstDay,
  tickStep,
} from '../shared/firstday';
import { genome } from '../shared/genome';
import { npcPid } from '../shared/npcs';
import { hatchSeed, hatchTimeIso } from '../shared/rng';
import { formatStrategy, parseScript, ScriptError } from '../shared/script';
import {
  advance,
  type CareAction,
  COOLDOWNS,
  care,
  levelForXp,
  moodWord,
  newState,
  nextStageXp,
  type PetState,
  stageForXp,
} from '../shared/state';
import type { Strategy, Style } from '../shared/strategy';
import type { Env } from './env';

const STARTER_ITEMS = ['beanie', 'glasses', 'mug'];
export const BATTLE_ENERGY = 15;
export const BATTLE_COOLDOWN_MS = 15 * 1000;

// A creature fights with its tactics, unless the player has written a script; then
// `script` holds the source as typed and `strategy` the compiled rules.
interface Creature {
  seed: string;
  hatchedAt: string;
  handle: string;
  state: PetState;
  items: Record<string, string | null>;
  tactics: Tactics;
  script?: string | null;
  strategy?: Strategy | null;
}

// Everything below crosses the Workers RPC boundary, so it is plain JSON-able data:
// no class instances and no functions, or the typed stub collapses to `never`.

/** The `who` profile record: the player this Durable Object belongs to. */
export interface Who {
  pid: string;
  handle: string;
  verified: boolean;
  created: number;
}

/** Success with extra fields `T`, or a failure with a message. */
export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

// SQLite rows. These are `type`s, not interfaces: SqlStorage.exec<T> wants an index-signature-compatible row.
export type InventoryRow = { item: string; got_at: number; source: string };
export type BattleRow = {
  id: string;
  at: number;
  side: number;
  opp_handle: string;
  opp_bot: number;
  outcome: string;
  xp: number;
  loot: string | null;
  rating_delta: number;
  seen: number;
};
type ProfileRow = { v: string };
type CountRow = { n: number };
type CareLogRow = { action: CareAction; at: number };
type ReplayRow = { id: string; at: number; side: number; outcome: string; replay: string };

export interface StrategyView {
  source: 'script' | 'tactics';
  script: string;
  rules: number;
  style: Style;
}

export interface CreatureView {
  seed: string;
  hatchedAt: string;
  handle: string;
  items: Record<string, string | null>;
  tactics: Tactics;
  strategy: StrategyView;
  state: PetState;
  level: number;
  stage: number;
  mood: string;
  nextStageXp: number | null;
  evolving: { from: number; to: number } | null;
  cooldowns: Record<string, number>;
  battleEnergy: number;
}

export interface PlayerView {
  who: Who | null;
  creature: CreatureView | null;
  inventory: InventoryRow[];
  unseenDefences: number;
  /** Absent until the player has hatched. */
  now?: number;
  /** The first-day checklist; null once it's closed or for house NPCs, absent until the player has hatched. */
  firstDay?: FirstDayView | null;
}

export interface CareOutcome {
  ok: boolean;
  message: string;
  xpGain?: number;
}

export type TacticsResult = Result<{ tactics: Tactics; strategy: StrategyView }>;
export type ScriptResult = { ok: true; strategy: StrategyView } | { ok: false; error: string; line?: number; col?: number };
export type EvolveResult = { ok: true; stage: number } | { ok: false; stage?: number };

/** What both sides store and a replay re-simulates from. */
export interface StoredReplay {
  a: Snapshot;
  b: Snapshot;
  seed: string;
}
export type RecordResult =
  | { ok: false }
  | { ok: true; outcome: 'win' | 'loss' | 'draw'; xp: number; loot: string | null; lootNote: string | null };

export interface ReplayView extends StoredReplay {
  id: string;
  at: number;
  side: number;
  outcome: string;
}

const isCareAction = (a: unknown): a is CareAction => a === 'feed' || a === 'play' || a === 'pat' || a === 'nap';

export class PlayerDO extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory (item TEXT PRIMARY KEY, got_at INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, at INTEGER NOT NULL, side INTEGER NOT NULL, opp_handle TEXT NOT NULL,
        opp_bot INTEGER NOT NULL, outcome TEXT NOT NULL, xp INTEGER NOT NULL, loot TEXT, rating_delta INTEGER NOT NULL DEFAULT 0, replay TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS care_log (action TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  /** Read a profile value. The stored JSON was written by `set`, so it is trusted to be a `T`. */
  private get<T>(k: string): T | null {
    const r: ProfileRow | undefined = this.sql.exec<ProfileRow>('SELECT v FROM profile WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private set(k: string, v: unknown) {
    this.sql.exec('INSERT OR REPLACE INTO profile (k, v) VALUES (?, ?)', k, JSON.stringify(v));
  }

  private creature(): Creature | null {
    return this.get<Creature>('creature');
  }

  /** Integrate needs forward to now and persist the snapshot. */
  private advanced(now: number): Creature | null {
    const c = this.creature();
    if (!c) return null;
    c.state = advance(c.state, now);
    this.set('creature', c);
    return c;
  }

  async init(pid: string, handle: string, verified: boolean): Promise<void> {
    const p = this.get<Who>('who');
    if (!p || p.handle !== handle || p.verified !== verified) {
      const who: Who = { pid, handle, verified, created: p?.created ?? Date.now() };
      this.set('who', who);
    }
  }

  async view(now = Date.now()): Promise<PlayerView> {
    const who = this.get<Who>('who');
    const c = this.advanced(now);
    const inv = this.sql.exec<InventoryRow>('SELECT item, got_at, source FROM inventory ORDER BY got_at').toArray();
    const unseen: CountRow | undefined = this.sql
      .exec<CountRow>('SELECT COUNT(*) AS n FROM battles WHERE seen = 0 AND side = 1')
      .toArray()[0];
    if (!c) return { who, creature: null, inventory: inv, unseenDefences: unseen?.n ?? 0 };
    const trueStage = stageForXp(c.state.xp);
    const cool: Record<string, number> = {};
    for (const r of this.sql.exec<CareLogRow>('SELECT action, at FROM care_log').toArray()) {
      const left = r.at + COOLDOWNS[r.action] - now;
      if (left > 0) cool[r.action] = left;
    }
    return {
      who,
      creature: {
        seed: c.seed,
        hatchedAt: c.hatchedAt,
        handle: c.handle,
        items: c.items,
        tactics: c.tactics,
        strategy: this.strategyView(c),
        state: c.state,
        level: levelForXp(c.state.xp),
        stage: c.state.stage,
        mood: moodWord(c.state, now),
        nextStageXp: nextStageXp(c.state.stage),
        evolving: trueStage > c.state.stage ? { from: c.state.stage, to: c.state.stage + 1 } : null,
        cooldowns: cool,
        battleEnergy: BATTLE_ENERGY,
      },
      inventory: inv,
      unseenDefences: unseen?.n ?? 0,
      now,
      firstDay: this.firstDayOf(c, now)?.view ?? null,
    };
  }

  /**
   * The first-day checklist, or null for house NPCs. Created on first use, with any steps
   * the player's history already covers ticked, so players from before it existed aren't
   * asked to do things again.
   */
  private firstDayOf(c: Creature, now: number): { fd: FirstDay; view: FirstDayView | null } | null {
    const who = this.get<Who>('who');
    if (!who || who.pid.startsWith(npcPid(''))) return null;
    let fd = this.get<FirstDay>('firstDay');
    if (!fd) {
      const t = c.tactics;
      fd = this.saveFirstDay(
        startFirstDay(
          {
            fed: this.sql.exec("SELECT 1 FROM care_log WHERE action = 'feed'").toArray().length > 0,
            dressed: Object.values(c.items).some(Boolean),
            planned: !!c.script || (Object.keys(DEFAULT_TACTICS) as (keyof Tactics)[]).some((k) => t[k] !== DEFAULT_TACTICS[k]),
            won: this.sql.exec("SELECT 1 FROM battles WHERE outcome = 'win' LIMIT 1").toArray().length > 0,
          },
          now,
        ),
        now,
      );
    }
    return { fd, view: firstDayView(fd) };
  }

  /** Store the checklist, giving the starter reward (once) when the last step is done. */
  private saveFirstDay(fd: FirstDay, now: number): FirstDay {
    if (needsReward(fd)) {
      const owned = this.sql.exec<{ item: string }>('SELECT item FROM inventory').toArray();
      const item = rewardFor(owned.map((r) => r.item));
      if (item) this.sql.exec('INSERT OR IGNORE INTO inventory (item, got_at, source) VALUES (?, ?, ?)', item, now, 'first-day');
      fd = rewarded(fd, item, now);
    }
    this.set('firstDay', fd);
    return fd;
  }

  private tickFirstDay(c: Creature, step: FirstDayStep, now: number) {
    const cur = this.firstDayOf(c, now);
    if (!cur) return;
    const next = tickStep(cur.fd, step, now);
    if (next !== cur.fd) this.saveFirstDay(next, now);
  }

  /** Close the first-day card: hides the list, or acknowledges the reward once it's done. */
  async closeFirstDay(now = Date.now()): Promise<Result> {
    const c = this.creature();
    if (!c) return { ok: false, error: 'Hatch first.' };
    const cur = this.firstDayOf(c, now);
    if (cur) this.set('firstDay', closeFirstDay(cur.fd, now));
    return { ok: true };
  }

  async hatch(salt: string, now = Date.now()): Promise<Result> {
    if (this.creature()) return { ok: false, error: 'Already hatched.' };
    const who = this.get<Who>('who');
    if (!who) return { ok: false, error: 'Unknown player.' };
    const hatchedAt = hatchTimeIso(now);
    const seed = await hatchSeed(who.handle, hatchedAt, salt);
    const c: Creature = {
      seed,
      hatchedAt,
      handle: who.handle.toLowerCase(),
      state: newState(now),
      items: { head: null, face: null, neck: null, held: null },
      tactics: DEFAULT_TACTICS,
    };
    this.set('creature', c);
    for (const it of STARTER_ITEMS)
      this.sql.exec('INSERT OR IGNORE INTO inventory (item, got_at, source) VALUES (?, ?, ?)', it, now, 'starter');
    await this.publish(now);
    return { ok: true };
  }

  /** `action` is untrusted (request body or MCP argument) and checked here. */
  async care(action: unknown, now = Date.now()): Promise<CareOutcome> {
    const c = this.advanced(now);
    if (!c) return { ok: false, message: 'Hatch first.' };
    if (!isCareAction(action)) return { ok: false, message: 'Unknown action.' };
    const last: { at: number } | undefined = this.sql.exec<{ at: number }>('SELECT at FROM care_log WHERE action = ?', action).toArray()[0];
    if (last && now - last.at < COOLDOWNS[action]) return { ok: false, message: 'Give it a moment.' };
    const r = care(c.state, action, now);
    if (r.ok) {
      c.state = r.state;
      this.set('creature', c);
      this.sql.exec('INSERT OR REPLACE INTO care_log (action, at) VALUES (?, ?)', action, now);
      if (action === 'feed') this.tickFirstDay(c, 'feed', now);
      if (r.xpGain) await this.publish(now);
    }
    return { ok: r.ok, message: r.message, xpGain: r.xpGain };
  }

  /** `item` is untrusted (request body): an item id, or null to take the slot off. */
  async equip(slot: string, item: unknown, now = Date.now()): Promise<Result> {
    const c = this.advanced(now);
    if (!c) return { ok: false, error: 'Hatch first.' };
    if (!['head', 'face', 'neck', 'held'].includes(slot)) return { ok: false, error: 'Bad slot.' };
    if (item !== null && typeof item !== 'string') return { ok: false, error: "That doesn't go there." };
    if (item !== null) {
      const it = ITEMS[item];
      if (!it || it.slot !== slot) return { ok: false, error: "That doesn't go there." };
      const own = this.sql.exec('SELECT 1 FROM inventory WHERE item = ?', item).toArray().length;
      if (!own) return { ok: false, error: "You don't own that yet." };
    }
    c.items = { ...c.items, [slot]: item };
    this.set('creature', c);
    if (item !== null) this.tickFirstDay(c, 'dress', now);
    await this.publish(now);
    return { ok: true };
  }

  /** Coaching tactics. Setting them replaces any script. */
  async setTactics(t: unknown, now = Date.now()): Promise<TacticsResult> {
    const c = this.advanced(now);
    if (!c) return { ok: false, error: 'Hatch first.' };
    c.tactics = sanitiseTactics(t);
    c.script = null;
    c.strategy = null;
    this.set('creature', c);
    this.tickFirstDay(c, 'plan', now);
    await this.publish(now);
    return { ok: true, tactics: c.tactics, strategy: this.strategyView(c) };
  }

  /** A strategy script, parsed and validated here whatever the client: web, API or MCP. */
  async setScript(src: unknown, now = Date.now()): Promise<ScriptResult> {
    const c = this.advanced(now);
    if (!c) return { ok: false, error: 'Hatch first.' };
    if (typeof src !== 'string') return { ok: false, error: 'The script must be text.' };
    try {
      c.strategy = parseScript(src);
    } catch (e) {
      if (e instanceof ScriptError) return { ok: false, error: e.message, line: e.line, col: e.col };
      throw e;
    }
    c.script = src;
    this.set('creature', c);
    this.tickFirstDay(c, 'plan', now);
    await this.publish(now);
    return { ok: true, strategy: this.strategyView(c) };
  }

  private strategyView(c: Creature): StrategyView {
    const compiled = c.strategy ?? compileTactics(c.tactics);
    return {
      source: c.strategy ? 'script' : 'tactics',
      script: c.script ?? formatStrategy(compiled),
      rules: compiled.rules.length,
      style: compiled.style,
    };
  }

  /**
   * House NPC setup, run once by the seeding cron. Hatches through the normal path at a
   * fixed hatch time (so each NPC's Forkling is reproducible), then gives it its starting
   * XP, wardrobe and tactics. Battles and care afterwards use the normal methods.
   */
  async setupNpc(
    salt: string,
    hatchAt: number,
    xp: number,
    items: Partial<Record<Slot, string>>,
    tactics: unknown,
    now = Date.now(),
  ): Promise<Result> {
    if (!this.creature()) {
      const r = await this.hatch(salt, hatchAt);
      if (!r.ok) return r;
    }
    const c = this.creature()!;
    c.state = { ...newState(now), xp, stage: stageForXp(xp) };
    for (const it of Object.values(items))
      this.sql.exec('INSERT OR IGNORE INTO inventory (item, got_at, source) VALUES (?, ?, ?)', it, now, 'npc');
    c.items = { head: null, face: null, neck: null, held: null, ...items };
    c.tactics = sanitiseTactics(tactics);
    this.set('creature', c);
    await this.publish(now);
    return { ok: true };
  }

  async ackEvolution(now = Date.now()): Promise<EvolveResult> {
    const c = this.advanced(now);
    if (!c) return { ok: false };
    const s = stageForXp(c.state.xp);
    if (s > c.state.stage) {
      c.state.stage = c.state.stage + 1;
      this.set('creature', c);
      await this.publish(now);
      return { ok: true, stage: c.state.stage };
    }
    return { ok: false, stage: c.state.stage };
  }

  snapshotOf(c: Creature): Snapshot {
    // A creature always has an owner record; if it somehow didn't, this throws as it always has.
    const who = this.get<Who>('who')!;
    return {
      pid: who.pid,
      handle: who.handle,
      verified: !!who.verified,
      bot: false,
      seed: c.seed,
      stage: c.state.stage,
      level: levelForXp(c.state.xp),
      xp: Math.floor(c.state.xp),
      items: c.items,
      tactics: c.tactics,
      ...(c.strategy ? { strategy: c.strategy } : {}),
    };
  }

  /** Challenger side: check and spend energy, return the snapshot to fight with. */
  async prepareBattle(now = Date.now()): Promise<Result<{ snapshot: Snapshot }>> {
    const c = this.advanced(now);
    if (!c) return { ok: false, error: 'Hatch first.' };
    if (now < c.state.napUntil) return { ok: false, error: 'Your Forkling is napping.' };
    if (c.state.energy < BATTLE_ENERGY) return { ok: false, error: 'Too tired to battle. Let it rest or nap.' };
    const last = this.get<number>('lastBattle') ?? 0;
    if (now - last < BATTLE_COOLDOWN_MS) return { ok: false, error: 'Catching its breath. Try again in a few seconds.' };
    c.state.energy -= BATTLE_ENERGY;
    this.set('creature', c);
    this.set('lastBattle', now);
    return { ok: true, snapshot: this.snapshotOf(c) };
  }

  /** Called by the battle DO for both sides once a battle is simulated. */
  async recordBattle(
    id: string,
    side: 0 | 1,
    replay: StoredReplay,
    result: Pick<BattleResult, 'winner' | 'xp' | 'loot'>,
    ratingDelta: number,
    now = Date.now(),
  ): Promise<RecordResult> {
    const c = this.advanced(now);
    if (!c) return { ok: false };
    const opp = side === 0 ? replay.b : replay.a;
    const outcome = result.winner === null ? 'draw' : result.winner === side ? 'win' : 'loss';
    const xp = result.xp[side];
    c.state.xp += xp;
    c.state.mood = Math.max(0, Math.min(100, c.state.mood + (outcome === 'win' ? 6 : outcome === 'loss' ? -4 : 0)));
    let loot: string | null = null,
      lootNote: string | null = null;
    if (side === 0 && result.loot) {
      const have = this.sql.exec('SELECT 1 FROM inventory WHERE item = ?', result.loot).toArray().length;
      if (have) {
        c.state.xp += 10;
        lootNote = 'duplicate';
      } else {
        this.sql.exec('INSERT INTO inventory (item, got_at, source) VALUES (?, ?, ?)', result.loot, now, `battle:${id}`);
      }
      loot = result.loot;
    }
    this.set('creature', c);
    if (outcome === 'win') this.tickFirstDay(c, 'win', now);
    this.sql.exec(
      'INSERT OR IGNORE INTO battles (id, at, side, opp_handle, opp_bot, outcome, xp, loot, rating_delta, replay, seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      now,
      side,
      opp.handle,
      opp.bot ? 1 : 0,
      outcome,
      xp,
      loot ? loot + (lootNote ? `:${lootNote}` : '') : null,
      ratingDelta,
      JSON.stringify(replay),
      side === 0 ? 1 : 0,
    );
    await this.publish(now);
    return { ok: true, outcome, xp, loot, lootNote };
  }

  async battles(limit = 30): Promise<BattleRow[]> {
    const rows = this.sql
      .exec<BattleRow>(
        'SELECT id, at, side, opp_handle, opp_bot, outcome, xp, loot, rating_delta, seen FROM battles ORDER BY at DESC LIMIT ?',
        limit,
      )
      .toArray();
    // Only the battles actually shown count as seen.
    for (const r of rows) if (!r.seen) this.sql.exec('UPDATE battles SET seen = 1 WHERE id = ?', r.id);
    return rows;
  }

  async replay(id: string): Promise<ReplayView | null> {
    const r: ReplayRow | undefined = this.sql
      .exec<ReplayRow>('SELECT id, at, side, outcome, replay FROM battles WHERE id = ?', id)
      .toArray()[0];
    if (!r) return null;
    // Written by recordBattle as JSON.stringify(replay), so it parses back to a StoredReplay.
    const stored = JSON.parse(r.replay) as StoredReplay;
    return { id: r.id, at: r.at, side: r.side, outcome: r.outcome, ...stored };
  }

  /** Push the public, cross-player view (matchmaking pool and leaderboard) into D1. */
  private async publish(now: number) {
    const who = this.get<Who>('who');
    const c = this.creature();
    if (!who || !c) return;
    const g = genome(c.seed);
    const snap = this.snapshotOf(c);
    await this.env.DB.prepare(
      `UPDATE players SET has_creature = 1, name = ?, seed = ?, level = ?, stage = ?, xp = ?, snapshot = ?, updated_at = ? WHERE pid = ?`,
    )
      .bind(g.name, c.seed, snap.level, snap.stage, Math.floor(c.state.xp), JSON.stringify(snap), now, who.pid)
      .run();
  }
}
