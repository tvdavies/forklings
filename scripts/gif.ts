// Minimal animated GIF89a encoder for indexed pixel art (up to 256 colours),
// used by scripts/art.ts to export README images straight from the generator.

/** LZW-compress indexed pixels as GIF image data sub-blocks. */
function lzw(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bitBuf = 0;
  let bitLen = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bitBuf |= code << bitLen;
    bitLen += codeSize;
    while (bitLen >= 8) {
      out.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitLen -= 8;
    }
  };
  // Each dictionary entry is (code of the prefix string, next index) packed into one number.
  let dict = new Map<number, number>();
  let next = end + 1;
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // Grow the code size once a code that needs the extra bit has been assigned.
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (bitLen > 0) out.push(bitBuf & 255);
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const part = out.slice(i, i + 255);
    blocks.push(part.length, ...part);
  }
  blocks.push(0);
  return blocks;
}

export interface GifFrame {
  /** Hex colour per pixel, or null for the background colour. */
  pixels: (string | null)[];
  /** Frame duration in hundredths of a second. */
  delay: number;
}

/** Encode frames of `width`×`height` pixels into a looping GIF. */
export function encodeGif(width: number, height: number, background: string, frames: GifFrame[]): Uint8Array {
  const palette = [background];
  const index = new Map([[background, 0]]);
  for (const f of frames)
    for (const c of f.pixels)
      if (c && !index.has(c)) {
        index.set(c, palette.length);
        palette.push(c);
      }
  if (palette.length > 256) throw new Error(`too many colours: ${palette.length}`);
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const size = 1 << bits;
  const bytes: number[] = [];
  const u16 = (n: number) => bytes.push(n & 255, (n >> 8) & 255);
  for (const ch of 'GIF89a') bytes.push(ch.charCodeAt(0));
  u16(width);
  u16(height);
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < size; i++) {
    const n = parseInt((palette[i] ?? background).slice(1), 16);
    bytes.push(n >> 16, (n >> 8) & 255, n & 255);
  }
  bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0x04);
    u16(f.delay);
    bytes.push(0, 0);
    bytes.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    bytes.push(0);
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < idx.length; i++) idx[i] = f.pixels[i] ? (index.get(f.pixels[i] as string) as number) : 0;
    const min = Math.max(2, bits);
    bytes.push(min, ...lzw(idx, min));
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
