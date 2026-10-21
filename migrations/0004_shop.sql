-- The shop: generated items, each day's shelf, and an analytics copy of the bits ledger.
-- Wallets themselves live in each player's Durable Object (authoritative); D1 holds only
-- what is shared between players or needed for balancing. See docs/economy.md.

-- Every item the nightly generator has made. `def` is the compact drawing compose() needs
-- (a pixel map, or a few parameters); `look` its worn silhouette for the distinctness check.
CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,                -- g<yyyymmdd><a-h>, e.g. g20261021a
  day TEXT NOT NULL,                  -- UTC day it was made
  slot TEXT NOT NULL,
  arch TEXT NOT NULL,                 -- archetype, e.g. beanie, lens, cape
  rarity INTEGER NOT NULL,
  level INTEGER NOT NULL,             -- level needed to buy
  price INTEGER NOT NULL,             -- in bits
  gen_version INTEGER NOT NULL,
  def TEXT NOT NULL,
  look TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_items_slot ON shop_items(slot, day);

-- One row per UTC day: what was on the shelf, and how generation went.
CREATE TABLE IF NOT EXISTS shop_days (
  day TEXT PRIMARY KEY,
  items TEXT NOT NULL,                -- JSON: [{ "id": "...", "tag": "new" | "back" }]
  made INTEGER NOT NULL,              -- new items generated
  rejected INTEGER NOT NULL,          -- candidates refused as near-duplicates
  short INTEGER NOT NULL,             -- slots that found nothing distinct enough
  ms INTEGER NOT NULL,                -- generation time
  at INTEGER NOT NULL
);

-- A copy of each ledger entry, for economy balancing (faucets and sinks per day).
-- Written after the Durable Object commits; INSERT OR IGNORE on (pid, key) makes resends harmless.
CREATE TABLE IF NOT EXISTS bits_events (
  pid TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
  kind TEXT NOT NULL, delta INTEGER NOT NULL, ref TEXT NOT NULL, balance INTEGER NOT NULL,
  npc INTEGER NOT NULL DEFAULT 0,     -- house NPC: leave out of balancing with WHERE npc = 0
  PRIMARY KEY (pid, key)
);
CREATE INDEX IF NOT EXISTS bits_events_day ON bits_events(day, kind, npc);

-- The new body slot (capes, wings, backpacks and clothes) in the per-battle analytics.
ALTER TABLE battle_sides ADD COLUMN body TEXT;
