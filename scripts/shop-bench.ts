// How a night's shop generation scales with the catalogue. Simulates N nights the way
// ensureShopDay does, with the D1 rows held in memory, and times the CPU work of each night:
// decoding the 28-day window and the key index, choosing returning items, generating, and
// encoding what gets stored. D1 round trips are left out (they are I/O, not CPU).
// Run with: bun scripts/shop-bench.ts [nights]   (prints a table; see docs/economy.md)

import { classicLooks } from '../src/shared/classic-looks';
import { ITEMS, type Slot } from '../src/shared/compose';
import { decodeLook, encodeLook, RECENT_DAYS } from '../src/shared/distinct';
import { CLASSICS, utcDay } from '../src/shared/economy';
import {
  BACK_CANDIDATES,
  type Existing,
  generateDay,
  loadDef,
  RESURFACE_COOLDOWN_DAYS,
  resurface,
  shopSeed,
  storeDef,
} from '../src/shared/shopgen';

const NIGHTS = Number(process.argv[2] ?? 400);
const START = Date.UTC(2026, 9, 22);
const MARKS = new Set([1, 30, 90, 180, 365, 400, 730]);
type Row = { id: string; slot: Slot; day: string; look: string; def: string; draw_key: string; look_key: string };

const rows: Row[] = [];
const shelves: { day: string; ids: string[] }[] = [];
const classics: Existing[] = Object.keys(CLASSICS).map((id) => ({
  id,
  slot: ITEMS[id].slot,
  look: classicLooks()[id],
  name: ITEMS[id].name,
}));
const toExisting = (r: Row): Existing => ({ id: r.id, slot: r.slot, day: r.day, look: decodeLook(r.look), name: loadDef(r.def).name });
let short = 0,
  rejected = 0,
  worst = 0,
  total = 0;
console.log('| Night | Catalogue | CPU (ms) | Rejected | Short so far |\n| --- | --- | --- | --- | --- |');
for (let n = 1; n <= NIGHTS; n++) {
  const day = utcDay(START + (n - 1) * 86400e3);
  const seed = await shopSeed(day, 'forklings-bench');
  const since = utcDay(START + (n - 1 - RECENT_DAYS) * 86400e3);
  const cooldown = utcDay(START + (n - 1 - RESURFACE_COOLDOWN_DAYS) * 86400e3);
  const t0 = performance.now();
  // What ensureShopDay does with the rows it reads.
  const seen = new Map(rows.flatMap((r) => [[r.draw_key, r.id] as const, [r.look_key, r.id] as const]));
  const recentRows = rows.filter((r) => r.day >= since);
  const shelved = new Set(shelves.filter((s) => s.day >= cooldown).flatMap((s) => s.ids));
  const order = resurface(
    seed,
    rows.map((r) => r.id),
    shelved,
    BACK_CANDIDATES,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const back = order.map((id) => toExisting(byId.get(id) as Row));
  const night = generateDay(seed, day, [...classics, ...recentRows.map(toExisting)], { seen, back });
  const stored = night.items.map((i) => ({
    id: i.id,
    slot: i.def.slot,
    day,
    look: encodeLook(i.look),
    def: storeDef(i.def),
    draw_key: i.keys[0],
    look_key: i.keys[1],
  }));
  const ms = performance.now() - t0;
  rows.push(...stored);
  shelves.push({ day, ids: [...night.items.map((i) => i.id), ...night.back] });
  short += 6 - night.items.length;
  rejected += night.rejected.length;
  if (n > 1) {
    worst = Math.max(worst, ms);
    total += ms;
  }
  if (MARKS.has(n)) console.log(`| ${n} | ${rows.length} | ${ms.toFixed(1)} | ${night.rejected.length} | ${short} |`);
}
console.log(
  `\n${NIGHTS} nights: mean ${(total / Math.max(1, NIGHTS - 1)).toFixed(1)} ms, worst ${worst.toFixed(1)} ms (night 1 excluded: warm-up), ${short} of ${NIGHTS * 6} slots short, ${rejected} candidates rejected`,
);
