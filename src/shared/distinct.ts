// Distinctness: how different two items look when worn. Each item is drawn alone on the
// mannequin (compose's itemsOnly mode), outlined and cropped, and the two looks are compared
// pixel by pixel. See docs/economy.md for how the threshold was chosen.
import { type ItemDef, itemWornCols, type Px } from './compose';
import { INK } from './genome';

/**
 * Distance is 0 for identical looks and 1 for looks that share no pixels. Two rules, both per slot:
 *
 * - Against the classics, items made in the last `RECENT_DAYS` and everything else on tonight's
 *   shelf, a new item must be at least `MIN_ITEM_DISTANCE` away: a different shape or pattern, or
 *   the same shape in clearly different colours.
 * - Against every item ever made, its drawing may not be an exact repeat (`drawKey` in shopgen).
 *
 * The distance rule works on a bounded set, so a night's cost stays flat as the catalogue grows;
 * the exact-repeat rule is a set lookup. See docs/economy.md for the numbers.
 */
export const MIN_ITEM_DISTANCE = 0.2;
export const RECENT_DAYS = 28;

/** A worn look: cropped pixels plus its size. Stored compactly as a signature string. */
export interface Look {
  w: number;
  h: number;
  cols: Px[];
}

/** How an item looks worn. Pass a classic's id too: some classics are drawn by id, not from their definition. */
export const lookOf = (d: ItemDef, id?: string): Look => itemWornCols(d, id);

/** sRGB hex to CIELAB (D65). */
export function lab(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(n >> 16),
    g = lin((n >> 8) & 255),
    b = lin(n & 255);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047),
    y = f(0.2126 * r + 0.7152 * g + 0.0722 * b),
    z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** A colour difference (CIE76 ΔE) at or above this counts as completely different. */
export const DELTA_E_FULL = 60;
const colourCache = new Map<string, number>();
/** Perceptual distance between two colours, 0 to 1: ΔE / 60, capped at 1. */
export function colourDistance(a: string, b: string): number {
  if (a === b) return 0;
  const k = a < b ? a + b : b + a;
  let d = colourCache.get(k);
  if (d === undefined) {
    const [l1, a1, b1] = lab(a),
      [l2, a2, b2] = lab(b);
    d = Math.min(1, Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) / DELTA_E_FULL);
    colourCache.set(k, d);
  }
  return d;
}

// Precomputed features, so a comparison is integer lookups: each look's pixels as colour ids
// (0 empty, 1 ink) and its filled count, cached per look, plus a lazily filled table of
// colour distances between ids. The values are exactly colourDistance's.
const colourIds = new Map<string, number>([[INK, 1]]);
const colourList = ['', INK];
let cap = 64;
let table = new Float64Array(cap * cap).fill(-1);
function colourId(c: string): number {
  let id = colourIds.get(c);
  if (id === undefined) {
    id = colourList.push(c) - 1;
    colourIds.set(c, id);
    if (id >= cap) {
      const old = table,
        was = cap;
      cap *= 2;
      table = new Float64Array(cap * cap).fill(-1);
      for (let i = 0; i < was; i++) table.set(old.subarray(i * was, (i + 1) * was), i * cap);
    }
  }
  return id;
}
function idDistance(i: number, j: number): number {
  let d = table[i * cap + j];
  if (d < 0) {
    d = colourDistance(colourList[i], colourList[j]);
    table[i * cap + j] = d;
    table[j * cap + i] = d;
  }
  return d;
}
interface Features {
  ids: Uint16Array;
  filled: number;
}
const featureCache = new WeakMap<Look, Features>();
function features(l: Look): Features {
  let f = featureCache.get(l);
  if (!f) {
    const ids = new Uint16Array(l.cols.length);
    let filled = 0;
    l.cols.forEach((c, i) => {
      if (c) {
        ids[i] = colourId(c);
        filled++;
      }
    });
    f = { ids, filled };
    featureCache.set(l, f);
  }
  return f;
}
const filled = (l: Look) => features(l).filled;

export interface Distance {
  /**
   * Mean per-pixel difference over the union of both looks, leaving out pixels that are outline
   * in both: 1 where only one has a pixel, else the colour distance.
   */
  pixel: number;
  /** 1 minus the overlap (intersection over union) of the two silhouettes. */
  silhouette: number;
  /** How far each look's colours are from the other's nearest colour, weighted by area, outline excluded. */
  palette: number;
}

/** Compare two looks, centred on each other and nudged up to a pixel each way to find the best match. */
export function lookDistance(a: Look, b: Look): Distance {
  return { ...overlap(a, b), palette: paletteDistance(a, b) };
}

/**
 * The pixel and silhouette parts of the distance: all the generator needs to decide. With
 * `stop`, an alignment is abandoned as soon as its distance provably reaches `stop` (or the best
 * so far): the union is at most both looks' filled pixels, so cost / (na + nb) is a lower bound.
 * Distances under `stop` come out exactly as without it.
 */
function overlap(a: Look, b: Look, stop = 1): Omit<Distance, 'palette'> {
  let best = { pixel: 1, silhouette: 1 };
  if (!a.w || !b.w) return best;
  const A = features(a).ids,
    B = features(b).ids;
  const most = filled(a) + filled(b);
  const ax = 0,
    ay = 0,
    bx0 = Math.round((a.w - b.w) / 2),
    by0 = Math.round((a.h - b.h) / 2);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const bx = bx0 + dx,
        by = by0 + dy;
      const x0 = Math.min(ax, bx),
        y0 = Math.min(ay, by),
        x1 = Math.max(ax + a.w, bx + b.w),
        y1 = Math.max(ay + a.h, by + b.h);
      let union = 0,
        inter = 0,
        cost = 0,
        gaveUp = false;
      const limit = Math.min(stop, best.pixel) * most;
      for (let y = y0; y < y1 && !gaveUp; y++) {
        const inA = y >= ay && y < ay + a.h,
          inB = y >= by && y < by + b.h,
          rowA = (y - ay) * a.w - ax,
          rowB = (y - by) * b.w - bx;
        for (let x = x0; x < x1; x++) {
          const ca = inA && x >= ax && x < ax + a.w ? A[rowA + x] : 0;
          const cb = inB && x >= bx && x < bx + b.w ? B[rowB + x] : 0;
          // Shared outline says nothing about the drawing itself; mismatched outline still counts.
          if ((!ca && !cb) || (ca === 1 && cb === 1)) continue;
          union++;
          if (ca && cb) {
            inter++;
            if (ca !== cb) cost += idDistance(ca, cb);
          } else cost += 1;
        }
        gaveUp = cost >= limit;
      }
      if (gaveUp) continue;
      const pixel = union ? cost / union : 0;
      if (pixel < best.pixel) best = { pixel, silhouette: union ? 1 - inter / union : 0 };
    }
  return best;
}

function paletteHistogram(l: Look) {
  const h = new Map<string, number>();
  let n = 0;
  for (const c of l.cols)
    if (c && c !== INK) {
      h.set(c, (h.get(c) ?? 0) + 1);
      n++;
    }
  return { h, n };
}
export function paletteDistance(a: Look, b: Look): number {
  const A = paletteHistogram(a),
    B = paletteHistogram(b);
  if (!A.n || !B.n) return A.n || B.n ? 1 : 0;
  const oneWay = (X: typeof A, Y: typeof A) => {
    let s = 0;
    for (const [c, k] of X.h) {
      let m = 1;
      for (const d of Y.h.keys()) m = Math.min(m, colourDistance(c, d));
      s += m * k;
    }
    return s / X.n;
  };
  return (oneWay(A, B) + oneWay(B, A)) / 2;
}

export interface Neighbour {
  id: string;
  distance: Distance;
}

/**
 * The nearest existing look to a candidate, or null when nothing is within the threshold.
 * A cheap bound skips most pairs: the pixel distance is at least the difference in filled
 * pixels over the larger count, so looks of very different sizes can't be near-duplicates.
 */
export function nearDuplicate(candidate: Look, existing: Iterable<{ id: string; look: Look }>, min = MIN_ITEM_DISTANCE): Neighbour | null {
  const n = filled(candidate);
  let nearest: { id: string; look: Look; d: Omit<Distance, 'palette'> } | null = null;
  for (const e of existing) {
    const m = filled(e.look);
    if (Math.abs(n - m) / Math.max(n, m, 1) >= min) continue;
    const d = overlap(candidate, e.look, Math.min(min, nearest?.d.pixel ?? 1));
    if (d.pixel < min && (!nearest || d.pixel < nearest.d.pixel)) nearest = { id: e.id, look: e.look, d };
  }
  return nearest && { id: nearest.id, distance: { ...nearest.d, palette: paletteDistance(candidate, nearest.look) } };
}

/** Compact signature for storage: width, height, palette and one palette index per pixel. */
export function encodeLook(l: Look): string {
  const pal: string[] = [];
  const idx = l.cols.map((c) => {
    if (!c) return '.';
    let i = pal.indexOf(c);
    if (i < 0) i = pal.push(c) - 1;
    return i.toString(36);
  });
  return `${l.w}x${l.h}|${pal.map((c) => c.slice(1)).join(',')}|${idx.join('')}`;
}
/** A short, stable 53-bit hash of a string, in base 36 (cyrb53). */
export function hash53(s: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export function decodeLook(s: string): Look {
  const [size, pal, px] = s.split('|');
  const [w, h] = size.split('x').map(Number);
  const colours = pal ? pal.split(',').map((c) => `#${c}`) : [];
  return { w, h, cols: [...(px ?? '')].map((ch) => (ch === '.' ? null : colours[parseInt(ch, 36)])) };
}
