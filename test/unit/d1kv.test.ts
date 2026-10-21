import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { D1KV } from '../../src/worker/d1kv';
import { approvedScopes, DEFAULT_SCOPES, effectiveScopes, isAuthorizeReturn, oauthUserId } from '../../src/worker/scopes';

/** Just enough of D1 over bun:sqlite for D1KV: prepare, bind, first, all, run. */
function d1(db: Database): D1Database {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) {
        args = a;
        return stmt;
      },
      async first<T>() {
        return (db.query(sql).get(...(args as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: db.query(sql).all(...(args as never[])) as T[] };
      },
      async run() {
        const r = db.query(sql).run(...(args as never[]));
        return { meta: { changes: r.changes } };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

let now = Date.UTC(2026, 9, 21);
let kv: D1KV;
beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(readFileSync('migrations/0004_oauth.sql', 'utf8'));
  now = Date.UTC(2026, 9, 21);
  kv = new D1KV(d1(db), () => now);
});

describe('D1KV, the KV slice the OAuth library uses', () => {
  test('get returns text, JSON or null', async () => {
    await kv.put('client:a', '{"x":1}');
    expect(await kv.get('client:a')).toBe('{"x":1}');
    expect(await kv.get('client:a', { type: 'json' })).toEqual({ x: 1 });
    expect(await kv.get('client:a', 'json')).toEqual({ x: 1 });
    expect(await kv.get('missing', { type: 'json' })).toBeNull();
  });

  test('put replaces the value, metadata and expiry together', async () => {
    await kv.put('k', 'one', { expirationTtl: 60, metadata: { a: 1 } });
    await kv.put('k', 'two');
    expect(await kv.get('k')).toBe('two');
    const { keys } = await kv.list({ prefix: 'k' });
    expect(keys).toEqual([{ name: 'k' }]);
  });

  test('expired keys vanish from get and list, and purge removes them', async () => {
    await kv.put('token:u:g:1', 'a', { expirationTtl: 60 });
    await kv.put('token:u:g:2', 'b', { expiration: Math.floor(now / 1000) + 3600 });
    now += 61_000;
    expect(await kv.get('token:u:g:1')).toBeNull();
    expect((await kv.list({ prefix: 'token:u:' })).keys.map((k) => k.name)).toEqual(['token:u:g:2']);
    expect(await kv.purgeExpired()).toBe(1);
  });

  test('delete removes a key', async () => {
    await kv.put('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  test('list is prefix-bounded, ordered, and pages with a cursor', async () => {
    for (const n of ['grant:u1:c', 'grant:u1:a', 'grant:u1:b', 'grant:u10:z', 'grant:u2:a', 'grant;x'])
      await kv.put(n, '1', { metadata: { n } });
    const first = await kv.list({ prefix: 'grant:u1:', limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(['grant:u1:a', 'grant:u1:b']);
    expect(first.keys[0].metadata).toEqual({ n: 'grant:u1:a' });
    expect(first.list_complete).toBe(false);
    const rest = await kv.list({ prefix: 'grant:u1:', limit: 2, cursor: first.cursor });
    expect(rest.keys.map((k) => k.name)).toEqual(['grant:u1:c']);
    expect(rest.list_complete).toBe(true);
    expect(rest.cursor).toBeUndefined();
  });

  test('list treats LIKE wildcards in a prefix literally', async () => {
    await kv.put('a_b', '1');
    await kv.put('axb', '1');
    await kv.put('a%c', '1');
    expect((await kv.list({ prefix: 'a_' })).keys.map((k) => k.name)).toEqual(['a_b']);
    expect((await kv.list({ prefix: 'a%' })).keys.map((k) => k.name)).toEqual(['a%c']);
  });

  test('list reports expiry like KV', async () => {
    const at = Math.floor(now / 1000) + 600;
    await kv.put('t', '1', { expiration: at });
    expect((await kv.list()).keys).toEqual([{ name: 't', expiration: at }]);
  });

  test('non-string values and unsupported read types are refused', async () => {
    await expect(kv.put('k', new ArrayBuffer(1))).rejects.toThrow();
    await expect(kv.get('k', { type: 'stream' })).rejects.toThrow();
  });
});

describe('OAuth scopes and identities', () => {
  test('strategy:write implies strategy:read', () => {
    expect([...effectiveScopes(['strategy:write'])].sort()).toEqual(['strategy:read', 'strategy:write']);
    expect([...effectiveScopes(['pet:read', 'offline_access', 'admin'])]).toEqual(['pet:read']);
  });

  test('the default request covers every tool and not battle:simulate', () => {
    expect(DEFAULT_SCOPES).not.toContain('battle:simulate');
    expect(DEFAULT_SCOPES).toContain('strategy:write');
  });

  test('approved scopes drop unknowns and always keep pet:read', () => {
    expect(approvedScopes(['pet:care', 'admin', 'offline_access']).sort()).toEqual(['offline_access', 'pet:care', 'pet:read']);
  });

  test("player IDs are made safe for the library, which splits on ':'", () => {
    expect(oauthUserId('gh:12345')).toBe('gh%3A12345');
    expect(oauthUserId('demo:abc')).not.toContain(':');
  });

  test('sign-in only returns to this site’s /authorize', () => {
    expect(isAuthorizeReturn('/authorize?response_type=code&client_id=x')).toBe(true);
    for (const bad of [
      '//evil.example/authorize?x',
      'https://evil.example/authorize?x',
      '/authorize',
      '/\\evil.example',
      '/authorize?a b',
      null,
    ])
      expect(isAuthorizeReturn(bad)).toBe(false);
  });
});
