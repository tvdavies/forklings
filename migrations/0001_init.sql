-- Cross-player data only. Everything private to a player lives in their Durable Object.
CREATE TABLE IF NOT EXISTS players (
  pid TEXT PRIMARY KEY,            -- gh:<github id> or demo:<random>
  handle TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,                    -- salted hash of the signup IP (demo accounts), for alt-farming checks
  has_creature INTEGER NOT NULL DEFAULT 0,
  name TEXT, seed TEXT,
  level INTEGER NOT NULL DEFAULT 1, stage INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT,                   -- public battle snapshot (stats come from the seed)
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_handle ON players(handle);
CREATE INDEX IF NOT EXISTS players_pool ON players(has_creature, level, rating);
CREATE INDEX IF NOT EXISTS players_rank ON players(has_creature, rating DESC);

CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL,
  challenger TEXT NOT NULL, defender TEXT NOT NULL, defender_bot INTEGER NOT NULL,
  winner INTEGER, seed TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS battles_pair ON battles(challenger, defender, at);
CREATE INDEX IF NOT EXISTS battles_def ON battles(defender, at);

CREATE TABLE IF NOT EXISTS api_tokens (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, pid TEXT NOT NULL, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_pid ON api_tokens(pid);

CREATE TABLE IF NOT EXISTS demo_signups (ip_hash TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip_hash, day));
