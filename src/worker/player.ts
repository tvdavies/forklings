// One Durable Object per player, on SQLite storage. Holds the creature, its
// lazily-derived needs, the wardrobe, tactics and the player's battle log.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { genome } from '../shared/genome';
import { hatchSeed, hatchTimeIso } from '../shared/rng';
import { advance, care, CareAction, COOLDOWNS, levelForXp, newState, PetState, stageForXp, moodWord, nextStageXp } from '../shared/state';
import { DEFAULT_TACTICS, sanitiseTactics, Snapshot, Tactics, BattleResult } from '../shared/battle';
import { ITEMS } from '../shared/compose';

const STARTER_ITEMS = ['beanie', 'glasses', 'mug'];
export const BATTLE_ENERGY = 15;
export const BATTLE_COOLDOWN_MS = 15 * 1000;

interface Creature { seed: string; hatchedAt: string; handle: string; state: PetState; items: Record<string, string | null>; tactics: Tactics }

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

  private get<T>(k: string): T | null {
    const r = this.sql.exec('SELECT v FROM profile WHERE k = ?', k).toArray()[0] as any;
    return r ? JSON.parse(r.v) : null;
  }
  private set(k: string, v: unknown) { this.sql.exec('INSERT OR REPLACE INTO profile (k, v) VALUES (?, ?)', k, JSON.stringify(v)); }

  private creature(): Creature | null { return this.get<Creature>('creature'); }

  /** Integrate needs forward to now and persist the snapshot. */
  private advanced(now: number): Creature | null {
    const c = this.creature(); if (!c) return null;
    c.state = advance(c.state, now);
    this.set('creature', c);
    return c;
  }

  async init(pid: string, handle: string, verified: boolean) {
    const p = this.get<any>('who');
    if (!p || p.handle !== handle || p.verified !== verified) this.set('who', { pid, handle, verified, created: p?.created ?? Date.now() });
  }

  async view(now = Date.now()) {
    const who = this.get<any>('who');
    const c = this.advanced(now);
    const inv = this.sql.exec('SELECT item, got_at, source FROM inventory ORDER BY got_at').toArray();
    const unseen = this.sql.exec('SELECT COUNT(*) AS n FROM battles WHERE seen = 0 AND side = 1').toArray()[0] as any;
    if (!c) return { who, creature: null, inventory: inv, unseenDefences: unseen?.n ?? 0 };
    const trueStage = stageForXp(c.state.xp);
    const cool: Record<string, number> = {};
    for (const r of this.sql.exec('SELECT action, at FROM care_log').toArray() as any[]) {
      const left = r.at + (COOLDOWNS as any)[r.action] - now; if (left > 0) cool[r.action] = left;
    }
    return {
      who,
      creature: {
        seed: c.seed, hatchedAt: c.hatchedAt, handle: c.handle, items: c.items, tactics: c.tactics,
        state: c.state, level: levelForXp(c.state.xp), stage: c.state.stage, mood: moodWord(c.state, now),
        nextStageXp: nextStageXp(c.state.stage),
        evolving: trueStage > c.state.stage ? { from: c.state.stage, to: c.state.stage + 1 } : null,
        cooldowns: cool, battleEnergy: BATTLE_ENERGY,
      },
      inventory: inv,
      unseenDefences: unseen?.n ?? 0,
      now,
    };
  }

  async hatch(salt: string, now = Date.now()) {
    if (this.creature()) return { ok: false, error: 'Already hatched.' };
    const who = this.get<any>('who'); if (!who) return { ok: false, error: 'Unknown player.' };
    const hatchedAt = hatchTimeIso(now);
    const seed = await hatchSeed(who.handle, hatchedAt, salt);
    const c: Creature = { seed, hatchedAt, handle: who.handle.toLowerCase(), state: newState(now), items: { head: null, face: null, neck: null, held: null }, tactics: DEFAULT_TACTICS };
    this.set('creature', c);
    for (const it of STARTER_ITEMS) this.sql.exec('INSERT OR IGNORE INTO inventory (item, got_at, source) VALUES (?, ?, ?)', it, now, 'starter');
    await this.publish(now);
    return { ok: true };
  }

  async care(action: CareAction, now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false, message: 'Hatch first.' };
    if (!['feed', 'play', 'pat', 'nap'].includes(action)) return { ok: false, message: 'Unknown action.' };
    const last = this.sql.exec('SELECT at FROM care_log WHERE action = ?', action).toArray()[0] as any;
    if (last && now - last.at < COOLDOWNS[action]) return { ok: false, message: 'Give it a moment.' };
    const r = care(c.state, action, now);
    if (r.ok) {
      c.state = r.state; this.set('creature', c);
      this.sql.exec('INSERT OR REPLACE INTO care_log (action, at) VALUES (?, ?)', action, now);
      if (r.xpGain) await this.publish(now);
    }
    return { ok: r.ok, message: r.message, xpGain: r.xpGain };
  }

  async equip(slot: string, item: string | null, now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false, error: 'Hatch first.' };
    if (!['head', 'face', 'neck', 'held'].includes(slot)) return { ok: false, error: 'Bad slot.' };
    if (item !== null) {
      const it = (ITEMS as any)[item]; if (!it || it.slot !== slot) return { ok: false, error: 'That doesn\'t go there.' };
      const own = this.sql.exec('SELECT 1 FROM inventory WHERE item = ?', item).toArray().length; if (!own) return { ok: false, error: 'You don\'t own that yet.' };
    }
    c.items = { ...c.items, [slot]: item }; this.set('creature', c);
    await this.publish(now);
    return { ok: true };
  }

  async setTactics(t: unknown, now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false, error: 'Hatch first.' };
    c.tactics = sanitiseTactics(t); this.set('creature', c);
    await this.publish(now);
    return { ok: true, tactics: c.tactics };
  }

  /**
   * House NPC setup, run once by the seeding cron. Hatches through the normal path at a
   * fixed hatch time (so each NPC's Forkling is reproducible), then gives it its starting
   * XP, wardrobe and tactics. Battles and care afterwards use the normal methods.
   */
  async setupNpc(salt: string, hatchAt: number, xp: number, items: Record<string, string>, tactics: unknown, now = Date.now()) {
    if (!this.creature()) { const r = await this.hatch(salt, hatchAt); if (!r.ok) return r; }
    const c = this.creature()!;
    c.state = { ...newState(now), xp, stage: stageForXp(xp) };
    for (const it of Object.values(items)) this.sql.exec('INSERT OR IGNORE INTO inventory (item, got_at, source) VALUES (?, ?, ?)', it, now, 'npc');
    c.items = { head: null, face: null, neck: null, held: null, ...items };
    c.tactics = sanitiseTactics(tactics);
    this.set('creature', c);
    await this.publish(now);
    return { ok: true };
  }

  async ackEvolution(now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false };
    const s = stageForXp(c.state.xp);
    if (s > c.state.stage) { c.state.stage = c.state.stage + 1; this.set('creature', c); await this.publish(now); return { ok: true, stage: c.state.stage }; }
    return { ok: false, stage: c.state.stage };
  }

  snapshotOf(c: Creature): Snapshot {
    const who = this.get<any>('who');
    return { pid: who.pid, handle: who.handle, verified: !!who.verified, bot: false, seed: c.seed, stage: c.state.stage, level: levelForXp(c.state.xp), xp: Math.floor(c.state.xp), items: c.items, tactics: c.tactics };
  }

  /** Challenger side: check and spend energy, return the snapshot to fight with. */
  async prepareBattle(now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false, error: 'Hatch first.' };
    if (now < c.state.napUntil) return { ok: false, error: 'Your Forkling is napping.' };
    if (c.state.energy < BATTLE_ENERGY) return { ok: false, error: 'Too tired to battle. Let it rest or nap.' };
    const last = this.get<number>('lastBattle') ?? 0;
    if (now - last < BATTLE_COOLDOWN_MS) return { ok: false, error: 'Catching its breath. Try again in a few seconds.' };
    c.state.energy -= BATTLE_ENERGY; this.set('creature', c); this.set('lastBattle', now);
    return { ok: true, snapshot: this.snapshotOf(c) };
  }

  /** Called by the battle DO for both sides once a battle is simulated. */
  async recordBattle(id: string, side: 0 | 1, replay: { a: Snapshot; b: Snapshot; seed: string }, result: Pick<BattleResult, 'winner' | 'xp' | 'loot'>, ratingDelta: number, now = Date.now()) {
    const c = this.advanced(now); if (!c) return { ok: false };
    const opp = side === 0 ? replay.b : replay.a;
    const outcome = result.winner === null ? 'draw' : result.winner === side ? 'win' : 'loss';
    const xp = result.xp[side];
    c.state.xp += xp;
    c.state.mood = Math.max(0, Math.min(100, c.state.mood + (outcome === 'win' ? 6 : outcome === 'loss' ? -4 : 0)));
    let loot: string | null = null, lootNote: string | null = null;
    if (side === 0 && result.loot) {
      const have = this.sql.exec('SELECT 1 FROM inventory WHERE item = ?', result.loot).toArray().length;
      if (have) { c.state.xp += 10; lootNote = 'duplicate'; }
      else { this.sql.exec('INSERT INTO inventory (item, got_at, source) VALUES (?, ?, ?)', result.loot, now, 'battle:' + id); }
      loot = result.loot;
    }
    this.set('creature', c);
    this.sql.exec('INSERT OR IGNORE INTO battles (id, at, side, opp_handle, opp_bot, outcome, xp, loot, rating_delta, replay, seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, now, side, opp.handle, opp.bot ? 1 : 0, outcome, xp, loot ? loot + (lootNote ? ':' + lootNote : '') : null, ratingDelta, JSON.stringify(replay), side === 0 ? 1 : 0);
    await this.publish(now);
    return { ok: true, outcome, xp, loot, lootNote };
  }

  async battles(limit = 30) {
    const rows = this.sql.exec('SELECT id, at, side, opp_handle, opp_bot, outcome, xp, loot, rating_delta, seen FROM battles ORDER BY at DESC LIMIT ?', limit).toArray();
    this.sql.exec('UPDATE battles SET seen = 1 WHERE seen = 0');
    return rows;
  }

  async replay(id: string) {
    const r = this.sql.exec('SELECT id, at, side, outcome, replay FROM battles WHERE id = ?', id).toArray()[0] as any;
    if (!r) return null;
    return { id: r.id, at: r.at, side: r.side, outcome: r.outcome, ...JSON.parse(r.replay) };
  }

  /** Push the public, cross-player view (matchmaking pool and leaderboard) into D1. */
  private async publish(now: number) {
    const who = this.get<any>('who'); const c = this.creature(); if (!who || !c) return;
    const g = genome(c.seed);
    const snap = this.snapshotOf(c);
    await this.env.DB.prepare(`UPDATE players SET has_creature = 1, name = ?, seed = ?, level = ?, stage = ?, xp = ?, snapshot = ?, updated_at = ? WHERE pid = ?`)
      .bind(g.name, c.seed, snap.level, snap.stage, Math.floor(c.state.xp), JSON.stringify(snap), now, who.pid).run();
  }
}
