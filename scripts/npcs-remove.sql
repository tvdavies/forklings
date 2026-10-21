-- Remove the house NPC players and every battle they took part in.
-- First set "NPCS": "off" in wrangler.jsonc and deploy, or the cron reseeds them.
--   npx wrangler d1 execute forklings-db --remote --file scripts/npcs-remove.sql
-- Each NPC's Durable Object keeps its own small SQLite store; nothing reads it once
-- the D1 rows are gone, and an idle Durable Object costs nothing.
DELETE FROM battle_moves WHERE battle_id IN (SELECT id FROM battles WHERE npc = 1);
DELETE FROM battle_sides WHERE battle_id IN (SELECT id FROM battles WHERE npc = 1);
DELETE FROM battles WHERE npc = 1;
DELETE FROM players WHERE npc = 1;
