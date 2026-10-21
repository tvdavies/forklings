// The bits economy's numbers: prices, level locks and their messages, and what a day of play earns.
// docs/economy.md explains the bands these tests hold the numbers to.
import { describe, expect, test } from 'bun:test';
import { HELD_CAP_PCT } from '../../src/shared/battle';
import { ITEMS } from '../../src/shared/compose';
import {
  basePrice,
  CLASSICS,
  checkPurchase,
  classicOffers,
  HELD_PCT,
  levelUpReward,
  lockMessage,
  nextUtcMidnight,
  npcPick,
  type Offer,
  PRICE,
  prevDay,
  REWARDS,
  START_BITS,
  utcDay,
} from '../../src/shared/economy';
import { RATES } from '../../src/shared/state';
import { makeWallet } from './sqlite';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const GOOD = { fullness: 80, mood: 80, energy: 80 };

describe('level locks', () => {
  test('say exactly how far away the item is', () => {
    expect(lockMessage(7, 3)).toBe('Unlocks at level 7: 4 levels to go.');
    expect(lockMessage(4, 3)).toBe('Unlocks at level 4: 1 level to go.');
    expect(lockMessage(3, 3)).toBeNull();
    expect(lockMessage(3, 9)).toBeNull();
  });
  test('owning beats locks, and locks beat price, so the message is always the useful one', () => {
    const o = { level: 10, price: 500 };
    expect(checkPurchase(o, { level: 1, bits: 0, owned: true })).toMatchObject({ ok: false, code: 'owned' });
    expect(checkPurchase(o, { level: 1, bits: 0, owned: false })).toMatchObject({ ok: false, code: 'locked' });
    expect(checkPurchase(o, { level: 10, bits: 499, owned: false })).toEqual({ ok: false, code: 'funds', error: 'You need 1 more bit.' });
    expect(checkPurchase(o, { level: 10, bits: 500, owned: false })).toEqual({ ok: true });
  });
});

describe('prices', () => {
  test('rise with rarity, held items cost more, and every price is a multiple of 5', () => {
    for (let r = 0; r < 4; r++) {
      expect(basePrice(r, 'head')).toBe(PRICE[r]);
      expect(basePrice(r, 'held')).toBeGreaterThan(basePrice(r, 'head'));
      expect(basePrice(r, 'held') % 5).toBe(0);
    }
  });
  test('every classic is on the shelf, with a level and price that fit its rarity', () => {
    const offers = classicOffers();
    expect(offers.map((o) => o.id).sort()).toEqual(Object.keys(CLASSICS).sort());
    for (const o of offers) {
      expect(ITEMS[o.id]).toBeDefined();
      expect(o.level).toBeGreaterThanOrEqual(1);
      expect(o.price).toBeGreaterThanOrEqual(PRICE[0]);
      expect(o.price % 5).toBe(0);
    }
    // the starter kit is affordable from the starting bits
    expect(offers.filter((o) => o.level === 1).some((o) => o.price <= START_BITS)).toBe(true);
  });
  test('held effects by rarity never pass the battle cap', () => {
    for (const p of HELD_PCT) expect(p).toBeLessThanOrEqual(HELD_CAP_PCT);
  });
});

describe('UTC days', () => {
  test('roll over at midnight UTC', () => {
    expect(utcDay(Date.UTC(2026, 9, 21, 23, 59, 59))).toBe('2026-10-21');
    expect(nextUtcMidnight(Date.UTC(2026, 9, 21, 23, 59, 59))).toBe(Date.UTC(2026, 9, 22));
    expect(prevDay('2026-11-01')).toBe('2026-10-31');
    expect(prevDay('2027-01-01')).toBe('2026-12-31');
  });
});

/** One UTC day of play through the real ledger: `battles` fought as challenger, `wins` of them won. */
function day(battles: number, wins: number, careDone: boolean) {
  const { w } = makeWallet();
  w.open(1, 0, T0);
  const start = w.balance();
  for (let i = 0; i < battles; i++) w.battle(`b${i}`, 0, i < wins ? 'win' : 'loss', T0 + i * 60e3);
  if (careDone) w.care(GOOD, T0);
  return w.balance() - start;
}

/** The most battles battle energy allows in a day: napping all day, 15 energy a battle (BATTLE_ENERGY). */
const MAX_BATTLES = Math.floor((24 * RATES.energyNapPerHour) / 15);

describe('a day of play', () => {
  const casual = day(3, 2, true),
    regular = day(8, 5, true),
    grinder = day(MAX_BATTLES, MAX_BATTLES, true);
  test('a casual player (three battles and some care) can buy a common item every day', () => {
    expect(casual).toBeGreaterThanOrEqual(PRICE[0]);
    expect(casual).toBeLessThanOrEqual(100);
  });
  test('a regular player can buy an uncommon in a day or two', () => {
    expect(regular * 2).toBeGreaterThanOrEqual(PRICE[1]);
  });
  test('grinding is tapered: winning every battle energy allows earns at most seven casual days', () => {
    expect(MAX_BATTLES).toBe(96);
    expect(grinder).toBeLessThanOrEqual(7 * casual);
    // past the full-pay battles, a win pays only the tapered amount and a loss nothing
    const full = day(REWARDS.fullBattlesPerDay, REWARDS.fullBattlesPerDay, false);
    expect(day(REWARDS.fullBattlesPerDay + 1, REWARDS.fullBattlesPerDay + 1, false) - full).toBe(REWARDS.taperedWin);
    expect(day(REWARDS.fullBattlesPerDay + 1, REWARDS.fullBattlesPerDay, false) - full).toBe(0);
  });
  test('an Epic item takes real play: more than four days for a casual player, five for a held one', () => {
    expect(PRICE[3] / casual).toBeGreaterThan(4);
    expect(basePrice(3, 'held') / casual).toBeGreaterThan(5);
  });
  test('levels and evolutions pay a little, never enough to farm', () => {
    let toTen = 0;
    for (let l = 2; l <= 10; l++) toTen += levelUpReward(l);
    expect(toTen).toBeLessThan(PRICE[3]);
    expect(REWARDS.evolve[1] + REWARDS.evolve[2]).toBeLessThan(PRICE[3]);
  });
});

describe('house NPCs', () => {
  const offer = (id: string, slot: 'head' | 'held', tag: Offer['tag'], level: number, price: number): Offer => ({
    id,
    def: { slot, name: id, rarity: 0, blurb: '' },
    level,
    price,
    tag,
  });
  const shelf = [
    offer('cheap-held', 'held', 'new', 1, 10),
    offer('beanie', 'head', 'classic', 1, 20),
    offer('pricey', 'head', 'new', 1, 90),
    offer('locked', 'head', 'new', 9, 30),
    offer('pick-me', 'head', 'back', 1, 50),
  ];
  test('buy the cheapest new or returning cosmetic they can, never a held item or a classic', () => {
    expect(npcPick(shelf, { level: 3, bits: 100, owns: () => false })?.id).toBe('pick-me');
    expect(npcPick(shelf, { level: 3, bits: 100, owns: (id) => id === 'pick-me' })?.id).toBe('pricey');
    expect(npcPick(shelf, { level: 3, bits: 40, owns: () => false })).toBeNull();
  });
});
