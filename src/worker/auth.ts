// Signed session cookies and per-user API tokens.
import type { Env } from './env';

/** A signed-in player. GitHub is the only way in, so `pid` is always `gh:<GitHub user id>`. */
export interface Session {
  pid: string;
  h: string;
  exp: number;
}

/** Player ids that can sign in. Anything else (house NPCs, retired accounts) never gets a session. */
export const isGithubPid = (pid: unknown): pid is string => typeof pid === 'string' && /^gh:\d+$/.test(pid);

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(env: Env, s: Session): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(s)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

export async function verifySession(env: Env, token: string | null): Promise<Session | null> {
  if (!token || !env.SESSION_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), fromB64u(sig), enc.encode(body));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64u(body))) as Partial<Session> | null;
    // Fail closed: only unexpired sessions for GitHub players are accepted.
    if (!s || !isGithubPid(s.pid) || typeof s.h !== 'string' || typeof s.exp !== 'number' || s.exp < Date.now()) return null;
    return { pid: s.pid, h: s.h, exp: s.exp };
  } catch {
    return null;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number, secure = true): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function randomToken(bytes = 32): string {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64(s: string): Promise<string> {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export const SESSION_DAYS = 30;
