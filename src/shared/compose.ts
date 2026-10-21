// Sprite composer: assembles a 32x32 palette-indexed creature from its genome,
// pose and equipped items. Pure function, no DOM, ported from the approved concept:
// per-shape shading lit from the top left, face after shading, one ink outline last.
import { INK, RAMPS, type Genome } from './genome';
import { mulberry } from './rng';

export type Slot = 'head' | 'face' | 'neck' | 'held';
/** A pixel map (one character per pixel, '.' is empty) and the colour for each character. */
export interface IconDef { map: string[]; cols: Record<string, string> }
/** A wardrobe item. Items with a `map` are stamped from it; `proc` items are drawn in code by compose(). */
export interface ItemDef { slot: Slot; name: string; rarity: number; blurb: string; edge?: number; proc?: number; map?: string[]; cols?: Record<string, string>; anim?: string[] }
type MapItem = ItemDef & IconDef;
const hasMap = (it: ItemDef): it is MapItem => !!it.map;

const ITEM_DEFS = {
  beanie: { slot: 'head', name: 'Beanie', rarity: 0, edge: 1, map: ['....pp....', '..rrrrrr..', '.rrRrrRrr.', '.rrRrrRrr.', 'cccccccccc'], cols: { p: '#fff2dc', r: '#cf3a4a', R: '#ff6f62', c: '#ff9f78' }, blurb: 'Warm ears, warmer heart.' },
  cap: { slot: 'head', name: 'Propeller cap', rarity: 2, edge: 1, map: ['..aaa..bbb..', '.....kk.....', '...yyrrrr...', '..yyyrrrrr..', '..yyyrrrrrrr'], cols: { a: '#86bdff', b: '#ff6f62', k: '#1a1124', y: '#ffd166', r: '#4f7fe0' }, anim: ['...bbbaaa...', '.....kk.....', '...yyrrrr...', '..yyyrrrrr..', '..yyyrrrrrrr'], blurb: 'Spins when it thinks.' },
  crown: { slot: 'head', name: 'Crown', rarity: 3, edge: 1, map: ['y...yy...y', 'yy.yyyy.yy', 'yyyyyyyyyy', 'yrYYgYYYry', 'YYYYYYYYYY'], cols: { y: '#ffd34d', Y: '#c8892c', r: '#cf3a4a', g: '#6fdc9c' }, blurb: 'Main branch royalty.' },
  party: { slot: 'head', name: 'Party hat', rarity: 1, edge: 1, map: ['...w...', '...p...', '..pyp..', '..ppp..', '.pypyp.', '.ppppp.', 'pypypyp'], cols: { w: '#fff2dc', p: '#bf98ff', y: '#ffd166' }, blurb: 'For every green build.' },
  phones: { slot: 'head', name: 'Headphones', rarity: 1, proc: 1, blurb: 'Lo-fi beats to debug to.' },
  glasses: { slot: 'face', name: 'Round glasses', rarity: 0, proc: 1, blurb: 'Reads the whole diff.' },
  shades: { slot: 'face', name: 'Shades', rarity: 2, proc: 1, blurb: 'Deploys on a Friday.' },
  scarf: { slot: 'neck', name: 'Scarf', rarity: 0, proc: 1, blurb: 'Cosy for long builds.' },
  bowtie: { slot: 'neck', name: 'Bow tie', rarity: 1, map: ['gg..gg', 'gGkkGg', 'gg..gg'], cols: { g: '#ff86bd', G: '#d94c93', k: '#8c2766' }, blurb: 'Dressed for the demo.' },
  duck: { slot: 'held', name: 'Rubber duck', rarity: 2, edge: 1, map: ['..yy....', '.ykyy...', 'oyyyy..y', '..yyyyyy', '..yyyyyY', '...YYYY.'], cols: { y: '#ffd166', Y: '#e39b3a', k: '#1a1124', o: '#ff6f62' }, blurb: 'Your pet explains bugs to it.' },
  keyboard: { slot: 'held', name: 'Clicky keyboard', rarity: 1, edge: 1, map: ['kkkkkkkk', 'kwkwkwkk', 'kwwwwwwk', 'kkkkkkkk'], cols: { k: '#4a3a6b', w: '#eadcff' }, blurb: 'Loud switches, louder hits.' },
  mug: { slot: 'held', name: 'Coffee mug', rarity: 0, edge: 1, map: ['kkkk..', 'mmmmmm', 'mWmm.m', 'mmmmmm', 'MMMM..'], cols: { k: '#4f2c2c', m: '#4f7fe0', W: '#d2efff', M: '#32449a' }, blurb: 'Fuel for the next sprint.' },
} satisfies Record<string, ItemDef>;
export const ITEMS: Record<string, ItemDef> = ITEM_DEFS;
export const ICONS: Record<string, IconDef> = {
  phones: { map: ['.bbbbbb.', 'b......b', 'b......b', 'rr....rr', 'RR....RR', 'rr....rr'], cols: { b: '#4f7fe0', r: '#cf3a4a', R: '#ff6f62' } },
  glasses: { map: ['kkkk.kkkk', 'kllk.kllk', 'kllkkkllk', 'kllk.kllk', 'kkkk.kkkk'], cols: { k: '#e39b3a', l: '#d2efff' } },
  shades: { map: ['kkkkkkkkkk', 'kbkkkkbkkk', 'kkkk..kkkk'], cols: { k: '#1a1124', b: '#86bdff' } },
  scarf: { map: ['rRrRrRrR', 'RrRrRrRr', '.rr.....', '.Rr.....', '.yy.....'], cols: { r: '#cf3a4a', R: '#ff6f62', y: '#ffd166' } },
};
export const SLOTS: [Slot, string][] = [['head', 'Head'], ['face', 'Face'], ['neck', 'Neck'], ['held', 'Held']];
export const ITEM_IDS = Object.keys(ITEMS);

const GR = { NONE: 0, BODY: 1, ACC: 2, BELLY: 3, DARK: 4, WHITE: 5, BLUSH: 6, MOUTH: 7, ITEM: 8, LINE: 9, STALK: 10 };
export const L_BODY = 1, L_PAT = 2, L_EARS = 4, L_TAIL = 8, L_FACE = 16, L_ITEMS = 32, L_ALL = 63;
const EYE: Record<string, string[]> = { round: ['wd', 'dd', 'dd'], big: ['.dd.', 'dwwd', 'dwdd', 'dddd', '.dd.'], tall: ['wd', 'dd', 'dd', 'dd'], dot: ['dd', 'dd'], sleepy: ['ddd', '.dd'],
  cyclops: ['.dddd.', 'dwwwwd', 'dwwdwd', 'dwddwd', 'dwwwwd', '.dddd.'] };
const MOUTH: Record<string, string[]> = { smile: ['d..d', '.dd.'], cat: ['d.dd.d', '.d..d.'], dot: ['dd'], fang: ['dddd', '..w.'], open: ['.dd.', 'dmmd', '.dd.'], frown: ['.dd.', 'd..d'], o: ['.dd.', 'd..d', '.dd.'] };

export interface Pose { stage?: number; sq?: number; eyes?: string; mouth?: string; look?: number; flash?: boolean; sil?: string; phase?: number; L?: number; noItems?: boolean }
/** One pixel: a '#rrggbb' colour, or null for transparent. */
export type Px = string | null;
export interface SpriteMeta { cx: number; cy: number; rx: number; ry: number; eyeY: number; headTop: number }
/** The genome traits the composer reads. Items are optional: without them the creature is drawn bare. */
export type SpriteGenome = Pick<Genome, 'shape' | 'rx' | 'ry' | 'n' | 'ears' | 'tail' | 'eyes' | 'mouth' | 'pattern' | 'feet' | 'arms' | 'blush' | 'flop' | 'pal' | 'belly' | 'seed'> & { items?: Genome['items'] };
type Pred = (px: number, py: number) => boolean;

export function compose(g: SpriteGenome, pose: Pose = {}): { cols: Px[]; meta: SpriteMeta } {
  const W = 32, H = 32, N = W * H;
  const grp = new Uint8Array(N), shp = new Uint8Array(N), shade = new Uint8Array(N), icol = new Array<string>(N), edge = new Uint8Array(N);
  const st = pose.stage == null ? 1 : pose.stage, L = pose.L == null ? L_ALL : pose.L;
  const k = st === 0 ? 0.74 : st === 2 ? 1.16 : 1, sq = pose.sq || 0;
  const rx = g.rx * k + sq * 0.6, ry = Math.max(3, g.ry * k - sq);
  const hasFeet = g.feet && st > 0, bottom = hasFeet ? 29 : 30, cx = 16, cy = bottom - ry;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const put = (x: number, y: number, gr: number, s: number) => { if (!inb(x, y)) return; const i = y * W + x; grp[i] = gr; shp[i] = s; };
  const fill = (fn: Pred, gr: number, s: number, cond?: (i: number) => boolean) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (fn(x + .5, y + .5) && (!cond || cond(y * W + x))) put(x, y, gr, s); } };
  const ell = (ex: number, ey: number, a: number, b: number, ang?: number): Pred => (px, py) => { let dx = px - ex, dy = py - ey; if (ang) { const c = Math.cos(ang), s = Math.sin(ang); const tx = dx * c + dy * s; dy = -dx * s + dy * c; dx = tx; } return dx * dx / (a * a) + dy * dy / (b * b) <= 1; };
  const tri = (ax: number, ay: number, bx: number, by: number, qx: number, qy: number): Pred => (px, py) => { const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - qx) * (by - qy) - (bx - qx) * (py - qy), d3 = (px - ax) * (qy - ay) - (qx - ax) * (py - ay); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
  const path = (pts: number[][], r0: number, r1: number): Pred => (px, py) => { for (let j = 0; j < pts.length - 1; j++) { const [ax, ay] = pts[j], [bx, by] = pts[j + 1]; const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1; let t = ((px - ax) * vx + (py - ay) * vy) / l2; t = Math.max(0, Math.min(1, t)); const qx = ax + t * vx - px, qy = ay + t * vy - py, f = (j + t) / (pts.length - 1), r = r0 + (r1 - r0) * f; if (qx * qx + qy * qy <= r * r) return true; } return false; };
  const n = g.n;
  const bodyFn = (px: number, py: number) => { const dy = (py - cy) / ry; let dx = (px - cx) / rx; if (g.shape === 'pear') dx /= (1 + 0.22 * dy); else if (g.shape === 'drop') dx /= (1 + 0.32 * dy); else if (g.shape === 'bean') dx /= (1 - 0.1 * dy); return Math.pow(Math.abs(dx), n) + Math.pow(Math.abs(dy), n) <= 1; };
  const bm = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bm[y * W + x] = bodyFn(x + .5, y + .5) ? 1 : 0;
  const topY = (x: number) => { x = Math.max(0, Math.min(W - 1, Math.floor(x))); for (let y = 0; y < H; y++) if (bm[y * W + x]) return y; return Math.round(cy - ry); };
  const headTop = topY(15.5);
  const items: Record<string, string | null> = (L & L_ITEMS) && !pose.noItems ? (g.items || {}) : {};
  const hatOn = !!items.head;

  if (st === 2 && (L & L_EARS)) { // wings
    for (const s of [-1, 1]) { const reach = Math.min(rx + 5, 15.2);
      fill(tri(cx + s * (rx - 2.5), cy - 2, cx + s * reach, cy - 7.5, cx + s * (rx + 2.5), cy + 3), GR.ACC, 5);
      fill(tri(cx + s * (rx - 2.5), cy, cx + s * Math.min(rx + 4.4, 15.2), cy - 2, cx + s * (rx + 1), cy + 5), GR.ACC, 5); }
  }
  if (st > 0 && g.tail !== 'none' && (L & L_TAIL)) {
    const bx = cx + rx * 0.8, by = cy + ry * 0.45, ph = pose.phase || 0, T = (pts: number[][]) => pts.map(([a, b]) => [bx + a, by + b]);
    switch (g.tail) {
      case 'curl': fill(path(T([[0, 0], [2.5, -0.5], [4.5, -2.5], [5, -5], [3.8, -6.6], [2.2, -6.4], [1.8, -4.8], [3, -4]]), 1.3, 0.8), GR.BODY, 4); break;
      case 'bolt': fill(path(T([[0, 0], [3, -1.5], [2, -3], [5, -5], [4, -6.5], [7, -9]]), 1.0, 0.7), GR.ACC, 4); break;
      case 'ball': fill(path(T([[0, 0], [2, -0.5]]), 0.9, 0.9), GR.BODY, 4); fill(ell(bx + 3.3, by - 1.5, 2.6, 2.4), GR.ACC, 4); break;
      case 'spade': fill(path(T([[0, 0], [2.5, 0], [4.5, -2.5]]), 0.8, 0.7), GR.BODY, 4); fill(tri(bx + 3, by - 3.6, bx + 7.5, by - 2.6, bx + 5.8, by - 7), GR.ACC, 4); break;
      case 'flame': fill(path(T([[0, 0], [2, -1]]), 0.9, 0.9), GR.BODY, 4); fill(ell(bx + 3.6, by - 2.6, 2.3, 2.6), GR.ACC, 4); fill(tri(bx + 1.5, by - 3.2, bx + 5.7, by - 3.2, bx + (ph ? 5 : 3), by - 8), GR.ACC, 4); break;
    }
  }
  let ears = g.ears; if (st === 2 && ears === 'none') ears = 'horns';
  if (L & L_EARS) {
    const es = st === 0 ? 0.6 : st === 2 ? 1.2 : 1, ex = Math.max(3, rx * 0.55);
    for (const s of [-1, 1]) {
      const x = cx + s * ex, by = topY(x) + 1.5, sid = s < 0 ? 2 : 3, flop = g.flop && s > 0;
      if (ears === 'cat') { const h = Math.min(5.5 * es, by - 1), w = 3 * Math.min(es, 1.1); const ax = flop ? x + s * 3.6 : x + s * 1.2, ay = flop ? by - h * 0.55 : by - h;
        fill(tri(x - w, by + 1, x + w, by + 1, ax, ay), GR.BODY, sid); fill(tri(x - w * 0.4, by + 0.5, x + w * 0.4, by + 0.5, x + (ax - x) * 0.6, by - (by - ay) * 0.55), GR.ACC, sid); }
      else if (ears === 'bunny') { const h = Math.max(2, Math.min(5 * es, (by - 1.5) / 2)); const ang = flop ? s * 1.15 : s * 0.18, ox = flop ? s * 3.2 : s * 0.8, oy = flop ? -2.4 : -h + 0.6;
        fill(ell(x + ox, by + oy, 1.9, h, ang), GR.BODY, sid); fill(ell(x + ox, by + oy + 0.3, 0.8, Math.max(0.8, h - 1.5), ang), GR.ACC, sid); }
      else if (ears === 'antenna') { const h = 5 * es; const pts = flop ? [[x, by], [x + 1.6, by - h * 0.8], [x + 3.6, by - h * 0.8]] : [[x, by], [x + s, by - h]];
        fill(path(pts, 0.55, 0.55), GR.STALK, sid); const e = pts[pts.length - 1]; fill(ell(e[0], e[1], 1.7, 1.7), GR.ACC, sid); }
      else if (ears === 'horns') { const h = 6 * es; fill(path([[x, by], [x + s * 2.4, by - h * 0.6], [x + s * 1.4, by - h]], 1.6, 0.55), GR.ACC, sid); }
      else if (ears === 'round') { const rr = 2.7 * Math.min(es, 1.1); fill(ell(x + s * 0.6, by - 1.6, rr, rr), GR.BODY, sid); fill(ell(x + s * 0.6, by - 1.4, rr * 0.48, rr * 0.48), GR.ACC, sid); }
    }
    if (!hatOn) { const t = headTop, es2 = st === 0 ? 0.6 : 1;
      if (ears === 'fin') { fill(tri(cx - 3.5, t + 2.5, cx + 2.5, t + 2.5, cx + 2, t - 4 * es2), GR.ACC, 2); fill(tri(cx + 1.5, t + 3, cx + 5.5, t + 3.5, cx + 5, t - 1.5 * es2), GR.ACC, 3); }
      if (ears === 'sprout') { fill(path([[cx - 0.5, t + 1.5], [cx - 0.5, t - 2.5 * es2]], 0.5, 0.5), GR.STALK, 2); fill(ell(cx + 1.8, t - 3.3 * es2, 2.3, 1.2, -0.5), GR.ACC, 3); fill(ell(cx - 2, t - 2.3 * es2, 1.4, 0.8, 0.55), GR.ACC, 2); }
    }
  }
  if (L & L_BODY) {
    for (let i = 0; i < N; i++) if (bm[i]) { grp[i] = GR.BODY; shp[i] = 1; }
    if (hasFeet) for (const s of [-1, 1]) fill(ell(cx + s * rx * 0.45, 28.6, 2.3, 1.5), GR.BODY, 6);
    if (st > 0 && g.arms) for (const s of [-1, 1]) fill(ell(cx + s * (rx - 0.2), cy + ry * 0.3, 1.5, 2.1), GR.BODY, 7);
  }
  const openH = EYE[g.eyes].length;
  const eyeY = Math.round(cy + ry * 0.08 + (st === 0 ? 0.6 : 0)) - (g.eyes === 'cyclops' ? 1 : 0);
  const isBody = (i: number) => shp[i] === 1;
  if ((L & L_PAT) && (L & L_BODY)) {
    const pat = g.pattern;
    if (pat === 'belly' || (st === 2 && pat === 'none')) fill(ell(cx, cy + ry * 0.42, rx * 0.58, ry * 0.52), GR.BELLY, 1, isBody);
    if (pat === 'split') fill((_px, py) => py > cy + ry * 0.18, GR.ACC, 1, isBody);
    if (pat === 'spots') { const r = mulberry(g.seed ^ 0x9e37); for (let j = 0; j < 4; j++) { const u = (r() * 1.5 - 0.75) * rx, v = (r() * 1.0 - 0.85) * ry, rr = 1 + r() * 0.9; fill(ell(cx + u, cy + v, rr, rr), GR.ACC, 1, isBody); } }
    if (pat === 'stripes') { const t = cy - ry; fill((px, py) => py < t + 3.8 && ((px > cx - 4 && px < cx - 2.6) || (px > cx - 1 && px < cx + 1) || (px > cx + 2.6 && px < cx + 4)) && !(py > t + 2.8 && Math.abs(px - cx) > 2), GR.ACC, 1, isBody); }
    if (pat === 'mask') fill((px, py) => Math.abs(py - eyeY - 0.5) < 2 && Math.abs(px - cx) > 1, GR.ACC, 1, isBody);
    if (st === 2) fill((px, py) => Math.abs(px - cx) + Math.abs(py - (cy + ry * 0.55)) <= 1.6, GR.ACC, 1, isBody);
  }
  // shading per shape: light from the top left
  const S = (x: number, y: number, s: number) => inb(x, y) && shp[y * W + x] === s && grp[y * W + x] !== GR.LINE && grp[y * W + x] !== GR.STALK && grp[y * W + x] !== GR.NONE;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, g0 = grp[i]; if (g0 < 1 || g0 > 3) continue; const s = shp[i];
    let v = 1; if (!S(x + 1, y + 1, s) || !S(x + 2, y + 2, s)) v = 0; else if (!S(x - 1, y - 1, s)) v = 2; shade[i] = v; }
  if (L & L_BODY) { const sx = Math.round(cx - rx * 0.5), sy = Math.round(cy - ry * 0.55); for (const [a, b] of [[sx, sy], [sx + 1, sy], [sx, sy + 1]]) { if (inb(a, b) && shp[b * W + a] === 1 && grp[b * W + a] <= 3) shade[b * W + a] = 3; } }

  const stamp = (m: string[], x0: number, y0: number, map?: Record<string, string>) => { x0 = Math.round(x0); for (let j = 0; j < m.length; j++) for (let i = 0; i < m[j].length; i++) { const ch = m[j][i]; if (ch === '.') continue; const x = x0 + i, y = y0 + j; if (!inb(x, y)) continue; const q = y * W + x;
    if (map) { grp[q] = GR.ITEM; icol[q] = map[ch]; } else { grp[q] = ch === 'd' ? GR.DARK : ch === 'w' ? GR.WHITE : ch === 'm' ? GR.MOUTH : ch === 'b' ? GR.BLUSH : GR.DARK; } } };
  const eyeCentres = g.eyes === 'cyclops' ? [cx] : [cx - Math.max(g.eyes === 'big' ? 5 : 4, Math.round(rx * 0.47)), cx + Math.max(g.eyes === 'big' ? 5 : 4, Math.round(rx * 0.47))];
  const look = pose.look || 0, mode = pose.eyes || 'open';
  const openMap = EYE[g.eyes], ow = openMap[0].length, y0open = eyeY - Math.floor(openH / 2);
  const boxes = eyeCentres.map(c => [Math.round(c - ow / 2) + look, y0open, ow, openH]);
  const mouthY = y0open + openH + (g.eyes === 'cyclops' ? 0 : 1);
  if ((L & L_FACE) && (L & L_BODY)) {
    if (items.face === 'glasses') {
      for (const [x0, yy, w, h] of boxes) { const bx0 = x0 - 1, by0 = yy - 1, bx1 = x0 + Math.max(w, 2), by1 = yy + Math.max(h, 3);
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { if (!inb(x, y)) continue; const corner = (x === bx0 || x === bx1) && (y === by0 || y === by1); if (corner) continue; const q = y * W + x;
          grp[q] = GR.ITEM; icol[q] = (x === bx0 || x === bx1 || y === by0 || y === by1) ? '#e39b3a' : '#d2efff'; } }
      if (boxes.length === 2) { const y = boxes[0][1]; for (let x = boxes[0][0] + boxes[0][2] + 1; x < boxes[1][0] - 1; x++) if (inb(x, y)) { grp[y * W + x] = GR.ITEM; icol[y * W + x] = '#e39b3a'; } }
    }
    eyeCentres.forEach((c, ix) => { const right = ix === 1; let m = openMap;
      if (mode === 'blink' || mode === 'closed') { const w = Math.max(ow, 3); m = [(g.eyes === 'cyclops' ? '.dddd.' : 'd'.repeat(w))]; stamp(m, Math.round(c - m[0].length / 2) + look, y0open + openH - 1 - (openH > 3 ? 1 : 0)); return; }
      if (mode === 'happy') m = g.eyes === 'cyclops' ? ['.dddd.', 'd....d'] : ['.d.', 'd.d'];
      if (mode === 'hurt') m = g.eyes === 'cyclops' ? ['d....d', '.d..d.', '..dd..', '.d..d.', 'd....d'] : (right ? ['.d', 'd.', '.d'] : ['d.', '.d', 'd.']);
      if (mode === 'sleep') m = g.eyes === 'cyclops' ? ['d....d', '.dddd.'] : ['d..d', '.dd.'];
      const yy = mode === 'open' ? y0open : eyeY - Math.floor(m.length / 2);
      stamp(m, Math.round(c - m[0].length / 2) + look, yy); });
    if (g.pattern === 'freckles' && g.eyes !== 'cyclops') { for (const c of eyeCentres) { const yb = y0open + openH + 1; for (const [a, b] of [[c - 2, yb], [c, yb], [c - 1, yb + 1], [c + 1, yb + 1]]) { const x = Math.round(a), q = b * W + x; if (inb(x, b) && grp[q] >= 1 && grp[q] <= 3) { grp[q] = GR.ACC; shade[q] = 0; } } } }
    else if (g.blush && mode !== 'hurt' && g.pal[0] !== 'gum') { eyeCentres.forEach((c, ix) => { const s = g.eyes === 'cyclops' ? 0 : (ix ? 1 : -1); if (!s) { for (const dx of [-5, -4, 3, 4]) { const x = Math.round(c + dx), y = y0open + openH, q = y * W + x; if (inb(x, y) && grp[q] >= 1 && grp[q] <= 3) grp[q] = GR.BLUSH; } return; }
      const yb = y0open + openH; for (const dx of [0, 1]) { const x = Math.round(c + s * (ow / 2 + dx) - (s < 0 ? 1 : 0)), q = yb * W + x; if (inb(x, yb) && grp[q] >= 1 && grp[q] <= 3) grp[q] = GR.BLUSH; } }); }
    const mm = pose.mouth || g.mouth; const mmap = MOUTH[mm];
    stamp(mmap, cx - mmap[0].length / 2, mouthY);
    if (items.face === 'shades') { const xa = boxes[0][0] - 1, xb = boxes[boxes.length - 1][0] + ow; for (let y = eyeY - 1; y <= eyeY + 1; y++) for (let x = xa; x <= xb; x++) { if (!inb(x, y)) continue;
      const inLens = boxes.some(([x0, , w]) => x >= x0 - 1 && x <= x0 + w); if (y > eyeY - 1 && !inLens) continue; const q = y * W + x; grp[q] = GR.ITEM; icol[q] = INK; }
      for (const [x0] of boxes) { const q = eyeY * W + x0; if (inb(x0, eyeY)) { icol[q] = '#86bdff'; } } }
  }
  if (L & L_ITEMS) {
    const ny = mouthY + MOUTH[pose.mouth || g.mouth].length + 1;
    if (items.neck === 'scarf') { for (const y of [ny, ny + 1]) for (let x = 0; x < W; x++) { const q = y * W + x; if (!inb(x, y)) continue; const nearB = bm[q] || (x > 0 && bm[q - 1]) || (x < W - 1 && bm[q + 1]); if (!nearB) continue;
        grp[q] = GR.ITEM; icol[q] = y === ny + 1 ? '#7e1f3a' : ((x >> 1) % 2 ? '#cf3a4a' : '#ff6f62'); }
      const sx = Math.round(cx - rx * 0.35); for (let y = ny + 2; y <= ny + 4; y++) for (const x of [sx, sx + 1]) { if (inb(x, y)) { const q = y * W + x; grp[q] = GR.ITEM; icol[q] = y === ny + 4 ? '#ffd166' : '#cf3a4a'; } } }
    if (items.neck === 'bowtie') { const it = ITEM_DEFS.bowtie; stamp(it.map, cx - 3, ny, it.cols); }
    const markEdge = (x0: number, y0: number, m: string[]) => { for (let j = 0; j < m.length; j++) for (let i = 0; i < m[j].length; i++) if (m[j][i] !== '.' && inb(x0 + i, y0 + j)) edge[(y0 + j) * W + x0 + i] = 1; };
    if (items.held && ITEMS[items.held] && st > 0) { const it = ITEMS[items.held] as MapItem; /* every held item is a map item */ const x0 = Math.round(cx + rx - 3), y0 = Math.round(cy + ry * 0.3) - it.map.length + 3; stamp(it.map, x0, y0, it.cols); markEdge(x0, y0, it.map); }
    if (items.head === 'phones') { const R = ry + 0.6; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x + .5 - cx, dy = y + .5 - cy, d = Math.sqrt(dx * dx / ((rx + 0.8) * (rx + 0.8)) + dy * dy / (R * R));
        if (d >= 1 && d < 1 + 1.4 / R && dy < -ry * 0.35) { const q = y * W + x; grp[q] = GR.ITEM; icol[q] = '#4f7fe0'; } }
      for (const s of [-1, 1]) { const x0 = s < 0 ? Math.round(cx - rx - 1.2) : Math.round(cx + rx - 1.8); for (let y = eyeY - 2; y <= eyeY + 2; y++) for (let x = x0; x < x0 + 3; x++) if (inb(x, y)) { const q = y * W + x; grp[q] = GR.ITEM; icol[q] = (y === eyeY - 2 || y === eyeY + 2) ? '#7e1f3a' : (x === x0 + 1 ? '#ff6f62' : '#cf3a4a'); edge[q] = 1; } } }
    else { const it = items.head ? ITEMS[items.head] : undefined;
      if (it && hasMap(it)) { const m = (it.anim && pose.phase) ? it.anim : it.map; const w = m[0].length, x0 = Math.round(cx - w / 2), y0 = headTop + 2 - m.length; stamp(m, x0, y0, it.cols); markEdge(x0, y0, m); } }
  }
  // internal outline around items that sit on the body
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = y * W + x; if (grp[q] < 1 || grp[q] > 3) continue;
    if ((x > 0 && edge[q - 1]) || (x < W - 1 && edge[q + 1]) || (y > 0 && edge[q - W]) || (y < H - 1 && edge[q + W])) grp[q] = GR.LINE; }

  const bR = RAMPS[g.pal[0]], aR = RAMPS[g.pal[1]];
  const beR = g.belly === 'cream' ? [bR[2], '#f6e2c6', '#fff6e6', '#ffffff'] : [bR[2], bR[3], '#fffaf0', '#ffffff'];
  const cols: Px[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) { switch (grp[i]) {
    case GR.BODY: cols[i] = bR[shade[i]]; break; case GR.ACC: cols[i] = aR[Math.min(shade[i], 3)]; break; case GR.BELLY: cols[i] = beR[shade[i]]; break;
    case GR.DARK: case GR.LINE: cols[i] = INK; break; case GR.WHITE: cols[i] = '#ffffff'; break; case GR.BLUSH: cols[i] = '#ff8fb1'; break; case GR.MOUTH: cols[i] = '#b3304f'; break; case GR.ITEM: cols[i] = icol[i]; break; case GR.STALK: cols[i] = aR[0]; break; } }
  const out = cols.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (cols[i]) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (!inb(xx, yy)) continue; const j = yy * W + xx; if (cols[j] && grp[j] !== GR.LINE && grp[j] !== GR.STALK) { out[i] = INK; break; } } }
  if (pose.flash) for (let i = 0; i < N; i++) if (out[i] && out[i] !== INK) out[i] = '#ffffff';
  if (pose.sil) for (let i = 0; i < N; i++) if (out[i]) out[i] = pose.sil;
  return { cols: out, meta: { cx, cy, rx, ry, eyeY, headTop } };
}

export function outlineCols(cols: Px[], w: number, h: number): Px[] { const out = cols.slice(); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (cols[i]) continue;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; if (cols[yy * w + xx]) { out[i] = INK; break; } } } return out; }

export function mapCols(map: string[], colMap: Record<string, string>, pad = 1) { const w = map[0].length + pad * 2, h = map.length + pad * 2; const cols: Px[] = new Array(w * h).fill(null);
  map.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.') cols[(j + pad) * w + i + pad] = colMap[ch]; })); return { cols: pad ? outlineCols(cols, w, h) : cols, w, h }; }

export function itemIconCols(id: string) { const it = ITEMS[id]; const src: IconDef = hasMap(it) ? it : ICONS[id]; return mapCols(src.map, src.cols); }

/** Egg sprite in the creature's own palette (the hint before the reveal). */
export function eggCols(g: Pick<Genome, 'pal' | 'seed'>, lean: number, crack: number): Px[] {
  const W = 32, H = 32, N = W * H, cx = 16, cy = 18.8, rx = 8.4, ry = 10.2, bottom = cy + ry;
  const sh = (py: number) => lean * (bottom - py) / (2 * ry);
  const inEgg = (px: number, py: number) => { const dy = (py - cy) / ry, w = rx * (1 + 0.16 * dy), dx = (px - cx - sh(py)) / w; return dx * dx + dy * dy <= 1; };
  const m = new Uint8Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = inEgg(x + .5, y + .5) ? 1 : 0;
  const M = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x];
  const bR = RAMPS[g.pal[0]], aR = RAMPS[g.pal[1]]; const r = mulberry(g.seed ^ 0xe66), band = r() < 0.5;
  const spots = [0, 1, 2, 3].map(() => [(r() * 1.4 - 0.7) * rx, (r() * 1.4 - 0.8) * ry, 0.9 + r() * 1.1]);
  const cols: Px[] = new Array(N).fill(null);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m[y * W + x]) continue; const dark = !M(x + 1, y + 1) || !M(x + 2, y + 2), lit = !M(x - 1, y - 1);
    let c = dark ? bR[2] : lit ? '#ffffff' : bR[3];
    const px = x + .5 - sh(y + .5), py = y + .5;
    if (band) { const zig = ((x >> 1) % 2) ? 0.8 : -0.8; if (Math.abs(py - (cy + 1 + zig)) < 1.1) c = dark ? aR[1] : aR[2]; }
    else for (const [u, v, rr] of spots) { const dx = px - (cx + u), dy = py - (cy + v); if (dx * dx + dy * dy <= rr * rr) c = dark ? aR[1] : aR[2]; }
    cols[y * W + x] = c; }
  const cr1 = [[13, 17], [14, 16], [15, 17], [16, 16], [17, 17], [18, 16]], cr2 = [[10, 17], [11, 16], [12, 17], [19, 17], [20, 16], [21, 17], [22, 16], [15, 15], [16, 14], [17, 13]];
  const draw = (pts: number[][]) => { for (const [x, y] of pts) { const xx = Math.round(x + sh(y + .5)); if (M(xx, y)) cols[y * W + xx] = INK; } };
  if (crack >= 1) draw(cr1); if (crack >= 2) draw(cr2);
  return outlineCols(cols, W, H);
}
