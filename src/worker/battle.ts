// Short-lived battle Durable Object: one instance per battle id. It runs the
// deterministic simulation outside both player DOs, then writes the outcome
// back to each player, to the D1 leaderboard and to the D1 battle record used
// for balancing. It stores nothing itself, so an idle battle DO costs nothing.
import { DurableObject } from 'cloudflare:workers';
import { elo, fighter, moveStats, type Snapshot, simulate, strategyOf, turnSummary } from '../shared/battle';
import type { Env } from './env';
import type { StoredReplay } from './player';

/** What a battle returns to the challenger (and over the API). Plain data: it crosses Workers RPC. */
export interface BattleOutcome {
  id: string;
  seed: string;
  a: Snapshot;
  b: Snapshot;
  ranked: boolean;
  winner: 0 | 1 | null;
  rounds: number;
  xp: number;
  loot: string | null;
  lootNote: string | null;
  ratingDelta: number;
}

export class BattleDO extends DurableObject<Env> {
  async run(id: string, a: Snapshot, b: Snapshot, seed: string, ranked: boolean): Promise<BattleOutcome> {
    const result = simulate(a, b, seed);
    const now = Date.now();

    // Ratings move only in ranked battles: full K between two real players, a small K against house bots.
    let na = 0,
      nb = 0,
      ra = 0,
      rb = 0;
    if (ranked) {
      ra = (await this.env.DB.prepare('SELECT rating FROM players WHERE pid = ?').bind(a.pid).first<number>('rating')) ?? 1000;
      rb = b.bot
        ? 1000 + (b.level - a.level) * 15
        : ((await this.env.DB.prepare('SELECT rating FROM players WHERE pid = ?').bind(b.pid).first<number>('rating')) ?? 1000);
      const score = result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5;
      [na, nb] = elo(ra, rb, score, b.bot ? 8 : 24);
    }
    const replay: StoredReplay = { a, b, seed };

    const pa = this.env.PLAYER.get(this.env.PLAYER.idFromName(a.pid));
    const recA = await pa.recordBattle(
      id,
      0,
      replay,
      { winner: result.winner, xp: result.xp, loot: result.loot },
      ranked ? na - ra : 0,
      now,
    );
    if (!b.bot) {
      const pb = this.env.PLAYER.get(this.env.PLAYER.idFromName(b.pid));
      await pb.recordBattle(id, 1, replay, { winner: result.winner, xp: result.xp, loot: null }, ranked ? nb - rb : 0, now);
    }
    const col = (w: 0 | 1 | null, side: 0 | 1) => (w === null ? 'draws' : w === side ? 'wins' : 'losses');
    const DB = this.env.DB;
    // House NPCs are tagged so balancing queries can leave them out: WHERE npc = 0.
    const isNpc = (s: Snapshot) => (s.pid.startsWith('npc:') ? 1 : 0);
    const npcBattle = isNpc(a) || isNpc(b) ? 1 : 0;
    const stmts = [
      DB.prepare(
        'INSERT INTO battles (id, at, challenger, defender, defender_bot, winner, seed, ranked, npc, rounds, sim_version, snap_a, snap_b, turns) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        now,
        a.pid,
        b.pid,
        b.bot ? 1 : 0,
        result.winner,
        seed,
        ranked ? 1 : 0,
        npcBattle,
        result.rounds,
        result.version,
        JSON.stringify({ ...a, strategy: strategyOf(a) }),
        JSON.stringify({ ...b, strategy: strategyOf(b) }),
        turnSummary(result),
      ),
      DB.prepare(
        `UPDATE players SET ${ranked ? 'rating = ?, ' : ''}${col(result.winner, 0)} = ${col(result.winner, 0)} + 1 WHERE pid = ?`,
      ).bind(...(ranked ? [na, a.pid] : [a.pid])),
    ];
    if (!b.bot)
      stmts.push(
        DB.prepare(
          `UPDATE players SET ${ranked ? 'rating = ?, ' : ''}${col(result.winner, 1)} = ${col(result.winner, 1)} + 1 WHERE pid = ?`,
        ).bind(...(ranked ? [nb, b.pid] : [b.pid])),
      );
    const lastHp = result.events.length ? result.events[result.events.length - 1].hp : result.maxHp;
    for (const [side, s] of [
      [0, a],
      [1, b],
    ] as const) {
      const f = fighter(s),
        st = strategyOf(s),
        t = s.tactics;
      stmts.push(
        DB.prepare(`INSERT INTO battle_sides (battle_id, side, pid, bot, npc, ranked, won, level, stage, type, head, face, neck, held, strategy_source, style, special, heal_at, aggression, max_hp, hp_left, at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id,
          side,
          s.pid,
          s.bot ? 1 : 0,
          isNpc(s),
          ranked ? 1 : 0,
          result.winner === null ? null : result.winner === side ? 1 : 0,
          s.level,
          s.stage,
          f.g.type,
          s.items?.head ?? null,
          s.items?.face ?? null,
          s.items?.neck ?? null,
          s.items?.held ?? null,
          st.source,
          st.style,
          st.source === 'tactics' ? t.special : null,
          st.source === 'tactics' ? t.healAt : null,
          st.source === 'tactics' ? t.aggression : null,
          result.maxHp[side],
          lastHp[side],
          now,
        ),
      );
    }
    for (const m of moveStats(result))
      stmts.push(
        DB.prepare(
          'INSERT INTO battle_moves (battle_id, side, move, kind, uses, hits, crits, misses, dmg, heal) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(id, m.side, m.move, m.kind, m.uses, m.hits, m.crits, m.misses, m.dmg, m.heal),
      );
    await DB.batch(stmts);

    return {
      id,
      seed,
      a,
      b,
      ranked,
      winner: result.winner,
      rounds: result.rounds,
      xp: result.xp[0],
      // A challenger with no creature records nothing ({ ok: false }): no loot then, as before.
      loot: recA.ok ? recA.loot : null,
      lootNote: recA.ok ? recA.lootNote : null,
      ratingDelta: ranked ? na - ra : 0,
    };
  }
}
