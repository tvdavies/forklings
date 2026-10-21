// OAuth 2.1 for MCP clients, following the MCP authorization spec: Protected Resource
// Metadata (RFC 9728) for /mcp, Authorization Server Metadata (RFC 8414), PKCE, resource
// indicators, Client ID Metadata Documents and, for older clients, Dynamic Client
// Registration. @cloudflare/workers-oauth-provider does the protocol; this file supplies
// the scopes, the sign-in and consent page at /authorize, and the "connected apps" list.
//
// Players sign in with their existing Forklings session (GitHub login), so the GitHub
// token is still never kept. Tokens are stored in D1 through D1KV, not in KV.

import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ConsentDescription,
  OAuthAuthorizationServer,
  type OAuthHelpers,
  type OAuthResourceContext,
  OAuthResourceServer,
  type OAuthResourceTokenValidation,
} from '@cloudflare/workers-oauth-provider';
import { prop } from '../shared/json';
import { D1KV } from './d1kv';
import type { Env } from './env';
import { ALL_SCOPES, approvedScopes, COACH_SCOPES, DEFAULT_SCOPES, isScope, oauthUserId, SCOPES, type Scope } from './scopes';

// ---------- lifetimes ----------
/** 8-hour access tokens, as the proposal planned: fewer refreshes, and revocation is instant anyway. */
export const ACCESS_TOKEN_TTL = 8 * 3600;
/** Refresh tokens rotate and stay valid while used at least once every 30 days. */
const REFRESH_TOKEN_TTL = 30 * 86400;
/** Remembered consent: a client re-authorising within this window skips the page. */
const REMEMBER_CONSENT_S = 30 * 86400;

// ---------- identities ----------
/** What every MCP request carries in `ctx.props`. */
export interface McpProps {
  pid: string;
}
/** Grant metadata, stored in clear so the settings page can list connections without lookups. */
interface GrantMeta {
  client: string;
  domain: string | null;
  redirectHost: string;
  local: boolean;
}
export type OAuthEnv = Env & { OAUTH_KV: KVNamespace };
/** The Worker's env with D1KV standing in for the KV namespace the library expects. */
export const withOAuthStore = (env: Env): OAuthEnv => ({ ...env, OAUTH_KV: new D1KV(env.DB).asKVNamespace() });

export const publicOrigin = (env: Env, req?: Request) => env.PUBLIC_ORIGIN || (req ? new URL(req.url).origin : 'https://forklings.dev');
export const mcpResource = (origin: string) => `${origin}/mcp`;

// ---------- servers ----------
export type McpHandler = (req: Request, env: OAuthEnv, ctx: OAuthResourceContext<McpProps>) => Promise<Response>;
/** Validates a personal `fk_` token and returns its owner, or null. */
export type PersonalTokenLookup = (env: Env, token: string) => Promise<{ pid: string } | null>;

export interface OAuthServers {
  as: OAuthAuthorizationServer<OAuthEnv>;
  rs: OAuthResourceServer<OAuthEnv, McpProps>;
}

/** Build the authorization and resource servers for one public origin (memoised per origin). */
export function oauthServers(handler: McpHandler, personalToken: PersonalTokenLookup) {
  const cache = new Map<string, OAuthServers>();
  return (origin: string): OAuthServers => {
    const hit = cache.get(origin);
    if (hit) return hit;
    const resource = mcpResource(origin);
    const as = new OAuthAuthorizationServer<OAuthEnv>({
      issuer: origin,
      resources: [resource],
      defaultResource: resource,
      // offline_access is advertised so Claude Code asks for it; refresh tokens are issued either way.
      scopesSupported: [...ALL_SCOPES, 'offline_access'],
      clientIdMetadataDocumentEnabled: true,
      // Deprecated in the 2026 MCP spec but still what Pi uses by default, and older Claude Code and Codex fall back to it.
      clientRegistrationEndpoint: '/oauth/register',
      accessTokenTTL: ACCESS_TOKEN_TTL,
      refreshTokenTTL: REFRESH_TOKEN_TTL,
      refreshTokenIdleTTL: REFRESH_TOKEN_TTL,
    });
    const rs = new OAuthResourceServer<OAuthEnv, McpProps>({
      resourceMetadata: { resource, authorization_servers: [origin], resource_name: 'Forklings' },
      requiredScopes: DEFAULT_SCOPES,
      validateToken:
        (env) =>
        async (res, token): Promise<OAuthResourceTokenValidation<McpProps> | null> => {
          // Personal tokens are Forklings' own long-lived credentials for headless use (scripts,
          // the status line); they carry every scope. Everything else is an OAuth access token.
          if (token.startsWith('fk_')) {
            const owner = await personalToken(env, token);
            return owner ? { props: { pid: owner.pid }, audience: res, scope: [...ALL_SCOPES], userId: oauthUserId(owner.pid) } : null;
          }
          return as.validateToken<McpProps>(res, token, env);
        },
      handler: { fetch: handler },
    });
    const servers = { as, rs };
    cache.set(origin, servers);
    return servers;
  };
}

// ---------- connected apps ----------
export interface Connection {
  id: string;
  client: string;
  domain: string | null;
  redirectHost: string;
  local: boolean;
  scopes: string[];
  connectedAt: number;
  /** When its newest live access token was issued, if it holds one (ms). */
  lastActive: number | null;
}

function grantMeta(m: unknown): GrantMeta {
  return {
    client: String(prop(m, 'client') ?? 'Unknown app'),
    domain: typeof prop(m, 'domain') === 'string' ? String(prop(m, 'domain')) : null,
    redirectHost: String(prop(m, 'redirectHost') ?? ''),
    local: prop(m, 'local') === true,
  };
}

export async function listConnections(oauth: OAuthHelpers, env: OAuthEnv, pid: string): Promise<Connection[]> {
  const uid = oauthUserId(pid);
  const grants = await oauth.listUserGrants(uid, { limit: 100 });
  // Live access tokens are keyed token:<user>:<grant>:<id> and expire ACCESS_TOKEN_TTL after
  // issue, so one key listing (no values read) says when each connection last refreshed.
  const latest = new Map<string, number>();
  const tokens = await env.OAUTH_KV.list({ prefix: `token:${uid}:`, limit: 1000 });
  for (const k of tokens.keys) {
    const grantId = k.name.split(':')[2];
    if (grantId && k.expiration) latest.set(grantId, Math.max(latest.get(grantId) ?? 0, (k.expiration - ACCESS_TOKEN_TTL) * 1000));
  }
  return grants.items
    .map((g) => ({
      id: g.id,
      ...grantMeta(g.metadata),
      scopes: g.scope,
      connectedAt: g.createdAt * 1000,
      lastActive: latest.get(g.id) ?? null,
    }))
    .sort((a, b) => b.connectedAt - a.connectedAt);
}

/** Revoke one connection: its grant, refresh token and access tokens go at once. */
export async function revokeConnection(oauth: OAuthHelpers, pid: string, grantId: string): Promise<void> {
  await oauth.revokeGrant(grantId, oauthUserId(pid));
}

// ---------- /authorize ----------
export interface Signed {
  pid: string;
  handle: string;
  verified: boolean;
}
export interface ForklingCard {
  name: string;
  line: string;
  portrait: string | null;
}
export interface AuthorizeDeps {
  session(req: Request): Promise<Signed | null>;
  forkling(who: Signed): Promise<ForklingCard | null>;
  github: boolean;
  /** HMAC key for remembered consent; at least 32 characters. */
  consentSecret: string;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CSP = [
  "default-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('content-security-policy', CSP);
  h.set('x-frame-options', 'DENY');
  // same-origin, not no-referrer: the authorize query stays off other sites (the font host),
  // while the consent form's POST still carries a real Origin rather than `null`.
  h.set('referrer-policy', 'same-origin');
  return new Response(
    `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Forklings</title>
<meta name="theme-color" content="#271d3b">
<link rel="icon" href="/icon-192.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Atkinson+Hyperlegible+Next:wght@400;600;700&family=Pixelify+Sans:wght@400..700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="oauth">
<header class="top"><a class="brand" href="/">Forklings</a></header>
<main class="consent">
${body}
</main>
</body>
</html>`,
    { status, headers: h },
  );
}

function errorPage(message: string, status = 400): Response {
  return page(
    "Couldn't connect",
    `<div class="panel consent-box"><h1>That didn't work</h1><p>${esc(message)}</p><p class="small dim">Start connecting again from your app. If it keeps happening, the app may need updating.</p></div>`,
    status,
  );
}

function appLine(d: ConsentDescription): string {
  if (d.clientDomain)
    return `<p class="app-id"><span class="badge">verified</span> Published by <strong>${esc(d.clientDomain)}</strong>.</p>`;
  return `<p class="app-id"><span class="badge warn">unverified</span> This app named itself “${esc(d.clientName)}”. Forklings can't check that name.</p>`;
}

function redirectLine(d: ConsentDescription): string {
  if (d.redirectIsLoopback)
    return `<p class="small">Access goes to <code>${esc(d.redirectHost)}</code>, an app on your computer. Continue only if you just started connecting from your terminal or editor.</p>`;
  return `<p class="small">Access goes to <code>${esc(d.redirectHost)}</code>.</p>`;
}

function signInPage(d: ConsentDescription, authorizeUrl: string, github: boolean): Response {
  const next = `/authorize${new URL(authorizeUrl).search}`;
  const action = github
    ? `<a class="btn" href="/auth/github?next=${esc(encodeURIComponent(next))}">Sign in with GitHub</a>
       <p class="small dim">GitHub is used for your name only. Forklings never reads your repos or activity.</p>`
    : `<p>Sign in at <a href="/">forklings.dev</a> first, then start connecting again.</p>`;
  return page(
    'Sign in',
    `<div class="panel consent-box">
  <h1>Sign in to connect <span class="hl">${esc(d.clientName)}</span></h1>
  ${appLine(d)}
  <p>Sign in to Forklings, then choose what it may do with your Forkling.</p>
  ${action}
</div>`,
  );
}

function consentPage(d: ConsentDescription, consentHandle: string, who: Signed, pet: ForklingCard | null, headers: Headers): Response {
  const requested = new Set(d.scope.filter(isScope));
  // A client that asks for nothing (or only offline_access) gets the default set.
  const shown = requested.size ? [...requested] : DEFAULT_SCOPES;
  // pet:read is the baseline: without it no tool works, so it's always granted.
  if (!shown.includes('pet:read')) shown.unshift('pet:read');
  const box = (s: Scope) =>
    s === 'pet:read'
      ? `<li><input type="hidden" name="scope" value="pet:read"><span class="tick" aria-hidden="true">✔</span> ${esc(SCOPES[s])}</li>`
      : `<li><label><input type="checkbox" name="scope" value="${esc(s)}" checked> ${esc(SCOPES[s])}</label></li>`;
  const care = shown.filter((s) => !COACH_SCOPES.includes(s));
  const coach = shown.filter((s) => COACH_SCOPES.includes(s));
  const keep = d.scope.includes('offline_access') ? '<input type="hidden" name="scope" value="offline_access">' : '';
  const petBlock = pet
    ? `<div class="pet">${pet.portrait ? `<img src="data:image/png;base64,${pet.portrait}" width="96" height="96" alt="">` : ''}<div><strong>${esc(pet.name)}</strong><div class="small dim">${esc(pet.line)}</div></div></div>`
    : `<p class="small dim">You haven't hatched a Forkling yet. You can connect now, and it will see your Forkling once you hatch one at forklings.dev.</p>`;
  return page(
    `Connect ${d.clientName}`,
    `<div class="panel consent-box">
  <h1>Connect <span class="hl">${esc(d.clientName)}</span> to ${pet ? esc(pet.name) : 'your Forkling'}?</h1>
  ${appLine(d)}
  ${petBlock}
  <form method="post" action="/authorize">
    <input type="hidden" name="consent" value="${esc(consentHandle)}">${keep}
    <fieldset><legend>It will be able to</legend><ul class="scopes">${care.map(box).join('')}</ul></fieldset>
    ${coach.length ? `<fieldset class="coach"><legend>Coaching</legend><ul class="scopes">${coach.map(box).join('')}</ul><p class="small dim">Untick to keep the strategy in your own hands.</p></fieldset>` : ''}
    ${redirectLine(d)}
    <p class="small dim">No permission lets an app pick ranked opponents or act during a battle. Signed in as <strong>@${esc(who.handle)}</strong>. Disconnect any time under API on forklings.dev.</p>
    <div class="row"><button class="btn" type="submit" name="decision" value="approve">Connect</button><button class="btn ghost" type="submit" name="decision" value="deny">Cancel</button></div>
  </form>
</div>`,
    200,
    headers,
  );
}

async function complete(oauth: OAuthHelpers, request: AuthRequest, d: ConsentDescription, who: Signed, scope: string[]) {
  const meta: GrantMeta = {
    client: d.clientName,
    domain: d.clientDomain ?? null,
    redirectHost: d.redirectHost,
    local: d.redirectIsLoopback,
  };
  return oauth.completeAuthorization({
    request,
    userId: oauthUserId(who.pid),
    metadata: meta,
    scope,
    props: { pid: who.pid } satisfies McpProps,
  });
}

/** GET shows sign-in or consent; POST takes the decision. */
export async function authorize(
  req: Request,
  env: OAuthEnv,
  as: OAuthAuthorizationServer<OAuthEnv>,
  deps: AuthorizeDeps,
): Promise<Response> {
  const oauth = as.getOAuthApi(env);
  try {
    if (req.method === 'POST') {
      // The consent handle is tied to a SameSite cookie already; refusing other origins outright
      // also stops a cross-site form from approving on a signed-in player's behalf.
      const from = req.headers.get('origin');
      if (from && from !== publicOrigin(env, req)) return errorPage('That request came from another site, so it was refused.', 403);
      const who = await deps.session(req);
      if (!who) return errorPage('Your Forklings session ended. Start connecting again from your app.', 401);
      const form = await req.formData();
      const consentHandle = String(form.get('consent') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(req, consentHandle, { description: 'The player cancelled.' });
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = approvedScopes(form.getAll('scope').map(String));
      const remember = { secret: deps.consentSecret, subject: who.pid, maxAgeSeconds: REMEMBER_CONSENT_S };
      const approved = await oauth.approveConsent(req, consentHandle, { scope, remember });
      const d = await oauth.describeConsent(approved.request);
      const { redirectTo } = await complete(oauth, approved.request, d, who, approved.request.scope);
      approved.headers.set('location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    if (req.method !== 'GET') return errorPage('Use GET or POST here.', 405);

    const request = await oauth.parseAuthRequest(req);
    // describeConsent first: if the client can't be resolved, nothing is stored.
    const d = await oauth.describeConsent(request);
    const who = await deps.session(req);
    if (!who) return signInPage(d, req.url, deps.github);
    if (await oauth.isConsentRemembered(req, request, { secret: deps.consentSecret, subject: who.pid })) {
      const { redirectTo } = await complete(oauth, request, d, who, approvedScopes(request.scope));
      return new Response(null, { status: 302, headers: { location: redirectTo, 'cache-control': 'no-store' } });
    }
    const consent = await oauth.beginConsent(request);
    return consentPage(d, consent.handle, who, await deps.forkling(who), consent.headers);
  } catch (e) {
    if (e instanceof AuthorizationError) {
      // Redirect only once the client and its redirect URI are validated; otherwise render here.
      if (e.redirectTo) return new Response(null, { status: 302, headers: { location: e.redirectTo, 'cache-control': 'no-store' } });
      return errorPage(e.description || 'That sign-in request is not valid, or it expired.');
    }
    if (e instanceof CimdFetchError) return errorPage("Forklings couldn't fetch this app's details, so it can't tell who is asking.");
    throw e;
  }
}
