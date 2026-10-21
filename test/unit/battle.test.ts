import { describe, expect, test } from 'bun:test';
import {
  elo,
  fighter,
  HELD_CAP_PCT,
  HELD_EFFECTS,
  MAX_ROUNDS,
  moveStats,
  type Snapshot,
  simulate,
  strongAgainst,
  TYPE_EDGE,
  turnSummary,
} from '../../src/shared/battle';
import { makeBot } from '../../src/shared/bots';
import { TYPES } from '../../src/shared/genome';
import { sha256Hex } from '../../src/shared/rng';
import {
  type Ctx,
  compileTactics,
  DEFAULT_TACTICS,
  decide,
  type Expr,
  type Strategy,
  sanitiseStrategy,
  sanitiseTactics,
} from '../../src/shared/strategy';

const snap = async (name: string, over: Partial<Snapshot> = {}): Promise<Snapshot> => ({
  pid: `p:${name}`,
  handle: name,
  verified: false,
  bot: false,
  seed: await sha256Hex(`creature|${name}`),
  stage: 1,
  level: 5,
  items: { head: null, face: null, neck: null, held: null },
  tactics: DEFAULT_TACTICS,
  ...over,
});

describe('battle simulation', () => {
  test('same seed and snapshots replay identically', async () => {
    const a = await snap('alice'),
      b = await snap('bob'),
      seed = await sha256Hex('battle-1');
    expect(simulate(a, b, seed)).toEqual(simulate(a, b, seed));
  });

  test('different seeds give different fights', async () => {
    const a = await snap('alice'),
      b = await snap('bob');
    const logs = new Set<string>();
    for (let i = 0; i < 10; i++) logs.add(turnSummary(simulate(a, b, await sha256Hex(`battle-${i}`))));
    expect(logs.size).toBeGreaterThan(5);
  });

  test('battles end, HP stays in range and the log is consistent', async () => {
    for (let i = 0; i < 200; i++) {
      const a = await snap(`a${i}`, { level: 1 + (i % 12), stage: i % 3 }),
        b = await snap(`b${i}`, { level: 1 + ((i * 7) % 12), stage: (i + 1) % 3 });
      const r = simulate(a, b, await sha256Hex(`s${i}`));
      expect(r.rounds).toBeLessThanOrEqual(MAX_ROUNDS);
      for (const e of r.events)
        for (const s of [0, 1]) {
          expect(e.hp[s]).toBeGreaterThanOrEqual(0);
          expect(e.hp[s]).toBeLessThanOrEqual(r.maxHp[s]);
        }
      if (r.winner !== null && r.events.at(-1)!.kind === 'faint') expect(r.events.at(-1)!.hp[1 - r.winner]).toBe(0);
      expect(r.events.filter((e) => e.kind === 'heal' && e.who === 0).length).toBeLessThanOrEqual(2);
    }
  });

  test('higher level and evolution win more often', async () => {
    let strong = 0;
    for (let i = 0; i < 100; i++) {
      const a = await snap(`x${i}`, { level: 12, stage: 2 }),
        b = await snap(`y${i}`, { level: 3, stage: 0 });
      if (simulate(a, b, await sha256Hex(`lv${i}`)).winner === 0) strong++;
    }
    expect(strong).toBeGreaterThan(85);
  });

  test('loot only comes from the item catalogue and is deterministic', async () => {
    const a = await snap('alice'),
      b = await snap('bob');
    for (let i = 0; i < 50; i++) {
      const s = await sha256Hex(`loot${i}`);
      const r = simulate(a, b, s);
      expect(r.loot).toBe(simulate(a, b, s).loot);
    }
  });

  test('analytics summaries match the event log', async () => {
    const r = simulate(await snap('alice'), await snap('bob'), await sha256Hex('an'));
    const ms = moveStats(r);
    expect(ms.reduce((n, m) => n + m.uses, 0)).toBe(r.events.filter((e) => e.kind !== 'faint').length);
    expect(ms.filter((m) => m.side === 1).reduce((n, m) => n + m.dmg, 0)).toBe(
      r.maxHp[0] - r.events.at(-1)!.hp[0] + ms.filter((m) => m.side === 0).reduce((n, m) => n + m.heal, 0),
    );
    expect(turnSummary(r).split(' ').length).toBe(r.events.filter((e) => e.kind !== 'faint').length);
  });
});

describe('types', () => {
  test('each type has the edge over exactly one other, in a single loop', () => {
    expect(TYPE_EDGE).toBeGreaterThan(1);
    expect(new Set(TYPES.map(strongAgainst)).size).toBe(TYPES.length);
    for (const t of TYPES) expect(strongAgainst(t)).not.toBe(t);
    let t = TYPES[0];
    for (let i = 0; i < TYPES.length; i++) t = strongAgainst(t);
    expect(t).toBe(TYPES[0]);
    expect(strongAgainst('Markup')).toBe('Data');
  });
});

describe('held items', () => {
  test('give a small, capped edge to one stat', async () => {
    const base = fighter(await snap('h')),
      duck = fighter(await snap('h', { items: { head: null, face: null, neck: null, held: 'duck' } }));
    expect(duck.def / base.def).toBeCloseTo(1 + HELD_EFFECTS.duck.pct / 100, 6);
    expect(duck.atk).toBe(base.atk);
    for (const e of Object.values(HELD_EFFECTS)) expect(e.pct).toBeLessThanOrEqual(HELD_CAP_PCT);
  });
  test('cosmetic slots never change stats', async () => {
    const base = fighter(await snap('c')),
      dressed = fighter(await snap('c', { items: { head: 'crown', face: 'shades', neck: 'scarf', held: null } }));
    expect([dressed.maxHp, dressed.atk, dressed.def, dressed.spd]).toEqual([base.maxHp, base.atk, base.def, base.spd]);
  });
});

describe('strategy', () => {
  const ctx = (o: Partial<Ctx> = {}): Ctx => ({
    hp: 100,
    foe_hp: 100,
    turn: 1,
    heals_left: 2,
    foe_heals_left: 2,
    level: 1,
    foe_level: 1,
    specialReady: true,
    focused: false,
    foeGuarding: false,
    rng: () => 0.5,
    ...o,
  });

  test('tactics compile to rules with the expected priorities', () => {
    const s = compileTactics({ aggression: 0, special: 'save', healAt: 40, style: 'steady' });
    expect(decide(s, ctx({ hp: 30 })).action).toBe('heal');
    expect(decide(s, ctx({ hp: 20, heals_left: 0 })).action).toBe('special');
    expect(decide(s, ctx({ foe_hp: 20 })).action).toBe('special');
    expect(decide(s, ctx()).action).toBe('guard');
    expect(decide(s, ctx({ focused: true })).action).toBe('strike');
    expect(decide(compileTactics({ ...DEFAULT_TACTICS, aggression: 100, special: 'open' }), ctx({ specialReady: false })).action).toBe(
      'strike',
    );
  });

  test('runs out of fuel safely instead of looping', () => {
    let e: Expr = { op: 'true' };
    for (let i = 0; i < 500; i++) e = { op: 'and', a: e, b: { op: 'true' } };
    const s: Strategy = { v: 1, source: 'script', style: 'balanced', rules: [{ when: e, do: 'guard' }] };
    expect(decide(s, ctx())).toEqual({ action: 'strike', rule: -1 });
  });

  test('untrusted strategies are validated', () => {
    expect(sanitiseStrategy({ rules: [{ when: { op: 'eval', code: 'x' }, do: 'strike' }] })).toBeNull();
    expect(sanitiseStrategy({ rules: [{ when: { op: '<', a: { var: 'constructor' }, b: { num: 1 } }, do: 'strike' }] })).toBeNull();
    expect(sanitiseStrategy({ style: 'reckless', rules: [{ when: { op: 'chance', p: 500 }, do: 'strike' }] })!.rules[0].when).toEqual({
      op: 'chance',
      p: 100,
    });
  });

  test('tactics input is clamped', () => {
    expect(sanitiseTactics({ aggression: 900, special: 'x', healAt: 13, style: 'wild' })).toEqual({
      aggression: 100,
      special: 'open',
      healAt: 25,
      style: 'balanced',
    });
  });
});

describe('bots and rating', () => {
  test('bots are deterministic and never out-evolve the player', async () => {
    for (let i = 0; i < 100; i++) {
      const s = await sha256Hex(`bot${i}`);
      expect(makeBot(s, 100)).toEqual(makeBot(s, 100));
      expect(makeBot(s, 100).stage).toBe(0);
      expect(makeBot(s, 100).bot).toBe(true);
    }
  });
  test('elo is zero-sum and favours upsets', () => {
    const [a, b] = elo(1000, 1200, 1);
    expect(a + b).toBe(2200);
    expect(a - 1000).toBeGreaterThan(12);
  });
});
