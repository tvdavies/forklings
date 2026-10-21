// Minimal PNG encoder built on the web-standard CompressionStream, so the same code
// runs in the Worker (MCP portraits), in Bun scripts (icons, README art) and in tests.

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGBA pixels as a PNG file. */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

/**
 * Paint 32×32 sprite pixels (hex colours, null for transparent) at an integer scale,
 * centred on a canvas of the given size, on a solid background or transparent.
 */
export function paintSprite(cols: readonly (string | null)[], size: number, scale: number, background: string | null): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  if (background) {
    const [r, g, b] = hex(background);
    for (let i = 0; i < size * size; i++) px.set([r, g, b, 255], i * 4);
  }
  const off = Math.floor((size - 32 * scale) / 2);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const c = cols[y * 32 + x];
      if (!c) continue;
      const [r, g, b] = hex(c);
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) px.set([r, g, b, 255], ((off + y * scale + dy) * size + off + x * scale + dx) * 4);
    }
  return px;
}

/** Shift a 32×32 sprite so its visible pixels sit in the middle of the frame. */
export function centreSprite(cols: readonly (string | null)[]): (string | null)[] {
  let x0 = 32, y0 = 32, x1 = -1, y1 = -1;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      if (cols[y * 32 + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return [...cols];
  const dx = Math.floor((32 - (x1 - x0 + 1)) / 2) - x0, dy = Math.floor((32 - (y1 - y0 + 1)) / 2) - y0;
  const out: (string | null)[] = new Array(32 * 32).fill(null);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out[(y + dy) * 32 + x + dx] = cols[y * 32 + x];
  return out;
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
