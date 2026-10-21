// Nightly shop items, generated procedurally from a date-seeded PRNG: no image model, no LLM.
// Each archetype is modelled on a real object (beanie, bucket hat, cat-eye glasses, lanyard,
// hoodie, takeaway cup...). Colours come only from the creature palette ramps, ink and
// cream, and shapes are shaded with the same top-left light as the creatures.
// The same day, salt and existing catalogue always give the same items.

import { type ItemDef, type ItemParams, type ParamKind, patternOn, type Slot, type Stat } from './compose';
import { type Look, lookOf, MIN_DISTANCE_EVER, MIN_ITEM_DISTANCE, nearDuplicate, RECENT_DAYS } from './distinct';
import { basePrice, HELD_PCT, LEVEL_RANGE } from './economy';
import { INK, PAIRS, RAMPS, RNAME } from './genome';
import { mulberry, type Rng, seedToInt, sha256Hex } from './rng';

/** Bump when the generator's output for a given seed changes, so old and new items can be told apart. */
export const SHOP_GEN_VERSION = 1;
/** New items per night, one per slot plus one extra. */
export const ITEMS_PER_DAY = 6;
/** Older items brought back each day, chosen from those not on the shelf in the last week. */
export const RESURFACED_PER_DAY = 4;
export const RESURFACE_COOLDOWN_DAYS = 7;
/** Candidates tried per slot before giving up on that slot for the night. */
export const MAX_ATTEMPTS = 40;
/** Slots a stage-0 Forkling shows: neck and held items appear from the first evolution. */
export const BABY_SLOTS = new Set<Slot>(['head', 'face', 'body']);

export const CREAM = '#fff2dc';
/** Every colour a generated item may use: the creature ramps, ink, cream, and white for glints. */
export const ITEM_PALETTE = new Set<string>([...Object.values(RAMPS).flat(), INK, CREAM, '#ffffff']);

/** A generated item: its drawing (`ItemDef`) plus shop data. */
export interface GenItem {
  id: string;
  day: string;
  arch: string;
  def: ItemDef;
  level: number;
  price: number;
}

/** The secret-salted seed for a day. The salt never leaves the Worker, so nobody can preview tomorrow's shop. */
export async function shopSeed(day: string, salt: string): Promise<number> {
  if (!salt) throw new Error('shop salt missing');
  return seedToInt(await sha256Hex(`forklings-shop-v${SHOP_GEN_VERSION}|${day}|${salt}`));
}

// ---------- a tiny pixel builder ----------
// Regions: M main, A accent (auto-shaded), m/a their darkest tone, H/h their lightest,
// K ink, W cream. Shading follows the creatures: lit from the top left, shadow bottom right.
type Region = 'M' | 'A' | 'm' | 'a' | 'H' | 'h' | 'K' | 'W';
class Px {
  g: (Region | null)[];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.g = new Array(w * h).fill(null);
  }
  set(x: number, y: number, r: Region | null) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.g[y * this.w + x] = r;
  }
  at(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.g[y * this.w + x] : null;
  }
  row(y: number, x0: number, x1: number, r: Region | null) {
    for (let x = x0; x <= x1; x++) this.set(x, y, r);
  }
  /** A row of width `w` centred in the grid. */
  centred(y: number, w: number, r: Region | null, shift = 0) {
    const x0 = Math.floor((this.w - w) / 2) + shift;
    this.row(y, x0, x0 + w - 1, r);
  }
  rect(x: number, y: number, w: number, h: number, r: Region | null) {
    for (let j = 0; j < h; j++) this.row(y + j, x, x + w - 1, r);
  }
  /** Rows from strings ('.' empty), each centred. */
  rows(lines: string[], y0 = 0) {
    lines.forEach((l, j) => {
      const x0 = Math.floor((this.w - l.length) / 2);
      for (let i = 0; i < l.length; i++) if (l[i] !== '.') this.set(x0 + i, y0 + j, l[i] as Region);
    });
  }
  mirror() {
    const g = this.g.slice();
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.g[y * this.w + x] = g[y * this.w + (this.w - 1 - x)];
  }
  /** Shade and colour into a stamped pixel map: tones 0-3 of the main ramp, 4-7 of the accent ramp, k ink, w cream. */
  toMap(main: string[], acc: string[]): { map: string[]; cols: Record<string, string> } {
    const same = (x: number, y: number, r: Region) => {
      const v = this.at(x, y);
      return v === r;
    };
    const map: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let line = '';
      for (let x = 0; x < this.w; x++) {
        const r = this.at(x, y);
        if (!r) {
          line += '.';
          continue;
        }
        if (r === 'K') line += 'k';
        else if (r === 'W') line += 'w';
        else if (r === 'm') line += '0';
        else if (r === 'a') line += '4';
        else if (r === 'H') line += '3';
        else if (r === 'h') line += '7';
        else {
          const tone = !same(x + 1, y + 1, r) || !same(x, y + 1, r) ? 1 : !same(x - 1, y - 1, r) ? 3 : 2;
          line += String(tone + (r === 'A' ? 4 : 0));
        }
      }
      map.push(line);
    }
    const cols: Record<string, string> = { k: INK, w: CREAM };
    for (let i = 0; i < 4; i++) {
      cols[String(i)] = main[i];
      cols[String(i + 4)] = acc[i];
    }
    // Keep only the colours the map uses: the stored item stays small.
    const used = new Set(map.join(''));
    for (const k of Object.keys(cols)) if (!used.has(k)) delete cols[k];
    // Trim empty rows and columns.
    let top = 0,
      bottom = map.length - 1;
    while (top < bottom && !/[^.]/.test(map[top])) top++;
    while (bottom > top && !/[^.]/.test(map[bottom])) bottom--;
    const rowsIn = map.slice(top, bottom + 1);
    let left = 0,
      right = this.w - 1;
    while (left < right && rowsIn.every((l) => l[left] === '.')) left++;
    while (right > left && rowsIn.every((l) => l[right] === '.')) right--;
    return { map: rowsIn.map((l) => l.slice(left, right + 1)), cols };
  }
}

// ---------- archetypes ----------
interface Ctx {
  r: Rng;
  rarity: number;
  main: string; // ramp name
  acc: string; // ramp name
}
interface Built {
  noun: string;
  adj?: string;
  /** A stamped map, or parametric drawing. */
  px?: Px;
  kind?: ParamKind;
  p?: ItemParams;
  stat?: Stat;
  /** Fixed main ramp for this archetype (e.g. a chef's hat is white). */
  mainOverride?: string;
}
interface Archetype {
  id: string;
  slot: Slot;
  build: (c: Ctx) => Built;
  blurbs: string[];
  /** Patterns this stamped item may wear on its main colour (stripes on a beanie, dots on a mug). */
  pats?: string[];
}
const SOFT = ['stripes', 'dots', 'check', 'pin', 'halves'];
const HARD = ['stripes', 'halves', 'dots'];

const WEAR_PATTERNS = ['stripes', 'wide', 'pin', 'check', 'dots', 'halves', 'yoke', 'hem', 'diag'];
const PATTERN_ADJ: Record<string, string> = {
  stripes: 'striped',
  wide: 'banded',
  pin: 'pinstripe',
  check: 'checked',
  dots: 'spotty',
  halves: 'two-tone',
  yoke: 'colour-block',
  hem: 'dip-dyed',
  diag: 'harlequin',
};
const chance = (r: Rng, p: number) => r() < p;
const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const between = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const ramp = (n: string) => RAMPS[n];

const ARCHETYPES: Archetype[] = [
  // ---- head ----
  {
    id: 'beanie',
    slot: 'head',
    pats: SOFT,
    blurbs: ['Keeps the ideas warm.', 'Knitted during a long CI run.', 'Standard issue for cold server rooms.'],
    build: ({ r, rarity }) => {
      const w = between(r, 9, 11),
        bobble = chance(r, 0.4 + rarity * 0.15),
        stripe = chance(r, 0.5),
        ribbed = chance(r, 0.5);
      const g = new Px(w, 7);
      let y = 0;
      if (bobble) g.centred(y++, 2, 'A');
      g.centred(y++, w - 4, 'M');
      g.centred(y++, w - 2, 'M');
      g.centred(y++, w, stripe ? 'A' : 'M');
      g.centred(y++, w, 'M');
      for (let x = 0; x < w; x++) g.set(x, y, ribbed && x % 2 ? 'a' : 'A');
      return { noun: bobble ? 'bobble hat' : 'beanie', adj: stripe ? 'striped' : ribbed ? 'ribbed' : undefined, px: g };
    },
  },
  {
    id: 'cap',
    slot: 'head',
    blurbs: ['Brim forward for focus mode.', 'Team cap from a hackathon nobody remembers.', 'Shades the screen glare.'],
    build: ({ r, rarity }) => {
      const g = new Px(12, 5),
        panel = chance(r, 0.5),
        button = chance(r, 0.5 + rarity * 0.1);
      if (button) g.set(4, 0, 'A');
      g.row(1, 2, 6, 'M');
      g.row(2, 1, 7, 'M');
      g.row(3, 1, 7, 'M');
      if (panel) for (const y of [1, 2, 3]) g.set(4, y, 'A');
      g.row(4, 1, 11, 'A');
      g.row(4, 0, 0, null);
      if (chance(r, 0.5)) g.mirror();
      return { noun: 'baseball cap', adj: panel ? 'two-tone' : undefined, px: g };
    },
  },
  {
    id: 'bucket',
    slot: 'head',
    pats: SOFT,
    blurbs: ['Festival-ready, terminal-ready.', 'Collects rain and stray semicolons.', 'Floppy brim, firm opinions.'],
    build: ({ r }) => {
      const g = new Px(12, 5),
        band = chance(r, 0.6);
      g.centred(0, 6, 'M');
      g.centred(1, 8, 'M');
      g.centred(2, 8, band ? 'A' : 'M');
      g.centred(3, 10, 'M');
      g.centred(4, 12, 'm');
      return { noun: 'bucket hat', adj: band ? 'banded' : undefined, px: g };
    },
  },
  {
    id: 'beret',
    slot: 'head',
    pats: ['dots', 'check', 'pin'],
    blurbs: ['For pixel artists only.', 'Tilted at exactly the right angle.', 'Adds 2 points of taste.'],
    build: ({ r }) => {
      const g = new Px(11, 4),
        s = chance(r, 0.5) ? 1 : -1;
      g.set(5 + s, 0, 'A');
      g.centred(1, 7, 'M', s);
      g.centred(2, 11, 'M');
      g.centred(3, 9, 'm', -s);
      return { noun: 'beret', px: g };
    },
  },
  {
    id: 'tophat',
    slot: 'head',
    pats: ['pin', 'check', 'halves'],
    blurbs: ['Dressed for the release party.', 'Pulls a rabbit out of a stack trace.', 'Very formal, very tall.'],
    build: ({ r, rarity }) => {
      const tall = between(r, 3, rarity >= 2 ? 5 : 4),
        g = new Px(10, tall + 2);
      for (let y = 0; y < tall; y++) g.centred(y, 6, 'M');
      g.centred(tall - 1, 6, 'A');
      g.centred(tall, 8, 'M');
      g.centred(tall + 1, 10, 'm');
      return { noun: 'top hat', px: g };
    },
  },
  {
    id: 'chef',
    slot: 'head',
    blurbs: ['Cooks up a fresh build.', 'Yes, chef. Merging now.', 'Smells faintly of toast.'],
    build: ({ r }) => {
      const g = new Px(9, 5);
      g.rows(['.WW.WW.', 'WWWWWWW', 'WWWWWWW', '.AAAAA.', '.aaaaa.'].map((l, i) => (i === 4 && chance(r, 0.5) ? '.AAAAA.' : l)));
      return { noun: "chef's hat", px: g, mainOverride: 'frost' };
    },
  },
  {
    id: 'hardhat',
    slot: 'head',
    pats: HARD,
    blurbs: ['Safety first, deploy second.', 'For working on the legacy code.', 'Hard-hat area: refactoring.'],
    build: ({ r }) => {
      const g = new Px(11, 5),
        ridge = chance(r, 0.6);
      g.centred(0, 5, 'M');
      g.centred(1, 7, 'M');
      g.centred(2, 9, 'M');
      if (ridge) for (const y of [0, 1, 2]) g.set(5, y, 'H');
      g.centred(3, 9, 'A');
      g.centred(4, 11, 'm');
      return { noun: 'hard hat', px: g };
    },
  },
  {
    id: 'cowboy',
    slot: 'head',
    pats: ['halves', 'dots'],
    blurbs: ['Rides into town on a pull request.', 'Yeehaw, the tests pass.', 'This repo is not big enough.'],
    build: ({ r }) => {
      const g = new Px(13, 5),
        band = chance(r, 0.7);
      g.rows(['.MM.MM.', 'MMMMMMM', band ? 'AAAAAAA' : 'MMMMMMM', 'mMMMMMMMMMMMm', '.mmmmmmmmmmm.']);
      return { noun: 'cowboy hat', adj: band ? 'banded' : undefined, px: g };
    },
  },
  {
    id: 'headband',
    slot: 'head',
    blurbs: ['Ready for a long debugging session.', 'Bow optional, focus mandatory.', 'Holds back the hair and the bugs.'],
    build: ({ r }) => {
      const g = new Px(11, 3),
        side = chance(r, 0.5) ? 2 : 6;
      g.row(0, side, side + 1, 'A');
      g.row(0, side + 3, side + 4, 'A');
      g.row(1, side, side + 4, 'A');
      g.set(side + 2, 1, 'a');
      g.row(2, 0, 10, 'M');
      return { noun: 'headband', adj: 'bow', px: g };
    },
  },
  {
    id: 'flowers',
    slot: 'head',
    blurbs: ['Picked fresh from the garden branch.', 'Smells like a green build.', 'A crown for a gentle soul.'],
    build: ({ r }) => {
      const g = new Px(11, 3),
        gap = chance(r, 0.5) ? 4 : 3;
      for (let x = 1; x < 11; x += gap) {
        g.set(x, 0, 'A');
        g.set(x - 1, 1, 'A');
        g.set(x, 1, 'W');
        g.set(x + 1, 1, 'A');
      }
      g.row(2, 0, 10, 'M');
      return { noun: 'flower crown', px: g, mainOverride: pick(r, ['moss', 'mint']) };
    },
  },
  {
    id: 'phones',
    slot: 'head',
    blurbs: ['Noise-cancelling for stand-ups.', 'Lo-fi beats, high focus.', 'Do not disturb: compiling.'],
    build: ({ r, main, acc }) => {
      const style = pick(r, ['cans', 'cat', 'mic']);
      const A = ramp(acc),
        M = ramp(main);
      return {
        noun: style === 'cat' ? 'cat-ear headphones' : style === 'mic' ? 'headset' : 'headphones',
        kind: 'phones',
        p: { style, c: [M[1], A[1], A[2], A[0]] },
      };
    },
  },
  // ---- face ----
  {
    id: 'lens',
    slot: 'face',
    blurbs: ['Sees every off-by-one.', 'Reads the diff twice.', 'Blue-light filter included.', 'Makes code review look easy.'],
    build: ({ r, main, acc, rarity }) => {
      const styles = ['round', 'square', 'cat', 'half', 'monocle', 'goggles', '3d', 'visor', 'browline', 'aviator'];
      const style = pick(r, rarity >= 2 ? styles : styles.filter((s) => s !== 'monocle'));
      const M = ramp(main),
        A = ramp(acc);
      const nouns: Record<string, string> = {
        round: 'round specs',
        square: 'square frames',
        cat: 'cat-eye glasses',
        half: 'reading glasses',
        monocle: 'monocle',
        goggles: 'ski goggles',
        '3d': '3D glasses',
        visor: 'sports visor',
        browline: 'browline glasses',
        aviator: 'aviators',
      };
      const frame = pick(r, [M[0], M[1], M[2], INK]);
      const c =
        style === '3d'
          ? [CREAM, RAMPS.coral[2], RAMPS.sky[2]]
          : style === 'goggles'
            ? [M[1], A[3], M[0]]
            : style === 'visor'
              ? [M[0], A[2], A[1]]
              : style === 'monocle'
                ? [RAMPS.gold[1], RAMPS.sky[3], RAMPS.gold[2]]
                : style === 'browline'
                  ? [frame, RAMPS.sky[3], A[1]]
                  : style === 'aviator'
                    ? [RAMPS.gold[1], A[2], A[1]]
                    : [frame, pick(r, [RAMPS.sky[3], A[3], A[2]]), A[1]];
      return { noun: nouns[style], kind: 'lens', p: { style, c } };
    },
  },
  // ---- neck ----
  {
    id: 'scarf',
    slot: 'neck',
    blurbs: ['Cosy for long builds.', 'Hand-knitted by a retired sysadmin.', 'Long enough for a long weekend.'],
    build: ({ r, main, acc }) => {
      const style = pick(r, ['stripe', 'knit', 'plain', 'pat']);
      const pat = style === 'pat' ? pick(r, ['pin', 'check', 'halves', 'diag']) : undefined;
      const M = ramp(main),
        A = ramp(acc);
      return {
        noun: 'scarf',
        adj: pat ? PATTERN_ADJ[pat] : style === 'stripe' ? 'striped' : style === 'knit' ? 'chequered' : undefined,
        kind: 'band',
        p: { style: pat ? 'plain' : style, c: [A[2], style === 'plain' ? M[2] : pat ? M[1] : A[2], M[0], A[1]], pat },
      };
    },
  },
  {
    id: 'bandana',
    slot: 'neck',
    blurbs: ['Rides with the merge train.', 'Dust-proof for old repos.', 'Paisley not included.'],
    build: ({ main, acc }) => {
      const M = ramp(main),
        A = ramp(acc);
      return { noun: 'bandana', kind: 'band', p: { style: 'bandana', c: [M[2], A[3], M[0]] } };
    },
  },
  {
    id: 'lanyard',
    slot: 'neck',
    blurbs: ['Access to every conference room.', 'Badge says HELLO, my name is root.', 'Conference swag, finally useful.'],
    build: ({ main, acc }) => {
      const M = ramp(main),
        A = ramp(acc);
      return { noun: 'lanyard', kind: 'band', p: { style: 'lanyard', c: [A[1], M[2], M[0]] } };
    },
  },
  {
    id: 'beads',
    slot: 'neck',
    blurbs: ['One bead for every green build.', 'Shiny, like a fresh release.', 'Strung together like a monorepo.'],
    build: ({ main, acc }) => {
      const M = ramp(main),
        A = ramp(acc);
      return { noun: 'pendant', kind: 'band', p: { style: 'beads', c: [M[2], A[2], A[0]] } };
    },
  },
  {
    id: 'collar',
    slot: 'neck',
    blurbs: ['Smart-casual for the all-hands.', 'Business on top, bugs underneath.', 'Collar up, standards up.'],
    build: ({ main }) => {
      const M = ramp(main);
      return { noun: 'polo collar', kind: 'band', p: { style: 'collar', c: [M[3], M[2], M[0]] } };
    },
  },
  {
    id: 'tie',
    slot: 'neck',
    pats: ['dots', 'check', 'diag'],
    blurbs: ['For the quarterly review.', 'Clip-on, like most dependencies.', 'Means business.'],
    build: ({ r }) => {
      const g = new Px(3, 6),
        stripe = chance(r, 0.6);
      g.rows(['.a.', '.M.', 'MMM', stripe ? 'MAM' : 'MMM', 'MMM', '.M.']);
      return { noun: 'tie', adj: stripe ? 'striped' : undefined, px: g };
    },
  },
  {
    id: 'bowtie',
    slot: 'neck',
    pats: ['check', 'pin', 'halves'],
    blurbs: ['Dressed for the demo.', 'Very dapper, very debugged.', 'Ties the whole look together.'],
    build: ({ r }) => {
      const g = new Px(7, 3),
        dots = chance(r, 0.5);
      g.rows([dots ? 'MA...AM' : 'MM...MM', 'MMMaMMM', dots ? 'AM...MA' : 'MM...MM']);
      return { noun: 'bow tie', adj: dots ? 'polka-dot' : undefined, px: g };
    },
  },
  {
    id: 'medal',
    slot: 'neck',
    blurbs: ['First place, bug bash.', 'Awarded for shipping on time.', 'Employee of the sprint.'],
    build: () => {
      const g = new Px(5, 5);
      g.rows(['A...A', '.A.A.', '..A..', '.MMM.', '..M..']);
      return { noun: 'medal', px: g, mainOverride: 'gold' };
    },
  },
  // ---- body ----
  {
    id: 'wear',
    slot: 'body',
    blurbs: [
      'Pairs well with a late-night deploy.',
      'Soft, warm and lint-free.',
      'Cut for a creature, not a human.',
      'Comes with pockets for snacks.',
    ],
    build: ({ r, main, acc, rarity }) => {
      // On these round bodies a top only shows as a band at the bottom, so items that stand
      // out from the silhouette (capes, wings, tutus, backpacks) are picked more often.
      const style = pick(r, [
        'hoodie',
        'jumper',
        'tee',
        'overalls',
        'backpack',
        'backpack',
        'cape',
        'cape',
        'wings',
        'wings',
        'tutu',
        'tutu',
        'hoodie',
      ]);
      // Plain is common; patterns get likelier with rarity.
      const patterned = style === 'cape' || style === 'jumper' || style === 'tee' || style === 'overalls' || style === 'hoodie';
      const pat = !patterned
        ? undefined
        : chance(r, 0.35 + rarity * 0.15)
          ? pick(r, WEAR_PATTERNS)
          : style === 'jumper'
            ? 'stripes'
            : 'plain';
      const M = ramp(main),
        A = ramp(acc);
      const nouns: Record<string, string> = {
        hoodie: 'hoodie',
        jumper: 'jumper',
        tee: 'T-shirt',
        overalls: 'dungarees',
        backpack: 'backpack',
        cape: 'cape',
        wings: 'fairy wings',
        tutu: 'tutu',
      };
      return { noun: nouns[style], adj: pat ? PATTERN_ADJ[pat] : undefined, kind: 'wear', p: { style, c: [...M, A[2], A[0]], pat } };
    },
  },
  // ---- held ----
  {
    id: 'mug',
    slot: 'held',
    pats: HARD,
    blurbs: ['Fuel for the next sprint.', 'Holds exactly one stand-up of coffee.', 'Says WORLD\u2019S OKAYEST DEV on the back.'],
    build: ({ r }) => {
      const g = new Px(7, 6),
        steam = chance(r, 0.5),
        band = chance(r, 0.5);
      if (steam) g.rows(['.W.W..'], 0);
      g.rect(0, 1, 5, 5, 'M');
      g.row(1, 0, 4, 'm');
      if (band) g.row(3, 0, 4, 'A');
      g.set(5, 2, 'M');
      g.set(6, 3, 'M');
      g.set(5, 4, 'M');
      return { noun: 'mug', adj: band ? 'banded' : undefined, px: g, stat: 'spd' };
    },
  },
  {
    id: 'cup',
    slot: 'held',
    pats: ['stripes', 'dots'],
    blurbs: ['Oat flat white, extra shot.', 'Your name, spelt wrong.', 'Takeaway, take-a-break.'],
    build: () => {
      const g = new Px(6, 7);
      g.rows(['AAAA', 'aaaaaa', '.WWWW.', '.MMMM.', '.MMMM.', '.WWWW.', '..WW..']);
      return { noun: 'takeaway cup', px: g, stat: 'spd' };
    },
  },
  {
    id: 'book',
    slot: 'held',
    pats: ['halves', 'check'],
    blurbs: ['A well-thumbed design patterns book.', 'Chapter 7: Why it works on my machine.', 'Read the docs. Literally.'],
    build: ({ r }) => {
      const g = new Px(6, 7),
        bookmark = chance(r, 0.5);
      g.rect(0, 0, 6, 6, 'M');
      for (let y = 0; y < 6; y++) g.set(0, y, 'a');
      for (let y = 1; y < 5; y++) g.set(5, y, 'W');
      g.row(2, 2, 3, 'A');
      if (bookmark) g.set(3, 6, 'A');
      return { noun: 'book', px: g, stat: 'def' };
    },
  },
  {
    id: 'laptop',
    slot: 'held',
    blurbs: ['Covered in stickers.', 'Battery at 4%, still compiling.', 'Runs the dev server and the space heater.'],
    build: ({ r }) => {
      const g = new Px(8, 6),
        sticker = chance(r, 0.6);
      g.rect(1, 0, 6, 4, 'm');
      g.rect(2, 1, 4, 2, 'A');
      g.row(1, 2, 3, 'h');
      if (sticker) g.set(5, 2, 'W');
      g.row(4, 0, 7, 'M');
      g.row(5, 0, 7, 'm');
      return { noun: 'laptop', px: g, stat: 'atk' };
    },
  },
  {
    id: 'phone',
    slot: 'held',
    pats: ['halves', 'stripes', 'diag'],
    blurbs: ['Forty unread notifications.', 'On-call, unfortunately.', 'Doom-scrolls the release notes.'],
    build: () => {
      const g = new Px(4, 6);
      g.rect(0, 0, 4, 6, 'M');
      g.rect(1, 1, 2, 3, 'A');
      g.set(1, 1, 'h');
      g.set(1, 5, 'W');
      g.set(2, 5, 'W');
      return { noun: 'phone', px: g, stat: 'spd' };
    },
  },
  {
    id: 'controller',
    slot: 'held',
    blurbs: ['Just one more round.', 'Muscle memory, battle-tested.', 'Press start to deploy.'],
    build: () => {
      const g = new Px(8, 4);
      g.rows(['.MMMMMM.', 'MKMMMMAM', 'KKKMMAMA', 'MMM..MMM']);
      return { noun: 'game controller', px: g, stat: 'atk' };
    },
  },
  {
    id: 'plant',
    slot: 'held',
    blurbs: ['Watered every sprint review.', 'The only thing on the desk still growing.', 'Photosynthesises your stress.'],
    build: ({ r }) => {
      const g = new Px(6, 7),
        tall = chance(r, 0.5);
      // leaves in a green ramp, the pot in the accent
      if (tall) g.rows(['.M..M.', 'MM.MM.', '.MMM..'], 0);
      else g.rows(['..M...', '.MMM.M', 'MM.MMM'], 0);
      g.rows(['AAAAAA', '.AAAA.', '.aaaa.'], 3);
      return { noun: 'desk plant', px: g, stat: 'hp', mainOverride: pick(r, ['moss', 'mint']) };
    },
  },
  {
    id: 'bottle',
    slot: 'held',
    pats: HARD,
    blurbs: ['Stay hydrated, stay shipping.', 'Covered in conference stickers.', 'Reusable, like good code.'],
    build: () => {
      const g = new Px(4, 7);
      g.rows(['.AA.', '.MM.', 'MMMM', 'MWWM', 'MMMM', 'MMMM', 'mmmm']);
      return { noun: 'water bottle', px: g, stat: 'hp' };
    },
  },
  {
    id: 'donut',
    slot: 'held',
    blurbs: ['Somebody brought donuts.', 'A treat for closing the ticket.', 'Sprinkles of joy.'],
    build: () => {
      const g = new Px(6, 5);
      g.rows(['.AAAA.', 'AWA.AA', 'AA..WA', 'MAAAAM', '.mmmm.']);
      return { noun: 'donut', px: g, stat: 'hp' };
    },
  },
];

export const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id);
const BY_SLOT: Record<Slot, Archetype[]> = { head: [], face: [], neck: [], body: [], held: [] };
for (const a of ARCHETYPES) BY_SLOT[a.slot].push(a);

const RARITY_WEIGHTS = [50, 30, 15, 5];
const rollRarity = (r: Rng) => {
  let x = r() * 100;
  for (let i = 0; i < 4; i++) {
    x -= RARITY_WEIGHTS[i];
    if (x < 0) return i;
  }
  return 3;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Build one candidate for a slot. */
function candidate(r: Rng, slot: Slot, avoid: Set<string>): { arch: Archetype; def: ItemDef } {
  const pool = BY_SLOT[slot].filter((a) => !avoid.has(a.id));
  const arch = pick(r, pool.length ? pool : BY_SLOT[slot]);
  const rarity = rollRarity(r);
  const pair = pick(r, PAIRS);
  // Epic items get the gold ramp as their accent; everything else a curated creature pairing.
  const ctx: Ctx = { r, rarity, main: pair[0], acc: rarity === 3 ? 'gold' : pair[1] };
  const b = arch.build(ctx);
  const main = b.mainOverride ?? ctx.main;
  // An optional pattern over the main colour of a stamped item.
  if (b.px && arch.pats && chance(r, 0.25 + rarity * 0.15)) {
    const pat = pick(r, arch.pats),
      g = b.px,
      mid = Math.floor(g.w / 2);
    let changed = 0;
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++)
        if (g.at(x, y) === 'M' && patternOn(pat, x - mid, y)) {
          g.set(x, y, 'A');
          changed++;
        }
    if (changed) b.adj = PATTERN_ADJ[pat];
  }
  const name = cap(`${RNAME[main]} ${b.adj ? `${b.adj} ` : ''}${b.noun}`);
  const def: ItemDef = { slot, name, rarity, blurb: pick(r, arch.blurbs) };
  if (b.px) Object.assign(def, b.px.toMap(ramp(main), ramp(ctx.acc)));
  else if (b.kind && b.p) Object.assign(def, { kind: b.kind, p: b.p });
  if (slot === 'held') def.effect = { stat: b.stat ?? 'spd', pct: HELD_PCT[rarity] };
  return { arch, def };
}

/** Slots for a night: one of each, plus one more chosen by the seed. */
function slotsFor(r: Rng): Slot[] {
  const all: Slot[] = ['head', 'face', 'neck', 'body', 'held'];
  const extra = pick(r, ['head', 'neck', 'held', 'body'] as Slot[]);
  return [...all, extra].slice(0, ITEMS_PER_DAY);
}

export interface Existing {
  id: string;
  slot: Slot;
  look: Look;
  /** The day it was made; absent for the classics, which always count as recent. */
  day?: string;
  /** Its shop name. Two recent items may not share one, however different they look. */
  name?: string;
}
export interface Rejection {
  slot: Slot;
  name: string;
  nearest: string;
  distance: number;
}

/**
 * Generate a night's items. Each candidate is drawn on the mannequin and compared with
 * existing items in its slot (and tonight's earlier picks): recent ones and the classics at
 * the strict threshold, older ones at the floor. A recent item's name can't be reused either
 * (two "Cocoa tutu"s in a week read as the same thing). Near-duplicates are rejected and
 * another candidate is drawn from the same seeded stream; a slot that finds nothing is skipped.
 */
export function generateDay(seed: number, day: string, existing: Existing[]): { items: GenItem[]; rejected: Rejection[] } {
  const r = mulberry(seed ^ 0x5409);
  const items: GenItem[] = [];
  const rejected: Rejection[] = [];
  const since = Date.parse(`${day}T00:00:00Z`) - RECENT_DAYS * 86400e3;
  type Entry = { id: string; look: Look };
  const bySlot = (): Record<Slot, Entry[]> => ({ head: [], face: [], neck: [], body: [], held: [] });
  const pool = bySlot(),
    old = bySlot();
  const recentNames = new Map<string, string>();
  for (const e of existing) {
    const recent = !e.day || Date.parse(`${e.day}T00:00:00Z`) >= since;
    (recent ? pool : old)[e.slot].push(e);
    if (recent && e.name) recentNames.set(e.name.toLowerCase(), e.id);
  }
  const usedArch = new Set<string>();
  slotsFor(r).forEach((slot, i) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { arch, def } = candidate(r, slot, usedArch);
      def.day = day;
      const look = lookOf(def);
      if (!look.w) continue;
      const sameName = recentNames.get(def.name.toLowerCase());
      if (sameName) {
        rejected.push({ slot, name: def.name, nearest: sameName, distance: 0 });
        continue;
      }
      const near = nearDuplicate(look, pool[slot], MIN_ITEM_DISTANCE) ?? nearDuplicate(look, old[slot], MIN_DISTANCE_EVER);
      if (near) {
        rejected.push({ slot, name: def.name, nearest: near.id, distance: near.distance.pixel });
        continue;
      }
      const id = `g${day.replace(/-/g, '')}${'abcdefgh'[i]}`;
      const [lo, hi] = LEVEL_RANGE[def.rarity];
      const level = lo + Math.floor(r() * (hi - lo + 1));
      const price = basePrice(def.rarity, slot) + 5 * Math.floor(r() * 3);
      items.push({ id, day, arch: arch.id, def, level, price });
      pool[slot].push({ id, look });
      recentNames.set(def.name.toLowerCase(), id);
      usedArch.add(arch.id);
      break;
    }
  });
  // Something new a brand-new Forkling can buy and see: the first head, face or body common opens at level 1.
  // (Babies have no neck to wear things on and don't hold items, so those wouldn't show.)
  // On a night without such a common, the least rare one opens at level 1 instead.
  if (!items.some((i) => i.level <= 1 && BABY_SLOTS.has(i.def.slot))) {
    const c = items.filter((i) => BABY_SLOTS.has(i.def.slot)).sort((a, b) => a.def.rarity - b.def.rarity)[0];
    if (c) c.level = 1;
  }
  return { items, rejected };
}

/**
 * Pick older items to bring back: those not on the shelf in the last week, chosen by the
 * day's seed. `recent` holds ids shelved in that window.
 */
export function resurface(seed: number, catalogue: string[], recent: Set<string>, n = RESURFACED_PER_DAY): string[] {
  const r = mulberry(seed ^ 0xbac);
  const pool = catalogue.filter((id) => !recent.has(id)).sort();
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

/** The compact form a generated item is stored in (D1 `shop_items.def`): only what compose() and the shop need. */
export type StoredDef = Pick<ItemDef, 'slot' | 'name' | 'rarity' | 'blurb' | 'map' | 'cols' | 'kind' | 'p' | 'effect' | 'day'>;
export function storeDef(d: ItemDef): string {
  const s: StoredDef = { slot: d.slot, name: d.name, rarity: d.rarity, blurb: d.blurb, day: d.day };
  if (d.map) Object.assign(s, { map: d.map, cols: d.cols });
  if (d.kind) Object.assign(s, { kind: d.kind, p: d.p });
  if (d.effect) s.effect = d.effect;
  return JSON.stringify(s);
}
/** Parse a stored def. Written by storeDef, so it is trusted to be an ItemDef. */
export const loadDef = (s: string): ItemDef => JSON.parse(s) as ItemDef;
