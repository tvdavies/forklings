import { describe, expect, test } from 'bun:test';
import { isGithubPid, signSession, verifySession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { githubIdentity } from '../../src/worker/github';

const env = { SESSION_SECRET: 'test-secret', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'shh' } as unknown as Env;
const later = () => Date.now() + 60_000;

describe('sessions', () => {
  test('only GitHub player ids can sign in', () => {
    expect(isGithubPid('gh:583231')).toBe(true);
    for (const pid of ['demo:abc123', 'npc:pixel-pat', 'bot:x', 'gh:', 'gh:12a', 'gh:12 ', '', null, 12])
      expect(isGithubPid(pid)).toBe(false);
  });

  test('a GitHub session round-trips', async () => {
    const token = await signSession(env, { pid: 'gh:42', h: 'octocat', exp: later() });
    expect(await verifySession(env, token)).toMatchObject({ pid: 'gh:42', h: 'octocat' });
  });

  test('sessions from retired sign-ins are refused, even when signed correctly', async () => {
    const legacy = { pid: 'demo:abc123', h: 'someone', v: false, exp: later() };
    expect(await verifySession(env, await signSession(env, legacy))).toBeNull();
  });

  test('expired, tampered and malformed sessions are refused', async () => {
    expect(await verifySession(env, await signSession(env, { pid: 'gh:42', h: 'octocat', exp: Date.now() - 1 }))).toBeNull();
    const token = await signSession(env, { pid: 'gh:42', h: 'octocat', exp: later() });
    expect(await verifySession({ ...env, SESSION_SECRET: 'other' }, token)).toBeNull();
    expect(await verifySession(env, `${token.slice(0, -2)}xx`)).toBeNull();
    expect(await verifySession(env, 'nonsense')).toBeNull();
    expect(await verifySession(env, null)).toBeNull();
  });
});

describe('GitHub callback', () => {
  const REDIRECT = 'https://forklings.test/auth/github/callback';
  const callback = (query: string, state: string | null = 'st8') =>
    new Request(`https://forklings.test/auth/github/callback?${query}`, { headers: state ? { cookie: `fk_oauth=${state}` } : {} });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  /** A fake GitHub: answers the token exchange, then the user lookup. */
  const github = (
    token: () => Response,
    user: () => Response = () => json({ id: 583231, login: 'OctoCat', created_at: '2011-01-25T18:44:36Z' }),
  ) => (async (input: RequestInfo | URL) => (String(input).includes('access_token') ? token() : user())) as typeof fetch;
  const ok = github(() => json({ access_token: 'gho_x' }));

  test('a good callback gives a GitHub player and their account age', async () => {
    const r = await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, ok);
    expect(r).toEqual({ ok: true, pid: 'gh:583231', handle: 'octocat', createdAt: Date.parse('2011-01-25T18:44:36Z') });
  });

  test('without an OAuth app it says so', async () => {
    const r = await githubIdentity(callback('code=c0de&state=st8'), { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }, REDIRECT, ok);
    expect(r).toEqual({ ok: false, reason: 'unconfigured' });
  });

  test('cancelling on GitHub reads as denied; other GitHub errors as failed', async () => {
    expect(await githubIdentity(callback('error=access_denied&state=st8'), env, REDIRECT, ok)).toEqual({ ok: false, reason: 'denied' });
    expect(await githubIdentity(callback('error=redirect_uri_mismatch&state=st8'), env, REDIRECT, ok)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  test('a missing or mismatched state reads as expired', async () => {
    expect(await githubIdentity(callback('code=c0de&state=st8', null), env, REDIRECT, ok)).toEqual({ ok: false, reason: 'expired' });
    expect(await githubIdentity(callback('code=c0de&state=other'), env, REDIRECT, ok)).toEqual({ ok: false, reason: 'expired' });
    expect(await githubIdentity(callback('state=st8'), env, REDIRECT, ok)).toEqual({ ok: false, reason: 'expired' });
  });

  test('a used or stale code reads as expired; other refusals as failed', async () => {
    const stale = github(() => json({ error: 'bad_verification_code' }));
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, stale)).toEqual({ ok: false, reason: 'expired' });
    const refused = github(() => json({ error: 'incorrect_client_credentials' }));
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, refused)).toEqual({ ok: false, reason: 'failed' });
  });

  test('GitHub being down or unreachable reads as unavailable', async () => {
    const down = github(() => json({}, 503));
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, down)).toEqual({ ok: false, reason: 'unavailable' });
    const userDown = github(
      () => json({ access_token: 'gho_x' }),
      () => json({}, 502),
    );
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, userDown)).toEqual({ ok: false, reason: 'unavailable' });
    const offline = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, offline)).toEqual({ ok: false, reason: 'unavailable' });
  });

  test('an unreadable GitHub profile reads as failed', async () => {
    for (const body of [{ login: 'octocat' }, { id: 'abc', login: 'octocat' }, { id: 7 }, null]) {
      const odd = github(
        () => json({ access_token: 'gho_x' }),
        () => json(body),
      );
      expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, odd)).toEqual({ ok: false, reason: 'failed' });
    }
    const unauthorised = github(
      () => json({ access_token: 'gho_x' }),
      () => json({ message: 'Bad credentials' }, 401),
    );
    expect(await githubIdentity(callback('code=c0de&state=st8'), env, REDIRECT, unauthorised)).toEqual({ ok: false, reason: 'failed' });
  });
});
