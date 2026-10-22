// The nightly shop generator: deterministic, distinct from everything on the shelf and from
// the last month, never an exact repeat, bounded in cost, priced and locked by rarity,
// compactly stored, and visible on the creatures that will wear it.
import { beforeAll, describe, expect, test } from 'bun:test';
import { HELD_CAP_PCT, heldEffect } from '../../src/shared/battle';
import { CLASSIC_LOOKS, classicLooks } from '../../src/shared/classic-looks';
import { compose, ITEMS, noItems, type Px } from '../../src/shared/compose';
import { decodeLook, encodeLook, lookDistance, lookOf, MIN_ITEM_DISTANCE, nearDuplicate, RECENT_DAYS } from '../../src/shared/distinct';
import { basePrice, CLASSICS, HELD_PCT, LEVEL_RANGE, utcDay } from '../../src/shared/economy';
import { genome, SHAPES } from '../../src/shared/genome';
import { sha256Hex } from '../../src/shared/rng';
import {
  BABY_SLOTS,
  BACK_CANDIDATES,
  type Day,
  drawKey,
  type Existing,
  type GenItem,
  generateDay,
  ITEM_PALETTE,
  ITEMS_PER_DAY,
  loadDef,
  lookKey,
  RESURFACE_COOLDOWN_DAYS,
  RESURFACED_PER_DAY,
  resurface,
  shopSeed,
  showsOnBaby,
  storeDef,
} from '../../src/shared/shopgen';

const SALT = 'unit-test-salt';
/** Long enough that the first nights fall out of the recent window. */
const DAYS = 40;
const D0 = Date.UTC(2026, 9, 21);
const dayN = (d: number) => utcDay(D0 + d * 86400e3);
const classics = (): Existing[] =>
  Object.keys(CLASSICS).map((id) => ({ id, slot: ITEMS[id].slot, look: classicLooks()[id], name: ITEMS[id].name }));

/**
 * Forty nights, generated the way the Worker does (src/worker/shop.ts): each night sees the
 * classics, the last month's items in full, every earlier item's draw key, and returning
 * candidates in the seed's order from those not shelved in the last week.
 */
const run: { day: string; items: GenItem[]; back: string[]; input: Parameters<typeof generateDay> }[] = [];
const made: Existing[] = [];
const byId = new Map<string, Existing>();
beforeAll(async () => {
  for (let d = 0; d < DAYS; d++) {
    const day = dayN(d);
    const seed = await shopSeed(day, SALT);
    const since = dayN(d - RECENT_DAYS),
      cooldown = dayN(d - RESURFACE_COOLDOWN_DAYS);
    const shelved = new Set(run.filter((r) => r.day >= cooldown).flatMap((r) => [...r.items.map((i) => i.id), ...r.back]));
    const order = resurface(
      seed,
      made.map((e) => e.id),
      shelved,
      BACK_CANDIDATES,
    );
    const input: Parameters<typeof generateDay> = [
      seed,
      day,
      [...classics(), ...made.filter((e) => e.day! >= since)],
      { seen: new Map(made.flatMap((e) => e.keys!.map((k) => [k, e.id] as const))), back: order.map((id) => byId.get(id)!) },
    ];
    const night: Day = generateDay(...input);
    run.push({ day, items: night.items, back: night.back, input });
    for (const it of night.items) {
      const e = { id: it.id, slot: it.def.slot, look: it.look, day, name: it.def.name, keys: it.keys };
      made.push(e);
      byId.set(it.id, e);
    }
  }
});
const all = () => run.flatMap((r) => r.items);

describe('generation', () => {
  test('is deterministic: the same night, salt and history give identical items and returns', async () => {
    for (const n of [5, 35]) {
      const again = generateDay(...run[n].input);
      expect(again.items).toEqual(run[n].items);
      expect(again.back).toEqual(run[n].back);
    }
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
    for (const r of run) expect(r.items.some((i) => i.level === 1 && showsOnBaby(i.def))).toBe(true);
  });
  test('the level-1 item really shows on babies, even on nights whose first body item is a T-shirt', async () => {
    // Babies are all head, so torso clothes (T-shirts, jumpers, dungarees) show on about one in
    // five. A night's level-1 item used to be picked by slot alone, which made one of those the
    // only thing a new Forkling could buy on about one night in twenty.
    const babies = await Promise.all(Array.from({ length: 30 }, (_, i) => sha256Hex(`baby-${i}`)));
    const shown = (it: GenItem) =>
      babies.filter(
        (s) =>
          compose({ ...genome(s), items: { ...noItems(), [it.def.slot]: it.id }, gear: { [it.id]: it.def } }, { stage: 0 }).meta.items[
            it.def.slot
          ]?.visible,
      ).length / babies.length;
    let torsoNights = 0;
    for (let d = 0; d < 300; d++) {
      const day = dayN(d);
      const { items } = generateDay(await shopSeed(day, `${SALT}-babies`), day, classics());
      if (items.some((i) => i.def.slot === 'body' && !showsOnBaby(i.def))) torsoNights++;
      const firsts = items.filter((i) => i.level === 1 && BABY_SLOTS.has(i.def.slot));
      expect(firsts.some((i) => shown(i) >= 0.9)).toBe(true);
    }
    expect(torsoNights).toBeGreaterThan(20); // the case this guards against does come up
  }, 60000);
  test('only paints with the game palette', () => {
    for (const it of all()) for (const c of lookOf(it.def).cols) if (c) expect(ITEM_PALETTE.has(c)).toBe(true);
  });
  test('carries the look and keys it is stored with', () => {
    for (const it of all()) {
      const stored = loadDef(storeDef(it.def));
      expect(it.look).toEqual(lookOf(stored));
      expect(it.keys).toEqual([drawKey(stored), lookKey(it.def.slot, lookOf(stored))]);
    }
  });
});

describe('distinctness', () => {
  test(`each item differs from the classics, the last ${RECENT_DAYS} days and tonight's shelf in its slot`, () => {
    for (const r of run)
      for (const it of r.items) {
        const since = utcDay(Date.parse(`${r.day}T00:00:00Z`) - RECENT_DAYS * 86400e3);
        const compared = [
          ...classics(),
          ...made.filter((e) => e.id < it.id && e.day! >= since),
          ...r.back.map((id) => byId.get(id)!),
        ].filter((e) => e.slot === it.def.slot);
        expect(nearDuplicate(it.look, compared, MIN_ITEM_DISTANCE)).toBeNull();
      }
  });
  test("everything on a night's shelf differs from everything else on it, and no two share a name", () => {
    for (const r of run) {
      const shelf = [...r.items.map((i) => byId.get(i.id)!), ...r.back.map((id) => byId.get(id)!), ...classics()];
      for (const [i, a] of shelf.entries())
        for (const b of shelf.slice(i + 1)) {
          if (a.slot === b.slot) expect(lookDistance(a.look, b.look).pixel).toBeGreaterThanOrEqual(MIN_ITEM_DISTANCE);
          expect(a.name?.toLowerCase()).not.toBe(b.name?.toLowerCase());
        }
    }
  });
  test('no item ever draws exactly like an earlier one', () => {
    expect(new Set(made.flatMap((e) => e.keys)).size).toBe(2 * made.length);
    const looks = new Set(made.map((e) => encodeLook(e.look)));
    expect(looks.size).toBe(made.length);
  });
  test('a drawing seen before is refused and replaced from the same stream', () => {
    const r = run[3];
    const [seed, day, existing, opts] = r.input;
    const seen = new Map([...(opts?.seen ?? []), ...r.items.flatMap((i) => i.keys.map((k) => [k, i.id] as [string, string]))]);
    const again = generateDay(seed, day, existing, { ...opts, seen });
    for (const it of again.items) expect(r.items.some((i) => encodeLook(i.look) === encodeLook(it.look))).toBe(false);
    expect(again.rejected.some((x) => x.why === 'repeat')).toBe(true);
  });
  test(`no two items in ${RECENT_DAYS} days share a name, and none takes a classic's`, () => {
    const named = [...classics(), ...made];
    for (const [i, a] of named.entries())
      for (const b of named.slice(i + 1)) {
        const apart = a.day && b.day ? Math.abs(Date.parse(a.day) - Date.parse(b.day)) / 86400e3 : 0;
        if (apart < RECENT_DAYS) expect(`${b.id} ${b.name}`.toLowerCase()).not.toBe(`${b.id} ${a.name}`.toLowerCase());
      }
  });
  test('an exact copy of an existing item is refused', () => {
    const it = run[0].items[0];
    expect(nearDuplicate(lookOf(it.def), [{ id: it.id, look: lookOf(it.def) }])?.id).toBe(it.id);
  });
  test('every classic has a look to compare with, and the precomputed looks match the art', () => {
    for (const id of Object.keys(CLASSICS)) {
      const look = lookOf(ITEMS[id], id);
      expect(look.w).toBeGreaterThan(0);
      // If this fails after changing a classic's art: bun scripts/classic-looks.ts && npm run format
      expect(CLASSIC_LOOKS[id]).toBe(encodeLook(look));
    }
  });
});

describe('bounded cost', () => {
  test('older items count only through their keys: full history gives the same night as the window', () => {
    // The Worker reads looks for the last month only; handing the generator every look ever made must change nothing.
    for (const n of [30, 39]) {
      const [seed, day, existing, opts] = run[n].input;
      const full = generateDay(seed, day, [...classics(), ...made.filter((e) => e.day! < day)], opts);
      expect(full.items).toEqual(run[n].items);
      expect(full.back).toEqual(run[n].back);
      expect(existing.length).toBeLessThan(full.items.length + made.filter((e) => e.day! < day).length);
    }
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
    // A longer draw starts with the same items, so the Worker can load a few spare candidates.
    expect(resurface(1234, catalogue, recent, BACK_CANDIDATES).slice(0, 4)).toEqual(back);
  });
  test(`each night returns ${RESURFACED_PER_DAY} items once there are enough, plus one for each short slot`, () => {
    for (const r of run.slice(10)) {
      expect(r.back).toHaveLength(RESURFACED_PER_DAY + ITEMS_PER_DAY - r.items.length);
      const cooldown = utcDay(Date.parse(`${r.day}T00:00:00Z`) - RESURFACE_COOLDOWN_DAYS * 86400e3);
      for (const id of r.back) expect(byId.get(id)!.day! < cooldown).toBe(true);
    }
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
  test(`a week of items shows on every body plan (${SHAPES.join(', ')}) at every stage that wears it`, async () => {
    // Six creatures of each shape. Torso clothes are a junior's and a prime's, like neck and held
    // items; the rest show on babies too. Loaf juniors hide the most under the chin, so a shape
    // passes when most of its creatures show the item; across all of them it's 9 in 10.
    const byShape = new Map<string, string[]>(SHAPES.map((s) => [s, []]));
    for (let i = 0; [...byShape.values()].some((v) => v.length < 6); i++) {
      const s = await sha256Hex(`plan-${i}`);
      const of = byShape.get(genome(s).shape)!;
      if (of.length < 6) of.push(s);
    }
    for (const it of run.slice(0, 7).flatMap((r) => r.items)) {
      let shown = 0,
        total = 0;
      for (const stage of showsOnBaby(it.def) ? [0, 1, 2] : [1, 2])
        for (const [shape, seedsOf] of byShape) {
          const here = seedsOf.filter(
            (s) =>
              compose({ ...genome(s), items: { ...noItems(), [it.def.slot]: it.id }, gear: { [it.id]: it.def } }, { stage }).meta.items[
                it.def.slot
              ]?.visible,
          ).length;
          if (here * 2 <= seedsOf.length)
            throw new Error(`${it.def.name} shows on ${here} of ${seedsOf.length} ${shape} creatures at stage ${stage}`);
          shown += here;
          total += seedsOf.length;
        }
      expect(shown / total).toBeGreaterThanOrEqual(0.9);
    }
  }, 60000);
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
