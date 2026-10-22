// The Worker's scheduled() handler, driven the way Cron Triggers drive it: the real entry
// module, both crons from wrangler.jsonc, and D1 as bun:sqlite with every migration applied.
// Player Durable Objects are stand-ins that record calls, so these tests see which cron does
// what: the nightly shop cron makes the day's shelf and nothing else, and the NPC cron never
// makes one.
import { Database } from 'bun:sqlite';
import { beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELD_CAP_PCT, heldEffect } from '../../src/shared/battle';
import { classicLooks } from '../../src/shared/classic-looks';
import { ITEMS } from '../../src/shared/compose';
import { decodeLook, MIN_ITEM_DISTANCE, nearDuplicate, RECENT_DAYS } from '../../src/shared/distinct';
import { basePrice, CLASSICS, HELD_PCT, LEVEL_RANGE, utcDay } from '../../src/shared/economy';
import { NPC_ROSTER } from '../../src/shared/npcs';
import { ITEMS_PER_DAY, loadDef, RESURFACE_COOLDOWN_DAYS, RESURFACED_PER_DAY, showsOnBaby } from '../../src/shared/shopgen';

// Bun shares module mocks and the module cache across test files, so this keeps ctx and env
// exactly as player-firstday.test.ts's stub does: whichever file loads player.ts first, both work.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class {},
}));
const { default: worker } = await import('../../src/worker/index');
// The handler logs each night's stats and every skipped NPC battle; keep the test output readable.
beforeAll(() => {
  spyOn(console, 'log').mockImplementation(() => {});
});

/** The two crons, as wrangler.jsonc registers them. */
const SHOP_CRON = '5 0 * * *';
const NPC_CRON = '*/20 * * * *';
const SALT = 'scheduled-test-salt';
const DAY = 86400e3;
const D0 = Date.UTC(2026, 10, 2); // a Monday
const dayN = (d: number) => utcDay(D0 + d * DAY);
const at = (d: number, hh: number, mm: number) => D0 + d * DAY + hh * 3600e3 + mm * 60e3;

type Bind = string | number | null;
/** D1 over bun:sqlite: prepare/bind/first/all/run and batch (one transaction), as the Worker uses them. */
function d1(db: Database) {
  const isRead = (sql: string) => /^\s*(SELECT|WITH)/i.test(sql);
  const exec = (sql: string, args: Bind[]) => {
    if (isRead(sql)) return { results: db.query(sql).all(...args), meta: { changes: 0 }, success: true };
    const r = db.query(sql).run(...args);
    return { results: [], meta: { changes: r.changes }, success: true };
  };
  const stmt = (sql: string, args: Bind[] = []) => ({
    sql,
    args,
    bind: (...a: Bind[]) => stmt(sql, a),
    all: async () => exec(sql, args),
    run: async () => exec(sql, args),
    first: async (col?: string) => {
      const row = db.query(sql).get(...args) as Record<string, unknown> | null;
      return row && col ? row[col] : row;
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => db.transaction(() => list.map((s) => exec(s.sql, s.args)))(),
  };
}

/** Player Durable Objects that do nothing but record what was asked of them. */
function players() {
  const calls: { pid: string; method: string; args: unknown[] }[] = [];
  const ns = {
    idFromName: (pid: string) => pid,
    get: (pid: string) =>
      new Proxy(
        {},
        {
          get: (_t, method: string) =>
            method === 'then'
              ? undefined
              : async (...args: unknown[]) => {
                  calls.push({ pid, method, args });
                  if (method === 'view') return { creature: null };
                  if (method === 'prepareBattle') return { ok: false, error: 'stand-in' };
                  if (method === 'npcShop') return null;
                  return { ok: true };
                },
        },
      ),
  };
  return { ns, calls };
}

let db: Database;
let calls: ReturnType<typeof players>['calls'];
let env: Record<string, unknown>;
beforeEach(() => {
  db = new Database(':memory:');
  for (const f of readdirSync(join(import.meta.dir, '../../migrations')).sort())
    db.exec(readFileSync(join(import.meta.dir, '../../migrations', f), 'utf8'));
  const p = players();
  calls = p.calls;
  env = { DB: d1(db), PLAYER: p.ns, BATTLE: {}, HATCH_SALT: SALT, NPCS: 'on', PUBLIC_ORIGIN: 'http://localhost' };
});

/** Fire one cron at `time`, as the runtime does, and wait for everything it handed to waitUntil. */
async function fire(cron: string, time: number) {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
  // biome-ignore lint/suspicious/noExplicitAny: test doubles for the Workers runtime types
  await worker.scheduled!({ cron, scheduledTime: time, noRetry: () => {} } as any, env as any, ctx as any);
  await Promise.all(waits);
}

type ItemRow = {
  id: string;
  day: string;
  slot: string;
  rarity: number;
  level: number;
  price: number;
  def: string;
  look: string;
  draw_key: string;
  look_key: string;
};
type DayRow = { day: string; items: string; made: number; rejected: number; short: number };
const items = (day?: string) =>
  (day
    ? db.query('SELECT * FROM shop_items WHERE day = ? ORDER BY id').all(day)
    : db.query('SELECT * FROM shop_items ORDER BY id').all()) as ItemRow[];
const shopDay = (day: string) => db.query('SELECT * FROM shop_days WHERE day = ?').get(day) as DayRow | null;
const shelf = (day: string) => JSON.parse(shopDay(day)!.items) as { id: string; tag: 'new' | 'back' }[];
const dump = () =>
  JSON.stringify([db.query('SELECT * FROM shop_items ORDER BY id').all(), db.query('SELECT * FROM shop_days ORDER BY day').all()]);

test('wrangler.jsonc registers both crons this test fires', () => {
  const config = JSON.parse(
    readFileSync(join(import.meta.dir, '../../wrangler.jsonc'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n'),
  ) as { triggers: { crons: string[] } };
  expect(config.triggers.crons.sort()).toEqual([NPC_CRON, SHOP_CRON].sort());
});

describe('the nightly shop cron', () => {
  test("makes the night's items and shelf, and touches no player or NPC", async () => {
    await fire(SHOP_CRON, at(0, 0, 5));
    const made = items(dayN(0));
    expect(made).toHaveLength(ITEMS_PER_DAY);
    expect(made.every((r) => r.id.startsWith(`g${dayN(0).replace(/-/g, '')}`))).toBe(true);
    expect(shopDay(dayN(0))).toMatchObject({ made: ITEMS_PER_DAY, short: 0 });
    expect(shelf(dayN(0)).map((e) => e.id)).toEqual(made.map((r) => r.id));
    expect(calls).toHaveLength(0);
    expect(db.query('SELECT COUNT(*) AS n FROM players').get()).toEqual({ n: 0 });
  });

  test('is idempotent: firing it again, or twice at once, for the same night changes nothing', async () => {
    await fire(SHOP_CRON, at(0, 0, 5));
    const once = dump();
    await fire(SHOP_CRON, at(0, 0, 5));
    await Promise.all([fire(SHOP_CRON, at(0, 0, 5)), fire(SHOP_CRON, at(0, 0, 6))]);
    expect(dump()).toBe(once);
  });

  test('gives the same night whether the cron or the first visit makes it', async () => {
    await fire(SHOP_CRON, at(0, 0, 5));
    const viaCron = items(dayN(0)).map((r) => [r.id, r.draw_key, r.level, r.price]);
    db.exec('DELETE FROM shop_items; DELETE FROM shop_days');
    // A missed cron: the first visit after midnight makes the same night (src/worker/shop.ts).
    const { ensureShopDay } = await import('../../src/worker/shop');
    // biome-ignore lint/suspicious/noExplicitAny: test double for the Env binding types
    await ensureShopDay(env as any, dayN(0), at(0, 7, 30));
    expect(items(dayN(0)).map((r) => [r.id, r.draw_key, r.level, r.price])).toEqual(viaCron);
  });

  describe('over successive nights', () => {
    const NIGHTS = 10;
    beforeEach(async () => {
      for (let d = 0; d < NIGHTS; d++) await fire(SHOP_CRON, at(d, 0, 5));
    });

    test('each night adds new items, every one distinct from the classics and the last four weeks', () => {
      const classics = Object.keys(CLASSICS).map((id) => ({ id, slot: ITEMS[id].slot, look: classicLooks()[id] }));
      const keys = new Set<string>();
      for (let d = 0; d < NIGHTS; d++) {
        const made = items(dayN(d));
        expect(made.length).toBe(ITEMS_PER_DAY);
        for (const it of made) {
          const since = dayN(d - RECENT_DAYS);
          const earlier = items()
            .filter((e) => e.slot === it.slot && e.id < it.id && e.day >= since)
            .map((e) => ({ id: e.id, look: decodeLook(e.look) }));
          expect(
            nearDuplicate(decodeLook(it.look), [...classics.filter((c) => c.slot === it.slot), ...earlier], MIN_ITEM_DISTANCE),
          ).toBeNull();
          // never an exact repeat of any earlier drawing or worn look
          expect(keys.has(it.draw_key) || keys.has(it.look_key)).toBe(false);
          keys.add(it.draw_key).add(it.look_key);
        }
        const names = made.map((r) => loadDef(r.def).name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
      }
    });

    test('the shelf rotates: older items come back once a week has passed, never one shelved in the last week', () => {
      const shelves = Array.from({ length: NIGHTS }, (_, d) => shelf(dayN(d)));
      for (let d = 1; d < NIGHTS; d++) expect(shelves[d].map((e) => e.id)).not.toEqual(shelves[d - 1].map((e) => e.id));
      for (let d = 0; d < NIGHTS; d++) {
        const back = shelves[d].filter((e) => e.tag === 'back');
        // Night 0 is on the shelf for the week through night 7, so items first come back on night 8.
        if (d <= RESURFACE_COOLDOWN_DAYS) expect(back).toHaveLength(0);
        else expect(back).toHaveLength(RESURFACED_PER_DAY);
        const lastWeek = new Set(shelves.slice(Math.max(0, d - RESURFACE_COOLDOWN_DAYS), d).flatMap((s) => s.map((e) => e.id)));
        for (const e of back) expect(lastWeek.has(e.id)).toBe(false);
      }
    });

    test('level locks and prices follow rarity, every night opens one item a baby can wear, and held items stay within the stat cap', () => {
      expect(HELD_CAP_PCT).toBeLessThanOrEqual(8);
      for (let d = 0; d < NIGHTS; d++) {
        const made = items(dayN(d));
        expect(made.some((r) => r.level === 1 && showsOnBaby(loadDef(r.def)))).toBe(true);
        for (const r of made) {
          const def = loadDef(r.def);
          expect(r.rarity).toBe(def.rarity);
          const [lo, hi] = LEVEL_RANGE[r.rarity];
          if (r.level !== 1) expect(r.level).toBeGreaterThanOrEqual(lo);
          expect(r.level).toBeLessThanOrEqual(hi);
          const base = basePrice(r.rarity, r.slot);
          expect(r.price).toBeGreaterThanOrEqual(base);
          expect(r.price).toBeLessThanOrEqual(base + 10);
          expect(r.price % 5).toBe(0);
          if (r.slot === 'held') {
            expect(def.effect?.pct).toBe(HELD_PCT[r.rarity]);
            expect(heldEffect(r.id, { [r.id]: def })!.pct).toBeLessThanOrEqual(HELD_CAP_PCT);
          } else expect(def.effect).toBeUndefined();
        }
      }
    });
  });

  test('refuses a near-duplicate of something already in the catalogue, through the handler', async () => {
    // What tonight would make on its own...
    await fire(SHOP_CRON, at(1, 0, 5));
    const planned = items(dayN(1));
    // ...then, in a fresh database, the same drawing already sold yesterday under another id.
    db.exec('DELETE FROM shop_items; DELETE FROM shop_days');
    const copy = planned[0];
    db.query(
      'INSERT INTO shop_items (id, day, slot, arch, rarity, level, price, gen_version, def, look, draw_key, look_key) SELECT ?, ?, slot, arch, rarity, level, price, gen_version, def, look, ?, ? FROM (SELECT ? AS slot, ? AS arch, ? AS rarity, ? AS level, ? AS price, 1 AS gen_version, ? AS def, ? AS look)',
    ).run(
      `g${dayN(0).replace(/-/g, '')}z`,
      dayN(0),
      copy.draw_key,
      copy.look_key,
      copy.slot,
      'copy',
      copy.rarity,
      copy.level,
      copy.price,
      copy.def,
      copy.look,
    );
    await fire(SHOP_CRON, at(1, 0, 5));
    const made = items(dayN(1));
    expect(made.map((r) => r.draw_key)).not.toContain(copy.draw_key);
    expect(made.map((r) => r.look_key)).not.toContain(copy.look_key);
    expect(shopDay(dayN(1))!.rejected).toBeGreaterThan(0);
    for (const r of made.filter((x) => x.slot === copy.slot))
      expect(nearDuplicate(decodeLook(r.look), [{ id: 'copy', look: decodeLook(copy.look) }], MIN_ITEM_DISTANCE)).toBeNull();
  });

  test('leaves the hourly OAuth clean-up to the NPC cron', async () => {
    db.query("INSERT INTO oauth_kv (key, value, expires_at) VALUES ('stale', 'x', 1)").run();
    await fire(SHOP_CRON, at(0, 0, 5));
    expect(db.query('SELECT COUNT(*) AS n FROM oauth_kv').get()).toEqual({ n: 1 });
    await fire(NPC_CRON, at(0, 1, 0));
    expect(db.query('SELECT COUNT(*) AS n FROM oauth_kv').get()).toEqual({ n: 0 });
  });
});

describe('the NPC cron', () => {
  test('seeds and looks after the NPCs, and never makes a shop day', async () => {
    await fire(NPC_CRON, at(0, 12, 0));
    expect(calls.filter((c) => c.method === 'setupNpc')).toHaveLength(NPC_ROSTER.length);
    expect(db.query('SELECT COUNT(*) AS n FROM shop_days').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM shop_items').get()).toEqual({ n: 0 });
  });

  test("at 00:20 the NPCs shop from the night's shelf, and without one they don't make it", async () => {
    await fire(NPC_CRON, at(0, 0, 0)); // seed them
    db.exec('UPDATE players SET has_creature = 1 WHERE npc = 1'); // as their Durable Objects would on hatching
    calls.length = 0;
    // No shelf yet (the 00:05 cron didn't run): no shopping, and no generation from an NPC tick.
    await fire(NPC_CRON, at(0, 0, 20));
    expect(calls.filter((c) => c.method === 'npcShop')).toHaveLength(0);
    expect(shopDay(dayN(0))).toBeNull();
    // With the shelf made at 00:05, each NPC is offered tonight's items and the classics.
    await fire(SHOP_CRON, at(1, 0, 5));
    calls.length = 0;
    await fire(NPC_CRON, at(1, 0, 20));
    const shopping = calls.filter((c) => c.method === 'npcShop');
    expect(shopping).toHaveLength(NPC_ROSTER.length);
    const offered = (shopping[0].args[0] as { id: string }[]).map((o) => o.id);
    expect(offered).toEqual([...shelf(dayN(1)).map((e) => e.id), ...Object.keys(CLASSICS)]);
    // Other ticks don't shop.
    calls.length = 0;
    await fire(NPC_CRON, at(1, 0, 40));
    expect(calls.filter((c) => c.method === 'npcShop')).toHaveLength(0);
  });
});
