// Export the README art from the real sprite generator: a banner and an animated
// line-up of Forklings. Nothing here is drawn by hand or by an image model.
// Run with: bun scripts/art.ts   (writes docs/assets/banner.png and docs/assets/lineup.gif)
import { compose, idlePose, outlineCols, type Px } from '../src/shared/compose';
import { type Genome, genome } from '../src/shared/genome';
import { encodePng } from '../src/shared/png';
import { mulberry, sha256Hex } from '../src/shared/rng';
import { encodeGif } from './gif';

const DUSK = '#271d3b';
const STAR = '#5a4a7b';
const GROUND = '#3b2c55';

/** A canvas of hex pixels with integer-scaled sprite blits. */
class Canvas {
  readonly px: (string | null)[];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Array(w * h).fill(null);
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.px[j * this.w + i] = c;
  }
  blit(cols: Px[], cw: number, ch: number, x: number, y: number, scale: number) {
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const c = cols[j * cw + i];
        if (c) this.rect(x + i * scale, y + j * scale, scale, scale, c);
      }
  }
  stars(seed: number, n: number, maxY: number) {
    const rng = mulberry(seed);
    for (let k = 0; k < n; k++) this.rect(Math.floor(rng() * this.w), Math.floor(rng() * maxY), 2, 2, STAR);
  }
  rgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.px.length; i++) {
      const n = parseInt((this.px[i] ?? DUSK).slice(1), 16);
      out.set([n >> 16, (n >> 8) & 255, n & 255, 255], i * 4);
    }
    return out;
  }
}

// 5×7 pixel font, just the letters the wordmark needs.
const FONT: Record<string, string[]> = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};

function wordmark(text: string, fill: string, shade: string) {
  const w = text.length * 6 - 1 + 2,
    h = 7 + 2;
  const cols: Px[] = new Array(w * h).fill(null);
  [...text].forEach((ch, n) => {
    FONT[ch].forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row[x] === '#') cols[(y + 1) * w + n * 6 + x + 1] = y >= 5 ? shade : fill;
    });
  });
  return { cols: outlineCols(cols, w, h), w, h };
}

/** Pick varied Forklings: one per palette, across all three stages, some dressed up. */
async function cast(n: number): Promise<{ g: Genome; stage: number }[]> {
  const out: { g: Genome; stage: number }[] = [];
  const seen = new Set<string>();
  const outfits = [
    { head: 'crown' },
    { face: 'shades', held: 'mug' },
    {},
    { head: 'beanie', neck: 'scarf' },
    { face: 'glasses' },
    { head: 'phones', held: 'duck' },
    {},
    { neck: 'bowtie' },
  ];
  for (let i = 0; out.length < n && i < 500; i++) {
    const g = genome(await sha256Hex(`forklings-readme-${i}`));
    if (seen.has(g.pal[0]) || g.shape === seen.values().next().value) continue;
    seen.add(g.pal[0]);
    const k = out.length;
    out.push({
      g: { ...g, items: { head: null, face: null, neck: null, held: null, ...outfits[k % outfits.length] } },
      stage: [1, 2, 0, 2, 1, 0, 2, 1][k % 8],
    });
  }
  return out;
}

const forklings = await cast(7);

// Banner: wordmark over a starry dusk with Forklings standing on the ground line.
{
  const W = 1280,
    H = 400,
    S = 4;
  const c = new Canvas(W, H);
  c.stars(7, 90, 260);
  c.rect(0, 336, W, 64, GROUND);
  const wm = wordmark('FORKLINGS', '#ffd166', '#f2a541');
  const ws = 12;
  c.blit(wm.cols, wm.w, wm.h, Math.floor((W - wm.w * ws) / 2), 40, ws);
  const step = Math.floor(W / forklings.length);
  forklings.forEach(({ g, stage }, i) => {
    const { cols } = compose(g, idlePose(g, 0, { stage }));
    c.blit(cols, 32, 32, i * step + Math.floor((step - 32 * S) / 2), 336 - 32 * S + 4 * S, S);
  });
  await Bun.write('docs/assets/banner.png', await encodePng(W, H, c.rgba()));
}

// Line-up: the same cast idling, blinking and swaying, as a looping GIF.
{
  const S = 4,
    cell = 32 * S + 16,
    W = cell * forklings.length,
    H = 32 * S + 24;
  const frames = [];
  const FPS = 10,
    SECONDS = 4;
  for (let f = 0; f < FPS * SECONDS; f++) {
    const t = f / FPS;
    const c = new Canvas(W, H);
    c.rect(0, H - 14, W, 14, GROUND);
    forklings.forEach(({ g, stage }, i) => {
      const { cols } = compose(g, idlePose(g, t, { stage }));
      c.blit(cols, 32, 32, i * cell + 8, H - 14 - 32 * S + 4 * S, S);
    });
    frames.push({ pixels: c.px, delay: 100 / FPS });
  }
  await Bun.write('docs/assets/lineup.gif', encodeGif(W, H, DUSK, frames));
}

console.log('wrote docs/assets/banner.png and docs/assets/lineup.gif');
