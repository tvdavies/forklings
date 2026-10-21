import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEADERBOARD_LIMIT, type LeaderboardQuery, leaderboard } from '../../src/worker/leaderboard';

// The leaderboard queries, run against the real migrations in an in-memory SQLite
// database behind a minimal D1-shaped wrapper.
type Bind = string | number | null;
function d1(db: Database): D1Database {
  const stmt = (sql: string, args: Bind[] = []) => ({
    bind: (...a: Bind[]) => stmt(sql, a),
    all: async () => ({ results: db.query(sql).all(...args) }),
    first: async () => db.query(sql).get(...args) ?? null,
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const DAY = 86400e3;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MIN_AGE = 30 * DAY;
// The same conditions as rankedSql() and visibleSql() in src/worker/index.ts.
const RANKED_NPCS_ON = '(npc = 1 OR (verified = 1 AND gh_created_at IS NOT NULL AND gh_created_at <= ?))';
const RANKED_NPCS_OFF = '((verified = 1 AND gh_created_at IS NOT NULL AND gh_created_at <= ?))';
const VISIBLE_NPCS_ON = '(verified = 1 OR npc = 1)';
const VISIBLE_NPCS_OFF = '(verified = 1 AND npc = 0)';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
});

interface Seed {
  pid: string;
  verified?: number;
  ghAgeDays?: number | null;
  npc?: number;
  rating?: number;
  wins?: number;
  losses?: number;
  xp?: number;
  hatched?: number;
}
function add(p: Seed) {
  const gh = p.ghAgeDays === undefined || p.ghAgeDays === null ? null : NOW - p.ghAgeDays * DAY;
  db.query(
    `INSERT INTO players (pid, handle, verified, created_at, updated_at, has_creature, name, seed, level, stage, xp, rating, wins, losses, npc, gh_created_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, 'seed', 3, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.pid,
    p.pid.split(':')[1],
    p.verified ?? 0,
    p.hatched ?? 1,
    `Pet ${p.pid}`,
    p.xp ?? 0,
    p.rating ?? 1000,
    p.wins ?? 0,
    p.losses ?? 0,
    p.npc ?? 0,
    gh,
  );
}
const veteran = (pid: string, o: Partial<Seed> = {}) => add({ pid, verified: 1, ghAgeDays: 400, ...o });
const query = (pid: string | null, npcs = true): LeaderboardQuery => ({
  rankedSql: npcs ? RANKED_NPCS_ON : RANKED_NPCS_OFF,
  visibleSql: npcs ? VISIBLE_NPCS_ON : VISIBLE_NPCS_OFF,
  minAccountAgeMs: MIN_AGE,
  now: NOW,
  pid,
});
const handles = (rows: { handle: string }[]) => rows.map((r) => r.handle);

describe('leaderboard lists', () => {
  test('players, NPCs and the practice bracket each get their own list', async () => {
    veteran('gh:ana', { rating: 1100 });
    veteran('gh:bo', { rating: 1200 });
    add({ pid: 'npc:queen', npc: 1, rating: 1320 });
    add({ pid: 'gh:newbie', verified: 1, ghAgeDays: 5, wins: 2 });
    const r = await leaderboard(d1(db), query(null));
    expect(handles(r.players)).toEqual(['bo', 'ana']);
    expect(handles(r.npcs)).toEqual(['queen']);
    expect(handles(r.unranked)).toEqual(['newbie']);
    expect(r.me).toBeNull();
  });

  test('rows left from the retired demo sign-in are never listed', async () => {
    add({ pid: 'demo:pip', wins: 9 });
    veteran('gh:ana');
    for (const npcs of [true, false]) {
      const r = await leaderboard(d1(db), query(null, npcs));
      expect(handles([...r.players, ...r.npcs, ...r.unranked])).toEqual(['ana']);
    }
  });

  test('rows carry no verified flag', async () => {
    veteran('gh:ana');
    const r = await leaderboard(d1(db), query('gh:ana'));
    expect(Object.keys(r.players[0])).not.toContain('verified');
    expect(Object.keys(r.me ?? {})).not.toContain('verified');
  });

  test('rows never include a pid', async () => {
    veteran('gh:ana');
    const r = await leaderboard(d1(db), query('gh:ana'));
    expect(Object.keys(r.players[0])).not.toContain('pid');
    expect(Object.keys(r.me ?? {})).not.toContain('pid');
    expect(Object.keys(r.me ?? {})).not.toContain('gh_created_at');
  });

  test('players without a Forkling are left out', async () => {
    veteran('gh:ana', { hatched: 0 });
    const r = await leaderboard(d1(db), query('gh:ana'));
    expect(r.players).toEqual([]);
    expect(r.me).toBeNull();
  });

  test('with NPCs off, none are listed', async () => {
    add({ pid: 'npc:queen', npc: 1, rating: 1320 });
    veteran('gh:ana');
    const r = await leaderboard(d1(db), query(null, false));
    expect(r.npcs).toEqual([]);
    expect(handles(r.unranked)).toEqual([]);
    expect(handles(r.players)).toEqual(['ana']);
  });
});

describe('your place', () => {
  test('a ranked player gets their rank among players, NPCs aside', async () => {
    add({ pid: 'npc:queen', npc: 1, rating: 1320 });
    veteran('gh:bo', { rating: 1200 });
    veteran('gh:ana', { rating: 1100, wins: 4, losses: 1 });
    veteran('gh:cy', { rating: 900 });
    const r = await leaderboard(d1(db), query('gh:ana'));
    expect(r.me).toMatchObject({ handle: 'ana', ranked: true, rank: 2, of: 3, rating: 1100, wins: 4, losses: 1 });
  });

  test('ties break the same way as the list', async () => {
    veteran('gh:b', { rating: 1000, wins: 2, xp: 50 });
    veteran('gh:a', { rating: 1000, wins: 2, xp: 50 });
    veteran('gh:c', { rating: 1000, wins: 2, xp: 60 });
    veteran('gh:d', { rating: 1000, wins: 3, xp: 0 });
    const r = await leaderboard(d1(db), query(null));
    const order = handles(r.players);
    expect(order).toEqual(['d', 'c', 'a', 'b']);
    for (const [i, h] of order.entries()) {
      const mine = await leaderboard(d1(db), query(`gh:${h}`));
      expect(mine.me).toMatchObject({ ranked: true, rank: i + 1, of: 4 });
    }
  });

  test('your rank still shows when you are below the top of the list', async () => {
    for (let i = 0; i < LEADERBOARD_LIMIT + 5; i++) veteran(`gh:p${i}`, { rating: 2000 - i });
    veteran('gh:last', { rating: 100 });
    const r = await leaderboard(d1(db), query('gh:last'));
    expect(r.players).toHaveLength(LEADERBOARD_LIMIT);
    expect(handles(r.players)).not.toContain('last');
    expect(r.me).toMatchObject({ ranked: true, rank: LEADERBOARD_LIMIT + 6, of: LEADERBOARD_LIMIT + 6 });
  });

  test('a retired demo row gets no place', async () => {
    add({ pid: 'demo:pip', wins: 1 });
    const r = await leaderboard(d1(db), query('demo:pip'));
    expect(r.me).toBeNull();
  });

  test('a new GitHub account is told when ranked play opens', async () => {
    add({ pid: 'gh:newbie', verified: 1, ghAgeDays: 18 });
    const r = await leaderboard(d1(db), query('gh:newbie'));
    expect(r.me).toMatchObject({ ranked: false, rankedAt: NOW + 12 * DAY });
  });

  test('a GitHub account of unknown age stays in practice', async () => {
    add({ pid: 'gh:old-row', verified: 1, ghAgeDays: null });
    const r = await leaderboard(d1(db), query('gh:old-row'));
    expect(r.me).toMatchObject({ ranked: false, rankedAt: null });
  });

  test('an account turns ranked on its 30th day', async () => {
    add({ pid: 'gh:today', verified: 1, ghAgeDays: 30 });
    const r = await leaderboard(d1(db), query('gh:today'));
    expect(r.me).toMatchObject({ ranked: true, rank: 1, of: 1 });
  });
});
