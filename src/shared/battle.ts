// Deterministic auto-battle. Given two snapshots and a battle seed, simulate()
// always produces the same event log, so a replay is just seed + snapshots.

import { ITEM_IDS, ITEMS } from './compose';
import { type Genome, genome, TYPES } from './genome';
import { mulberry, seedToInt } from './rng';
import { compileTactics, decide, type Strategy, sanitiseStrategy, type Tactics } from './strategy';

export type { Strategy, Tactics } from './strategy';
export { compileTactics, DEFAULT_TACTICS, sanitiseTactics } from './strategy';

export interface Snapshot {
  pid: string;
  handle: string;
  bot: boolean;
  seed: string;
  stage: number;
  level: number;
  xp?: number;
  items: Record<string, string | null>;
  tactics: Tactics;
  strategy?: Strategy;
  rating?: number;
}

/** The strategy a snapshot fights with: an explicit (script) strategy, else its compiled tactics. */
export function strategyOf(s: Snapshot): Strategy {
  return (s.strategy && sanitiseStrategy(s.strategy)) || compileTactics(s.tactics);
}

/** Held items give a small battle edge, capped at 6% of one stat. Other slots are cosmetic. */
export const HELD_EFFECTS: Record<string, { stat: 'atk' | 'def' | 'spd' | 'hp'; pct: number; label: string }> = {
  duck: { stat: 'def', pct: 6, label: '+6% Defence' },
  mug: { stat: 'spd', pct: 6, label: '+6% Speed' },
  keyboard: { stat: 'atk', pct: 6, label: '+6% Attack' },
};
export const HELD_CAP_PCT = 6;

export const MOVES: Record<string, { strike: string; special: string }> = {
  Async: { strike: 'Await Strike', special: 'Promise.all' },
  Kernel: { strike: 'Syscall', special: 'Segfault' },
  Markup: { strike: 'Tag Slap', special: 'Cascade' },
  Data: { strike: 'Query Jab', special: 'Drop Table' },
  Shell: { strike: 'Pipe Punch', special: 'Fork Bomb' },
  Cloud: { strike: 'Cold Start', special: 'Autoscale' },
  Pixel: { strike: 'Dither Dash', special: 'Palette Swap' },
  Logic: { strike: 'Short Circuit', special: 'Force Push' },
};
const STAGE_MULT = [1, 1.12, 1.28];
const STYLE = {
  steady: { acc: 0.97, crit: 0.04, vary: 0.05, mult: 1.0 },
  balanced: { acc: 0.93, crit: 0.1, vary: 0.1, mult: 1.0 },
  reckless: { acc: 0.85, crit: 0.2, vary: 0.2, mult: 1.1 },
};
export const MAX_ROUNDS = 30;

export interface Fighter {
  g: Genome;
  snap: Snapshot;
  strat: Strategy;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  strike: string;
  special: string;
  held: string | null;
}

export function fighter(snap: Snapshot): Fighter {
  const g = genome(snap.seed);
  const m = (1 + 0.06 * (Math.max(1, snap.level) - 1)) * STAGE_MULT[snap.stage];
  const st = { hp: g.base.hp * m, atk: g.base.atk * m, def: g.base.def * m, spd: g.base.spd * m };
  const held = snap.items?.held ?? null;
  const eff = held ? HELD_EFFECTS[held] : undefined;
  if (eff) st[eff.stat] *= 1 + Math.min(HELD_CAP_PCT, eff.pct) / 100;
  return {
    g,
    snap,
    strat: strategyOf(snap),
    held: eff ? held : null,
    maxHp: Math.round(st.hp * 4.2),
    atk: st.atk,
    def: st.def,
    spd: st.spd,
    strike: MOVES[g.type].strike,
    special: MOVES[g.type].special,
  };
}

/** Damage multiplier when a type hits the one it has the edge over. */
export const TYPE_EDGE = 1.15;
/** Each type has the edge over the next one in TYPES, wrapping round. */
export function strongAgainst(type: string): string {
  return TYPES[(TYPES.indexOf(type) + 1) % TYPES.length];
}
export function typeMult(att: string, def: string): number {
  return strongAgainst(att) === def ? TYPE_EDGE : 1;
}

export interface BattleEvent {
  r: number;
  who: 0 | 1;
  kind: 'strike' | 'special' | 'guard' | 'heal' | 'faint';
  rule: number;
  move: string;
  dmg: number;
  heal: number;
  crit: boolean;
  miss: boolean;
  hp: [number, number];
  text: string;
}
export interface BattleResult {
  version: 1;
  seed: string;
  winner: 0 | 1 | null;
  rounds: number;
  maxHp: [number, number];
  events: BattleEvent[];
  xp: [number, number];
  loot: string | null;
}

export function simulate(a: Snapshot, b: Snapshot, battleSeed: string): BattleResult {
  const rng = mulberry(seedToInt(battleSeed) ^ 0xba771e);
  const F = [fighter(a), fighter(b)];
  const hp: [number, number] = [F[0].maxHp, F[1].maxHp];
  const cd = [0, 0];
  const heals = [2, 2],
    guard = [false, false],
    focus = [false, false];
  const events: BattleEvent[] = [];
  const name = (i: number) => F[i].g.name;
  let round = 0,
    winner: 0 | 1 | null = null;

  const act = (i: 0 | 1) => {
    const me = F[i],
      foe = F[1 - i],
      st = STYLE[me.strat.style] ?? STYLE.balanced;
    const d = decide(me.strat, {
      hp: (hp[i] / me.maxHp) * 100,
      foe_hp: (hp[1 - i] / foe.maxHp) * 100,
      turn: round,
      heals_left: heals[i],
      foe_heals_left: heals[1 - i],
      level: me.snap.level,
      foe_level: foe.snap.level,
      specialReady: cd[i] <= 0,
      focused: focus[i],
      foeGuarding: guard[1 - i],
      rng,
    });
    const kind: BattleEvent['kind'] = d.action;
    if (cd[i] > 0) cd[i]--;
    const ev: BattleEvent = {
      r: round,
      who: i,
      kind,
      rule: d.rule,
      move: '',
      dmg: 0,
      heal: 0,
      crit: false,
      miss: false,
      hp: [0, 0],
      text: '',
    };
    if (kind === 'heal') {
      heals[i]--;
      const amt = Math.round(me.maxHp * 0.28);
      const before = hp[i];
      hp[i] = Math.min(me.maxHp, hp[i] + amt);
      ev.heal = hp[i] - before;
      ev.move = 'Rollback';
      ev.text = `${name(i)} used Rollback and recovered ${ev.heal} HP`;
    } else if (kind === 'guard') {
      guard[i] = true;
      focus[i] = true;
      ev.move = 'Code Review';
      ev.text = `${name(i)} braced with Code Review`;
    } else {
      const power = kind === 'special' ? 18 : 9;
      if (kind === 'special') cd[i] = 3;
      ev.move = kind === 'special' ? me.special : me.strike;
      if (rng() > st.acc) {
        ev.miss = true;
        ev.text = `${name(i)} used ${ev.move}, but it missed`;
      } else {
        const crit = rng() < st.crit;
        const vary = 1 + (rng() * 2 - 1) * st.vary;
        let dmg =
          power * ((2 * me.atk) / (me.atk + foe.def)) * vary * st.mult * typeMult(me.g.type, foe.g.type) * (1 + 0.06 * (me.snap.level - 1));
        if (crit) dmg *= 1.6;
        if (focus[i]) dmg *= 1.3;
        if (guard[1 - i]) dmg *= 0.5;
        ev.dmg = Math.max(1, Math.round(dmg));
        ev.crit = crit;
        hp[1 - i] = Math.max(0, hp[1 - i] - ev.dmg);
        ev.text = `${name(i)} used ${ev.move}${crit ? '. Critical hit' : ''}${guard[1 - i] ? ' (guarded)' : ''}`;
        guard[1 - i] = false;
      }
      focus[i] = false;
    }
    ev.hp = [hp[0], hp[1]];
    events.push(ev);
    if (hp[1 - i] <= 0) {
      winner = i;
      events.push({
        r: round,
        who: (1 - i) as 0 | 1,
        kind: 'faint',
        rule: -1,
        move: '',
        dmg: 0,
        heal: 0,
        crit: false,
        miss: false,
        hp: [hp[0], hp[1]],
        text: `${name(1 - i)} crashed`,
      });
    }
  };

  while (winner === null && round < MAX_ROUNDS) {
    round++;
    const first: 0 | 1 = F[0].spd > F[1].spd ? 0 : F[1].spd > F[0].spd ? 1 : rng() < 0.5 ? 0 : 1;
    act(first);
    if (winner === null) act((1 - first) as 0 | 1);
  }
  if (winner === null) {
    const pa = hp[0] / F[0].maxHp,
      pb = hp[1] / F[1].maxHp;
    winner = pa > pb ? 0 : pb > pa ? 1 : null;
  }
  const lv = [a.level, b.level];
  const xpFor = (i: number) => (winner === i ? 20 : winner === null ? 12 : 8) + Math.max(-6, Math.min(10, 2 * (lv[1 - i] - lv[i])));
  // Loot is rolled for the challenger (side 0) from the same seed, after the fight.
  let loot: string | null = null;
  const chance = winner === 0 ? 0.6 : 0.15;
  if (rng() < chance) loot = rollItem(rng);
  return {
    version: 1,
    seed: battleSeed,
    winner,
    rounds: round,
    maxHp: [F[0].maxHp, F[1].maxHp],
    events,
    xp: [Math.max(4, xpFor(0)), Math.max(2, Math.round(xpFor(1) / 2))],
    loot,
  };
}

/** Compact per-turn summary for analytics: side, move code, damage/heal, flags. e.g. "1.0S12 1.1Px 2.0G 2.1H14 3.0P31c". */
export function turnSummary(r: BattleResult): string {
  const code = { strike: 'S', special: 'P', guard: 'G', heal: 'H' } as Record<string, string>;
  return r.events
    .filter((e) => e.kind !== 'faint')
    .map(
      (e) =>
        `${e.r}.${e.who}${code[e.kind]}${e.miss ? 'x' : e.kind === 'heal' ? e.heal : e.kind === 'guard' ? '' : e.dmg}${e.crit ? 'c' : ''}`,
    )
    .join(' ');
}

/** Per-side, per-move aggregates for win-rate queries by move, item and tactic. */
export function moveStats(r: BattleResult) {
  const m = new Map<
    string,
    { side: 0 | 1; move: string; kind: string; uses: number; hits: number; crits: number; misses: number; dmg: number; heal: number }
  >();
  for (const e of r.events) {
    if (e.kind === 'faint') continue;
    const k = `${e.who}|${e.move}`;
    const s = m.get(k) ?? { side: e.who, move: e.move, kind: e.kind, uses: 0, hits: 0, crits: 0, misses: 0, dmg: 0, heal: 0 };
    s.uses++;
    if (e.miss) s.misses++;
    else if (e.kind === 'strike' || e.kind === 'special') s.hits++;
    if (e.crit) s.crits++;
    s.dmg += e.dmg;
    s.heal += e.heal;
    m.set(k, s);
  }
  return [...m.values()];
}

const RARITY_WEIGHT = [50, 30, 14, 6];
export function rollItem(rng: () => number): string {
  const w = ITEM_IDS.map((id) => RARITY_WEIGHT[ITEMS[id].rarity] ?? 1);
  let x = rng() * w.reduce((s, v) => s + v, 0);
  for (let i = 0; i < ITEM_IDS.length; i++) {
    x -= w[i];
    if (x < 0) return ITEM_IDS[i];
  }
  return ITEM_IDS[ITEM_IDS.length - 1];
}

/** Elo with a smaller K for bot fights, so bots can't be farmed for rating. */
export function elo(ra: number, rb: number, scoreA: number, k = 24): [number, number] {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const d = Math.round(k * (scoreA - ea));
  return [ra + d, rb - d];
}
