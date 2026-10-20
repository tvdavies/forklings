// Creature genome: every visible trait comes from the hatch seed.
// Parts, palettes and pairing rules are ported from the approved visual concept;
// only the seed source changed (hatch seed instead of the GitHub handle).
import { mulberry, seedToInt } from './rng';

export const INK = '#1a1124';
export const RAMPS: Record<string, string[]> = {
  peach: ['#9e3b5c', '#e0695a', '#ff9f78', '#ffd6a5'],
  butter: ['#a8592f', '#e39b3a', '#ffd166', '#fff3b8'],
  mint: ['#1f6672', '#2fa58a', '#6fdc9c', '#cdfcc0'],
  sky: ['#32449a', '#4f7fe0', '#86bdff', '#d2efff'],
  lilac: ['#4e3192', '#8a5fd6', '#bf98ff', '#eadcff'],
  gum: ['#8c2766', '#d94c93', '#ff86bd', '#ffd0e6'],
  coral: ['#7e1f3a', '#cf3a4a', '#ff6f62', '#ffc2a1'],
  cocoa: ['#4f2c2c', '#86523a', '#c08458', '#ebc392'],
  frost: ['#444766', '#8389ad', '#c1c6e0', '#f1f3ff'],
  moss: ['#2c4a3a', '#4f7d3e', '#93b84a', '#e0ef9a'],
  gold: ['#7a4a1c', '#c8892c', '#ffd34d', '#fffbe0'],
};
export const RNAME: Record<string, string> = { peach: 'Peach', butter: 'Butter', mint: 'Mint', sky: 'Sky', lilac: 'Lilac', gum: 'Bubblegum', coral: 'Coral', cocoa: 'Cocoa', frost: 'Frost', moss: 'Moss', gold: 'Gold' };
const PAIRS = [['peach', 'mint'], ['lilac', 'butter'], ['sky', 'gum'], ['mint', 'coral'], ['cocoa', 'butter'], ['frost', 'sky'], ['gum', 'sky'], ['butter', 'lilac'],
  ['coral', 'butter'], ['moss', 'peach'], ['sky', 'butter'], ['lilac', 'mint'], ['frost', 'gum'], ['mint', 'lilac'], ['peach', 'sky'], ['cocoa', 'mint']];
export const SHAPES = ['round', 'bean', 'pear', 'loaf', 'drop', 'blob'];
export const EARS = ['cat', 'bunny', 'antenna', 'horns', 'sprout', 'round', 'fin', 'none'];
export const TAILS = ['curl', 'bolt', 'ball', 'spade', 'flame', 'none'];
export const EYES = ['round', 'big', 'tall', 'dot', 'sleepy', 'cyclops'];
export const MOUTHS = ['smile', 'cat', 'dot', 'fang', 'open'];
export const PATTERNS = ['none', 'belly', 'spots', 'stripes', 'mask', 'split', 'freckles'];
const PRE = ['Byte', 'Null', 'Lint', 'Fork', 'Merge', 'Stack', 'Bit', 'Cache', 'Diff', 'Hash', 'Loop', 'Ping', 'Patch', 'Sudo', 'Kern', 'Async', 'Regex', 'Yaml', 'Pixel', 'Commit', 'Branch', 'Query', 'Lambda', 'Pear', 'Tensor', 'Cron'];
const SUF = ['pup', 'ling', 'moth', 'kin', 'bun', 'mew', 'nib', 'toad', 'puff', 'wisp', 'roo', 'bat', 'let', 'paw', 'mite', 'fox', 'chick', 'sprout'];
export const TYPES = ['Async', 'Kernel', 'Markup', 'Data', 'Shell', 'Cloud', 'Pixel', 'Logic'];
export const RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Shiny'];
export const RCOL = ['#c1c6e0', '#6fdc9c', '#86bdff', '#bf98ff', '#ffd34d'];
export const STAGE_NAMES = ['Sprout', 'Junior', 'Prime'];

export interface Genome {
  seed: number; seedHex: string; id: string;
  shape: string; rx: number; ry: number; n: number;
  ears: string; tail: string; eyes: string; mouth: string; pattern: string;
  feet: boolean; arms: boolean; blush: boolean; flop: boolean; shiny: boolean;
  pal: string[]; belly: string; rarity: number; name: string; type: string; blinkOff: number;
  base: { hp: number; atk: number; def: number; spd: number };
  items: Record<string, string | null>;
}

export function genome(seedHex: string): Genome {
  const seed = seedToInt(seedHex), r = mulberry(seed), pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const g: any = { seed, seedHex, id: seedHex.slice(0, 16) };
  g.shape = pick(SHAPES); g.rx = 7.6 + r() * 2.2; g.ry = 7.2 + r() * 2.2;
  if (g.shape === 'bean') { g.rx -= 1; g.ry += 0.8; } if (g.shape === 'loaf') { g.rx += 1; g.ry -= 1; }
  g.n = g.shape === 'loaf' ? 3.1 : g.shape === 'blob' ? 2.0 : 2.15 + r() * 0.55;
  g.ears = pick(EARS); g.tail = pick(TAILS); g.eyes = pick(EYES); g.mouth = pick(MOUTHS); g.pattern = pick(PATTERNS);
  // curated pairing rules
  if (g.eyes === 'cyclops' && (g.pattern === 'mask' || g.pattern === 'freckles')) g.pattern = 'belly';
  if (g.shape === 'drop' && (g.ears === 'bunny' || g.ears === 'round')) g.ears = 'sprout';
  if (g.ears === 'horns' && r() < 0.6) g.mouth = 'fang';
  if (g.eyes === 'cyclops' && g.mouth === 'cat') g.mouth = 'smile';
  if (g.eyes === 'sleepy' && g.mouth === 'open') g.mouth = 'smile';
  g.feet = r() < 0.72; g.arms = r() < 0.6; g.blush = r() < 0.6; g.flop = r() < 0.5;
  g.shiny = r() < 1 / 16; const pair = pick(PAIRS); g.pal = g.shiny ? ['gold', pair[1]] : pair;
  g.belly = r() < 0.5 ? 'cream' : 'light';
  let rare = 0; for (const p of ['cyclops', 'flame', 'sprout', 'fin', 'bolt']) if ([g.eyes, g.tail, g.ears].includes(p)) rare++;
  g.rarity = g.shiny ? 4 : Math.min(3, rare + (r() < 0.25 ? 1 : 0));
  g.name = pick(PRE) + pick(SUF); g.type = pick(TYPES); g.blinkOff = r() * 4;
  // Battle base stats come from a separate stream so cosmetic tweaks never shift them.
  const s = mulberry(seed ^ 0x5eed5);
  const shapeBias: Record<string, number[]> = { round: [1, 0, 0, 0], bean: [0, 0, 0, 1], pear: [1, 0, 1, -1], loaf: [2, -1, 1, -1], drop: [0, 1, -1, 1], blob: [1, 0, 1, -1] };
  const b = shapeBias[g.shape];
  g.base = { hp: 10 + Math.floor(s() * 6) + b[0], atk: 10 + Math.floor(s() * 6) + b[1], def: 10 + Math.floor(s() * 6) + b[2], spd: 10 + Math.floor(s() * 6) + b[3] };
  if (g.ears === 'horns') g.base.atk += 1; if (g.tail === 'bolt') g.base.spd += 1; if (g.shiny) { g.base.hp += 1; g.base.atk += 1; }
  g.items = { head: null, face: null, neck: null, held: null };
  return g as Genome;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function describe(g: Genome): string {
  const parts: Record<string, string> = { round: 'round', bean: 'bean', pear: 'pear', loaf: 'loaf', drop: 'teardrop', blob: 'blob' };
  return `${cap(parts[g.shape])} body, ${g.ears === 'none' ? 'no ears' : g.ears + (g.ears === 'horns' ? '' : ' ears')}${g.flop && ['cat', 'bunny', 'antenna'].includes(g.ears) ? ' (one flopped)' : ''}, ${g.tail === 'none' ? 'no tail' : g.tail + ' tail'}, ${g.eyes} eyes, ${g.pattern === 'none' ? 'plain' : g.pattern} pattern. ${RNAME[g.pal[0]]} and ${RNAME[g.pal[1]]}.`;
}
