// The slice of the Workers KV API that @cloudflare/workers-oauth-provider uses (get as text
// or JSON, put with an expiry and key metadata, delete, and prefix listing with cursors),
// backed by the D1 table `oauth_kv` (migrations/0004_oauth.sql) instead of a KV namespace.
//
// Why: KV writes cost $5 a million and every token refresh writes twice, which made KV the
// biggest line in the architecture proposal's cost model. D1 rows written are $1 a million
// with 50 million included, rows read are nearly free, and D1 is strongly consistent, so a
// revoked token stops working at once instead of after KV's cache window.
//
// The library reaches storage only through `env.OAUTH_KV`, so this is passed in its place.
// test/unit/d1kv.test.ts checks the semantics the library relies on.
import { prop } from '../shared/json';

export interface KvPutOptions {
  /** Absolute expiry, unix seconds. */
  expiration?: number;
  /** Expiry relative to now, seconds. */
  expirationTtl?: number;
  metadata?: unknown;
}
export interface KvListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}
export interface KvListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}
export interface KvListResult {
  keys: KvListKey[];
  list_complete: boolean;
  cursor?: string;
  cacheStatus: null;
}

type ValueRow = { value: string };
type KeyRow = { key: string; metadata: string | null; expires_at: number | null };

const MAX_LIST = 1000;

/** The smallest string greater than every string that starts with `prefix`, or null if there's no simple one. */
function prefixEnd(prefix: string): string | null {
  const last = prefix.charCodeAt(prefix.length - 1);
  // Keys the library writes are ASCII. Bumping a non-ASCII last character could step over
  // UTF-8 byte order, so those prefixes fall back to a substr() filter instead.
  if (!prefix || last >= 0x7f) return null;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export class D1KV {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  private nowSec() {
    return Math.floor(this.now() / 1000);
  }

  async get(key: string, options?: unknown): Promise<unknown> {
    const type = typeof options === 'string' ? options : prop(options, 'type');
    if (type !== undefined && type !== 'text' && type !== 'json') throw new TypeError(`D1KV.get: unsupported type ${String(type)}`);
    const row = await this.db
      .prepare('SELECT value FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(key, this.nowSec())
      .first<ValueRow>();
    if (!row) return null;
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: unknown, options: KvPutOptions = {}): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('D1KV.put: only string values are supported');
    const expires = options.expiration ?? (options.expirationTtl !== undefined ? this.nowSec() + options.expirationTtl : null);
    // Like KV, a put replaces the value, the metadata and the expiry together.
    await this.db
      .prepare(
        'INSERT INTO oauth_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at',
      )
      .bind(key, value, options.metadata === undefined ? null : JSON.stringify(options.metadata), expires)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_kv WHERE key = ?').bind(key).run();
  }

  /** Keys in byte order, like KV. The cursor is the last key returned. */
  async list(options: KvListOptions = {}): Promise<KvListResult> {
    const prefix = options.prefix ?? '';
    const limit = Math.min(Math.max(Math.floor(options.limit ?? MAX_LIST), 1), MAX_LIST);
    const where = ['(expires_at IS NULL OR expires_at > ?1)'];
    const args: (string | number)[] = [this.nowSec()];
    const arg = (v: string | number) => {
      args.push(v);
      return `?${args.length}`;
    };
    if (options.cursor) where.push(`key > ${arg(options.cursor)}`);
    if (prefix) {
      where.push(`key >= ${arg(prefix)}`);
      const end = prefixEnd(prefix);
      where.push(end ? `key < ${arg(end)}` : `substr(key, 1, ${arg(prefix.length)}) = ${arg(prefix)}`);
    }
    const sql = `SELECT key, metadata, expires_at FROM oauth_kv WHERE ${where.join(' AND ')} ORDER BY key LIMIT ${arg(limit + 1)}`;
    const rows = (
      await this.db
        .prepare(sql)
        .bind(...args)
        .all<KeyRow>()
    ).results;
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires_at !== null ? { expiration: r.expires_at } : {}),
        ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as unknown } : {}),
      })),
      list_complete: !more,
      ...(more ? { cursor: page[page.length - 1].key } : {}),
      cacheStatus: null,
    };
  }

  /** Delete expired rows. KV does this itself; here the cron calls it. Returns the rows removed. */
  async purgeExpired(): Promise<number> {
    const r = await this.db.prepare('DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(this.nowSec()).run();
    return r.meta.changes ?? 0;
  }

  /** This store, typed as the KV binding the OAuth library expects. */
  asKVNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
