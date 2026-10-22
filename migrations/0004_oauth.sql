-- OAuth 2.1 for MCP clients (Claude Code, Codex, Pi). @cloudflare/workers-oauth-provider
-- keeps its clients, grants, tokens and consent transactions in a key-value store; this
-- table is that store (see src/worker/d1kv.ts), so no KV namespace is needed.
-- Secrets are stored only as hashes and props are encrypted by the library itself.
-- WITHOUT ROWID: the key is the primary index, so each write touches one row and no extra
-- index. Expired rows are ignored on read and swept hourly by the cron.
CREATE TABLE IF NOT EXISTS oauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  metadata TEXT,              -- JSON, KV key metadata (the library lists grants by it)
  expires_at INTEGER          -- unix seconds; NULL never expires
) WITHOUT ROWID;
