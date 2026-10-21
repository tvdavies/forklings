import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { limitRegistration, REGISTER_PERIOD_S } from '../../src/worker/ratelimit';

/** An in-memory stand-in for the Workers Rate Limiting binding: `limit` calls per key. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const binding: RateLimit = {
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
  return { binding, keys };
}

const register = (ip: string | null, method = 'POST') =>
  new Request('https://forklings.dev/oauth/register', {
    method,
    headers: ip ? { 'cf-connecting-ip': ip, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });

describe('client registration rate limit', () => {
  test('lets registrations through up to the limit, then answers 429 with Retry-After', async () => {
    const { binding } = limiter(3);
    for (let i = 0; i < 3; i++) expect(await limitRegistration(register('203.0.113.7'), binding)).toBeNull();
    const res = await limitRegistration(register('203.0.113.7'), binding);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBe(String(REGISTER_PERIOD_S));
    expect(res?.headers.get('cache-control')).toBe('no-store');
    const body = (await res?.json()) as { error: string; error_description: string };
    expect(body.error).toBe('too_many_requests');
    expect(body.error_description).toContain(`${REGISTER_PERIOD_S} seconds`);
  });

  test('counts each client IP separately', async () => {
    const { binding, keys } = limiter(1);
    expect(await limitRegistration(register('203.0.113.7'), binding)).toBeNull();
    expect(await limitRegistration(register('198.51.100.2'), binding)).toBeNull();
    expect((await limitRegistration(register('203.0.113.7'), binding))?.status).toBe(429);
    expect(keys).toEqual(['oauth-register|203.0.113.7', 'oauth-register|198.51.100.2', 'oauth-register|203.0.113.7']);
  });

  test('only POST counts against the limit', async () => {
    const { binding, keys } = limiter(0);
    expect(await limitRegistration(register('203.0.113.7', 'GET'), binding)).toBeNull();
    expect(keys).toEqual([]);
  });

  test('fails open without a binding or when the limiter throws', async () => {
    expect(await limitRegistration(register('203.0.113.7'), undefined)).toBeNull();
    const broken: RateLimit = {
      async limit() {
        throw new Error('limiter unavailable');
      },
    };
    const err = console.error;
    console.error = () => {};
    try {
      expect(await limitRegistration(register('203.0.113.7'), broken)).toBeNull();
    } finally {
      console.error = err;
    }
  });

  test('a request without a client IP still shares one bucket', async () => {
    const { binding, keys } = limiter(5);
    await limitRegistration(register(null), binding);
    expect(keys).toEqual(['oauth-register|unknown']);
  });

  test('the period matches the binding in wrangler.jsonc', () => {
    const cfg = readFileSync('wrangler.jsonc', 'utf8');
    const m = cfg.match(/"name":\s*"REGISTER_LIMITER"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m?.[2])).toBe(REGISTER_PERIOD_S);
    expect(Number(m?.[1])).toBe(10);
  });
});
