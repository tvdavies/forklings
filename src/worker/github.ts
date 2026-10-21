// GitHub OAuth: the only way into Forklings. GitHub is used for identity alone. The
// access token is used once to read who you are and is never stored.
import { prop } from '../shared/json';
import { getCookie, isGithubPid } from './auth';
import type { Env } from './env';

/**
 * Why a sign-in didn't work. The Worker sends the player back to `/?signin=<reason>`
 * and the sign-in page turns the reason into a friendly message.
 */
export type SignInError = 'denied' | 'expired' | 'failed' | 'unavailable' | 'unconfigured';

export type GithubIdentity = { ok: true; pid: string; handle: string; createdAt: number | null } | { ok: false; reason: SignInError };

type GithubEnv = Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>;
export const githubConfigured = (env: GithubEnv) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

const readJson = async (r: Response): Promise<unknown> => r.json<unknown>().catch(() => null);

/**
 * Turn GitHub's callback into a GitHub player, or a reason the sign-in page can explain.
 * `redirectUri` must match the one sent to GitHub's authorise page.
 */
export async function githubIdentity(
  req: Request,
  env: GithubEnv,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubIdentity> {
  if (!githubConfigured(env)) return { ok: false, reason: 'unconfigured' };
  const url = new URL(req.url);
  // The player said no on GitHub's consent screen, or GitHub refused the request.
  const ghError = url.searchParams.get('error');
  if (ghError) return { ok: false, reason: ghError === 'access_denied' ? 'denied' : 'failed' };
  const code = url.searchParams.get('code'),
    state = url.searchParams.get('state');
  // No matching state cookie: it timed out (10 minutes) or the flow began in another browser.
  if (!code || !state || state !== getCookie(req, 'fk_oauth')) return { ok: false, reason: 'expired' };

  let token: string;
  try {
    const tr = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'forklings.dev' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
    if (tr.status >= 500) return { ok: false, reason: 'unavailable' };
    const tj = await readJson(tr);
    const t = prop(tj, 'access_token');
    if (typeof t !== 'string' || !t) {
      // bad_verification_code: the code was used already or is more than 10 minutes old.
      const e = prop(tj, 'error');
      console.log('github token exchange refused', String(e || tr.status));
      return { ok: false, reason: e === 'bad_verification_code' ? 'expired' : 'failed' };
    }
    token = t;
  } catch (e) {
    console.error('github token exchange unreachable', prop(e, 'message') || e);
    return { ok: false, reason: 'unavailable' };
  }

  let user: unknown;
  try {
    const ur = await fetchFn('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'forklings.dev', accept: 'application/vnd.github+json' },
    });
    if (ur.status >= 500) return { ok: false, reason: 'unavailable' };
    if (!ur.ok) return { ok: false, reason: 'failed' };
    user = await readJson(ur);
  } catch (e) {
    console.error('github user lookup unreachable', prop(e, 'message') || e);
    return { ok: false, reason: 'unavailable' };
  }
  const id = prop(user, 'id'),
    login = prop(user, 'login');
  const pid = `gh:${typeof id === 'number' || typeof id === 'string' ? id : ''}`;
  if (typeof login !== 'string' || !login || !isGithubPid(pid)) return { ok: false, reason: 'failed' };
  // Ranked play needs an account at least 30 days old, so keep its creation date.
  const created = Date.parse(String(prop(user, 'created_at')));
  return { ok: true, pid, handle: login.toLowerCase(), createdAt: Number.isFinite(created) ? created : null };
}
