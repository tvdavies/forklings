// The daily shop. The nightly cron makes the day's items just after 00:00 UTC; if it was
// missed, the first shop visit of the day does the same work and gets the same result
// (generation is deterministic in the day, the secret salt and the catalogue so far, and
// every write is INSERT OR IGNORE, so racing generators agree).
import { ITEMS, type ItemDef, type Slot } from '../shared/compose';
import { decodeLook, encodeLook, lookOf } from '../shared/distinct';
import { CLASSICS, classicOffers, type Offer, prevDay, utcDay } from '../shared/economy';
import { sha256Hex } from '../shared/rng';
import {
  type Existing,
  generateDay,
  loadDef,
  RESURFACE_COOLDOWN_DAYS,
  RESURFACED_PER_DAY,
  resurface,
  SHOP_GEN_VERSION,
  shopSeed,
  storeDef,
} from '../shared/shopgen';
import type { Env } from './env';

/** A purchase made this long after midnight may still use yesterday's shelf (a page left open over 00:00). */
export const ROLLOVER_GRACE_MS = 10 * 60 * 1000;

type ShelfEntry = { id: string; tag: 'new' | 'back' };
type DayRow = { day: string; items: string; made: number; rejected: number; short: number; ms: number };
type CatalogueRow = { id: string; slot: Slot; day: string; look: string };
type ItemRow = { id: string; day: string; level: number; price: number; def: string };

export interface ShopDay {
  day: string;
  shelf: ShelfEntry[];
  made: number;
  rejected: number;
  short: number;
  ms: number;
}

/** The generator's secret: SHOP_SALT if set, else derived from the hatch salt (so no new secret is required). */
export async function shopSalt(env: Env): Promise<string> {
  return env.SHOP_SALT || sha256Hex(`shop|${env.HATCH_SALT}`);
}

const parseDay = (r: DayRow): ShopDay => ({
  day: r.day,
  shelf: JSON.parse(r.items) as ShelfEntry[],
  made: r.made,
  rejected: r.rejected,
  short: r.short,
  ms: r.ms,
});

async function readDay(env: Env, day: string): Promise<ShopDay | null> {
  const r = await env.DB.prepare('SELECT day, items, made, rejected, short, ms FROM shop_days WHERE day = ?').bind(day).first<DayRow>();
  return r ? parseDay(r) : null;
}

let classicLooks: Existing[] | null = null;
/** The classics count as existing items: nothing generated may look like them either. */
function classics(): Existing[] {
  classicLooks ??= Object.keys(CLASSICS).map((id) => ({ id, slot: ITEMS[id].slot, look: lookOf(ITEMS[id]) }));
  return classicLooks;
}

/** Make `day`'s items and shelf unless they exist already. Returns the day as stored. */
export async function ensureShopDay(env: Env, day: string, now = Date.now()): Promise<ShopDay> {
  const have = await readDay(env, day);
  if (have) return have;
  const t0 = Date.now();
  const rows = (await env.DB.prepare('SELECT id, slot, day, look FROM shop_items WHERE day < ?').bind(day).all<CatalogueRow>()).results;
  const existing: Existing[] = [...classics(), ...rows.map((r) => ({ id: r.id, slot: r.slot, day: r.day, look: decodeLook(r.look) }))];
  const seed = await shopSeed(day, await shopSalt(env));
  const { items, rejected } = generateDay(seed, day, existing);
  const short = Math.max(0, 6 - items.length);

  // Bring back older items that haven't been on the shelf for a week; one more for each slot that came up short.
  const since = utcDay(Date.parse(`${day}T00:00:00Z`) - RESURFACE_COOLDOWN_DAYS * 86400e3);
  const recentDays = (
    await env.DB.prepare('SELECT items FROM shop_days WHERE day >= ? AND day < ?').bind(since, day).all<{ items: string }>()
  ).results;
  const recent = new Set<string>(recentDays.flatMap((r) => (JSON.parse(r.items) as ShelfEntry[]).map((e) => e.id)));
  const back = resurface(
    seed,
    rows.map((r) => r.id),
    recent,
    RESURFACED_PER_DAY + short,
  );
  const shelf: ShelfEntry[] = [
    ...items.map((i) => ({ id: i.id, tag: 'new' as const })),
    ...back.map((id) => ({ id, tag: 'back' as const })),
  ];
  const ms = Date.now() - t0;

  const stmts = items.map((i) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO shop_items (id, day, slot, arch, rarity, level, price, gen_version, def, look) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(i.id, day, i.def.slot, i.arch, i.def.rarity, i.level, i.price, SHOP_GEN_VERSION, storeDef(i.def), encodeLook(lookOf(i.def))),
  );
  stmts.push(
    env.DB.prepare('INSERT OR IGNORE INTO shop_days (day, items, made, rejected, short, ms, at) VALUES (?,?,?,?,?,?,?)').bind(
      day,
      JSON.stringify(shelf),
      items.length,
      rejected.length,
      short,
      ms,
      now,
    ),
  );
  await env.DB.batch(stmts);
  console.log('shop day', day, { made: items.length, rejected: rejected.length, short, back: back.length, ms });
  // Read back: if another request generated the same day at the same moment, its row won.
  return (await readDay(env, day)) ?? { day, shelf, made: items.length, rejected: rejected.length, short, ms };
}

/** Generated items by id, with their shop data. */
async function loadItems(env: Env, ids: string[]): Promise<Map<string, ItemRow>> {
  if (!ids.length) return new Map();
  const qs = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(`SELECT id, day, level, price, def FROM shop_items WHERE id IN (${qs})`)
    .bind(...ids)
    .all<ItemRow>();
  return new Map(r.results.map((x) => [x.id, x]));
}

/** Everything on sale on `day`: the day's new and returning items, then the classics. */
export async function offersFor(env: Env, day: ShopDay): Promise<Offer[]> {
  const rows = await loadItems(
    env,
    day.shelf.map((e) => e.id),
  );
  const shelf: Offer[] = [];
  for (const e of day.shelf) {
    const r = rows.get(e.id);
    if (r) shelf.push({ id: r.id, def: loadDef(r.def), level: r.level, price: r.price, tag: e.tag });
  }
  return [...shelf, ...classicOffers()];
}

/** Whether `id` is on sale right now, and on what terms. Untrusted id; null if not for sale. */
export async function findOffer(env: Env, id: unknown, now = Date.now()): Promise<Offer | null> {
  if (typeof id !== 'string' || id.length > 40) return null;
  const c = CLASSICS[id];
  if (c) return { id, def: ITEMS[id], level: c.level, price: c.price, tag: 'classic' };
  const today = utcDay(now);
  const days = [today];
  if (now - Date.parse(`${today}T00:00:00Z`) < ROLLOVER_GRACE_MS) days.push(prevDay(today));
  for (const d of days) {
    const sd = d === today ? await ensureShopDay(env, d, now) : await readDay(env, d);
    const e = sd?.shelf.find((x) => x.id === id);
    if (!e) continue;
    const r = (await loadItems(env, [id])).get(id);
    if (r) return { id, def: loadDef(r.def), level: r.level, price: r.price, tag: e.tag };
  }
  return null;
}

/** Item definitions for generated ids (for anything that has to draw them). */
export async function defsFor(env: Env, ids: string[]): Promise<Record<string, ItemDef>> {
  const rows = await loadItems(
    env,
    ids.filter((id) => !ITEMS[id]),
  );
  return Object.fromEntries([...rows.values()].map((r) => [r.id, loadDef(r.def)]));
}
