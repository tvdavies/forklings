// Forklings Worker: auth, routing and matchmaking. Static assets are served by
// Workers Static Assets; /api, /auth, /mcp, /authorize, /oauth and /.well-known come here first.

import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { Snapshot } from '../shared/battle';
import { nextUtcMidnight, utcDay } from '../shared/economy';
import { genome, RARITY, STAGE_NAMES } from '../shared/genome';
import { isRecord, prop } from '../shared/json';
import { isOnboarding, LEVEL_RANGE, ONBOARDING_BATTLES, pickOpponent } from '../shared/matchmaking';
import { NPC_ROSTER, npcPid } from '../shared/npcs';
import { sha256Hex } from '../shared/rng';
import type { CareAction } from '../shared/state';
import { cookie, getCookie, isGithubPid, randomToken, SESSION_DAYS, type Session, sha256b64, signSession, verifySession } from './auth';
import type { BattleOutcome } from './battle';
import { D1KV } from './d1kv';
import type { Env } from './env';
import { githubConfigured, githubIdentity, type SignInError } from './github';
import { leaderboard } from './leaderboard';
import { handleMcp, portrait } from './mcp';
import {
  authorize,
  type ForklingCard,
  listConnections,
  type McpProps,
  type OAuthEnv,
  oauthServers,
  publicOrigin,
  revokeConnection,
  type Signed,
  withOAuthStore,
} from './oauth';
import type { PlayerDO, PlayerView } from './player';
import { limitRegistration, REGISTER_PATH } from './ratelimit';
import { effectiveScopes, isAuthorizeReturn } from './scopes';
import { ensureShopDay, findOffer, offersFor, readShopDay } from './shop';

export { BattleDO } from './battle';
export { PlayerDO } from './player';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const err = (status: number, message: string) => json({ error: message }, status);

/** The nightly shop restock (must match wrangler.jsonc). Everything else on the cron is the NPC tick. */
const SHOP_CRON = '5 0 * * *';
const PAIR_COOLDOWN_MS = 6 * 3600 * 1000;
// Not exported: workerd rejects entry-module exports that aren't handlers or classes.
const RANKED_MIN_ACCOUNT_AGE_MS = 30 * 86400e3;
// SQL for "may play ranked": a verified GitHub player whose account is at least 30 days
// old, or a house NPC while NPCs are on. Takes one parameter: the account-age cutoff.
const rankedSql = (env: Env) => `(${npcsOn(env) ? 'npc = 1 OR ' : ''}(verified = 1 AND gh_created_at IS NOT NULL AND gh_created_at <= ?))`;
const npcsOn = (env: Env) => env.NPCS !== 'off';
// SQL for "shown on the leaderboard": GitHub players, plus the house NPCs while they're on.
// Rows left over from retired sign-in methods (verified = 0, not an NPC) stay hidden.
const visibleSql = (env: Env) => (npcsOn(env) ? '(verified = 1 OR npc = 1)' : '(verified = 1 AND npc = 0)');

const origin = (req: Request, env: Env) => publicOrigin(env, req);
const isSecure = (req: Request) => new URL(req.url).protocol === 'https:';

type PlayerStub = DurableObjectStub<PlayerDO>;

/** Someone who can own a Forkling: a signed-in GitHub player or a house NPC. */
type Who = { pid: string; h: string };

async function player(env: Env, s: Who): Promise<PlayerStub> {
  const stub = env.PLAYER.get(env.PLAYER.idFromName(s.pid));
  await stub.init(s.pid, s.h);
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
type TokenAuthRow = { id: string; pid: string; handle: string };
type PlayerRow = { handle: string };
type RatingRow = { rating: number; started: number };
type PoolRow = { pid: string; snapshot: string; rating: number };
type NpcRow = { pid: string; handle: string };

type Auth = { s: Session; via: 'cookie' | 'token' };

const LAST_USED_GRANULARITY_MS = 10 * 60 * 1000;

/**
 * Check a personal `fk_` token. Its last-used time is written at most every 10 minutes.
 * Tokens only work for GitHub players; any left over from retired accounts are refused.
 */
async function personalToken(env: Env, tok: string): Promise<TokenAuthRow | null> {
  if (!tok.startsWith('fk_')) return null;
  const row = await env.DB.prepare(
    'SELECT t.id, t.pid, p.handle FROM api_tokens t JOIN players p ON p.pid = t.pid WHERE t.hash = ? AND p.verified = 1',
  )
    .bind(await sha256b64(tok))
    .first<TokenAuthRow>();
  if (!row || !isGithubPid(row.pid)) return null;
  const now = Date.now();
  await env.DB.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)')
    .bind(now, row.id, now - LAST_USED_GRANULARITY_MS)
    .run();
  return row;
}

async function authenticate(req: Request, env: Env): Promise<Auth | null> {
  const authz = req.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) {
    // The JSON API takes personal tokens only. OAuth access tokens are for /mcp.
    const row = await personalToken(env, authz.slice(7).trim());
    return row ? { s: { pid: row.pid, h: row.handle, exp: Date.now() + 60000 }, via: 'token' } : null;
  }
  const s = await verifySession(env, getCookie(req, 'fk_session'));
  return s ? { s, via: 'cookie' } : null;
}

/** Create or refresh a GitHub player's directory row at sign-in. */
async function ensurePlayerRow(env: Env, s: Who, ghCreatedAt: number | null) {
  await env.DB.prepare(
    'INSERT INTO players (pid, handle, verified, created_at, updated_at, gh_created_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET handle = excluded.handle, verified = 1, gh_created_at = COALESCE(excluded.gh_created_at, players.gh_created_at)',
  )
    .bind(s.pid, s.h, Date.now(), Date.now(), ghCreatedAt)
    .run();
}

async function isRanked(env: Env, pid: string, now: number): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS ok FROM players WHERE pid = ? AND ${rankedSql(env)}`)
    .bind(pid, now - RANKED_MIN_ACCOUNT_AGE_MS)
    .first('ok'));
}

// ---------- auth routes ----------
// GitHub is the only way in. Every failure on the way back from GitHub lands on the
// sign-in page with a short reason code; the page turns it into a friendly message.
const clearOauth = (req: Request) => cookie('fk_oauth', '', 0, isSecure(req));
const clearNext = (req: Request) => cookie('fk_next', '', 0, isSecure(req));

function signInError(req: Request, reason: SignInError) {
  const headers = new Headers({ location: `/?signin=${reason}`, 'cache-control': 'no-store' });
  headers.append('set-cookie', clearOauth(req));
  if (getCookie(req, 'fk_next')) headers.append('set-cookie', clearNext(req));
  return new Response(null, { status: 302, headers });
}

async function startSession(req: Request, env: Env, s: Who, location: string) {
  const token = await signSession(env, { pid: s.pid, h: s.h, exp: Date.now() + SESSION_DAYS * 86400e3 });
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie('fk_session', token, SESSION_DAYS * 86400, isSecure(req)));
  headers.append('set-cookie', clearOauth(req));
  return new Response(null, { status: 302, headers });
}

function githubStart(req: Request, env: Env) {
  if (!env.GITHUB_CLIENT_ID || !githubConfigured(env)) return signInError(req, 'unconfigured');
  // Signing in to connect an MCP client returns to that client's /authorize page afterwards.
  const next = new URL(req.url).searchParams.get('next');
  const state = randomToken(18);
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${origin(req, env)}/auth/github/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  // No scopes: identity only, public profile. Forklings never reads repos or activity.
  const headers = new Headers({ location: u.toString(), 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie('fk_oauth', state, 600, isSecure(req)));
  if (isAuthorizeReturn(next)) headers.append('set-cookie', cookie('fk_next', next, 600, isSecure(req)));
  return new Response(null, { status: 302, headers });
}

async function githubCallback(req: Request, env: Env) {
  try {
    const r = await githubIdentity(req, env, `${origin(req, env)}/auth/github/callback`);
    if (!r.ok) return signInError(req, r.reason);
    const who = { pid: r.pid, h: r.handle };
    await ensurePlayerRow(env, who, r.createdAt);
    // Back to the MCP client's /authorize page if that's where sign-in started.
    const next = getCookie(req, 'fk_next');
    const res = await startSession(req, env, who, isAuthorizeReturn(next) ? next : '/');
    if (next) res.headers.append('set-cookie', clearNext(req));
    return res;
  } catch (e) {
    console.error('github sign-in failed', prop(e, 'stack') || e);
    return signInError(req, 'failed');
  }
}

// ---------- battle ----------
/**
 * One battle path for everyone, players and house NPCs alike.
 * Matchmaking: ranked players (and NPCs) meet other ranked players and NPCs close in
 * level, not themselves, and not anyone they fought in the last 6 hours either way.
 * Unranked players (GitHub accounts under 30 days old) meet NPCs and house
 * bots, and their battles never move a rating. With nobody suitable, a house bot steps in.
 * A player's first three battles are gentler (src/shared/matchmaking.ts): a tutorial bot first,
 * then only NPCs at their level or lower, or a bot at their XP.
 */
async function runBattle(
  env: Env,
  who: Who,
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
  const r = await runBattle(env, { pid: a.s.pid, h: a.s.h });
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
    const stub = await player(env, { pid, h: n.handle });
    await stub.setupNpc(env.HATCH_SALT, NPC_HATCH_EPOCH + i * 3637 * 1000, n.xp, n.items, n.tactics, now);
  }
}

/**
 * Once a day, after the shelf is made, each NPC may buy and wear something new. Reads the
 * day's shelf but never makes it: making items is the shop cron's job (or the first visit's),
 * so an NPC tick never spends its time on the generator. No shelf yet means no shopping today.
 */
async function npcShopping(env: Env, npcs: NpcRow[], now: number) {
  const day = await readShopDay(env, utcDay(now));
  if (!day) return;
  const offers = await offersFor(env, day);
  for (const n of npcs) {
    const stub = await player(env, { pid: n.pid, h: n.handle });
    const got = await stub.npcShop(offers, now);
    if (got) console.log('npc bought', n.handle, got);
  }
}

/** Every tick: NPCs look after their Forklings like an attentive player would, and a few pick a fight. */
async function npcTick(env: Env, now: number) {
  if (!npcsOn(env)) return;
  await seedNpcs(env, now);
  const npcs = (await env.DB.prepare('SELECT pid, handle FROM players WHERE npc = 1 AND has_creature = 1').all<NpcRow>()).results || [];
  for (const n of npcs) {
    const stub = await player(env, { pid: n.pid, h: n.handle });
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
  // The first tick after 00:20 UTC goes shopping (the shelf is made at 00:05).
  const sinceMidnight = now - Date.parse(`${utcDay(now)}T00:00:00Z`);
  if (sinceMidnight >= 20 * 60e3 && sinceMidnight < 40 * 60e3) await npcShopping(env, npcs, now);
  const order = npcs
    .map((n) => ({ n, k: Math.random() }))
    .sort((x, y) => x.k - y.k)
    .slice(0, NPC_BATTLES_PER_TICK);
  for (const { n } of order) {
    const r = await runBattle(env, { pid: n.pid, h: n.handle });
    if (!r.ok) console.log('npc battle skipped', n.handle, r.error);
  }
}

// ---------- shop ----------
async function shop(env: Env, me: PlayerStub) {
  const now = Date.now();
  const day = await ensureShopDay(env, utcDay(now), now);
  const [offers, v] = await Promise.all([offersFor(env, day), me.view(now)]);
  return json({ day: day.day, restockAt: nextUtcMidnight(now), offers, ...v });
}

async function buy(env: Env, me: PlayerStub, body: JsonBody) {
  const offer = await findOffer(env, body.item);
  if (!offer) return json({ error: 'That item has left the shop. New stock arrives at midnight UTC.', code: 'gone' }, 409);
  // Like every write endpoint, the player view comes back alongside the result, at the top level.
  const { view, ...r } = await me.buy(offer, body.requestId);
  return json({ ...view, ...r }, r.ok ? 200 : 409);
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

// ---------- MCP and OAuth ----------
/**
 * /mcp after the resource server has checked the Bearer token (never a cookie, so a web page
 * can't drive it). The handle is read fresh from D1, since it can change after a grant.
 */
async function mcp(req: Request, env: OAuthEnv, ctx: OAuthResourceContext<McpProps>): Promise<Response> {
  // Only GitHub players: a grant left over from a retired account stops working.
  const row = isGithubPid(ctx.props.pid)
    ? await env.DB.prepare('SELECT handle FROM players WHERE pid = ? AND verified = 1').bind(ctx.props.pid).first<PlayerRow>()
    : null;
  if (!row) return err(401, 'This player no longer exists.');
  const who = { pid: ctx.props.pid, h: row.handle };
  const me = await player(env, who);
  return handleMcp(req, env, {
    player: me,
    handle: row.handle,
    practiceBattle: () => runBattle(env, who, { practice: true }),
    scopes: effectiveScopes(ctx.auth.scope),
    insufficientScope: (scopes, description) => insufficientScope(ctx.auth, scopes, description),
  });
}

const servers = oauthServers(mcp, personalToken);

async function sessionOf(req: Request, env: Env): Promise<Signed | null> {
  const s = await verifySession(env, getCookie(req, 'fk_session'));
  return s ? { pid: s.pid, handle: s.h } : null;
}

/** The player's Forkling as the consent page shows it. */
async function forklingCard(env: Env, who: Signed): Promise<ForklingCard | null> {
  const v = await (await player(env, { pid: who.pid, h: who.handle })).view();
  const c = v.creature;
  if (!c) return null;
  const g = genome(c.seed);
  return {
    name: g.name,
    line: `@${who.handle}'s ${RARITY[g.rarity]} ${g.type}-type ${STAGE_NAMES[c.stage]}, level ${c.level}`,
    portrait: await portrait(g, c.items, c.stage, c.gear),
  };
}

function oauthRoute(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> | null {
  const p = url.pathname;
  const isMcp = p === '/mcp' || p.startsWith('/.well-known/oauth-protected-resource');
  const isAs = p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/oauth/');
  if (!isMcp && !isAs && p !== '/authorize') return null;
  const oenv = withOAuthStore(env);
  const { as, rs } = servers(publicOrigin(env, req));
  if (isMcp) return rs.fetch(req, oenv, ctx);
  if (isAs && p === REGISTER_PATH)
    return limitRegistration(req, env.REGISTER_LIMITER).then((limited) => limited ?? as.fetch(req, oenv, ctx));
  if (isAs) return as.fetch(req, oenv, ctx);
  return authorize(req, oenv, as, {
    session: (r) => sessionOf(r, env),
    forkling: (who) => forklingCard(env, who),
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    consentSecret: `forklings-consent|${env.SESSION_SECRET}`,
  });
}

// ---------- router ----------
async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname,
    m = req.method;
  if (p === '/api/config') return json({ github: githubConfigured(env) });
  if (p === '/api/leaderboard') {
    // Public, but a logged-in viewer also gets their own place (`me`).
    const viewer = await authenticate(req, env);
    return json(
      await leaderboard(env.DB, {
        rankedSql: rankedSql(env),
        visibleSql: visibleSql(env),
        minAccountAgeMs: RANKED_MIN_ACCOUNT_AGE_MS,
        now: Date.now(),
        pid: viewer?.s.pid ?? null,
      }),
    );
  }
  const a = await authenticate(req, env);
  if (!a) {
    // A cookie that no longer verifies (expired, or from a retired account) is cleared, and the
    // page is told so it can say the session ended rather than show a blank sign-in.
    if (!getCookie(req, 'fk_session')) return err(401, 'Not signed in.');
    return json({ error: 'Your session has ended. Sign in again.', ended: true }, 401, {
      'set-cookie': cookie('fk_session', '', 0, isSecure(req)),
    });
  }
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
      return json({ session: { handle: a.s.h, pid: a.s.pid }, ...(await me.view()) });
    case p === '/api/hatch' && m === 'POST': {
      const r = await me.hatch(env.HATCH_SALT);
      return r.ok ? json({ ok: true, ...(await me.view()) }) : err(409, r.error);
    }
    case p === '/api/care' && m === 'POST': {
      const r = await me.care(body.action);
      return json({ ...r, ...(await me.view()) }, r.ok ? 200 : 409);
    }
    case p === '/api/shop' && m === 'GET':
      return shop(env, me);
    case p === '/api/shop/buy' && m === 'POST':
      return buy(env, me, body);
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
    case p === '/api/first-day/close' && m === 'POST': {
      const r = await me.closeFirstDay();
      return r.ok ? json({ ok: true, ...(await me.view()) }) : err(409, r.error);
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
    // Apps connected over OAuth (Claude Code, Codex, Pi...). Managed from the website only.
    case p === '/api/connections' && m === 'GET': {
      if (a.via !== 'cookie') return err(403, 'Manage connected apps from the website.');
      const oenv = withOAuthStore(env);
      return json({ connections: await listConnections(servers(origin(req, env)).as.getOAuthApi(oenv), oenv, a.s.pid) });
    }
    case p.startsWith('/api/connections/') && m === 'DELETE': {
      if (a.via !== 'cookie') return err(403, 'Manage connected apps from the website.');
      const oenv = withOAuthStore(env);
      await revokeConnection(
        servers(origin(req, env)).as.getOAuthApi(oenv),
        a.s.pid,
        decodeURIComponent(p.slice('/api/connections/'.length)),
      );
      return json({ ok: true });
    }
  }
  return err(404, 'Not found.');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      const o = oauthRoute(req, env, ctx, url);
      if (o) return await o;
      // Other discovery documents (OpenID Connect, for one) don't exist here; say so in JSON
      // rather than letting the single-page app answer 200 with HTML.
      if (url.pathname.startsWith('/.well-known/')) return err(404, 'Not found.');
      if (url.pathname === '/auth/github') return githubStart(req, env);
      if (url.pathname === '/auth/github/callback') return await githubCallback(req, env);
      if (url.pathname === '/auth/logout' && req.method === 'POST')
        return json({ ok: true }, 200, { 'set-cookie': cookie('fk_session', '', 0, isSecure(req)) });
      // Nothing else lives under /auth, including the retired /auth/demo.
      if (url.pathname.startsWith('/auth/')) return err(404, 'Not found.');
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error('request failed', url.pathname, prop(e, 'stack') || e);
      return err(500, 'Something went wrong. Try again.');
    }
  },
  async scheduled(ctl: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (ctl.cron === SHOP_CRON) {
      ctx.waitUntil(ensureShopDay(env, utcDay(ctl.scheduledTime), ctl.scheduledTime));
      return;
    }
    ctx.waitUntil(npcTick(env, ctl.scheduledTime));
    // Once an hour (the cron runs every 20 minutes): drop expired OAuth codes, tokens and grants.
    if (new Date(ctl.scheduledTime).getUTCMinutes() < 20) ctx.waitUntil(new D1KV(env.DB).purgeExpired());
  },
} satisfies ExportedHandler<Env>;
