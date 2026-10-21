// House bot Forklings, used when there aren't enough real players to match.

import type { Snapshot, Tactics } from './battle';
import { ITEM_IDS, ITEMS } from './compose';
import { mulberry, seedToInt } from './rng';
import { levelForXp, STAGE_XP, stageForXp } from './state';

const A = [
  'sleepy',
  'tabs',
  'null',
  'async',
  'yaml',
  'rubber',
  'merge',
  'sudo',
  'lint',
  'cache',
  'flaky',
  'legacy',
  'hotfix',
  'pixel',
  'tiny',
  'grumpy',
  'midnight',
  'semver',
];
const B = [
  'compiler',
  'not-spaces',
  'pointer',
  'await',
  'wrangler',
  'duck',
  'queen',
  'sandwich',
  'goblin',
  'miss',
  'test',
  'wizard',
  'friday',
  'pusher',
  'gremlin',
  'owl',
  'oracle',
  'bard',
];

/** Build a bot near the player's growth. `seedHex` is a 64-char hex battle-derived seed. */
export function makeBot(seedHex: string, playerXp: number): Snapshot {
  const r = mulberry(seedToInt(seedHex) ^ 0xb07);
  const handle = `${A[Math.floor(r() * A.length)]}-${B[Math.floor(r() * B.length)]}`;
  // Within about 20% of the player's XP, but never across an evolution the player hasn't reached.
  let xp = Math.max(0, Math.round(playerXp * (0.8 + r() * 0.35)));
  const pst = stageForXp(playerXp);
  if (stageForXp(xp) > pst) xp = Math.max(0, (pst < 2 ? STAGE_XP[pst + 1] : xp) - 1);
  const tactics: Tactics = {
    aggression: 35 + Math.floor(r() * 55),
    special: r() < 0.6 ? 'open' : 'save',
    healAt: [0, 25, 40][Math.floor(r() * 3)],
    style: (['steady', 'balanced', 'reckless'] as const)[Math.floor(r() * 3)],
  };
  const items: Record<string, string | null> = { head: null, face: null, neck: null, held: null };
  if (r() < 0.5) {
    const id = ITEM_IDS[Math.floor(r() * ITEM_IDS.length)];
    items[ITEMS[id].slot] = id;
  }
  // Creature seed: re-mix the battle seed so the bot never shares the challenger's seed bits.
  const cs = (seedToInt(seedHex) ^ 0x9e3779b9) >>> 0;
  const seed = cs.toString(16).padStart(8, '0') + seedHex.slice(8);
  return {
    pid: `bot:${handle}`,
    handle,
    verified: false,
    bot: true,
    seed,
    stage: stageForXp(xp),
    level: levelForXp(xp),
    xp,
    items,
    tactics,
    rating: 1000,
  };
}
