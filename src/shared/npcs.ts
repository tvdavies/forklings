// House NPC players. They are ordinary player records (own Durable Object, hatched
// through the normal hatch path, normal battles) flagged npc = 1, with a persona.
import type { Tactics } from './strategy';

export interface NpcSpec {
  handle: string; persona: string; xp: number; rating: number;
  items: Partial<Record<'head' | 'face' | 'neck' | 'held', string>>; tactics: Tactics;
}

const P = {
  berserker: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 95, special: 'open', healAt: 0, style: 'reckless', ...o }),
  turtle: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 25, special: 'save', healAt: 60, style: 'steady', ...o }),
  tactician: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 60, special: 'save', healAt: 40, style: 'balanced', ...o }),
  medic: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 40, special: 'save', healAt: 60, style: 'balanced', ...o }),
  duelist: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 75, special: 'save', healAt: 25, style: 'steady', ...o }),
  chaos: (o: Partial<Tactics> = {}): Tactics => ({ aggression: 50, special: 'open', healAt: 40, style: 'reckless', ...o }),
};

export const NPC_ROSTER: NpcSpec[] = [
  { handle: 'npc-ada-lovebyte', persona: 'Tactician', xp: 520, rating: 1280, items: { head: 'crown', held: 'mug' }, tactics: P.tactician() },
  { handle: 'npc-segfault-sally', persona: 'Berserker', xp: 300, rating: 1210, items: { face: 'shades', held: 'keyboard' }, tactics: P.berserker() },
  { handle: 'npc-rubber-duck-dan', persona: 'Turtle', xp: 180, rating: 1100, items: { face: 'glasses', held: 'duck' }, tactics: P.turtle() },
  { handle: 'npc-yaml-wrangler', persona: 'All-rounder', xp: 90, rating: 1020, items: { head: 'beanie', held: 'mug' }, tactics: { aggression: 60, special: 'open', healAt: 25, style: 'balanced' } },
  { handle: 'npc-null-pointer-nell', persona: 'Glass cannon', xp: 60, rating: 980, items: { head: 'party' }, tactics: P.berserker({ aggression: 85 }) },
  { handle: 'npc-cache-miss-carl', persona: 'Medic', xp: 240, rating: 1060, items: { neck: 'scarf', held: 'mug' }, tactics: P.medic() },
  { handle: 'npc-merge-queen', persona: 'Duelist', xp: 700, rating: 1320, items: { head: 'crown', neck: 'bowtie', held: 'keyboard' }, tactics: P.duelist() },
  { handle: 'npc-flaky-test-fiona', persona: 'Chaos', xp: 140, rating: 1000, items: { head: 'cap' }, tactics: P.chaos() },
  { handle: 'npc-legacy-wizard', persona: 'Turtle', xp: 610, rating: 1180, items: { head: 'phones', held: 'duck' }, tactics: P.turtle({ aggression: 35, healAt: 40 }) },
  { handle: 'npc-hotfix-friday', persona: 'Berserker', xp: 30, rating: 940, items: { face: 'shades' }, tactics: P.berserker() },
  { handle: 'npc-tabs-not-spaces', persona: 'Pedant', xp: 400, rating: 1140, items: { face: 'glasses', neck: 'bowtie', held: 'mug' }, tactics: { aggression: 55, special: 'open', healAt: 25, style: 'steady' } },
  { handle: 'npc-sudo-sandwich', persona: 'Brawler', xp: 200, rating: 1050, items: { head: 'beanie', held: 'keyboard' }, tactics: { aggression: 70, special: 'open', healAt: 40, style: 'balanced' } },
  { handle: 'npc-midnight-owl', persona: 'Night shift', xp: 110, rating: 990, items: { head: 'phones' }, tactics: P.duelist({ style: 'reckless', aggression: 65 }) },
  { handle: 'npc-semver-bard', persona: 'Medic', xp: 330, rating: 1090, items: { head: 'party', neck: 'scarf', held: 'duck' }, tactics: P.medic({ aggression: 45, special: 'open', style: 'steady' }) },
];

export const npcPid = (handle: string) => 'npc:' + handle;
