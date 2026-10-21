// Opponent choice for a battle, kept pure so it can be tested without D1.
// The Worker (src/worker/index.ts) queries the candidate pool; this decides who fights.

import type { Snapshot, Strategy } from './battle';
import { makeBot } from './bots';

/** A player's first few battles are matched gently, so a new Forkling can win. */
export const ONBOARDING_BATTLES = 3;
/** Pool levels: within this many levels normally; during onboarding, never above the player. */
export const LEVEL_RANGE = 3;
/** A pool opponent is chosen when a battle-seed byte is below this (200/256, about 78%); otherwise a house bot. */
export const POOL_PICK_BELOW = 200;

export const isOnboarding = (startedBattles: number) => startedBattles < ONBOARDING_BATTLES;

/**
 * The tutorial opponent's script: braces with Guard (Code Review) on turn 2, then strikes
 * with the power-up that guarding gives. No signature move and no heals, so the very first
 * fight is winnable and shows the player what Guard does.
 */
export const TUTORIAL_STRATEGY: Strategy = {
  v: 1,
  source: 'script',
  style: 'steady',
  rules: [
    { when: { op: '==', a: { var: 'turn' }, b: { num: 2 } }, do: 'guard' },
    { when: { op: 'true' }, do: 'strike' },
  ],
};

/** A house bot at exactly the player's XP, level and stage, so it is never stronger by growth. */
export function sameXpBot(botSeed: string, me: Snapshot): Snapshot {
  const xp = me.xp ?? 0;
  return { ...makeBot(botSeed, xp), xp, level: me.level, stage: me.stage };
}

/** The first battle's sparring partner: a same-XP bot with no gear that runs TUTORIAL_STRATEGY. */
export function tutorialBot(botSeed: string, me: Snapshot): Snapshot {
  const bot = sameXpBot(botSeed, me);
  return { ...bot, items: { head: null, face: null, neck: null, held: null }, strategy: TUTORIAL_STRATEGY };
}

export interface MatchInput {
  /** The challenger's battle snapshot. */
  me: Snapshot;
  /** Battles this player has started before this one (capped counts are fine). */
  started: number;
  /** Candidates from the pool query, already excluding the player and recent opponents. */
  pool: Snapshot[];
  /** The battle seed (hex); bytes 8-14 decide pool versus bot and which candidate. */
  seed: string;
  /** A separate hex seed for building a house bot. */
  botSeed: string;
  /** False for house NPCs, which skip onboarding. */
  onboard?: boolean;
}

/**
 * Pick the opponent.
 * - First battle: the tutorial bot.
 * - Battles 2-3: an NPC at the player's level or lower, else a bot at the player's XP.
 * - After that: unchanged rules, a pool opponent about 78% of the time, else a bot near the player's XP.
 */
export function pickOpponent({ me, started, pool, seed, botSeed, onboard = true }: MatchInput): Snapshot {
  const gentle = onboard && isOnboarding(started);
  if (gentle && started <= 0) return tutorialBot(botSeed, me);
  // Defensive: the onboarding pool query already asks for npc = 1 and level <= mine.
  const rows = gentle ? pool.filter((s) => !s.bot && s.pid.startsWith('npc:') && s.level <= me.level) : pool;
  if (rows.length && parseInt(seed.slice(8, 10), 16) < POOL_PICK_BELOW) {
    const pick = rows[parseInt(seed.slice(10, 14), 16) % rows.length];
    return { ...pick, bot: false };
  }
  return gentle ? sameXpBot(botSeed, me) : makeBot(botSeed, me.xp ?? 0);
}
