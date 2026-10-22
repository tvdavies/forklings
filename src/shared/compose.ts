// Sprite composer: assembles a 32x32 palette-indexed creature from its genome,
// pose and equipped items. Pure function, no DOM, ported from the approved concept:
// per-shape shading lit from the top left, face after shading, one ink outline last.
import { type Genome, INK, RAMPS } from './genome';
import { mulberry } from './rng';

export type Slot = 'head' | 'face' | 'neck' | 'body' | 'held';
export type Stat = 'hp' | 'atk' | 'def' | 'spd';
/** A pixel map (one character per pixel, '.' is empty) and the colour for each character. */
export interface IconDef {
  map: string[];
  cols: Record<string, string>;
}
/**
 * Parametric drawing for generated items that have to fit each body rather than be stamped:
 * eyewear around the eyes, neckwear along the neck line, headphones around the head and
 * clothes over the torso. `style` picks the shape and `c` lists its colours (palette hexes).
 */
export type ParamKind = 'lens' | 'band' | 'phones' | 'wear';
export interface ItemParams {
  style: string;
  c: string[];
  /** Surface pattern for clothes: 'plain', 'stripes', 'wide', 'pin', 'check', 'dots', 'halves', 'yoke', 'hem', 'diag'. */
  pat?: string;
}

/** Whether pattern `pat` puts the accent colour at (x, y), relative to the centre column and the neck line. */
export function patternOn(pat: string | undefined, dx: number, dy: number): boolean {
  switch (pat) {
    case 'stripes':
      return dy % 3 === 2;
    case 'wide':
      return (dy >> 1) % 2 === 1;
    case 'pin':
      return ((dx % 3) + 3) % 3 === 0;
    case 'check':
      return ((dx >> 1) + (dy >> 1)) % 2 === 0;
    case 'dots':
      return dy % 3 === 1 && (((dx + (dy % 6 === 1 ? 0 : 2)) % 4) + 4) % 4 === 0;
    case 'halves':
      return dx >= 0;
    case 'yoke':
      return dy < 3;
    case 'hem':
      return dy >= 6;
    case 'diag':
      return (((dx + dy) % 4) + 4) % 4 < 2;
    default:
      return false;
  }
}
/**
 * A wardrobe item. Items with a `map` are stamped from it; `proc` items are drawn in code by
 * compose(); generated items with a `kind` are drawn from their `p` parameters.
 */
export interface ItemDef {
  slot: Slot;
  name: string;
  rarity: number;
  blurb: string;
  edge?: number;
  proc?: number;
  map?: string[];
  cols?: Record<string, string>;
  anim?: string[];
  kind?: ParamKind;
  p?: ItemParams;
  /** Battle effect of a generated held item (other slots are cosmetic). Capped by the engine. */
  effect?: { stat: Stat; pct: number };
  /** The UTC day a generated item was made, YYYY-MM-DD. Absent for the classic items. */
  day?: string;
}
type MapItem = ItemDef & IconDef;
const hasMap = (it: ItemDef): it is MapItem => !!it.map;

const ITEM_DEFS = {
  beanie: {
    slot: 'head',
    name: 'Beanie',
    rarity: 0,
    edge: 1,
    map: ['....pp....', '..rrrrrr..', '.rrRrrRrr.', '.rrRrrRrr.', 'cccccccccc'],
    cols: { p: '#fff2dc', r: '#cf3a4a', R: '#ff6f62', c: '#ff9f78' },
    blurb: 'Warm ears, warmer heart.',
  },
  cap: {
    slot: 'head',
    name: 'Propeller cap',
    rarity: 2,
    edge: 1,
    map: ['..aaa..bbb..', '.....kk.....', '...yyrrrr...', '..yyyrrrrr..', '..yyyrrrrrrr'],
    cols: { a: '#86bdff', b: '#ff6f62', k: '#1a1124', y: '#ffd166', r: '#4f7fe0' },
    anim: ['...bbbaaa...', '.....kk.....', '...yyrrrr...', '..yyyrrrrr..', '..yyyrrrrrrr'],
    blurb: 'Spins when it thinks.',
  },
  crown: {
    slot: 'head',
    name: 'Crown',
    rarity: 3,
    edge: 1,
    map: ['y...yy...y', 'yy.yyyy.yy', 'yyyyyyyyyy', 'yrYYgYYYry', 'YYYYYYYYYY'],
    cols: { y: '#ffd34d', Y: '#c8892c', r: '#cf3a4a', g: '#6fdc9c' },
    blurb: 'Main branch royalty.',
  },
  party: {
    slot: 'head',
    name: 'Party hat',
    rarity: 1,
    edge: 1,
    map: ['...w...', '...p...', '..pyp..', '..ppp..', '.pypyp.', '.ppppp.', 'pypypyp'],
    cols: { w: '#fff2dc', p: '#bf98ff', y: '#ffd166' },
    blurb: 'For every green build.',
  },
  phones: { slot: 'head', name: 'Headphones', rarity: 1, proc: 1, blurb: 'Lo-fi beats to debug to.' },
  glasses: { slot: 'face', name: 'Round glasses', rarity: 0, proc: 1, blurb: 'Reads the whole diff.' },
  shades: { slot: 'face', name: 'Shades', rarity: 2, proc: 1, blurb: 'Deploys on a Friday.' },
  scarf: { slot: 'neck', name: 'Scarf', rarity: 0, proc: 1, blurb: 'Cosy for long builds.' },
  bowtie: {
    slot: 'neck',
    name: 'Bow tie',
    rarity: 1,
    map: ['gg..gg', 'gGkkGg', 'gg..gg'],
    cols: { g: '#ff86bd', G: '#d94c93', k: '#8c2766' },
    blurb: 'Dressed for the demo.',
  },
  duck: {
    slot: 'held',
    name: 'Rubber duck',
    rarity: 2,
    edge: 1,
    map: ['..yy....', '.ykyy...', 'oyyyy..y', '..yyyyyy', '..yyyyyY', '...YYYY.'],
    cols: { y: '#ffd166', Y: '#e39b3a', k: '#1a1124', o: '#ff6f62' },
    blurb: 'Your pet explains bugs to it.',
  },
  keyboard: {
    slot: 'held',
    name: 'Clicky keyboard',
    rarity: 1,
    edge: 1,
    map: ['kkkkkkkk', 'kwkwkwkk', 'kwwwwwwk', 'kkkkkkkk'],
    cols: { k: '#4a3a6b', w: '#eadcff' },
    blurb: 'Loud switches, louder hits.',
  },
  mug: {
    slot: 'held',
    name: 'Coffee mug',
    rarity: 0,
    edge: 1,
    map: ['kkkk..', 'mmmmmm', 'mWmm.m', 'mmmmmm', 'MMMM..'],
    cols: { k: '#4f2c2c', m: '#4f7fe0', W: '#d2efff', M: '#32449a' },
    blurb: 'Fuel for the next sprint.',
  },
} satisfies Record<string, ItemDef>;
export const ITEMS: Record<string, ItemDef> = ITEM_DEFS;
export const ICONS: Record<string, IconDef> = {
  phones: {
    map: ['.bbbbbb.', 'b......b', 'b......b', 'rr....rr', 'RR....RR', 'rr....rr'],
    cols: { b: '#4f7fe0', r: '#cf3a4a', R: '#ff6f62' },
  },
  glasses: { map: ['kkkk.kkkk', 'kllk.kllk', 'kllkkkllk', 'kllk.kllk', 'kkkk.kkkk'], cols: { k: '#e39b3a', l: '#d2efff' } },
  shades: { map: ['kkkkkkkkkk', 'kbkkkkbkkk', 'kkkk..kkkk'], cols: { k: '#1a1124', b: '#86bdff' } },
  scarf: { map: ['rRrRrRrR', 'RrRrRrRr', '.rr.....', '.Rr.....', '.yy.....'], cols: { r: '#cf3a4a', R: '#ff6f62', y: '#ffd166' } },
};
export const SLOTS: [Slot, string][] = [
  ['head', 'Head'],
  ['face', 'Face'],
  ['neck', 'Neck'],
  ['body', 'Body'],
  ['held', 'Held'],
];
export const SLOT_IDS: Slot[] = SLOTS.map(([s]) => s);
export const isSlot = (s: unknown): s is Slot => SLOT_IDS.includes(s as Slot);
/** An empty outfit, one key per slot. */
export const noItems = (): Record<Slot, string | null> => ({ head: null, face: null, neck: null, body: null, held: null });
export const ITEM_IDS = Object.keys(ITEMS);

const GR = { NONE: 0, BODY: 1, ACC: 2, BELLY: 3, DARK: 4, WHITE: 5, BLUSH: 6, MOUTH: 7, ITEM: 8, LINE: 9, STALK: 10 };
export const L_BODY = 1,
  L_PAT = 2,
  L_EARS = 4,
  L_TAIL = 8,
  L_FACE = 16,
  L_ITEMS = 32,
  L_ALL = 63;
const EYE: Record<string, string[]> = {
  round: ['wd', 'dd', 'dd'],
  big: ['.dd.', 'dwwd', 'dwdd', 'dddd', '.dd.'],
  tall: ['wd', 'dd', 'dd', 'dd'],
  dot: ['dd', 'dd'],
  sleepy: ['ddd', '.dd'],
  cyclops: ['.dddd.', 'dwwwwd', 'dwwdwd', 'dwddwd', 'dwwwwd', '.dddd.'],
};
const MOUTH: Record<string, string[]> = {
  smile: ['d..d', '.dd.'],
  cat: ['d.dd.d', '.d..d.'],
  dot: ['dd'],
  fang: ['dddd', '..w.'],
  open: ['.dd.', 'dmmd', '.dd.'],
  frown: ['.dd.', 'd..d'],
  o: ['.dd.', 'd..d', '.dd.'],
};

export interface Pose {
  stage?: number;
  sq?: number;
  eyes?: string;
  mouth?: string;
  look?: number;
  flash?: boolean;
  sil?: string;
  phase?: number;
  L?: number;
  noItems?: boolean;
  /** Keep only the item pixels (and their outline): used for shop icons and the distinctness check. */
  itemsOnly?: boolean;
}
/** The resting animation at time t (seconds): a two-beat bob, blinks and tail sway. */
export function idlePose(g: Pick<Genome, 'blinkOff'>, t: number, extra?: Pose): Pose {
  const b = Math.floor((t + g.blinkOff) * 2) % 2,
    bt = (t + g.blinkOff * 1.7) % 3.9;
  return Object.assign({ sq: b, eyes: bt < 0.13 ? 'blink' : undefined, phase: Math.floor(t * 5) % 2 }, extra || {});
}

/** One pixel: a '#rrggbb' colour, or null for transparent. */
export type Px = string | null;
/** Per-slot item pixels: how many were drawn, how many fell off the 32x32 canvas, how many are still visible at the end. */
export interface ItemFit {
  drawn: number;
  clipped: number;
  visible: number;
}
export interface SpriteMeta {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  eyeY: number;
  headTop: number;
  items: Partial<Record<Slot, ItemFit>>;
}
/** The genome traits the composer reads. Items are optional: without them the creature is drawn bare. */
export type SpriteGenome = Pick<
  Genome,
  | 'shape'
  | 'rx'
  | 'ry'
  | 'n'
  | 'ears'
  | 'tail'
  | 'eyes'
  | 'mouth'
  | 'pattern'
  | 'feet'
  | 'arms'
  | 'blush'
  | 'flop'
  | 'pal'
  | 'belly'
  | 'seed'
> & { items?: Genome['items']; gear?: Record<string, ItemDef> };
type Pred = (px: number, py: number) => boolean;

export function compose(g: SpriteGenome, pose: Pose = {}): { cols: Px[]; meta: SpriteMeta } {
  const W = 32,
    H = 32,
    N = W * H;
  const grp = new Uint8Array(N),
    shp = new Uint8Array(N),
    shade = new Uint8Array(N),
    icol = new Array<string>(N),
    edge = new Uint8Array(N);
  const st = pose.stage == null ? 1 : pose.stage,
    L = pose.L == null ? L_ALL : pose.L;
  const k = st === 0 ? 0.74 : st === 2 ? 1.16 : 1,
    sq = pose.sq || 0;
  const rx = g.rx * k + sq * 0.6,
    ry = Math.max(3, g.ry * k - sq);
  const hasFeet = g.feet && st > 0,
    bottom = hasFeet ? 29 : 30,
    cx = 16,
    cy = bottom - ry;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const put = (x: number, y: number, gr: number, s: number) => {
    if (!inb(x, y)) return;
    const i = y * W + x;
    grp[i] = gr;
    shp[i] = s;
  };
  const fill = (fn: Pred, gr: number, s: number, cond?: (i: number) => boolean) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (fn(x + 0.5, y + 0.5) && (!cond || cond(y * W + x))) put(x, y, gr, s);
      }
  };
  const ell =
    (ex: number, ey: number, a: number, b: number, ang?: number): Pred =>
    (px, py) => {
      let dx = px - ex,
        dy = py - ey;
      if (ang) {
        const c = Math.cos(ang),
          s = Math.sin(ang);
        const tx = dx * c + dy * s;
        dy = -dx * s + dy * c;
        dx = tx;
      }
      return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
    };
  const tri =
    (ax: number, ay: number, bx: number, by: number, qx: number, qy: number): Pred =>
    (px, py) => {
      const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by),
        d2 = (px - qx) * (by - qy) - (bx - qx) * (py - qy),
        d3 = (px - ax) * (qy - ay) - (qx - ax) * (py - ay);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
  const path =
    (pts: number[][], r0: number, r1: number): Pred =>
    (px, py) => {
      for (let j = 0; j < pts.length - 1; j++) {
        const [ax, ay] = pts[j],
          [bx, by] = pts[j + 1];
        const vx = bx - ax,
          vy = by - ay,
          l2 = vx * vx + vy * vy || 1;
        let t = ((px - ax) * vx + (py - ay) * vy) / l2;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * vx - px,
          qy = ay + t * vy - py,
          f = (j + t) / (pts.length - 1),
          r = r0 + (r1 - r0) * f;
        if (qx * qx + qy * qy <= r * r) return true;
      }
      return false;
    };
  const n = g.n;
  const bodyFn = (px: number, py: number) => {
    const dy = (py - cy) / ry;
    let dx = (px - cx) / rx;
    if (g.shape === 'pear') dx /= 1 + 0.22 * dy;
    else if (g.shape === 'drop') dx /= 1 + 0.32 * dy;
    else if (g.shape === 'bean') dx /= 1 - 0.1 * dy;
    return Math.abs(dx) ** n + Math.abs(dy) ** n <= 1;
  };
  const bm = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bm[y * W + x] = bodyFn(x + 0.5, y + 0.5) ? 1 : 0;
  const topY = (x: number) => {
    x = Math.max(0, Math.min(W - 1, Math.floor(x)));
    for (let y = 0; y < H; y++) if (bm[y * W + x]) return y;
    return Math.round(cy - ry);
  };
  const headTop = topY(15.5);
  const items: Record<string, string | null> = L & L_ITEMS && !pose.noItems ? g.items || {} : {};
  const hatOn = !!items.head;
  // Item definitions: the classics by id, generated items from the outfit's `gear`.
  const def = (id: string | null | undefined): ItemDef | undefined => (id ? (g.gear?.[id] ?? ITEMS[id]) : undefined);
  const kindOf = (s: Slot) => {
    const d = def(items[s]);
    return d?.kind ? d : undefined;
  };
  // Which slot drew each item pixel, so callers (and the fit tests) can see what survived.
  const islot = new Uint8Array(N);
  const fit: Partial<Record<Slot, ItemFit>> = {};
  let cur = 0;
  const begin = (s: Slot) => {
    cur = SLOT_IDS.indexOf(s) + 1;
    fit[s] ??= { drawn: 0, clipped: 0, visible: 0 };
  };
  /** Paint one item pixel for the current slot; off-canvas pixels are counted as clipped. */
  const paint = (x: number, y: number, col: string, outlined = false) => {
    const f = cur ? fit[SLOT_IDS[cur - 1]] : undefined;
    if (f) f.drawn++;
    if (!inb(x, y)) {
      if (f) f.clipped++;
      return;
    }
    const q = y * W + x;
    grp[q] = GR.ITEM;
    icol[q] = col;
    islot[q] = cur;
    if (outlined) edge[q] = 1;
  };

  if (st === 2 && L & L_EARS) {
    // wings
    for (const s of [-1, 1]) {
      const reach = Math.min(rx + 5, 15.2);
      fill(tri(cx + s * (rx - 2.5), cy - 2, cx + s * reach, cy - 7.5, cx + s * (rx + 2.5), cy + 3), GR.ACC, 5);
      fill(tri(cx + s * (rx - 2.5), cy, cx + s * Math.min(rx + 4.4, 15.2), cy - 2, cx + s * (rx + 1), cy + 5), GR.ACC, 5);
    }
  }
  if (st > 0 && g.tail !== 'none' && L & L_TAIL) {
    const bx = cx + rx * 0.8,
      by = cy + ry * 0.45,
      ph = pose.phase || 0,
      T = (pts: number[][]) => pts.map(([a, b]) => [bx + a, by + b]);
    switch (g.tail) {
      case 'curl':
        fill(
          path(
            T([
              [0, 0],
              [2.5, -0.5],
              [4.5, -2.5],
              [5, -5],
              [3.8, -6.6],
              [2.2, -6.4],
              [1.8, -4.8],
              [3, -4],
            ]),
            1.3,
            0.8,
          ),
          GR.BODY,
          4,
        );
        break;
      case 'bolt':
        fill(
          path(
            T([
              [0, 0],
              [3, -1.5],
              [2, -3],
              [5, -5],
              [4, -6.5],
              [7, -9],
            ]),
            1.0,
            0.7,
          ),
          GR.ACC,
          4,
        );
        break;
      case 'ball':
        fill(
          path(
            T([
              [0, 0],
              [2, -0.5],
            ]),
            0.9,
            0.9,
          ),
          GR.BODY,
          4,
        );
        fill(ell(bx + 3.3, by - 1.5, 2.6, 2.4), GR.ACC, 4);
        break;
      case 'spade':
        fill(
          path(
            T([
              [0, 0],
              [2.5, 0],
              [4.5, -2.5],
            ]),
            0.8,
            0.7,
          ),
          GR.BODY,
          4,
        );
        fill(tri(bx + 3, by - 3.6, bx + 7.5, by - 2.6, bx + 5.8, by - 7), GR.ACC, 4);
        break;
      case 'flame':
        fill(
          path(
            T([
              [0, 0],
              [2, -1],
            ]),
            0.9,
            0.9,
          ),
          GR.BODY,
          4,
        );
        fill(ell(bx + 3.6, by - 2.6, 2.3, 2.6), GR.ACC, 4);
        fill(tri(bx + 1.5, by - 3.2, bx + 5.7, by - 3.2, bx + (ph ? 5 : 3), by - 8), GR.ACC, 4);
        break;
    }
  }
  let ears = g.ears;
  if (st === 2 && ears === 'none') ears = 'horns';
  if (L & L_EARS) {
    const es = st === 0 ? 0.6 : st === 2 ? 1.2 : 1,
      ex = Math.max(3, rx * 0.55);
    for (const s of [-1, 1]) {
      const x = cx + s * ex,
        by = topY(x) + 1.5,
        sid = s < 0 ? 2 : 3,
        flop = g.flop && s > 0;
      if (ears === 'cat') {
        const h = Math.min(5.5 * es, by - 1),
          w = 3 * Math.min(es, 1.1);
        const ax = flop ? x + s * 3.6 : x + s * 1.2,
          ay = flop ? by - h * 0.55 : by - h;
        fill(tri(x - w, by + 1, x + w, by + 1, ax, ay), GR.BODY, sid);
        fill(tri(x - w * 0.4, by + 0.5, x + w * 0.4, by + 0.5, x + (ax - x) * 0.6, by - (by - ay) * 0.55), GR.ACC, sid);
      } else if (ears === 'bunny') {
        const h = Math.max(2, Math.min(5 * es, (by - 1.5) / 2));
        const ang = flop ? s * 1.15 : s * 0.18,
          ox = flop ? s * 3.2 : s * 0.8,
          oy = flop ? -2.4 : -h + 0.6;
        fill(ell(x + ox, by + oy, 1.9, h, ang), GR.BODY, sid);
        fill(ell(x + ox, by + oy + 0.3, 0.8, Math.max(0.8, h - 1.5), ang), GR.ACC, sid);
      } else if (ears === 'antenna') {
        const h = 5 * es;
        const pts = flop
          ? [
              [x, by],
              [x + 1.6, by - h * 0.8],
              [x + 3.6, by - h * 0.8],
            ]
          : [
              [x, by],
              [x + s, by - h],
            ];
        fill(path(pts, 0.55, 0.55), GR.STALK, sid);
        const e = pts[pts.length - 1];
        fill(ell(e[0], e[1], 1.7, 1.7), GR.ACC, sid);
      } else if (ears === 'horns') {
        const h = 6 * es;
        fill(
          path(
            [
              [x, by],
              [x + s * 2.4, by - h * 0.6],
              [x + s * 1.4, by - h],
            ],
            1.6,
            0.55,
          ),
          GR.ACC,
          sid,
        );
      } else if (ears === 'round') {
        const rr = 2.7 * Math.min(es, 1.1);
        fill(ell(x + s * 0.6, by - 1.6, rr, rr), GR.BODY, sid);
        fill(ell(x + s * 0.6, by - 1.4, rr * 0.48, rr * 0.48), GR.ACC, sid);
      }
    }
    if (!hatOn) {
      const t = headTop,
        es2 = st === 0 ? 0.6 : 1;
      if (ears === 'fin') {
        fill(tri(cx - 3.5, t + 2.5, cx + 2.5, t + 2.5, cx + 2, t - 4 * es2), GR.ACC, 2);
        fill(tri(cx + 1.5, t + 3, cx + 5.5, t + 3.5, cx + 5, t - 1.5 * es2), GR.ACC, 3);
      }
      if (ears === 'sprout') {
        fill(
          path(
            [
              [cx - 0.5, t + 1.5],
              [cx - 0.5, t - 2.5 * es2],
            ],
            0.5,
            0.5,
          ),
          GR.STALK,
          2,
        );
        fill(ell(cx + 1.8, t - 3.3 * es2, 2.3, 1.2, -0.5), GR.ACC, 3);
        fill(ell(cx - 2, t - 2.3 * es2, 1.4, 0.8, 0.55), GR.ACC, 2);
      }
    }
  }
  if (L & L_BODY) {
    for (let i = 0; i < N; i++)
      if (bm[i]) {
        grp[i] = GR.BODY;
        shp[i] = 1;
      }
    if (hasFeet) for (const s of [-1, 1]) fill(ell(cx + s * rx * 0.45, 28.6, 2.3, 1.5), GR.BODY, 6);
    if (st > 0 && g.arms) for (const s of [-1, 1]) fill(ell(cx + s * (rx - 0.2), cy + ry * 0.3, 1.5, 2.1), GR.BODY, 7);
  }
  const openH = EYE[g.eyes].length;
  const eyeY = Math.round(cy + ry * 0.08 + (st === 0 ? 0.6 : 0)) - (g.eyes === 'cyclops' ? 1 : 0);
  const isBody = (i: number) => shp[i] === 1;
  if (L & L_PAT && L & L_BODY) {
    const pat = g.pattern;
    if (pat === 'belly' || (st === 2 && pat === 'none')) fill(ell(cx, cy + ry * 0.42, rx * 0.58, ry * 0.52), GR.BELLY, 1, isBody);
    if (pat === 'split') fill((_px, py) => py > cy + ry * 0.18, GR.ACC, 1, isBody);
    if (pat === 'spots') {
      const r = mulberry(g.seed ^ 0x9e37);
      for (let j = 0; j < 4; j++) {
        const u = (r() * 1.5 - 0.75) * rx,
          v = (r() * 1.0 - 0.85) * ry,
          rr = 1 + r() * 0.9;
        fill(ell(cx + u, cy + v, rr, rr), GR.ACC, 1, isBody);
      }
    }
    if (pat === 'stripes') {
      const t = cy - ry;
      fill(
        (px, py) =>
          py < t + 3.8 &&
          ((px > cx - 4 && px < cx - 2.6) || (px > cx - 1 && px < cx + 1) || (px > cx + 2.6 && px < cx + 4)) &&
          !(py > t + 2.8 && Math.abs(px - cx) > 2),
        GR.ACC,
        1,
        isBody,
      );
    }
    if (pat === 'mask') fill((px, py) => Math.abs(py - eyeY - 0.5) < 2 && Math.abs(px - cx) > 1, GR.ACC, 1, isBody);
    if (st === 2) fill((px, py) => Math.abs(px - cx) + Math.abs(py - (cy + ry * 0.55)) <= 1.6, GR.ACC, 1, isBody);
  }
  // shading per shape: light from the top left
  const S = (x: number, y: number, s: number) =>
    inb(x, y) && shp[y * W + x] === s && grp[y * W + x] !== GR.LINE && grp[y * W + x] !== GR.STALK && grp[y * W + x] !== GR.NONE;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x,
        g0 = grp[i];
      if (g0 < 1 || g0 > 3) continue;
      const s = shp[i];
      let v = 1;
      if (!S(x + 1, y + 1, s) || !S(x + 2, y + 2, s)) v = 0;
      else if (!S(x - 1, y - 1, s)) v = 2;
      shade[i] = v;
    }
  if (L & L_BODY) {
    const sx = Math.round(cx - rx * 0.5),
      sy = Math.round(cy - ry * 0.55);
    for (const [a, b] of [
      [sx, sy],
      [sx + 1, sy],
      [sx, sy + 1],
    ]) {
      if (inb(a, b) && shp[b * W + a] === 1 && grp[b * W + a] <= 3) shade[b * W + a] = 3;
    }
  }

  const stamp = (m: string[], x0: number, y0: number, map?: Record<string, string>) => {
    x0 = Math.round(x0);
    for (let j = 0; j < m.length; j++)
      for (let i = 0; i < m[j].length; i++) {
        const ch = m[j][i];
        if (ch === '.') continue;
        const x = x0 + i,
          y = y0 + j;
        if (map) paint(x, y, map[ch]);
        else if (inb(x, y))
          grp[y * W + x] = ch === 'd' ? GR.DARK : ch === 'w' ? GR.WHITE : ch === 'm' ? GR.MOUTH : ch === 'b' ? GR.BLUSH : GR.DARK;
      }
  };
  const eyeCentres =
    g.eyes === 'cyclops'
      ? [cx]
      : [cx - Math.max(g.eyes === 'big' ? 5 : 4, Math.round(rx * 0.47)), cx + Math.max(g.eyes === 'big' ? 5 : 4, Math.round(rx * 0.47))];
  const look = pose.look || 0,
    mode = pose.eyes || 'open';
  const openMap = EYE[g.eyes],
    ow = openMap[0].length,
    y0open = eyeY - Math.floor(openH / 2);
  const boxes = eyeCentres.map((c) => [Math.round(c - ow / 2) + look, y0open, ow, openH]);
  const mouthY = y0open + openH + (g.eyes === 'cyclops' ? 0 : 1);
  const lens = kindOf('face');
  /** Generated eyewear. Clear-lens styles go on before the eyes (so the eyes show through), tinted ones after. */
  const drawLens = (p: ItemParams, over: boolean) => {
    const [frame, glass, extra] = p.c;
    // Drawn alone (icons, distinctness), clear lenses go over the eyes too, so the glass shows.
    const tinted = p.style === 'visor' || !!pose.itemsOnly;
    if (tinted !== over && !(pose.itemsOnly && !over)) return;
    begin('face');
    if (p.style === 'visor') {
      const xa = boxes[0][0] - 1,
        xb = boxes[boxes.length - 1][0] + ow;
      for (let x = xa; x <= xb; x++) {
        paint(x, eyeY - 1, frame);
        paint(x, eyeY, x === xa + 1 ? '#ffffff' : glass);
        paint(x, eyeY + 1, extra);
      }
      return;
    }
    const list = p.style === 'monocle' ? [boxes[boxes.length - 1]] : boxes;
    list.forEach(([x0, yy, w, h], bi) => {
      const bx0 = x0 - 1,
        bx1 = x0 + Math.max(w, 2),
        by1 = yy + Math.max(h, 3),
        by0 = p.style === 'half' ? yy + Math.floor(Math.max(h, 3) / 2) : yy - 1;
      const fill = p.style === '3d' ? (bi === 0 ? glass : extra) : glass;
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) {
          const corner = (x === bx0 || x === bx1) && (y === by0 || y === by1);
          if (corner && (p.style === 'round' || p.style === 'cat' || p.style === 'monocle' || p.style === 'aviator')) continue;
          const rim = x === bx0 || x === bx1 || y === by0 || y === by1;
          // browline: a heavy top bar in the accent colour; aviator: a lower tint band
          const col = p.style === 'browline' && y === by0 ? extra : rim ? frame : p.style === 'aviator' && y >= by1 - 1 ? extra : fill;
          paint(x, y, col);
        }
      if (p.style === 'browline') for (let x = bx0; x <= bx1; x++) paint(x, by0 - 1, extra);
      if (p.style === 'aviator') for (let x = bx0 + 1; x < bx1; x++) paint(x, by1 + 1, frame);
      if (p.style === 'cat') paint(bi === 0 && list.length > 1 ? bx0 - 1 : bx1 + 1, by0 - 1, frame);
      if (p.style === 'monocle') for (let k = 1; k <= 3; k++) paint(bx1 + (k > 1 ? 1 : 0), by1 + k, extra);
    });
    if (list.length === 2 && p.style !== 'half') {
      const y = list[0][1];
      for (let x = list[0][0] + list[0][2] + 1; x < list[1][0] - 1; x++) paint(x, y, frame);
    }
    if (p.style === 'goggles') {
      // the strap runs across the head at eye level, wherever the body is
      const y = list[0][1];
      for (let x = 0; x < W; x++) if (bm[y * W + x] && grp[y * W + x] !== GR.ITEM) paint(x, y, extra);
    }
  };
  if (L & L_FACE && L & L_BODY) {
    if (lens?.p) drawLens(lens.p, false);
    if (items.face === 'glasses') {
      begin('face');
      for (const [x0, yy, w, h] of boxes) {
        const bx0 = x0 - 1,
          by0 = yy - 1,
          bx1 = x0 + Math.max(w, 2),
          by1 = yy + Math.max(h, 3);
        for (let y = by0; y <= by1; y++)
          for (let x = bx0; x <= bx1; x++) {
            if (!inb(x, y)) continue;
            const corner = (x === bx0 || x === bx1) && (y === by0 || y === by1);
            if (corner) continue;
            paint(x, y, x === bx0 || x === bx1 || y === by0 || y === by1 ? '#e39b3a' : '#d2efff');
          }
      }
      if (boxes.length === 2) {
        const y = boxes[0][1];
        for (let x = boxes[0][0] + boxes[0][2] + 1; x < boxes[1][0] - 1; x++) if (inb(x, y)) paint(x, y, '#e39b3a');
      }
    }
    cur = 0;
    eyeCentres.forEach((c, ix) => {
      const right = ix === 1;
      let m = openMap;
      if (mode === 'blink' || mode === 'closed') {
        const w = Math.max(ow, 3);
        m = [g.eyes === 'cyclops' ? '.dddd.' : 'd'.repeat(w)];
        stamp(m, Math.round(c - m[0].length / 2) + look, y0open + openH - 1 - (openH > 3 ? 1 : 0));
        return;
      }
      if (mode === 'happy') m = g.eyes === 'cyclops' ? ['.dddd.', 'd....d'] : ['.d.', 'd.d'];
      if (mode === 'hurt')
        m = g.eyes === 'cyclops' ? ['d....d', '.d..d.', '..dd..', '.d..d.', 'd....d'] : right ? ['.d', 'd.', '.d'] : ['d.', '.d', 'd.'];
      if (mode === 'sleep') m = g.eyes === 'cyclops' ? ['d....d', '.dddd.'] : ['d..d', '.dd.'];
      const yy = mode === 'open' ? y0open : eyeY - Math.floor(m.length / 2);
      stamp(m, Math.round(c - m[0].length / 2) + look, yy);
    });
    if (g.pattern === 'freckles' && g.eyes !== 'cyclops') {
      for (const c of eyeCentres) {
        const yb = y0open + openH + 1;
        for (const [a, b] of [
          [c - 2, yb],
          [c, yb],
          [c - 1, yb + 1],
          [c + 1, yb + 1],
        ]) {
          const x = Math.round(a),
            q = b * W + x;
          if (inb(x, b) && grp[q] >= 1 && grp[q] <= 3) {
            grp[q] = GR.ACC;
            shade[q] = 0;
          }
        }
      }
    } else if (g.blush && mode !== 'hurt' && g.pal[0] !== 'gum') {
      eyeCentres.forEach((c, ix) => {
        const s = g.eyes === 'cyclops' ? 0 : ix ? 1 : -1;
        if (!s) {
          for (const dx of [-5, -4, 3, 4]) {
            const x = Math.round(c + dx),
              y = y0open + openH,
              q = y * W + x;
            if (inb(x, y) && grp[q] >= 1 && grp[q] <= 3) grp[q] = GR.BLUSH;
          }
          return;
        }
        const yb = y0open + openH;
        for (const dx of [0, 1]) {
          const x = Math.round(c + s * (ow / 2 + dx) - (s < 0 ? 1 : 0)),
            q = yb * W + x;
          if (inb(x, yb) && grp[q] >= 1 && grp[q] <= 3) grp[q] = GR.BLUSH;
        }
      });
    }
    const mm = pose.mouth || g.mouth;
    const mmap = MOUTH[mm];
    stamp(mmap, cx - mmap[0].length / 2, mouthY);
    if (lens?.p) drawLens(lens.p, true);
    if (items.face === 'shades') {
      begin('face');
      const xa = boxes[0][0] - 1,
        xb = boxes[boxes.length - 1][0] + ow;
      for (let y = eyeY - 1; y <= eyeY + 1; y++)
        for (let x = xa; x <= xb; x++) {
          if (!inb(x, y)) continue;
          const inLens = boxes.some(([x0, , w]) => x >= x0 - 1 && x <= x0 + w);
          if (y > eyeY - 1 && !inLens) continue;
          paint(x, y, INK);
        }
      for (const [x0] of boxes) {
        const q = eyeY * W + x0;
        if (inb(x0, eyeY)) {
          icol[q] = '#86bdff';
        }
      }
    }
  }
  if (L & L_ITEMS) {
    const ny = mouthY + MOUTH[pose.mouth || g.mouth].length + 1;
    const nearBody = (x: number, y: number) => {
      const q = y * W + x;
      return inb(x, y) && !!(bm[q] || (x > 0 && bm[q - 1]) || (x < W - 1 && bm[q + 1]));
    };
    const markEdge = (x0: number, y0: number, m: string[]) => {
      for (let j = 0; j < m.length; j++)
        for (let i = 0; i < m[j].length; i++) if (m[j][i] !== '.' && inb(x0 + i, y0 + j)) edge[(y0 + j) * W + x0 + i] = 1;
    };
    const stampItem = (s: Slot, m: string[], x0: number, y0: number, colMap: Record<string, string>, outlined: boolean) => {
      begin(s);
      x0 = Math.round(x0);
      stamp(m, x0, y0, colMap);
      if (outlined) markEdge(x0, y0, m);
    };
    /** Torso pixels below the neck line: body and arms, not ears, feet, eyes or mouth. */
    const torso = (q: number, y: number) => y >= ny && grp[q] >= 1 && grp[q] <= 3 && (shp[q] === 1 || shp[q] === 7);

    // Clothes recolour the torso, so they go on before anything worn over them.
    const wear = kindOf('body');
    if (wear?.p) {
      const { style, c } = wear.p;
      const tone = (q: number) => c[Math.min(3, shade[q])];
      begin('body');
      /** The main body's left and right edge on a row, or null. */
      const span = (y: number): [number, number] | null => {
        let l = -1,
          r2 = -1;
        for (let x = 0; x < W; x++)
          if (bm[y * W + x] && shp[y * W + x] === 1) {
            if (l < 0) l = x;
            r2 = x;
          }
        return l < 0 ? null : [l, r2];
      };
      let bottom = H - 1;
      while (bottom > 0 && !span(bottom)) bottom--;
      const icx = Math.round(cx);
      if (style === 'cape') {
        // Hangs behind: only the part outside the body shows, flaring towards the hem.
        const top = Math.max(headTop + 3, eyeY - 2);
        for (let y = top; y <= bottom; y++) {
          const s = span(y);
          if (!s) continue;
          const spread = 1 + Math.min(2, Math.floor((y - top) / 3));
          for (let k = 1; k <= spread; k++) {
            const col = y === bottom ? c[0] : k === spread ? c[1] : patternOn(wear.p.pat, k, y - top) ? c[4] : c[2];
            for (const x of [s[0] - k, s[1] + k]) if (!bm[y * W + x] || grp[y * W + x] === GR.NONE) paint(x, y, col, true);
          }
        }
        for (const x of [icx - 1, icx]) paint(x, ny, c[4]);
      } else if (style === 'wings') {
        // Small fairy wings behind the shoulders.
        const y0 = Math.round(cy - ry * 0.35),
          s = span(y0 + 2);
        if (s) {
          const wing = ['.aa', 'abw', 'abb', '.ab', '..a'];
          const colMap = { a: c[1], b: c[4], w: '#fff2dc' };
          stampItem('body', wing, s[0] - 3, y0, colMap, true);
          stampItem(
            'body',
            wing.map((l) => [...l].reverse().join('')),
            s[1] + 1,
            y0,
            colMap,
            true,
          );
        }
      } else if (style === 'tutu') {
        // A frilled skirt round the bottom of the body, sticking out a pixel each side.
        for (const [y, out] of [
          [bottom - 2, 1],
          [bottom - 1, 2],
        ] as const) {
          const s = span(y);
          if (!s) continue;
          for (let x = s[0] - out; x <= s[1] + out; x++) paint(x, y, out === 2 ? ((x + y) % 2 ? c[4] : c[2]) : c[3], true);
        }
      } else if (style !== 'backpack') {
        for (let y = ny; y < H; y++)
          for (let x = 0; x < W; x++) {
            const q = y * W + x;
            if (!torso(q, y)) continue;
            const ax = Math.abs(x + 0.5 - cx);
            if (style === 'vest' && ax < 1.6 && shp[q] === 1) continue;
            if (style === 'overalls' && y < ny + 3 && ax > 2.6 && shp[q] === 1) continue;
            let col = tone(q);
            const pat = wear.p.pat ?? (style === 'jumper' ? 'stripes' : 'plain');
            if (patternOn(pat, x - Math.round(cx), y - ny)) col = c[4];
            if (style === 'jumper' && y === ny) col = c[0];
            if (style === 'vest' && ax < 2.6 && (y - ny) % 2 === 1 && shp[q] === 1) col = c[4];
            paint(x, y, col);
          }
        if (style === 'hoodie') {
          for (let y = headTop + 2; y < ny; y++)
            for (let x = 0; x < W; x++) {
              const q = y * W + x;
              if (!bm[q] || grp[q] < 1 || grp[q] > 3) continue;
              const rim = (x > 0 && !bm[q - 1]) || (x < W - 1 && !bm[q + 1]) || (y > 0 && !bm[q - W]);
              if (rim) paint(x, y, c[1]);
            }
          for (const x of [Math.round(cx) - 2, Math.round(cx) + 1]) for (let y = ny; y <= ny + 2; y++) if (bm[y * W + x]) paint(x, y, c[4]);
          for (let x = Math.round(cx) - 3; x <= Math.round(cx) + 2; x++) if (bm[(ny + 4) * W + x]) paint(x, ny + 4, c[0]);
        }
        if (style === 'tee') {
          const lx = Math.round(cx) - 1;
          for (const [i, j, k] of [
            [0, 0, 4],
            [2, 0, 4],
            [1, 1, 5],
            [0, 2, 4],
            [2, 2, 4],
          ])
            if (bm[(ny + 2 + j) * W + lx + i]) paint(lx + i, ny + 2 + j, c[k] ?? c[4]);
        }
        if (style === 'overalls')
          for (const s of [-1, 1]) {
            const x = Math.round(cx + s * rx * 0.45) - (s > 0 ? 1 : 0);
            for (let y = ny; y < ny + 3; y++) if (bm[y * W + x]) paint(x, y, c[1]);
            if (bm[(ny + 3) * W + Math.round(cx) + s * 2]) paint(Math.round(cx) + (s > 0 ? 1 : -2), ny + 3, c[4]);
          }
      } else {
        // straps over the shoulders, the pack itself peeking out on the left
        for (const s of [-1, 1]) {
          const x = Math.round(cx + s * rx * 0.45) - (s > 0 ? 1 : 0);
          for (let y = ny; y < H; y++) if (torso(y * W + x, y)) paint(x, y, c[1]);
        }
        const pack = ['.333.', '24442', '21222', '24442', '21112', '21112', '11111', '.000.'];
        const colMap: Record<string, string> = { '0': c[0], '1': c[1], '2': c[2], '3': c[3], '4': c[4] };
        const s = span(ny) ?? [Math.round(cx - rx), 0];
        stampItem('body', pack, Math.max(0, s[0] - 3), Math.min(H - pack.length, Math.max(0, ny - 4)), colMap, true);
      }
    }

    const neck = def(items.neck);
    if (items.neck === 'scarf') drawScarf({ style: 'stripe', c: ['#cf3a4a', '#ff6f62', '#7e1f3a', '#ffd166'] });
    else if (neck?.kind === 'band' && neck.p) {
      const p = neck.p;
      if (p.style === 'stripe' || p.style === 'knit' || p.style === 'plain') drawScarf(p);
      else drawBand(p);
    } else if (neck && hasMap(neck)) stampItem('neck', neck.map, cx - neck.map[0].length / 2, ny, neck.cols, !!neck.day);

    function drawScarf(p: ItemParams) {
      const [a, b, dark, tassel] = p.c;
      begin('neck');
      for (const y of [ny, ny + 1])
        for (let x = 0; x < W; x++) {
          if (!nearBody(x, y)) continue;
          const on = p.pat
            ? patternOn(p.pat, x - Math.round(cx), y - ny)
            : p.style === 'stripe'
              ? (x >> 1) % 2
              : p.style === 'knit'
                ? (x + y) % 2
                : 0;
          paint(x, y, y === ny + 1 && !p.pat ? dark : on ? a : b);
        }
      const sx = Math.round(cx - rx * 0.35);
      for (let y = ny + 2; y <= ny + 4; y++) for (const x of [sx, sx + 1]) if (inb(x, y)) paint(x, y, y === ny + 4 ? tassel : a);
    }
    function drawBand(p: ItemParams) {
      const [a, b, dark] = p.c;
      begin('neck');
      const icx = Math.round(cx);
      if (p.style === 'bandana') {
        for (let x = 0; x < W; x++) if (nearBody(x, ny)) paint(x, ny, dark);
        for (let j = 1; j <= 4; j++)
          for (let x = icx - 4 + j; x <= icx + 4 - j; x++) paint(x, ny + j, j === 4 ? dark : (x + j) % 3 === 0 ? b : a, true);
      } else if (p.style === 'lanyard') {
        for (const s of [-1, 1]) {
          const x0 = Math.round(cx + s * rx * 0.45) - (s > 0 ? 1 : 0);
          for (let j = 0; j < 3; j++) paint(Math.round(x0 + ((icx - x0) * j) / 3), ny + j, a);
        }
        stampItem('neck', ['.k.', 'bbb', 'bwb', 'bbb'], icx - 1, ny + 2, { k: dark, b, w: '#fff2dc' }, true);
      } else if (p.style === 'beads') {
        for (let x = 0; x < W; x++) if (nearBody(x, ny) && x % 2 === 0) paint(x, ny, a);
        stampItem('neck', ['.a.', 'aba', '.d.'], icx - 1, ny + 1, { a: b, b: '#fff2dc', d: dark }, true);
      } else {
        // collar: a turned-down polo collar
        for (const y of [ny, ny + 1]) for (let x = 0; x < W; x++) if (nearBody(x, y)) paint(x, y, y === ny ? a : b);
        for (const x of [icx - 2, icx - 1, icx, icx + 1]) paint(x, ny + 2, x === icx - 1 || x === icx ? dark : b);
      }
    }

    const held = def(items.held);
    if (held && hasMap(held) && st > 0) {
      const x0 = Math.min(W - held.map[0].length, Math.round(cx + rx - 3)),
        y0 = Math.round(cy + ry * 0.3) - held.map.length + 3;
      stampItem('held', held.map, x0, y0, held.cols, true);
    }

    const head = def(items.head);
    if (items.head === 'phones') drawPhones({ style: 'cans', c: ['#4f7fe0', '#cf3a4a', '#ff6f62', '#7e1f3a'] });
    else if (head?.kind === 'phones' && head.p) drawPhones(head.p);
    else if (head && hasMap(head)) {
      const m = head.anim && pose.phase ? head.anim : head.map;
      const w = m[0].length,
        y0 = Math.max(0, headTop + 2 - m.length);
      stampItem('head', m, cx - w / 2, y0, head.cols, true);
    }
    function drawPhones(p: ItemParams) {
      const [band, cup, light, dark] = p.c;
      begin('head');
      const R = ry + 0.6;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const dx = x + 0.5 - cx,
            dy = y + 0.5 - cy,
            d = Math.sqrt((dx * dx) / ((rx + 0.8) * (rx + 0.8)) + (dy * dy) / (R * R));
          if (d >= 1 && d < 1 + 1.4 / R && dy < -ry * 0.35) paint(x, y, band);
        }
      if (p.style === 'cat')
        for (const s of [-1, 1]) {
          const ex = Math.round(cx + s * rx * 0.5) - (s > 0 ? 1 : 0);
          let by = 0;
          while (by < H - 1 && !(grp[by * W + ex] === GR.ITEM && islot[by * W + ex] === cur)) by++;
          stampItem('head', ['.c.', 'ccc'], ex - 1, by - 2, { c: light }, true);
        }
      for (const s of [-1, 1]) {
        const x0 = s < 0 ? Math.round(cx - rx - 1.2) : Math.round(cx + rx - 1.8);
        for (let y = eyeY - 2; y <= eyeY + 2; y++)
          for (let x = x0; x < x0 + 3; x++) paint(x, y, y === eyeY - 2 || y === eyeY + 2 ? dark : x === x0 + 1 ? light : cup, true);
      }
      if (p.style === 'mic') {
        const x0 = Math.round(cx - rx - 1.2) + 1,
          y0 = eyeY + 3,
          x1 = Math.round(cx) - 3,
          y1 = mouthY + 1;
        const n = Math.max(1, Math.abs(x1 - x0));
        for (let k = 0; k <= n; k++)
          paint(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), k === n ? dark : band, true);
      }
    }
  }
  // internal outline around items that sit on the body
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const q = y * W + x;
      if (grp[q] < 1 || grp[q] > 3) continue;
      if ((x > 0 && edge[q - 1]) || (x < W - 1 && edge[q + 1]) || (y > 0 && edge[q - W]) || (y < H - 1 && edge[q + W])) grp[q] = GR.LINE;
    }
  for (let i = 0; i < N; i++) if (grp[i] === GR.ITEM && islot[i]) fit[SLOT_IDS[islot[i] - 1]]!.visible++;
  if (pose.itemsOnly) for (let i = 0; i < N; i++) if (grp[i] !== GR.ITEM) grp[i] = GR.NONE;

  const bR = RAMPS[g.pal[0]],
    aR = RAMPS[g.pal[1]];
  const beR = g.belly === 'cream' ? [bR[2], '#f6e2c6', '#fff6e6', '#ffffff'] : [bR[2], bR[3], '#fffaf0', '#ffffff'];
  const cols: Px[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    switch (grp[i]) {
      case GR.BODY:
        cols[i] = bR[shade[i]];
        break;
      case GR.ACC:
        cols[i] = aR[Math.min(shade[i], 3)];
        break;
      case GR.BELLY:
        cols[i] = beR[shade[i]];
        break;
      case GR.DARK:
      case GR.LINE:
        cols[i] = INK;
        break;
      case GR.WHITE:
        cols[i] = '#ffffff';
        break;
      case GR.BLUSH:
        cols[i] = '#ff8fb1';
        break;
      case GR.MOUTH:
        cols[i] = '#b3304f';
        break;
      case GR.ITEM:
        cols[i] = icol[i];
        break;
      case GR.STALK:
        cols[i] = aR[0];
        break;
    }
  }
  // Ink outline on empty pixels next to anything solid (the hot loop of every draw: kept allocation-free).
  const out = cols.slice();
  const solid = (j: number) => !!cols[j] && grp[j] !== GR.LINE && grp[j] !== GR.STALK;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (cols[i]) continue;
      if ((x < W - 1 && solid(i + 1)) || (x > 0 && solid(i - 1)) || (y < H - 1 && solid(i + W)) || (y > 0 && solid(i - W))) out[i] = INK;
    }
  if (pose.flash) for (let i = 0; i < N; i++) if (out[i] && out[i] !== INK) out[i] = '#ffffff';
  if (pose.sil) for (let i = 0; i < N; i++) if (out[i]) out[i] = pose.sil;
  return { cols: out, meta: { cx, cy, rx, ry, eyeY, headTop, items: fit } };
}

export function outlineCols(cols: Px[], w: number, h: number): Px[] {
  const out = cols.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cols[i]) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (cols[yy * w + xx]) {
          out[i] = INK;
          break;
        }
      }
    }
  return out;
}

export function mapCols(map: string[], colMap: Record<string, string>, pad = 1) {
  const w = map[0].length + pad * 2,
    h = map.length + pad * 2;
  const cols: Px[] = new Array(w * h).fill(null);
  for (let j = 0; j < map.length; j++)
    for (let i = 0; i < map[j].length; i++) if (map[j][i] !== '.') cols[(j + pad) * w + i + pad] = colMap[map[j][i]];
  return { cols: pad ? outlineCols(cols, w, h) : cols, w, h };
}

/** A plain stand-in body that parametric items are drawn on, for their icons and for the distinctness check. */
export const MANNEQUIN: SpriteGenome = {
  shape: 'round',
  rx: 8.6,
  ry: 8.4,
  n: 2.3,
  ears: 'none',
  tail: 'none',
  eyes: 'round',
  mouth: 'smile',
  pattern: 'none',
  feet: true,
  arms: true,
  blush: false,
  flop: false,
  pal: ['frost', 'sky'],
  belly: 'light',
  seed: 1,
};

/** Crop a sprite to its filled pixels. */
export function cropCols(cols: Px[], w: number, h: number) {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (cols[y * w + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return { cols: [] as Px[], w: 0, h: 0 };
  const cw = x1 - x0 + 1,
    ch = y1 - y0 + 1;
  const out: Px[] = new Array(cw * ch).fill(null);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = cols[(y + y0) * w + x + x0];
  return { cols: out, w: cw, h: ch };
}

/** An item as it looks when worn on the mannequin, alone, outlined and cropped. */
export function itemWornCols(d: ItemDef, id?: string) {
  const items: Record<string, string | null> = noItems();
  // A classic is drawn by its id: some (glasses, shades, scarf, headphones) are drawn in code, not from a map.
  const classic = id !== undefined && ITEMS[id] === d;
  items[d.slot] = classic ? id : '_';
  const { cols } = compose({ ...MANNEQUIN, items, gear: classic ? {} : { _: d } }, { stage: 1, itemsOnly: true });
  return cropCols(cols, 32, 32);
}

/** The mannequin's own pixels in an icon: a flat silhouette, so the item stands out. */
const GHOST = '#4a3a6b',
  GHOST_EDGE = '#33264c';

/**
 * The shop and wardrobe icon: the item's own pixel map, or for drawn items how it looks worn.
 * Clothes (`wear`) follow the body, so alone they're a thin band: they're shown on a ghost of the mannequin.
 */
export function itemIconCols(id: string, d?: ItemDef) {
  const it = d ?? ITEMS[id];
  if (!it) return { cols: [] as Px[], w: 0, h: 0 };
  if (hasMap(it)) return mapCols(it.map, it.cols);
  if (!it.kind && ICONS[id]) return mapCols(ICONS[id].map, ICONS[id].cols);
  if (it.kind !== 'wear') return itemWornCols(it);
  const items: Record<string, string | null> = noItems();
  items[it.slot] = '_';
  const g = { ...MANNEQUIN, items, gear: { _: it } };
  const worn = compose(g, { stage: 1, itemsOnly: true }).cols,
    whole = compose(g, { stage: 1 }).cols;
  return cropCols(
    whole.map((c, i) => worn[i] ?? (c ? (c === INK ? GHOST_EDGE : GHOST) : null)),
    32,
    32,
  );
}

/** Egg sprite in the creature's own palette (the hint before the reveal). */
export function eggCols(g: Pick<Genome, 'pal' | 'seed'>, lean: number, crack: number): Px[] {
  const W = 32,
    H = 32,
    N = W * H,
    cx = 16,
    cy = 18.8,
    rx = 8.4,
    ry = 10.2,
    bottom = cy + ry;
  const sh = (py: number) => (lean * (bottom - py)) / (2 * ry);
  const inEgg = (px: number, py: number) => {
    const dy = (py - cy) / ry,
      w = rx * (1 + 0.16 * dy),
      dx = (px - cx - sh(py)) / w;
    return dx * dx + dy * dy <= 1;
  };
  const m = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = inEgg(x + 0.5, y + 0.5) ? 1 : 0;
  const M = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x];
  const bR = RAMPS[g.pal[0]],
    aR = RAMPS[g.pal[1]];
  const r = mulberry(g.seed ^ 0xe66),
    band = r() < 0.5;
  const spots = [0, 1, 2, 3].map(() => [(r() * 1.4 - 0.7) * rx, (r() * 1.4 - 0.8) * ry, 0.9 + r() * 1.1]);
  const cols: Px[] = new Array(N).fill(null);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!m[y * W + x]) continue;
      const dark = !M(x + 1, y + 1) || !M(x + 2, y + 2),
        lit = !M(x - 1, y - 1);
      let c = dark ? bR[2] : lit ? '#ffffff' : bR[3];
      const px = x + 0.5 - sh(y + 0.5),
        py = y + 0.5;
      if (band) {
        const zig = (x >> 1) % 2 ? 0.8 : -0.8;
        if (Math.abs(py - (cy + 1 + zig)) < 1.1) c = dark ? aR[1] : aR[2];
      } else
        for (const [u, v, rr] of spots) {
          const dx = px - (cx + u),
            dy = py - (cy + v);
          if (dx * dx + dy * dy <= rr * rr) c = dark ? aR[1] : aR[2];
        }
      cols[y * W + x] = c;
    }
  const cr1 = [
      [13, 17],
      [14, 16],
      [15, 17],
      [16, 16],
      [17, 17],
      [18, 16],
    ],
    cr2 = [
      [10, 17],
      [11, 16],
      [12, 17],
      [19, 17],
      [20, 16],
      [21, 17],
      [22, 16],
      [15, 15],
      [16, 14],
      [17, 13],
    ];
  const draw = (pts: number[][]) => {
    for (const [x, y] of pts) {
      const xx = Math.round(x + sh(y + 0.5));
      if (M(xx, y)) cols[y * W + xx] = INK;
    }
  };
  if (crack >= 1) draw(cr1);
  if (crack >= 2) draw(cr2);
  return outlineCols(cols, W, H);
}
