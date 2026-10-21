// Distinctness: how different two items look when worn. Each item is drawn alone on the
// mannequin (compose's itemsOnly mode), outlined and cropped, and the two looks are compared
// pixel by pixel. See docs/economy.md for how the threshold was chosen.
import { type ItemDef, itemWornCols, type Px } from './compose';
import { INK } from './genome';

/**
 * Distance is 0 for identical looks and 1 for looks that share no pixels. Two rules, both per slot:
 *
 * - Against every item ever made (and the classics), a new item must be at least
 *   `MIN_DISTANCE_EVER` away: no clones, no recolour into a neighbouring ramp, no one-pixel tweak.
 * - Against items made in the last `RECENT_DAYS`, it must be at least `MIN_ITEM_DISTANCE` away:
 *   a different shape or pattern, or the same shape in clearly different colours.
 *
 * A single strict rule against all history runs the design space dry in a few months (see
 * docs/economy.md); this keeps every month's shop varied and still never repeats an item.
 */
export const MIN_ITEM_DISTANCE = 0.2;
export const MIN_DISTANCE_EVER = 0.1;
export const RECENT_DAYS = 28;

/** A worn look: cropped pixels plus its size. Stored compactly as a signature string. */
export interface Look {
  w: number;
  h: number;
  cols: Px[];
}

export const lookOf = (d: ItemDef): Look => itemWornCols(d);

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

const filled = (l: Look) => l.cols.reduce((n, c) => n + (c ? 1 : 0), 0);

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
  let best: Distance = { pixel: 1, silhouette: 1, palette: paletteDistance(a, b) };
  if (!a.w || !b.w) return best;
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
        cost = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const ca = x >= ax && x < ax + a.w && y >= ay && y < ay + a.h ? a.cols[(y - ay) * a.w + (x - ax)] : null;
          const cb = x >= bx && x < bx + b.w && y >= by && y < by + b.h ? b.cols[(y - by) * b.w + (x - bx)] : null;
          // Shared outline says nothing about the drawing itself; mismatched outline still counts.
          if ((!ca && !cb) || (ca === INK && cb === INK)) continue;
          union++;
          if (ca && cb) {
            inter++;
            cost += colourDistance(ca, cb);
          } else cost += 1;
        }
      const pixel = union ? cost / union : 0;
      if (pixel < best.pixel) best = { pixel, silhouette: union ? 1 - inter / union : 0, palette: best.palette };
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
  let nearest: Neighbour | null = null;
  for (const e of existing) {
    const m = filled(e.look);
    if (Math.abs(n - m) / Math.max(n, m, 1) >= min) continue;
    const d = lookDistance(candidate, e.look);
    if (d.pixel < min && (!nearest || d.pixel < nearest.distance.pixel)) nearest = { id: e.id, distance: d };
  }
  return nearest;
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
export function decodeLook(s: string): Look {
  const [size, pal, px] = s.split('|');
  const [w, h] = size.split('x').map(Number);
  const colours = pal ? pal.split(',').map((c) => `#${c}`) : [];
  return { w, h, cols: [...(px ?? '')].map((ch) => (ch === '.' ? null : colours[parseInt(ch, 36)])) };
}
