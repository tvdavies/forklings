import { describe, expect, test } from 'bun:test';
import { genome, EARS, EYES, MOUTHS, PATTERNS, SHAPES, TAILS, RAMPS, INK } from '../../src/shared/genome';
import { compose, eggCols, ITEMS, SLOTS } from '../../src/shared/compose';
import { hatchSeed, hatchTimeIso, seedToInt, sha256Hex } from '../../src/shared/rng';

const seeds = async (n: number) => Promise.all(Array.from({ length: n }, (_, i) => sha256Hex('test-seed-' + i)));

describe('genome', () => {
  test('is deterministic for a seed', async () => {
    const [s] = await seeds(1);
    expect(genome(s)).toEqual(genome(s));
  });

  test('only uses known parts and curated palette pairs', async () => {
    for (const s of await seeds(300)) {
      const g = genome(s);
      expect(SHAPES).toContain(g.shape); expect(EARS).toContain(g.ears); expect(TAILS).toContain(g.tail);
      expect(EYES).toContain(g.eyes); expect(MOUTHS).toContain(g.mouth); expect(PATTERNS).toContain(g.pattern);
      expect(RAMPS[g.pal[0]]).toBeDefined(); expect(RAMPS[g.pal[1]]).toBeDefined();
      if (!g.shiny) expect(g.pal[0]).not.toBe('gold');
    }
  });

  test('applies the pairing rules', async () => {
    for (const s of await seeds(600)) {
      const g = genome(s);
      if (g.eyes === 'cyclops') { expect(['mask', 'freckles']).not.toContain(g.pattern); expect(g.mouth).not.toBe('cat'); }
      if (g.shape === 'drop') expect(['bunny', 'round']).not.toContain(g.ears);
      if (g.eyes === 'sleepy') expect(g.mouth).not.toBe('open');
    }
  });

  test('shiny is rare (about 1 in 16)', async () => {
    const all = await seeds(2000);
    const shiny = all.filter((s) => genome(s).shiny).length / all.length;
    expect(shiny).toBeGreaterThan(0.03); expect(shiny).toBeLessThan(0.1);
  });
});

describe('compose', () => {
  test('always fits 32x32 and uses a single ink outline (thin stalks use the darkest accent)', async () => {
    for (const s of await seeds(80)) {
      const g = genome(s);
      for (const stage of [0, 1, 2]) {
        const { cols } = compose(g, { stage });
        const stalk = RAMPS[g.pal[1]][0];
        expect(cols.length).toBe(32 * 32);
        // Every filled pixel next to an empty one must be ink: the outline is the last pass.
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
          const c = cols[y * 32 + x]; if (!c) continue;
          const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < 32 && yy < 32 && !cols[yy * 32 + xx]; });
          if (edge) expect([INK, stalk]).toContain(c);
        }
      }
    }
  });

  test('is pixel-identical for the same seed, pose and items', async () => {
    const [s] = await seeds(1);
    const a: any = genome(s), b: any = genome(s);
    a.items = b.items = { head: 'crown', face: 'shades', neck: 'scarf', held: 'duck' };
    expect(compose(a, { stage: 2, sq: 1 }).cols).toEqual(compose(b, { stage: 2, sq: 1 }).cols);
  });

  test('every item renders on every body without throwing', async () => {
    for (const s of await seeds(30)) {
      for (const [slot] of SLOTS) for (const id of Object.keys(ITEMS).filter((k) => (ITEMS as any)[k].slot === slot)) {
        const g: any = genome(s); g.items = { head: null, face: null, neck: null, held: null, [slot]: id };
        expect(compose(g, { stage: 1 }).cols.some((c) => c)).toBe(true);
      }
    }
  });

  test('egg wears the creature palette', async () => {
    const [s] = await seeds(1);
    const g = genome(s);
    const cols = eggCols(g, 0, 0).filter(Boolean);
    expect(cols.some((c) => RAMPS[g.pal[0]].includes(c!))).toBe(true);
  });
});

describe('hatch seeding', () => {
  test('hatch time is truncated to the second', () => {
    expect(hatchTimeIso(Date.UTC(2026, 9, 21, 6, 59, 30, 987))).toBe('2026-10-21T06:59:30Z');
  });

  test('same handle, second and salt replay the same creature', async () => {
    const a = await hatchSeed('TvDavies', '2026-10-21T06:59:30Z', 'salt-a');
    const b = await hatchSeed('tvdavies', '2026-10-21T06:59:30Z', 'salt-a');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(compose(genome(a)).cols).toEqual(compose(genome(b)).cols);
  });

  test('a different second, handle or salt changes the seed', async () => {
    const base = await hatchSeed('tvdavies', '2026-10-21T06:59:30Z', 'salt-a');
    expect(await hatchSeed('tvdavies', '2026-10-21T06:59:31Z', 'salt-a')).not.toBe(base);
    expect(await hatchSeed('octocat', '2026-10-21T06:59:30Z', 'salt-a')).not.toBe(base);
    expect(await hatchSeed('tvdavies', '2026-10-21T06:59:30Z', 'salt-b')).not.toBe(base);
  });

  test('refuses to hatch without a salt', async () => {
    expect(hatchSeed('tvdavies', '2026-10-21T06:59:30Z', '')).rejects.toThrow();
  });

  test('rejects malformed seeds', () => {
    expect(() => seedToInt('not-hex')).toThrow();
  });
});
