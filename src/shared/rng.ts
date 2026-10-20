// Deterministic hashing and PRNG, shared by the Worker and the browser.
// Ported from the approved visual concept (cyrb-style hash + mulberry32).

export function hashStr(str: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h1 >>> 0) ^ ((h2 & 0xffff) << 7)) >>> 0;
}

export type Rng = () => number;

export function mulberry(a: number): Rng {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A creature or battle seed is a 64-char hex SHA-256 digest; the generator uses its first 32 bits. */
export function seedToInt(seedHex: string): number {
  if (!/^[0-9a-f]{8,}$/i.test(seedHex)) throw new Error('bad seed');
  return parseInt(seedHex.slice(0, 8), 16) >>> 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hatch time is truncated to the second and written as ISO 8601 without milliseconds. */
export function hatchTimeIso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The hatch seed: SHA-256 of handle, hatch time to the second and the server-side salt. */
export async function hatchSeed(handle: string, hatchedAtIso: string, salt: string): Promise<string> {
  if (!salt) throw new Error('HATCH_SALT missing');
  return sha256Hex(`forklings-hatch-v1|${handle.toLowerCase()}|${hatchedAtIso}|${salt}`);
}
