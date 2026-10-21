import { describe, expect, test } from 'bun:test';
import { type BattleEvent, type BattleResult, fighter, MAX_ROUNDS, type Snapshot, simulate } from '../../src/shared/battle';
import { sha256Hex } from '../../src/shared/rng';
import { DEFAULT_TACTICS } from '../../src/shared/strategy';
import { battleVerdict } from '../../src/shared/verdict';

const snap = async (name: string, over: Partial<Snapshot> = {}): Promise<Snapshot> => ({
  pid: `p:${name}`,
  handle: name,
  bot: false,
  seed: await sha256Hex(`creature|${name}`),
  stage: 1,
  level: 5,
  items: { head: null, face: null, neck: null, held: null },
  tactics: DEFAULT_TACTICS,
  ...over,
});

/** A hand-written fight: each step is [who, kind, amount], with HP tracked from full. */
function fight(
  a: Snapshot,
  b: Snapshot,
  steps: [0 | 1, BattleEvent['kind'], number][],
  winner: 0 | 1 | null,
  rounds = steps.length,
): BattleResult {
  const maxHp: [number, number] = [fighter(a).maxHp, fighter(b).maxHp];
  const hp: [number, number] = [...maxHp];
  const events: BattleEvent[] = steps.map(([who, kind, n], i) => {
    const foe = (1 - who) as 0 | 1;
    let dmg = 0,
      heal = 0;
    if (kind === 'strike' || kind === 'special') {
      dmg = n;
      hp[foe] = Math.max(0, hp[foe] - n);
    } else if (kind === 'heal') {
      heal = n;
      hp[who] = Math.min(maxHp[who], hp[who] + n);
    }
    return { r: i + 1, who, kind, rule: 0, move: kind, dmg, heal, crit: false, miss: false, hp: [hp[0], hp[1]], text: '' };
  });
  return { version: 1, seed: 'test', winner, rounds, maxHp, events, xp: [8, 4], loot: null };
}
const pctOf = (side: 0 | 1, p: number, a: Snapshot, b: Snapshot) => Math.round((fighter(side === 0 ? a : b).maxHp * p) / 100);

describe('battle verdict', () => {
  test('a loss to a much higher level says so first', async () => {
    const a = await snap('low', { level: 2 }),
      b = await snap('high', { level: 6 });
    const hit = fighter(a).maxHp;
    const v = battleVerdict(
      a,
      b,
      fight(
        a,
        b,
        [
          [1, 'strike', hit],
          [0, 'faint', 0],
        ],
        1,
      ),
    );
    expect(v.outcome).toBe('loss');
    expect(v.reason).toBe(`${fighter(b).g.name} is Level 6, you're Level 2.`);
    expect(v.nudge).toBe('grow');
  });

  test('a loss with healing switched off points at Coach', async () => {
    const a = await snap('noheal', { tactics: { ...DEFAULT_TACTICS, healAt: 0 } }),
      b = await snap('rival');
    const v = battleVerdict(
      a,
      b,
      fight(
        a,
        b,
        [
          [1, 'strike', fighter(a).maxHp],
          [0, 'faint', 0],
        ],
        1,
      ),
    );
    expect(v.reason).toStartWith('Your plan never heals.');
    expect(v.nudge).toBe('coach');
  });

  test('a heal that never fired names the hit that skipped past it', async () => {
    const a = await snap('healer'),
      b = await snap('rival');
    const max = fighter(a).maxHp;
    const r = fight(
      a,
      b,
      [
        [1, 'strike', pctOf(0, 40, a, b)],
        [0, 'strike', 5],
        [1, 'special', max],
        [0, 'faint', 0],
      ],
      1,
    );
    const v = battleVerdict(a, b, r);
    expect(v.reason).toBe(`Your heal never fired: ${fighter(a).g.name} went from 60% HP to 0 in one hit.`);
    expect(v.nudge).toBe('coach');
  });

  test('a win that needed Rollback credits it', async () => {
    const a = await snap('comeback'),
      b = await snap('rival');
    const r = fight(
      a,
      b,
      [
        [1, 'strike', pctOf(0, 80, a, b)],
        [0, 'heal', pctOf(0, 15, a, b)],
        [1, 'strike', pctOf(0, 5, a, b)],
        [0, 'special', fighter(b).maxHp],
        [1, 'faint', 0],
      ],
      0,
    );
    const v = battleVerdict(a, b, r);
    expect(v.outcome).toBe('win');
    expect(v.reason).toStartWith('Rollback won it:');
    expect(v.nudge).toBe('again');
  });

  test('a fight decided on time says time ran out, not a knockout', async () => {
    const a = await snap('slow'),
      b = await snap('rival');
    const r = fight(a, b, [[1, 'strike', 10]], 1, MAX_ROUNDS);
    const v = battleVerdict(a, b, r);
    expect(v.outcome).toBe('loss');
    expect(v.reason).toStartWith(`Time ran out after ${MAX_ROUNDS} rounds`);
  });

  test('draws and the defender’s side read the same fight correctly', async () => {
    const a = await snap('left'),
      b = await snap('right');
    expect(battleVerdict(a, b, fight(a, b, [], null, MAX_ROUNDS)).outcome).toBe('draw');
    const r = fight(
      a,
      b,
      [
        [0, 'special', fighter(b).maxHp],
        [1, 'faint', 0],
      ],
      0,
    );
    expect(battleVerdict(a, b, r, 0).outcome).toBe('win');
    expect(battleVerdict(a, b, r, 1).outcome).toBe('loss');
  });

  test('every simulated fight gets one clean, repeatable reason', async () => {
    for (let i = 0; i < 300; i++) {
      const a = await snap(`a${i}`, { level: 1 + (i % 9), stage: i % 3, tactics: { ...DEFAULT_TACTICS, healAt: [0, 25, 40, 60][i % 4] } }),
        b = await snap(`b${i}`, { level: 1 + ((i * 5) % 9), stage: (i + 1) % 3 });
      const r = simulate(a, b, await sha256Hex(`v${i}`));
      for (const side of [0, 1] as const) {
        const v = battleVerdict(a, b, r, side);
        expect(v.outcome).toBe(r.winner === null ? 'draw' : r.winner === side ? 'win' : 'loss');
        expect(v.reason).not.toMatch(/undefined|NaN|null/);
        expect(v.reason.length).toBeLessThan(110);
        expect(battleVerdict(a, b, r, side)).toEqual(v);
      }
    }
  });
});
