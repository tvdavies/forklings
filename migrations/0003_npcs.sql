-- House NPC players: real player records driven by the cron, clearly flagged so they
-- can be hidden, removed (scripts/npcs-remove.sql) or filtered out of balancing analytics.
ALTER TABLE players ADD COLUMN npc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN persona TEXT;
ALTER TABLE battles ADD COLUMN npc INTEGER NOT NULL DEFAULT 0;        -- 1 if either side is an NPC
ALTER TABLE battle_sides ADD COLUMN npc INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS players_npc ON players(npc);
