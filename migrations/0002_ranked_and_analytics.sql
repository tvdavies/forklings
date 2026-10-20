-- Ranked play needs a GitHub account at least 30 days old; demo players fight bots, unranked.
ALTER TABLE players ADD COLUMN gh_created_at INTEGER;   -- GitHub account creation (ms), stored at login

-- Every battle, compact and queryable for balancing.
ALTER TABLE battles ADD COLUMN ranked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE battles ADD COLUMN rounds INTEGER;
ALTER TABLE battles ADD COLUMN sim_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE battles ADD COLUMN snap_a TEXT;              -- challenger snapshot: stats seed, gear, tactics, strategy
ALTER TABLE battles ADD COLUMN snap_b TEXT;              -- defender snapshot
ALTER TABLE battles ADD COLUMN turns TEXT;               -- per-turn summary, see turnSummary() in src/shared/battle.ts
CREATE INDEX IF NOT EXISTS battles_at ON battles(at);

-- One row per side: who fought with what, and whether it won (1 win, 0 loss, NULL draw).
CREATE TABLE IF NOT EXISTS battle_sides (
  battle_id TEXT NOT NULL, side INTEGER NOT NULL, pid TEXT NOT NULL, bot INTEGER NOT NULL, ranked INTEGER NOT NULL,
  won INTEGER, level INTEGER NOT NULL, stage INTEGER NOT NULL, type TEXT NOT NULL,
  head TEXT, face TEXT, neck TEXT, held TEXT,
  strategy_source TEXT NOT NULL, style TEXT NOT NULL, special TEXT, heal_at INTEGER, aggression INTEGER,
  max_hp INTEGER NOT NULL, hp_left INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (battle_id, side)
);
CREATE INDEX IF NOT EXISTS battle_sides_held ON battle_sides(held, won);
CREATE INDEX IF NOT EXISTS battle_sides_style ON battle_sides(style, won);

-- One row per move used by a side in a battle.
CREATE TABLE IF NOT EXISTS battle_moves (
  battle_id TEXT NOT NULL, side INTEGER NOT NULL, move TEXT NOT NULL, kind TEXT NOT NULL,
  uses INTEGER NOT NULL, hits INTEGER NOT NULL, crits INTEGER NOT NULL, misses INTEGER NOT NULL, dmg INTEGER NOT NULL, heal INTEGER NOT NULL,
  PRIMARY KEY (battle_id, side, move)
);
CREATE INDEX IF NOT EXISTS battle_moves_move ON battle_moves(move);
