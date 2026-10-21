// The bits economy: what things cost, what unlocks when, and what play earns.
// Every number here is explained in docs/economy.md; tests in test/unit/economy.test.ts
// check the daily earnings of a casual and a grinding player stay in the intended bands.
import { HELD_CAP_PCT } from './battle';
import { ITEMS, type ItemDef, type Stat } from './compose';

/** The currency's name in the interface. Bits are earned by playing; they can never be bought. */
export const CURRENCY = { one: 'bit', many: 'bits' };

/** Every new Forkling (and every existing one, the first time it opens the shop) starts with this. */
export const START_BITS = 50;

/** Base price by rarity (Common, Uncommon, Rare, Epic). Held items cost a quarter more: they help in battle. */
export const PRICE = [40, 80, 150, 260];
export const HELD_PRICE_FACTOR = 1.25;
/** Level needed to buy, by rarity: [lowest, highest]. Generated items pick a level in the range. */
export const LEVEL_RANGE: [number, number][] = [
  [1, 3],
  [3, 7],
  [6, 12],
  [12, 20],
];
/** Battle edge of a generated held item by rarity, in percent of one stat. Never above the engine cap. */
export const HELD_PCT = [3, 4, 5, 6].map((p) => Math.min(p, HELD_CAP_PCT));

export const REWARDS = {
  /** Per battle you fight (side 0), by outcome. */
  win: 12,
  draw: 6,
  loss: 3,
  /** When someone challenges you and you win. Losing a defence earns nothing. */
  defendWin: 4,
  /** Full battle rewards stop after this many rewarded battles in a UTC day; after that a win pays `taperedWin`. */
  fullBattlesPerDay: 12,
  taperedWin: 3,
  /** Once per UTC day, on your first win (as challenger or defender). */
  firstWinOfDay: 25,
  /** Once per UTC day, for a care action that leaves fullness, mood and energy all at or above `careBonusMin`. */
  dailyCare: 10,
  careBonusMin: 40,
  /** Evolving into a Junior, then a Prime. */
  evolve: [0, 60, 150],
};

/** Bits for reaching a level: 5 plus 2 per level (level 2 pays 9, level 10 pays 25, level 20 pays 45). */
export const levelUpReward = (level: number) => (level < 2 ? 0 : 5 + 2 * level);

/** Rounded to the nearest 5, so prices read cleanly. */
const round5 = (n: number) => Math.round(n / 5) * 5;
export function basePrice(rarity: number, slot: string): number {
  const p = PRICE[Math.max(0, Math.min(3, rarity))];
  return round5(slot === 'held' ? p * HELD_PRICE_FACTOR : p);
}

/** The UTC day of a timestamp, YYYY-MM-DD. The shop restocks and daily bonuses reset at 00:00 UTC. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The next 00:00 UTC after `ms`. */
export const nextUtcMidnight = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
/** The UTC day before `day`. */
export const prevDay = (day: string) => utcDay(Date.parse(`${day}T00:00:00Z`) - 86400e3);

/**
 * The classics: the original wardrobe, always on sale. Starters come free with every egg;
 * the rest unlock by level. Loot from battles can still drop any classic at any level.
 */
export const CLASSICS: Record<string, { level: number; price: number }> = {
  beanie: { level: 1, price: 40 },
  glasses: { level: 1, price: 40 },
  mug: { level: 1, price: 60 },
  scarf: { level: 2, price: 45 },
  bowtie: { level: 3, price: 80 },
  party: { level: 3, price: 80 },
  phones: { level: 5, price: 90 },
  keyboard: { level: 6, price: 120 },
  cap: { level: 8, price: 150 },
  shades: { level: 8, price: 150 },
  duck: { level: 10, price: 190 },
  crown: { level: 15, price: 300 },
};

/** Where an offer sits in the shop: made last night, back from an earlier day, or always stocked. */
export type OfferTag = 'new' | 'back' | 'classic';
/** One thing on sale. The def travels with it, so the client can draw and preview it. */
export interface Offer {
  id: string;
  def: ItemDef;
  level: number;
  price: number;
  tag: OfferTag;
}

export function classicOffers(): Offer[] {
  return Object.entries(CLASSICS).map(([id, c]) => ({ id, def: ITEMS[id], level: c.level, price: c.price, tag: 'classic' as const }));
}

/** The battle effect of any item: a classic's fixed effect or a generated item's recorded one, capped. */
export function itemEffect(d: ItemDef | undefined, classic?: { stat: Stat; pct: number }) {
  const e = classic ?? d?.effect;
  return e && d?.slot === 'held' ? { stat: e.stat, pct: Math.min(HELD_CAP_PCT, e.pct) } : undefined;
}

/**
 * Bits for a player who already had a Forkling when the shop opened: the usual starting 50
 * plus 10 per level above 1, up to 250. Their past levels and evolutions don't pay out again.
 */
export const welcomeBits = (level: number) => Math.min(250, START_BITS + 10 * Math.max(0, level - 1));

/** The lock line under a level-locked item, or null when it's unlocked. */
export function lockMessage(itemLevel: number, myLevel: number): string | null {
  if (myLevel >= itemLevel) return null;
  const gap = itemLevel - myLevel;
  return `Unlocks at level ${itemLevel}: ${gap} level${gap === 1 ? '' : 's'} to go.`;
}

export type PurchaseCheck = { ok: true } | { ok: false; code: 'locked' | 'owned' | 'funds'; error: string };
/** Whether a player can buy an offer. The same rules run in the shop UI and, authoritatively, in the player's Durable Object. */
export function checkPurchase(o: { level: number; price: number }, me: { level: number; bits: number; owned: boolean }): PurchaseCheck {
  if (me.owned) return { ok: false, code: 'owned', error: 'Already in your wardrobe.' };
  const lock = lockMessage(o.level, me.level);
  if (lock) return { ok: false, code: 'locked', error: lock };
  if (me.bits < o.price) {
    const short = o.price - me.bits;
    return { ok: false, code: 'funds', error: `You need ${short} more ${short === 1 ? CURRENCY.one : CURRENCY.many}.` };
  }
  return { ok: true };
}

/** A battle's bits for one side, before the daily taper. */
export function battleBits(side: 0 | 1, outcome: 'win' | 'loss' | 'draw'): number {
  if (side === 1) return outcome === 'win' ? REWARDS.defendWin : 0;
  return REWARDS[outcome];
}
