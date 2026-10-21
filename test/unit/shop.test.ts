// The nightly shop generator: deterministic, distinct from everything before it, priced and
// locked by rarity, compactly stored, and visible on the creatures that will wear it.
import { beforeAll, describe, expect, test } from 'bun:test';
import { HELD_CAP_PCT, heldEffect } from '../../src/shared/battle';
import { compose, ITEMS, noItems, type Px } from '../../src/shared/compose';
import {
  decodeLook,
  encodeLook,
  lookOf,
  MIN_DISTANCE_EVER,
  MIN_ITEM_DISTANCE,
  nearDuplicate,
  RECENT_DAYS,
} from '../../src/shared/distinct';
import { basePrice, CLASSICS, HELD_PCT, LEVEL_RANGE, utcDay } from '../../src/shared/economy';
import { genome } from '../../src/shared/genome';
import { sha256Hex } from '../../src/shared/rng';
import {
  BABY_SLOTS,
  type Existing,
  type GenItem,
  generateDay,
  ITEM_PALETTE,
  ITEMS_PER_DAY,
  loadDef,
  resurface,
  shopSeed,
  storeDef,
} from '../../src/shared/shopgen';

const SALT = 'unit-test-salt';
const DAYS = 21;
const D0 = Date.UTC(2026, 9, 21);
const classics = (): Existing[] => Object.keys(CLASSICS).map((id) => ({ id, slot: ITEMS[id].slot, look: lookOf(ITEMS[id]) }));

/** Three weeks of nights, generated the way the Worker does: each night sees every earlier item and the classics. */
const run: { day: string; items: GenItem[] }[] = [];
const made: Existing[] = [];
beforeAll(async () => {
  const existing = classics();
  for (let d = 0; d < DAYS; d++) {
    const day = utcDay(D0 + d * 86400e3);
    const { items } = generateDay(await shopSeed(day, SALT), day, existing);
    run.push({ day, items });
    for (const it of items) {
      const e = { id: it.id, slot: it.def.slot, look: lookOf(it.def), day };
      existing.push(e);
      made.push(e);
    }
  }
});
const all = () => run.flatMap((r) => r.items);

describe('generation', () => {
  test('is deterministic: the same night, salt and history give identical items', async () => {
    const day = run[5].day;
    const history = [...classics(), ...made.filter((e) => e.day! < day)];
    const again = generateDay(await shopSeed(day, SALT), day, history).items;
    expect(again).toEqual(run[5].items);
  });
  test('depends on the secret salt, so nobody can compute tomorrow', async () => {
    const day = run[0].day;
    const other = generateDay(await shopSeed(day, 'another-salt'), day, classics()).items;
    expect(other.map((i) => i.def.name)).not.toEqual(run[0].items.map((i) => i.def.name));
  });
  test(`fills all ${ITEMS_PER_DAY} slots every night in the first weeks, with stable ids`, () => {
    for (const r of run) {
      expect(r.items).toHaveLength(ITEMS_PER_DAY);
      for (const [i, it] of r.items.entries()) expect(it.id).toBe(`g${r.day.replace(/-/g, '')}${'abcdef'[i]}`);
      expect(new Set(r.items.map((i) => i.def.slot)).size).toBeGreaterThanOrEqual(4);
    }
  });
  test('prices and level locks follow rarity, and held effects stay under the cap', () => {
    for (const it of all()) {
      const [lo, hi] = LEVEL_RANGE[it.def.rarity];
      // the one exception: each night's level-1 item for new Forklings (see the next test)
      if (it.level !== 1) expect(it.level).toBeGreaterThanOrEqual(lo);
      expect(it.level).toBeLessThanOrEqual(hi);
      const base = basePrice(it.def.rarity, it.def.slot);
      expect(it.price).toBeGreaterThanOrEqual(base);
      expect(it.price).toBeLessThanOrEqual(base + 10);
      if (it.def.slot === 'held') {
        expect(it.def.effect?.pct).toBe(HELD_PCT[it.def.rarity]);
        expect(heldEffect(it.id, { [it.id]: it.def })!.pct).toBeLessThanOrEqual(HELD_CAP_PCT);
      } else expect(it.def.effect).toBeUndefined();
    }
  });
  test('every night has something a brand-new Forkling can buy and see', () => {
    for (const r of run) expect(r.items.some((i) => i.level === 1 && BABY_SLOTS.has(i.def.slot))).toBe(true);
  });
  test('only paints with the game palette', () => {
    for (const it of all()) for (const c of lookOf(it.def).cols) if (c) expect(ITEM_PALETTE.has(c)).toBe(true);
  });
});

describe('distinctness', () => {
  test(`each item differs from the classics and the last ${RECENT_DAYS} days in its slot, and from everything ever made`, () => {
    for (const r of run)
      for (const it of r.items) {
        const look = lookOf(it.def);
        const since = utcDay(Date.parse(`${r.day}T00:00:00Z`) - RECENT_DAYS * 86400e3);
        const before = made.filter((e) => e.slot === it.def.slot && e.id < it.id);
        const recent = [...classics().filter((e) => e.slot === it.def.slot), ...before.filter((e) => e.day! >= since)];
        expect(nearDuplicate(look, recent, MIN_ITEM_DISTANCE)).toBeNull();
        expect(nearDuplicate(look, before, MIN_DISTANCE_EVER)).toBeNull();
      }
  });
  test('an exact copy of an existing item is refused', () => {
    const it = run[0].items[0];
    expect(nearDuplicate(lookOf(it.def), [{ id: it.id, look: lookOf(it.def) }])?.id).toBe(it.id);
  });
});

describe('rotation', () => {
  test('brings back older items, never one shelved in the last week, deterministically', () => {
    const catalogue = made.map((e) => e.id);
    const recent = new Set(made.filter((e) => e.day! >= run[14].day).map((e) => e.id));
    const back = resurface(1234, catalogue, recent);
    expect(back).toEqual(resurface(1234, catalogue, recent));
    expect(back).toHaveLength(4);
    expect(new Set(back).size).toBe(4);
    for (const id of back) expect(recent.has(id)).toBe(false);
    expect(resurface(1234, catalogue, new Set(catalogue))).toEqual([]);
  });
});

describe('storage', () => {
  test('round-trips every item exactly and compactly', () => {
    for (const it of all()) {
      const s = storeDef(it.def);
      expect(s.length).toBeLessThan(900);
      const back = loadDef(s);
      const draw = (d: typeof it.def) =>
        compose({ ...genome('ab'.repeat(32)), items: { ...noItems(), [d.slot]: 'x' }, gear: { x: d } }, { stage: 1 }).cols;
      expect(draw(back)).toEqual(draw(it.def));
      const look = lookOf(it.def);
      expect(decodeLook(encodeLook(look))).toEqual(look);
    }
  });
});

describe('fit on real creatures', () => {
  // Babies (stage 0) have no neck and hold nothing, by design: those slots are checked from stage 1.
  const stagesFor = (slot: string) => (BABY_SLOTS.has(slot as never) ? [0, 1, 2] : [1, 2]);
  let seeds: string[] = [];
  beforeAll(async () => {
    seeds = await Promise.all(Array.from({ length: 60 }, (_, i) => sha256Hex(`fit-${i}`)));
  });
  test('every item shows on at least 97% of creatures, and never mostly falls off the sprite', () => {
    const sample = run.slice(0, 7).flatMap((r) => r.items);
    for (const it of sample) {
      let shown = 0,
        total = 0;
      for (const s of seeds)
        for (const stage of stagesFor(it.def.slot)) {
          const g = { ...genome(s), items: { ...noItems(), [it.def.slot]: it.id }, gear: { [it.id]: it.def } };
          const f = compose(g, { stage }).meta.items[it.def.slot]!;
          total++;
          if (f.visible) shown++;
          if (f.drawn + f.clipped) expect(f.clipped / (f.drawn + f.clipped)).toBeLessThanOrEqual(0.55);
        }
      expect(shown / total).toBeGreaterThanOrEqual(0.97);
    }
  }, 30000);
  test('an item never changes the creature more than a pixel away from itself', () => {
    // Right at the item's edge the outline is redrawn around the new silhouette, which can open a one-pixel seam.
    const near = (only: Px[], i: number) => {
      const x = i % 32,
        y = Math.floor(i / 32);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < 32 && yy < 32 && only[yy * 32 + xx]) return true;
        }
      return false;
    };
    for (const it of run.slice(0, 7).flatMap((r) => r.items))
      for (const s of seeds.slice(0, 20))
        for (const stage of stagesFor(it.def.slot)) {
          const base = genome(s);
          const outfit = { ...base, items: { ...noItems(), [it.def.slot]: it.id }, gear: { [it.id]: it.def } };
          // Any head item replaces a crest (fins, sprouts), as it always has: an unknown head id
          // draws nothing but still hides the crest, which makes it the fair comparison.
          const bareItems = it.def.slot === 'head' ? { ...noItems(), head: 'nothing-here' } : noItems();
          const bare = compose({ ...base, items: bareItems }, { stage }).cols;
          const worn = compose(outfit, { stage }).cols;
          const only = compose(outfit, { stage, itemsOnly: true }).cols;
          const far = worn.filter((c, i) => c !== bare[i] && !near(only, i)).length;
          expect(far).toBe(0);
        }
  }, 30000);
});
