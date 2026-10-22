// The Forklings mark: a butter-yellow face with a forked sprout, drawn by hand on a
// separate grid for each size it is shown at, so every pixel lands on a real pixel.
// 16 and 32 are drawn at 1:1; the 48 px favicon is the 24 grid at 2×. Bigger icons
// (Apple touch, PWA, the GitHub OAuth app) put the 32 grid on a dusk tile.
// scripts/icons.ts turns these into files.

/** One key per pixel. '.' is transparent. Colours come from the game's palette. */
export const PALETTE: Record<string, string> = {
  k: '#1a1124', // ink outline, eyes and mouth
  y: '#ffd166', // butter body
  h: '#fff3b8', // butter highlight
  s: '#e39b3a', // butter shadow
  m: '#6fdc9c', // mint leaf
  M: '#cdfcc0', // mint highlight
  n: '#2fa58a', // mint shadow
  w: '#fff2dc', // eye shine
  p: '#ff86bd', // blush
  P: '#d94c93', // tongue
};

export const FACE_16 = [
  '....kk....kk....',
  '...kMmk..kmMk...',
  '....knmkkmnk....',
  '...kkkkmnkkkk...',
  '..kyyyyyyyyyyk..',
  '.kyhhyyyyyyyyyk.',
  '.kyhyyyyyyyyysk.',
  'kyyykwyyyykwyysk',
  'kyyykkyyyykkyysk',
  'kyyykkyyyykkyysk',
  'kyppyykyykyppysk',
  'kyyyyyykkyyyyysk',
  '.kyyyyyyyyyyysk.',
  '..ksyyyyyyyssk..',
  '...kssssssssk...',
  '....kkkkkkkk....',
];

export const FACE_24 = [
  '...kkkk..........kkkk...',
  '..kMMMMk........kMMMMk..',
  '..kmmmmmk......kmmmmmk..',
  '...knmmmmk....kmmmmnk...',
  '....kknnmmkkkkmmnnkk....',
  '......kkknmmmmnkkk......',
  '..........kmnk..........',
  '.....kkkkkkmnkkkkkk.....',
  '...kkyyyyyyyyyyyyyykk...',
  '..kyyhhyyyyyyyyyyyyyyk..',
  '.kyyhhyyyyyyyyyyyyyyysk.',
  '.kyyyyyyyyyyyyyyyyyyysk.',
  'kyyyyykkyyyyyyyykkyyyysk',
  'kyyyykkwkyyyyyykkwkyyysk',
  'kyyyykkkkyyyyyykkkkyyysk',
  'kyyyykkkkyyyyyykkkkyyysk',
  'kyyyyykkyyyyyyyykkyyyssk',
  '.kypppyyyykkkkyyyypppsk.',
  '.kyyyyyyyyykkyyyyyyyssk.',
  '..kyyyyyyyyyyyyyyyyssk..',
  '..kksyyyyyyyyyyyyssskk..',
  '....kksssssssssssskk....',
  '......kkkkkkkkkkkk......',
  '........................',
];

export const FACE_32 = [
  '.....kkkk..............kkkk.....',
  '....kMMMMkk..........kkMMMMk....',
  '...kMmmmmmMk........kMmmmmmMk...',
  '...kmmmmmmmmk......kmmmmmmmmk...',
  '....knmmmmmmmk....kmmmmmmmnk....',
  '.....knnmmmmmmk..kmmmmmmnnk.....',
  '......kknnnmmmmkkmmmmnnnkk......',
  '........kkknnmmmmmmnnkkk........',
  '..............kmnk..............',
  '.........kkkkkkmnkkkkkk.........',
  '......kkkyyyyyyyyyyyyyykkk......',
  '....kkyhhhyyyyyyyyyyyyyyyykk....',
  '...kyyhhhyyyyyyyyyyyyyyyyyyyk...',
  '..kyyyhhyyyyyyyyyyyyyyyyyyyysk..',
  '..kyyyyyyyyyyyyyyyyyyyyyyyyysk..',
  '.kyyyyyyyyyyyyyyyyyyyyyyyyyyysk.',
  '.kyyyyyyyyyyyyyyyyyyyyyyyyyyysk.',
  '.kyyyyyyykkyyyyyyyyyykkyyyyyysk.',
  'kyyyyyyykkwwyyyyyyyykkwwyyyyyysk',
  'kyyyyyyykkwwyyyyyyyykkwwyyyyyysk',
  'kyyyyyyykkkkyyyyyyyykkkkyyyyyysk',
  'kyyyyyyykkkkyyyyyyyykkkkyyyyyssk',
  'kyyyyyyyykkyyyyyyyyyykkyyyyyyssk',
  '.kyyyyyyyyyyykkkkkkyyyyyyyyyssk.',
  '.kyyppppyyyyyykPPkyyyyyyppppssk.',
  '.kyyyppyyyyyyyykkyyyyyyyyppyssk.',
  '..kyyyyyyyyyyyyyyyyyyyyyyyyssk..',
  '..kyyyyyyyyyyyyyyyyyyyyyyysssk..',
  '...ksyyyyyyyyyyyyyyyyyyyssssk...',
  '....kkssyyyyyyyyyyyyyssssskk....',
  '......kkksssssssssssssskkk......',
  '.........kkkkkkkkkkkkkk.........',
];

/** Background tile for the large icons, from the game's dusk palette. */
export const TILE = { dusk: '#271d3b', shadow: '#1c1530' };

export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255] as const;
};

/** A blank canvas, transparent or filled. */
export function canvas(size: number, fill: string | null = null): Raster {
  const rgba = new Uint8Array(size * size * 4);
  if (fill) {
    const [r, g, b] = rgb(fill);
    for (let i = 0; i < size * size; i++) rgba.set([r, g, b, 255], i * 4);
  }
  return { width: size, height: size, rgba };
}

export function fillRect(c: Raster, x: number, y: number, w: number, h: number, hex: string) {
  const [r, g, b] = rgb(hex);
  for (let j = Math.max(0, y); j < Math.min(c.height, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(c.width, x + w); i++) c.rgba.set([r, g, b, 255], (j * c.width + i) * 4);
}

/** Paint a pixel map at an integer scale with its top-left corner at (x, y). */
export function blit(c: Raster, map: readonly string[], x: number, y: number, scale: number) {
  map.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const key = row[i];
      if (key === '.') continue;
      const hex = PALETTE[key];
      if (!hex) throw new Error(`Unknown pixel key "${key}" at ${i},${j}`);
      fillRect(c, x + i * scale, y + j * scale, scale, scale, hex);
    }
  });
}

/** A favicon: the map drawn to fill a transparent square. */
export function favicon(map: readonly string[], size: number): Raster {
  const scale = size / map.length;
  if (!Number.isInteger(scale)) throw new Error(`A ${map.length}px map can't fill ${size}px exactly`);
  const c = canvas(size);
  blit(c, map, 0, 0, scale);
  return c;
}

/** Does every visible pixel of the 32 grid, drawn at this scale and centred, sit inside the circle? */
function fitsCircle(size: number, scale: number, radius: number): boolean {
  const o = (size - 32 * scale) / 2,
    c = size / 2;
  return FACE_32.every((row, y) =>
    [...row].every((key, x) => {
      if (key === '.') return true;
      const corners = [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1],
      ];
      return corners.every(([i, j]) => Math.hypot(o + i * scale - c, o + j * scale - c) <= radius);
    }),
  );
}

/** The largest whole-number scale for the 32 grid in a large icon. */
export function iconScale(size: number, maskable: boolean): number {
  // Plain icons leave a margin of about 8% each side. Maskable icons must keep the art
  // inside the central circle, 40% of the width in radius, that every mask shape keeps.
  let scale = Math.max(1, Math.floor((size * 0.84) / 32));
  if (maskable) while (scale > 1 && !fitsCircle(size, scale, size * 0.4)) scale--;
  return scale;
}

/** A large app icon: the 32 grid on a dusk tile, standing on a small pixel shadow. */
export function appIcon(size: number, maskable = false): Raster {
  const c = canvas(size, TILE.dusk);
  const scale = iconScale(size, maskable);
  const art = 32 * scale;
  const ox = Math.floor((size - art) / 2),
    oy = Math.floor((size - art) / 2);
  // A flat shadow under the face, in the art's own pixel size: 18 wide, then 12, one pixel each.
  fillRect(c, ox + 7 * scale, oy + 31 * scale, 18 * scale, scale, TILE.shadow);
  fillRect(c, ox + 10 * scale, oy + 32 * scale, 12 * scale, scale, TILE.shadow);
  blit(c, FACE_32, ox, oy, scale);
  return c;
}

/** The mark as an SVG of crisp squares, for docs and anywhere a vector logo is wanted. */
export function svg(map: readonly string[]): string {
  const n = map.length;
  const rects: string[] = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x];
      let w = 1;
      while (row[x + w] === key) w++;
      if (key !== '.') rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${PALETTE[key]}"/>`);
      x += w;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">\n${rects.join('\n')}\n</svg>\n`;
}

/** Pack PNG images into one .ico file (PNG-compressed entries, supported everywhere current). */
export function ico(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + images.length * 16;
  const total = header + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  let offset = header;
  images.forEach((img, k) => {
    const e = 6 + k * 16;
    out[e] = img.size >= 256 ? 0 : img.size;
    out[e + 1] = img.size >= 256 ? 0 : img.size;
    v.setUint16(e + 4, 1, true); // colour planes
    v.setUint16(e + 6, 32, true); // bits per pixel
    v.setUint32(e + 8, img.png.length, true);
    v.setUint32(e + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}
