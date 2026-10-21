import { describe, expect, test } from 'bun:test';
import { DEFAULT_TACTICS, type Snapshot, simulate } from '../../src/shared/battle';
import { makeBot } from '../../src/shared/bots';
import { isOnboarding, ONBOARDING_BATTLES, pickOpponent, TUTORIAL_STRATEGY, tutorialBot } from '../../src/shared/matchmaking';
import { NPC_ROSTER, npcPid } from '../../src/shared/npcs';
import { sha256Hex } from '../../src/shared/rng';
import { levelForXp, stageForXp } from '../../src/shared/state';

const player = async (name: string, xp: number): Promise<Snapshot> => ({
  pid: `demo:${name}`,
  handle: name,
  verified: false,
  bot: false,
  seed: await sha256Hex(`creature|${name}`),
  stage: stageForXp(xp),
  level: levelForXp(xp),
  xp,
  items: { head: null, face: null, neck: null, held: null },
  tactics: DEFAULT_TACTICS,
});

/** Every roster NPC as it would come back from the pool query, whatever its level. */
const npcPool = async (): Promise<Snapshot[]> =>
  Promise.all(
    NPC_ROSTER.map(async (n) => ({
      pid: npcPid(n.handle),
      handle: n.handle,
      verified: false,
      bot: false,
      seed: await sha256Hex(`creature|${n.handle}`),
      stage: stageForXp(n.xp),
      level: levelForXp(n.xp),
      xp: n.xp,
      items: { head: null, face: null, neck: null, held: null, ...n.items },
      tactics: n.tactics,
    })),
  );

const seeds = async (i: number) => ({ seed: await sha256Hex(`battle|${i}`), botSeed: await sha256Hex(`bot|${i}`) });

describe('matchmaking', () => {
  test("a Level 1 player's first opponent is never higher level", async () => {
    const pool = await npcPool();
    for (let i = 0; i < 300; i++) {
      const me = await player(`new${i}`, 0);
      expect(me.level).toBe(1);
      const foe = pickOpponent({ me, started: 0, pool, ...(await seeds(i)) });
      expect(foe.level).toBeLessThanOrEqual(1);
      expect(foe.xp ?? 0).toBeLessThanOrEqual(me.xp ?? 0);
    }
  });

  test('the first three battles never meet a higher level, even if the pool offers one', async () => {
    const pool = await npcPool();
    for (const xp of [0, 8, 20, 30, 50, 100, 250]) {
      for (let started = 0; started < ONBOARDING_BATTLES; started++) {
        for (let i = 0; i < 60; i++) {
          const me = await player(`p${xp}-${i}`, xp);
          const foe = pickOpponent({ me, started, pool, ...(await seeds(i)) });
          expect(foe.level).toBeLessThanOrEqual(me.level);
          if (foe.bot) expect(foe.xp).toBe(xp);
          else expect(foe.pid.startsWith('npc:')).toBe(true);
        }
      }
    }
  });

  test('onboarding battles 2 and 3 can still meet an NPC at or below the player', async () => {
    const pool = await npcPool();
    const me = await player('mid', 250); // Level 7: several roster NPCs are at or below it
    const foes = await Promise.all(Array.from({ length: 80 }, async (_, i) => pickOpponent({ me, started: 1, pool, ...(await seeds(i)) })));
    expect(foes.some((f) => !f.bot)).toBe(true);
    expect(foes.every((f) => f.level <= me.level)).toBe(true);
  });

  test('the first opponent is the tutorial bot, which guards on turn 2', async () => {
    for (let i = 0; i < 50; i++) {
      const me = await player(`tut${i}`, 0);
      const { seed, botSeed } = await seeds(i);
      const foe = pickOpponent({ me, started: 0, pool: [], seed, botSeed });
      expect(foe).toEqual(tutorialBot(botSeed, me));
      expect(foe.bot).toBe(true);
      expect(foe.strategy).toEqual(TUTORIAL_STRATEGY);
      expect(Object.values(foe.items).every((v) => v === null)).toBe(true);
      const r = simulate(me, foe, seed);
      const foeTurn2 = r.events.filter((e) => e.who === 1 && e.r === 2 && e.kind !== 'faint');
      if (r.rounds >= 2 && foeTurn2.length) expect(foeTurn2[0].kind).toBe('guard');
      expect(r.events.filter((e) => e.who === 1 && e.kind !== 'faint' && e.r !== 2).every((e) => e.kind === 'strike')).toBe(true);
    }
  });

  test('a new player wins most first fights', async () => {
    const pool = await npcPool();
    let wins = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const me = await player(`win${i}`, 0);
      const { seed, botSeed } = await seeds(i);
      if (simulate(me, pickOpponent({ me, started: 0, pool, seed, botSeed }), seed).winner === 0) wins++;
    }
    expect(wins / N).toBeGreaterThan(0.6);
  });

  test('after three battles the usual rules apply unchanged', async () => {
    const pool = await npcPool();
    const me = await player('vet', 0);
    expect(isOnboarding(ONBOARDING_BATTLES)).toBe(false);
    let higher = 0;
    for (let i = 0; i < 100; i++) {
      const { seed, botSeed } = await seeds(i);
      const foe = pickOpponent({ me, started: ONBOARDING_BATTLES, pool, seed, botSeed });
      // Same choice as before this change: a pool pick when the seed byte is below 200, else makeBot.
      const expected =
        parseInt(seed.slice(8, 10), 16) < 200
          ? { ...pool[parseInt(seed.slice(10, 14), 16) % pool.length], bot: false }
          : makeBot(botSeed, 0);
      expect(foe).toEqual(expected);
      if (foe.level > me.level) higher++;
    }
    expect(higher).toBeGreaterThan(0);
  });

  test('house NPCs skip onboarding', async () => {
    const pool = await npcPool();
    const me = await player('npc-like', 0);
    for (let i = 0; i < 40; i++) {
      const { seed, botSeed } = await seeds(i);
      expect(pickOpponent({ me, started: 0, pool, seed, botSeed, onboard: false })).toEqual(
        pickOpponent({ me, started: ONBOARDING_BATTLES, pool, seed, botSeed }),
      );
    }
  });
});
