// Generate PWA icons from the sprite generator itself (no image files are hand-drawn).
// Run with: bun scripts/icons.ts
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { genome } from '../src/shared/genome';
import { compose } from '../src/shared/compose';

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const g: any = genome('5ab1e5eed0000000000000000000000000000000000000000000000000000000');
g.pal = ['butter', 'lilac']; g.eyes = 'big'; g.ears = 'cat'; g.mouth = 'smile'; g.pattern = 'belly'; g.shape = 'round';
const { cols } = compose(g, { stage: 1 });
for (const size of [192, 512]) {
  const P = Math.floor(size / 40), off = Math.floor((size - 32 * P) / 2);
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { px[i * 4] = 0x27; px[i * 4 + 1] = 0x1d; px[i * 4 + 2] = 0x3b; px[i * 4 + 3] = 255; }
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const c = cols[y * 32 + x]; if (!c) continue; const n = parseInt(c.slice(1), 16);
    for (let dy = 0; dy < P; dy++) for (let dx = 0; dx < P; dx++) { const i = ((off + y * P + dy) * size + off + x * P + dx) * 4; px[i] = n >> 16; px[i + 1] = (n >> 8) & 255; px[i + 2] = n & 255; } }
  writeFileSync(`public/icon-${size}.png`, png(size, size, px));
}
console.log('icons written');
