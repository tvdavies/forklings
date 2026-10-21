// Forklings Worker: auth, routing and matchmaking. Static assets are served by
// Workers Static Assets; everything under /api and /auth comes here first.

import type { Snapshot } from '../shared/battle';
import { genome } from '../shared/genome';
import { isRecord, prop } from '../shared/json';
import { isOnboarding, LEVEL_RANGE, ONBOARDING_BATTLES, pickOpponent } from '../shared/matchmaking';
import { NPC_ROSTER, npcPid } from '../shared/npcs';
import { sha256Hex } from '../shared/rng';
import type { CareAction } from '../shared/state';
import { cookie, getCookie, randomToken, SESSION_DAYS, type Session, sha256b64, signSession, verifySession } from './auth';
import type { BattleOutcome } from './battle';
import type { Env } from './env';
import { handleMcp } from './mcp';
import type { PlayerDO, PlayerView } from './player';

export { BattleDO } from './battle';
export { PlayerDO } from './player';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const err = (status: number, message: string) => json({ error: message }, status);

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const DEMO_SIGNUPS_PER_IP_PER_DAY = 5;
const PAIR_COOLDOWN_MS = 6 * 3600 * 1000;
export const RANKED_MIN_ACCOUNT_AGE_MS = 30 * 86400e3;
// SQL for "may play ranked": a verified GitHub player whose account is at least 30 days
// old, or a house NPC while NPCs are on. Takes one parameter: the account-age cutoff.
const rankedSql = (env: Env) => `(${npcsOn(env) ? 'npc = 1 OR ' : ''}(verified = 1 AND gh_created_at IS NOT NULL AND gh_created_at <= ?))`;
const npcsOn = (env: Env) => env.NPCS !== 'off';
const visibleSql = (env: Env) => (npcsOn(env) ? '1 = 1' : 'npc = 0');

function origin(req: Request, env: Env) {
  return env.PUBLIC_ORIGIN || new URL(req.url).origin;
}
const isSecure = (req: Request) => new URL(req.url).protocol === 'https:';

type PlayerStub = DurableObjectStub<PlayerDO>;

async function player(env: Env, s: { pid: string; h: string; v: boolean }): Promise<PlayerStub> {
  const stub = env.PLAYER.get(env.PLAYER.idFromName(s.pid));
  await stub.init(s.pid, s.h, s.v);
  return stub;
}

/**
 * A parsed JSON body. Every field is `unknown` and is checked where it is used (mostly
 * by the player's Durable Object). Anything that isn't a JSON object reads as `{}`.
 */
type JsonBody = Record<string, unknown>;
const readJson = async (r: Request | Response): Promise<JsonBody> => {
  const v: unknown = await r.json().catch(() => null);
  return isRecord(v) ? v : {};
};

// D1 rows read in this file.
type TokenAuthRow = { id: string; pid: string; handle: string; verified: number };
type HandleRow = { pid: string; verified: number };
type RatingRow = { rating: number; started: number };
type PoolRow = { pid: string; snapshot: string; rating: number };
type NpcRow = { pid: string; handle: string };

type Auth = { s: Session; via: 'cookie' | 'token' };

async function authenticate(req: Request, env: Env): Promise<Auth | null> {
  const authz = req.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) {
    const tok = authz.slice(7).trim();
    if (!tok.startsWith('fk_')) return null;
    const hash = await sha256b64(tok);
    const row = await env.DB.prepare(
      'SELECT t.id, t.pid, p.handle, p.verified FROM api_tokens t JOIN players p ON p.pid = t.pid WHERE t.hash = ?',
    )
      .bind(hash)
      .first<TokenAuthRow>();
    if (!row) return null;
    await env.DB.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').bind(Date.now(), row.id).run();
    return { s: { pid: row.pid, h: row.handle, v: !!row.verified, exp: Date.now() + 60000 }, via: 'token' };
  }
  const s = await verifySession(env, getCookie(req, 'fk_session'));
  return s ? { s, via: 'cookie' } : null;
}

async function ensurePlayerRow(
  env: Env,
  s: { pid: string; h: string; v: boolean },
  ipHash: string | null,
  ghCreatedAt: number | null = null,
) {
  await env.DB.prepare(
    'INSERT INTO players (pid, handle, verified, created_at, ip_hash, updated_at, gh_created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET handle = excluded.handle, verified = excluded.verified, gh_created_at = COALESCE(excluded.gh_created_at, players.gh_created_at)',
  )
    .bind(s.pid, s.h, s.v ? 1 : 0, Date.now(), ipHash, Date.now(), ghCreatedAt)
    .run();
}

async function isRanked(env: Env, pid: string, now: number): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS ok FROM players WHERE pid = ? AND ${rankedSql(env)}`)
    .bind(pid, now - RANKED_MIN_ACCOUNT_AGE_MS)
    .first('ok'));
}

async function ipHash(req: Request, env: Env) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  return (await sha256Hex(`ip|${ip}|${env.SESSION_SECRET}`)).slice(0, 24);
}

async function startSession(req: Request, env: Env, s: { pid: string; h: string; v: boolean }, redirect?: string) {
  const token = await signSession(env, { ...s, exp: Date.now() + SESSION_DAYS * 86400e3 });
  const headers = { 'set-cookie': cookie('fk_session', token, SESSION_DAYS * 86400, isSecure(req)) };
  if (redirect) return new Response(null, { status: 302, headers: { ...headers, location: redirect } });
  return json({ ok: true, handle: s.h, verified: s.v }, 200, headers);
}

// ---------- auth routes ----------
async function demoLogin(req: Request, env: Env) {
  if (env.DEMO_LOGIN === 'off') return err(403, 'Demo login is switched off.');
  const body = await readJson(req);
  const handle = String(body.handle || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  if (!HANDLE_RE.test(handle)) return err(400, 'Pick a handle: letters, numbers and dashes, up to 39 characters.');
  const ih = await ipHash(req, env);
  const day = new Date().toISOString().slice(0, 10);
  const taken = await env.DB.prepare('SELECT pid, verified FROM players WHERE handle = ? LIMIT 1').bind(handle).first<HandleRow>();
  if (taken)
    return err(
      409,
      taken.verified ? 'That handle belongs to a verified GitHub player.' : 'Someone already picked that demo handle. Try another.',
    );
  const used =
    (await env.DB.prepare('SELECT count FROM demo_signups WHERE ip_hash = ? AND day = ?').bind(ih, day).first<number>('count')) ?? 0;
  if (used >= DEMO_SIGNUPS_PER_IP_PER_DAY) return err(429, "That's enough demo Forklings from here for today.");
  await env.DB.prepare(
    'INSERT INTO demo_signups (ip_hash, day, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1',
  )
    .bind(ih, day)
    .run();
  const s = { pid: `demo:${randomToken(9)}`, h: handle, v: false };
  await ensurePlayerRow(env, s, ih);
  return startSession(req, env, s);
}

async function githubStart(req: Request, env: Env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return err(503, "GitHub login isn't configured yet.");
  const state = randomToken(18);
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${origin(req, env)}/auth/github/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  // No scopes: identity only, public profile. Forklings never reads repos or activity.
  return new Response(null, {
    status: 302,
    headers: { location: u.toString(), 'set-cookie': cookie('fk_oauth', state, 600, isSecure(req)) },
  });
}

async function githubCallback(req: Request, env: Env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return err(503, "GitHub login isn't configured yet.");
  const url = new URL(req.url);
  const code = url.searchParams.get('code'),
    state = url.searchParams.get('state');
  if (!code || !state || state !== getCookie(req, 'fk_oauth')) return err(400, 'Login expired or state mismatch. Try again.');
  const tr = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin(req, env)}/auth/github/callback`,
    }),
  });
  const tj = await readJson(tr);
  if (!tj.access_token) return err(502, "GitHub didn't accept the login.");
  const ur = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${tj.access_token}`, 'user-agent': 'forklings.dev', accept: 'application/vnd.github+json' },
  });
  const user: unknown = await ur.json<unknown>().catch(() => ({}));
  const userId = prop(user, 'id'),
    login = prop(user, 'login');
  if (!userId || !login) return err(502, "Couldn't read your GitHub identity.");
  // The access token is dropped here: identity only, never stored.
  const s = { pid: `gh:${userId}`, h: String(login).toLowerCase(), v: true };
  // Store the account creation date: ranked play needs an account at least 30 days old.
  // (Date.parse converts its argument to a string anyway; String() just makes that explicit.)
  const created = Date.parse(String(prop(user, 'created_at')));
  await ensurePlayerRow(env, s, null, Number.isFinite(created) ? created : null);
  // A demo player who picked this handle loses it to the verified owner.
  await env.DB.prepare("UPDATE players SET handle = handle || '-demo' WHERE handle = ? AND verified = 0").bind(s.h).run();
  const res = await startSession(req, env, s, '/');
  res.headers.append('set-cookie', cookie('fk_oauth', '', 0, isSecure(req)));
  return res;
}

// ---------- battle ----------
/**
 * One battle path for everyone, players and house NPCs alike.
 * Matchmaking: ranked players (and NPCs) meet other ranked players and NPCs close in
 * level, not themselves, and not anyone they fought in the last 6 hours either way.
 * Unranked players (demo logins, GitHub accounts under 30 days) meet NPCs and house
 * bots, and their battles never move a rating. With nobody suitable, a house bot steps in.
 * A player's first three battles are gentler (src/shared/matchmaking.ts): a tutorial bot first,
 * then only NPCs at their level or lower, or a bot at their XP.
 */
async function runBattle(
  env: Env,
  who: { pid: string; h: string; v: boolean },
  opts: { practice?: boolean } = {},
): Promise<{ ok: true; out: BattleOutcome } | { ok: false; error: string }> {
  const me = await player(env, who);
  const prep = await me.prepareBattle();
  if (!prep.ok) return { ok: false, error: prep.error };
  const snapA = prep.snapshot;
  const now = Date.now();
  // A practice battle is always unranked and always against an NPC (or a bot).
  const ranked = !opts.practice && (await isRanked(env, who.pid, now));
  // Battles this player started before, counted up to the onboarding limit.
  const myRow = await env.DB.prepare(
    'SELECT rating, (SELECT COUNT(*) FROM (SELECT 1 FROM battles WHERE challenger = ?1 LIMIT ?2)) AS started FROM players WHERE pid = ?1',
  )
    .bind(who.pid, ONBOARDING_BATTLES)
    .first<RatingRow>();
  const started = myRow?.started ?? 0;
  const onboard = !who.pid.startsWith('npc:');
  const gentle = onboard && isOnboarding(started);
  // Onboarding: house NPCs only, at the player's level or lower. Otherwise: anyone eligible within three levels.
  const npcOnly = npcsOn(env) ? '(npc = 1 AND ?2 = ?2)' : '(0 AND ?2 = ?2)';
  const eligible = ranked && !gentle ? rankedSql(env).replace('?', '?2') : npcOnly;
  const levelSql = gentle ? 'level <= ?3' : `ABS(level - ?3) <= ${LEVEL_RANGE}`;
  const pool = await env.DB.prepare(`
    SELECT pid, snapshot, rating FROM players
    WHERE has_creature = 1 AND pid != ?1 AND snapshot IS NOT NULL AND ${eligible}
      AND ${levelSql} AND updated_at > ?4
      AND pid NOT IN (SELECT defender FROM battles WHERE challenger = ?1 AND at > ?5)
      AND pid NOT IN (SELECT challenger FROM battles WHERE defender = ?1 AND at > ?5)
    ORDER BY ABS(rating - ?6) LIMIT 6`)
    .bind(who.pid, now - RANKED_MIN_ACCOUNT_AGE_MS, snapA.level, now - 14 * 86400e3, now - PAIR_COOLDOWN_MS, myRow?.rating ?? 1000)
    .all<PoolRow>();
  const rows = (pool.results || []).map((r) => JSON.parse(r.snapshot) as Snapshot);
  const id = crypto.randomUUID();
  const seed = await sha256Hex(`battle|${id}|${who.pid}|${now}`);
  const snapB = pickOpponent({ me: snapA, started, pool: rows, seed, botSeed: await sha256Hex(`bot|${seed}`), onboard });
  const battle = env.BATTLE.get(env.BATTLE.idFromName(id));
  return { ok: true, out: await battle.run(id, snapA, snapB, seed, ranked) };
}

async function startBattle(env: Env, a: Auth) {
  const r = await runBattle(env, { pid: a.s.pid, h: a.s.h, v: a.s.v });
  return r.ok ? json(r.out) : err(409, r.error);
}

// ---------- house NPCs ----------
const NPC_HATCH_EPOCH = Date.UTC(2026, 9, 1, 9, 0, 0);
const NPC_BATTLES_PER_TICK = 3;

/** Create any roster NPC that doesn't exist yet. Idempotent. */
async function seedNpcs(env: Env, now: number) {
  const existing = await env.DB.prepare('SELECT pid FROM players WHERE npc = 1 AND has_creature = 1').all<{ pid: string }>();
  const have = new Set((existing.results || []).map((r) => r.pid));
  for (const [i, n] of NPC_ROSTER.entries()) {
    const pid = npcPid(n.handle);
    if (have.has(pid)) continue;
    await env.DB.prepare(
      'INSERT INTO players (pid, handle, verified, created_at, updated_at, npc, persona, rating) VALUES (?, ?, 0, ?, ?, 1, ?, ?) ON CONFLICT(pid) DO NOTHING',
    )
      .bind(pid, n.handle, now, now, n.persona, n.rating)
      .run();
    const stub = await player(env, { pid, h: n.handle, v: false });
    await stub.setupNpc(env.HATCH_SALT, NPC_HATCH_EPOCH + i * 3637 * 1000, n.xp, n.items, n.tactics, now);
  }
}

/** Every tick: NPCs look after their Forklings like an attentive player would, and a few pick a fight. */
async function npcTick(env: Env, now: number) {
  if (!npcsOn(env)) return;
  await seedNpcs(env, now);
  const npcs = (await env.DB.prepare('SELECT pid, handle FROM players WHERE npc = 1 AND has_creature = 1').all<NpcRow>()).results || [];
  for (const n of npcs) {
    const stub = await player(env, { pid: n.pid, h: n.handle, v: false });
    const v = await stub.view(now);
    const c = v.creature;
    const s = c?.state;
    if (!c || !s) continue;
    if (c.evolving) await stub.ackEvolution(now);
    const todo: CareAction[] = [];
    if (s.fullness < 55) todo.push('feed');
    if (s.mood < 55) todo.push('pat');
    if (s.energy < 25) todo.push('nap');
    else if (s.mood < 70 && s.energy > 60) todo.push('play');
    for (const a of todo) await stub.care(a, now);
  }
  const order = npcs
    .map((n) => ({ n, k: Math.random() }))
    .sort((x, y) => x.k - y.k)
    .slice(0, NPC_BATTLES_PER_TICK);
  for (const { n } of order) {
    const r = await runBattle(env, { pid: n.pid, h: n.handle, v: false });
    if (!r.ok) console.log('npc battle skipped', n.handle, r.error);
  }
}

// ---------- tokens ----------
async function createToken(body: JsonBody, env: Env, a: Auth) {
  const name = String(body.name || 'API token').slice(0, 40);
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE pid = ?').bind(a.s.pid).first<number>('n')) ?? 0;
  if (n >= 5) return err(409, 'You already have 5 tokens. Revoke one first.');
  const token = `fk_${randomToken(24)}`;
  const id = randomToken(6);
  await env.DB.prepare('INSERT INTO api_tokens (hash, id, pid, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256b64(token), id, a.s.pid, name, Date.now())
    .run();
  return json({ id, name, token, note: 'Shown once. Store it somewhere safe.' });
}

/** One or two short lines for terminal status bars, e.g. the Claude Code plugin's status line. */
function statusLine(v: PlayerView): string {
  const c = v.creature;
  if (!c) return 'forkling: not hatched yet, visit forklings.dev\n';
  const s = c.state,
    r = (n: number) => Math.round(n);
  const FACES: Record<string, string> = {
    napping: '(-.-)zz',
    hungry: '(o_o)',
    sleepy: '(=_=)',
    delighted: '(^o^)',
    content: '(^-^)',
    grumpy: '(>_<)',
    sulking: '(;_;)',
  };
  const face = FACES[c.mood] ?? '(^-^)';
  const warn = c.evolving ? ' · ready to evolve!' : '';
  return `${face} ${genome(c.seed).name} is ${c.mood}${warn}\n   food ${r(s.fullness)}% · mood ${r(s.mood)}% · energy ${r(s.energy)}% · Lv ${c.level}\n`;
}

// ---------- MCP ----------
async function mcp(req: Request, env: Env) {
  // Personal API tokens only: no cookies, so a web page can't drive the MCP endpoint.
  const a = req.headers.get('authorization')?.startsWith('Bearer ') ? await authenticate(req, env) : null;
  if (!a) return handleMcp(req, env, null);
  const who = { pid: a.s.pid, h: a.s.h, v: a.s.v };
  const me = await player(env, who);
  return handleMcp(req, env, { player: me, handle: a.s.h, practiceBattle: () => runBattle(env, who, { practice: true }) });
}

// ---------- router ----------
async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname,
    m = req.method;
  if (p === '/api/config') return json({ github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET), demo: env.DEMO_LOGIN !== 'off' });
  if (p === '/api/leaderboard') {
    const cutoff = Date.now() - RANKED_MIN_ACCOUNT_AGE_MS;
    const cols = 'handle, verified, npc, persona, name, seed, level, stage, rating, wins, losses, draws, xp';
    const where = `has_creature = 1 AND ${visibleSql(env)}`;
    const ranked = await env.DB.prepare(
      `SELECT ${cols} FROM players WHERE ${where} AND ${rankedSql(env)} ORDER BY rating DESC, wins DESC, xp DESC LIMIT 50`,
    )
      .bind(cutoff)
      .all();
    const unranked = await env.DB.prepare(
      `SELECT ${cols} FROM players WHERE ${where} AND NOT ${rankedSql(env)} ORDER BY wins DESC, xp DESC LIMIT 50`,
    )
      .bind(cutoff)
      .all();
    return json({ players: ranked.results, unranked: unranked.results });
  }
  const a = await authenticate(req, env);
  if (!a) return err(401, 'Not logged in.');
  // Cookie-authenticated writes must come from our own pages.
  if (m !== 'GET' && a.via === 'cookie') {
    const o = req.headers.get('origin');
    if (o && o !== new URL(req.url).origin && o !== env.PUBLIC_ORIGIN) return err(403, 'Cross-site request refused.');
  }
  const me = await player(env, a.s);
  const body: JsonBody = m === 'POST' ? await readJson(req) : {};
  switch (true) {
    case p === '/api/status-line' && m === 'GET':
      return new Response(statusLine(await me.view()), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    case p === '/api/me' && m === 'GET':
      return json({ session: { handle: a.s.h, verified: a.s.v, pid: a.s.pid }, ...(await me.view()) });
    case p === '/api/hatch' && m === 'POST': {
      const r = await me.hatch(env.HATCH_SALT);
      return r.ok ? json({ ok: true, ...(await me.view()) }) : err(409, r.error);
    }
    case p === '/api/care' && m === 'POST': {
      const r = await me.care(body.action);
      return json({ ...r, ...(await me.view()) }, r.ok ? 200 : 409);
    }
    case p === '/api/equip' && m === 'POST': {
      const r = await me.equip(String(body.slot), body.item ?? null);
      return r.ok ? json({ ok: true, ...(await me.view()) }) : err(409, r.error);
    }
    case p === '/api/tactics' && m === 'POST': {
      const r = await me.setTactics(body.tactics ?? body);
      return r.ok ? json(r) : err(409, r.error);
    }
    case p === '/api/script' && m === 'POST': {
      const r = await me.setScript(body.script);
      return r.ok ? json(r) : json({ error: r.error, line: r.line, col: r.col }, 409);
    }
    case p === '/api/evolve' && m === 'POST':
      return json({ ...(await me.ackEvolution()), ...(await me.view()) });
    case p === '/api/battle' && m === 'POST':
      return startBattle(env, a);
    case p === '/api/battles' && m === 'GET':
      return json({ battles: await me.battles() });
    case p.startsWith('/api/battles/') && m === 'GET': {
      const r = await me.replay(decodeURIComponent(p.slice('/api/battles/'.length)));
      return r ? json(r) : err(404, 'No such battle.');
    }
    case p === '/api/tokens' && m === 'GET': {
      const r = await env.DB.prepare('SELECT id, name, created_at, last_used FROM api_tokens WHERE pid = ? ORDER BY created_at')
        .bind(a.s.pid)
        .all();
      return json({ tokens: r.results });
    }
    case p === '/api/tokens' && m === 'POST':
      if (a.via !== 'cookie') return err(403, 'Create tokens from the website.');
      return createToken(body, env, a);
    case p.startsWith('/api/tokens/') && m === 'DELETE':
      await env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND pid = ?').bind(p.slice('/api/tokens/'.length), a.s.pid).run();
      return json({ ok: true });
  }
  return err(404, 'Not found.');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname === '/mcp') return await mcp(req, env);
      if (url.pathname === '/auth/demo' && req.method === 'POST') return await demoLogin(req, env);
      if (url.pathname === '/auth/github') return await githubStart(req, env);
      if (url.pathname === '/auth/github/callback') return await githubCallback(req, env);
      if (url.pathname === '/auth/logout' && req.method === 'POST')
        return json({ ok: true }, 200, { 'set-cookie': cookie('fk_session', '', 0, isSecure(req)) });
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error('request failed', url.pathname, prop(e, 'stack') || e);
      return err(500, 'Something went wrong. Try again.');
    }
  },
  async scheduled(ctl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(npcTick(env, ctl.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
