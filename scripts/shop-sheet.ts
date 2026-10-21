// A contact sheet of a week of generated shop items, made exactly as the Worker makes them
// (classics count as existing, each night sees every earlier night), with a public demo salt:
// the live shop uses a secret salt, so its items differ. Each row is a night; each cell is
// the item's shop icon above it worn by three different Forklings.
// Run with: bun scripts/shop-sheet.ts [days]   (writes docs/assets/shop-week.png, prints the week as a table)
import { compose, ITEMS, itemIconCols, noItems, type Px } from '../src/shared/compose';
import { lookOf } from '../src/shared/distinct';
import { CLASSICS, utcDay } from '../src/shared/economy';
import { genome } from '../src/shared/genome';
import { encodePng } from '../src/shared/png';
import { sha256Hex } from '../src/shared/rng';
import { BABY_SLOTS, type Existing, generateDay, ITEMS_PER_DAY, shopSeed } from '../src/shared/shopgen';

const DAYS = Number(process.argv[2] ?? 7);
const SALT = 'forklings-contact-sheet';
const START = Date.UTC(2026, 9, 22);
const CELL_W = 236,
  CELL_H = 176,
  PAD = 12;
const W = PAD * 2 + CELL_W * ITEMS_PER_DAY,
  H = PAD * 2 + CELL_H * DAYS;
const BG = '#271d3b',
  CARD = '#33264c',
  WELL = '#1c1530',
  RARITY_COL = ['#b9a8cf', '#6fdc9c', '#86bdff', '#bf98ff'];

const px: string[] = new Array(W * H).fill(BG);
const rect = (x: number, y: number, w: number, h: number, c: string) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < W && j < H) px[j * W + i] = c;
};
const blit = (cols: Px[], w: number, h: number, x: number, y: number, s: number) => {
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const c = cols[j * w + i];
      if (c) rect(x + i * s, y + j * s, s, s, c);
    }
};

const wearers = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => sha256Hex(`sheet-${i}`)));
const existing: Existing[] = Object.keys(CLASSICS).map((id) => ({
  id,
  slot: ITEMS[id].slot,
  look: lookOf(ITEMS[id]),
  name: ITEMS[id].name,
}));
const lines = ['| Night | Item | Slot | Rarity | Level | Price | Battle |', '| --- | --- | --- | --- | --- | --- | --- |'];
for (let d = 0; d < DAYS; d++) {
  const day = utcDay(START + d * 86400e3);
  const { items, rejected } = generateDay(await shopSeed(day, SALT), day, existing);
  items.forEach((it, k) => {
    existing.push({ id: it.id, slot: it.def.slot, look: lookOf(it.def), day, name: it.def.name });
    const x0 = PAD + k * CELL_W,
      y0 = PAD + d * CELL_H;
    rect(x0 + 4, y0 + 4, CELL_W - 8, CELL_H - 8, CARD);
    rect(x0 + 4, y0 + 4, CELL_W - 8, 4, RARITY_COL[it.def.rarity]);
    const ic = itemIconCols(it.id, it.def);
    const s = Math.max(1, Math.min(4, Math.floor(64 / Math.max(ic.w, ic.h))));
    rect(x0 + 12, y0 + 16, 72, 72, WELL);
    blit(ic.cols, ic.w, ic.h, x0 + 12 + Math.floor((72 - ic.w * s) / 2), y0 + 16 + Math.floor((72 - ic.h * s) / 2), s);
    // three wearers, at the stages that show this slot
    const stages = BABY_SLOTS.has(it.def.slot) ? [0, 1, 2] : [1, 1, 2];
    stages.forEach((stage, j) => {
      const g = {
        ...genome(wearers[(k + j * 2) % wearers.length]),
        items: { ...noItems(), [it.def.slot]: it.id },
        gear: { [it.id]: it.def },
      };
      blit(compose(g, { stage }).cols, 32, 32, x0 + 12 + j * 72, y0 + 96, 2);
    });
    blit(
      compose(
        { ...genome(wearers[k % wearers.length]), items: { ...noItems(), [it.def.slot]: it.id }, gear: { [it.id]: it.def } },
        { stage: 2 },
      ).cols,
      32,
      32,
      x0 + 92,
      y0 + 16,
      2,
    );
    const fx = it.def.effect ? `+${it.def.effect.pct}% ${it.def.effect.stat}` : '';
    lines.push(
      `| ${day} | ${it.def.name} | ${it.def.slot} | ${['Common', 'Uncommon', 'Rare', 'Epic'][it.def.rarity]} | ${it.level} | ${it.price} | ${fx} |`,
    );
  });
  console.error(`${day}: ${items.length} items, ${rejected.length} near-duplicates refused`);
}
const rgba = new Uint8Array(W * H * 4);
px.forEach((c, i) => {
  const n = Number.parseInt(c.slice(1), 16);
  rgba.set([n >> 16, (n >> 8) & 255, n & 255, 255], i * 4);
});
await Bun.write('docs/assets/shop-week.png', await encodePng(W, H, rgba));
console.log(lines.join('\n'));
console.error('wrote docs/assets/shop-week.png');
