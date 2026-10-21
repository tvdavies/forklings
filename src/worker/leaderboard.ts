// The leaderboard, read from D1: ranked players, the house NPCs and the practice
// bracket as three lists, plus the viewer's own place when they're logged in.

/** One public leaderboard row. No pid: the leaderboard only ever shows handles. */
export interface LeaderRow {
  handle: string;
  verified: number;
  npc: number;
  persona: string | null;
  name: string;
  seed: string | null;
  level: number;
  stage: number;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  xp: number;
}

/**
 * The viewer's own row. A ranked player gets their place among ranked players (NPCs
 * aside) and how many there are. Anyone else is in the practice bracket: `reason` says
 * why (`github`: a demo login, `age`: a GitHub account under the minimum age), and
 * `rankedAt` says when ranked play opens, if we know the account's age.
 */
export type MyPlace = LeaderRow &
  ({ ranked: true; rank: number; of: number } | { ranked: false; reason: 'github' | 'age'; rankedAt: number | null });

export interface Leaderboard {
  /** Ranked players, NPCs aside, best first. */
  players: LeaderRow[];
  /** House NPCs, best first. They share the ranked ladder but are listed apart. */
  npcs: LeaderRow[];
  /** The practice bracket: demo players and newer GitHub accounts, by wins. */
  unranked: LeaderRow[];
  me: MyPlace | null;
}

export interface LeaderboardQuery {
  /** SQL condition for "may play ranked", with one `?` parameter: the account-age cutoff. */
  rankedSql: string;
  /** SQL condition for the rows the leaderboard may show (NPCs only while they're on). */
  visibleSql: string;
  minAccountAgeMs: number;
  now: number;
  /** The viewer, or null when nobody is logged in. */
  pid: string | null;
}

export const LEADERBOARD_LIMIT = 50;
const COLS = 'handle, verified, npc, persona, name, seed, level, stage, rating, wins, losses, draws, xp';
// pid breaks the last ties, so a list's order and the viewer's rank always agree.
const RANKED_ORDER = 'ORDER BY rating DESC, wins DESC, xp DESC, pid';

type MeRow = LeaderRow & { pid: string; gh_created_at: number | null; ranked: number };
type PlaceRow = { ahead: number | null; total: number };

export async function leaderboard(db: D1Database, q: LeaderboardQuery): Promise<Leaderboard> {
  const cutoff = q.now - q.minAccountAgeMs;
  const ranked = q.rankedSql.replace('?', '?1');
  const list = (where: string, order: string) =>
    db
      .prepare(`SELECT ${COLS} FROM players WHERE has_creature = 1 AND ${where} ${order} LIMIT ${LEADERBOARD_LIMIT}`)
      .bind(cutoff)
      .all<LeaderRow>()
      .then((r) => r.results || []);
  const [players, npcs, unranked, me] = await Promise.all([
    list(`npc = 0 AND ${ranked}`, RANKED_ORDER),
    list(`npc = 1 AND ${q.visibleSql} AND ${ranked}`, RANKED_ORDER),
    list(`${q.visibleSql} AND NOT ${ranked}`, 'ORDER BY wins DESC, xp DESC, pid'),
    q.pid ? myPlace(db, q.pid, ranked, cutoff, q.minAccountAgeMs) : null,
  ]);
  return { players, npcs, unranked, me };
}

async function myPlace(db: D1Database, pid: string, ranked: string, cutoff: number, minAgeMs: number): Promise<MyPlace | null> {
  const row = await db
    .prepare(`SELECT ${COLS}, pid, gh_created_at, ${ranked} AS ranked FROM players WHERE pid = ?2 AND has_creature = 1 AND npc = 0`)
    .bind(cutoff, pid)
    .first<MeRow>();
  if (!row) return null;
  const { pid: _pid, gh_created_at, ranked: isRanked, ...pub } = row;
  if (!isRanked) {
    return pub.verified
      ? { ...pub, ranked: false, reason: 'age', rankedAt: gh_created_at === null ? null : gh_created_at + minAgeMs }
      : { ...pub, ranked: false, reason: 'github', rankedAt: null };
  }
  // Ranked players ahead of this one, in the same order as the ranked list.
  const place = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN rating > ?2 OR (rating = ?2 AND (wins > ?3 OR (wins = ?3 AND (xp > ?4 OR (xp = ?4 AND pid < ?5)))))
         THEN 1 ELSE 0 END) AS ahead
       FROM players WHERE has_creature = 1 AND npc = 0 AND ${ranked}`,
    )
    .bind(cutoff, pub.rating, pub.wins, pub.xp, pid)
    .first<PlaceRow>();
  return { ...pub, ranked: true, rank: (place?.ahead ?? 0) + 1, of: place?.total ?? 1 };
}
