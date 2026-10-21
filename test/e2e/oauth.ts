// End-to-end check of OAuth for MCP clients against a running Worker, normally a local
// `wrangler dev`. It plays both sides: the MCP client is the official MCP TypeScript SDK
// (discovery, registration, PKCE, token exchange), and the "browser" is fetch with a cookie
// jar, so it runs in CI-like places without a display. With CHROMIUM set, it also screenshots
// the consent page and the connected-apps list into test/e2e/out/.
//
// Signing in needs GitHub, so it plays as the player whose session you pass: copy the value of
// the fk_session cookie from a browser signed in to the same server.
//
//   FORKLINGS_SESSION=<fk_session> bun test/e2e/oauth.ts http://localhost:8787
//   CHROMIUM=/usr/bin/chromium FORKLINGS_SESSION=<fk_session> bun test/e2e/oauth.ts http://localhost:8787
import { mkdirSync } from 'node:fs';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const MCP = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
const OUT = 'test/e2e/out';

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✘ ${name}\n  ${(e as Error).message.split('\n').slice(0, 3).join('\n  ')}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------- a browser, as far as cookies go ----------
class Browser {
  jar = new Map<string, string>();
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('cookie', this.cookieHeader());
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(i + 1) === '';
      if (gone) this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1));
    }
    return res;
  }
}

// ---------- an MCP client's token store ----------
class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authUrl?: URL;
  constructor(readonly scope?: string) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Forklings E2E',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const rpc = (method: string, params: object = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
async function mcpRaw(token: string, method: string, params: object = {}) {
  return fetch(MCP, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: rpc(method, params),
  });
}
async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams(form) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

/** Approve the consent page in `b` with the given scopes; returns the redirect back to the client. */
async function approve(b: Browser, html: string, scopes: string[], origin = BASE) {
  const form = new URLSearchParams({ consent: hidden(html, 'consent') ?? '', decision: 'approve' });
  for (const s of scopes) form.append('scope', s);
  return b.fetch(`${BASE}/authorize`, { method: 'POST', body: form, headers: { origin } });
}

// ---------- the run ----------
const SESSION = process.env.FORKLINGS_SESSION ?? '';
if (!SESSION) {
  console.error('Set FORKLINGS_SESSION to the fk_session cookie of a signed-in player.');
  process.exit(1);
}
const browser = new Browser();
browser.jar.set('fk_session', SESSION);
let handle = '';
const provider = new MemoryProvider();
let consentHtml = '';
let access = '';
let refresh = '';
let personal = '';

await step('discovery: 401 names the resource metadata and default scopes', async () => {
  const res = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc('initialize') });
  expect(res.status === 401, `expected 401, got ${res.status}`);
  const h = res.headers.get('www-authenticate') ?? '';
  expect(h.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), `challenge: ${h}`);
  expect(h.includes('scope="pet:read pet:care strategy:read strategy:write battle:read battle:spar"'), `scope: ${h}`);
  const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  expect(prm.resource === MCP, 'resource is the /mcp URL');
  const asm = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(asm.client_id_metadata_document_supported === true, 'CIMD advertised');
  expect(String(asm.registration_endpoint).endsWith('/oauth/register'), 'DCR advertised');
  expect((asm.code_challenge_methods_supported as string[]).join() === 'S256', 'S256 only');
});

await step('other discovery documents 404 as JSON, not the app shell', async () => {
  const res = await fetch(`${BASE}/.well-known/openid-configuration`);
  expect(res.status === 404, `got ${res.status}`);
});

await step('the GitHub session is signed in, with a Forkling', async () => {
  const r = await browser.fetch(`${BASE}/api/me`);
  expect(r.ok, `session ${r.status}`);
  const me = (await r.json()) as { session: { handle: string }; creature: unknown };
  handle = me.session.handle;
  if (me.creature) return;
  const h = await browser.fetch(`${BASE}/api/hatch`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(h.ok, `hatch ${h.status}`);
});

await step('the SDK client registers itself and is sent to /authorize with PKCE', async () => {
  const client = new Client({ name: 'forklings-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  await client.connect(transport).then(
    () => {
      throw new Error('connected without signing in');
    },
    (e: Error) => expect(e.name === 'UnauthorizedError' || /Unauthorized/.test(e.message), e.message),
  );
  const u = provider.authUrl;
  expect(u, 'no authorization URL');
  expect(u.pathname === '/authorize', u.toString());
  expect(u.searchParams.get('code_challenge_method') === 'S256', 'S256');
  expect(u.searchParams.get('resource') === MCP, `resource=${u.searchParams.get('resource')}`);
  expect(provider.info?.client_id, 'registered');
});

await step('signed out, /authorize offers GitHub-free sign-in guidance and names the app', async () => {
  const res = await new Browser().fetch(String(provider.authUrl));
  const html = await res.text();
  expect(res.status === 200, `status ${res.status}`);
  expect(html.includes('Sign in to connect') && html.includes('Forklings E2E'), 'sign-in page');
  expect(html.includes('unverified'), 'self-named client flagged unverified');
});

await step('signed in, the consent page shows the app, the Forkling and the scopes', async () => {
  const res = await browser.fetch(String(provider.authUrl));
  consentHtml = await res.text();
  expect(res.status === 200, `status ${res.status}`);
  expect(res.headers.get('x-frame-options') === 'DENY', 'not frameable');
  for (const s of ['Connect', 'Forklings E2E', `@${handle}`, '127.0.0.1', 'Coaching', 'strategy:write', 'data:image/png;base64,'])
    expect(consentHtml.includes(s), `consent page lacks ${s}`);
  expect(hidden(consentHtml, 'consent'), 'consent handle');
});

await step('a cross-site POST to /authorize is refused', async () => {
  const res = await approve(browser, consentHtml, ['pet:read'], 'https://evil.example');
  expect(res.status === 403, `got ${res.status}`);
});

await step('approving without coaching returns a code, and PKCE exchanges it', async () => {
  // Untick strategy:write: the player keeps the strategy in their own hands.
  const res = await approve(browser, consentHtml, ['pet:read', 'pet:care', 'strategy:read', 'battle:read', 'battle:spar']);
  expect(res.status === 302, `got ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const back = new URL(res.headers.get('location') ?? '');
  expect(back.origin + back.pathname === REDIRECT, `redirected to ${back}`);
  expect(back.searchParams.get('iss') === BASE, 'RFC 9207 iss');
  const code = back.searchParams.get('code');
  expect(code, 'code');
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  await transport.finishAuth(code);
  access = provider.saved?.access_token ?? '';
  refresh = provider.saved?.refresh_token ?? '';
  expect(access && refresh, 'tokens');
  expect(provider.saved?.scope?.split(' ').includes('strategy:write') === false, `scope ${provider.saved?.scope}`);
});

await step('the client lists only the tools its scopes allow, and they work', async () => {
  const client = new Client({ name: 'forklings-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools.join() === 'care_for_forkling,get_forkling,get_strategy,list_battles,practice_battle', tools.join());
  const pet = await client.callTool({ name: 'get_forkling', arguments: {} });
  expect(!pet.isError && JSON.stringify(pet.content).includes(`@${handle}`), JSON.stringify(pet.content).slice(0, 200));
  const care = await client.callTool({ name: 'care_for_forkling', arguments: { action: 'pat' } });
  expect(!care.isError, JSON.stringify(care.content).slice(0, 200));
  await client.close();
});

await step('a tool outside the grant gets 403 insufficient_scope asking for the union', async () => {
  const res = await mcpRaw(access, 'tools/call', { name: 'set_strategy', arguments: { tactics: { aggression: 70 } } });
  expect(res.status === 403, `got ${res.status}`);
  const h = res.headers.get('www-authenticate') ?? '';
  expect(h.includes('error="insufficient_scope"'), h);
  expect(/scope="[^"]*strategy:write[^"]*"/.test(h) && /scope="[^"]*pet:care[^"]*"/.test(h), h);
});

await step('a token for this resource is not accepted by the JSON API', async () => {
  const res = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${access}` } });
  expect(res.status === 401, `got ${res.status}`);
});

await step('the refresh token rotates, and the old one is retired', async () => {
  const client_id = provider.info?.client_id ?? '';
  const one = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id });
  expect(one.status === 200, JSON.stringify(one.body));
  const next = String(one.body.refresh_token);
  expect(next && next !== refresh, 'rotated');
  // The library keeps the previous refresh token for one more use (a retry after a lost
  // response); the new one must work and the one before it must then stop.
  const two = await tokenRequest({ grant_type: 'refresh_token', refresh_token: next, client_id });
  expect(two.status === 200, JSON.stringify(two.body));
  const old = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id });
  expect(old.status === 400, `old refresh token still works: ${JSON.stringify(old.body)}`);
  access = String(two.body.access_token);
  refresh = String(two.body.refresh_token);
  expect((await mcpRaw(access, 'tools/list')).status === 200, 'refreshed token works');
});

await step('re-connecting the same app asks again only for what was not approved', async () => {
  const again = new MemoryProvider();
  again.info = provider.info;
  const client = new Client({ name: 'forklings-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: again })).catch(() => {});
  // The default request includes strategy:write, which the player unticked: ask again.
  const asked = await browser.fetch(String(again.authUrl));
  expect(asked.status === 200 && (await asked.text()).includes('Coaching'), `got ${asked.status}`);
  // The same scopes as before, within 30 days: straight back to the app.
  const u = new URL(String(again.authUrl));
  u.searchParams.set('scope', 'pet:read pet:care strategy:read battle:read battle:spar');
  const res = await browser.fetch(String(u));
  expect(res.status === 302, `got ${res.status}`);
  expect((res.headers.get('location') ?? '').startsWith(REDIRECT), 'straight back to the app');
  // Use the code, so it doesn't sit as a second connection.
  await new StreamableHTTPClientTransport(new URL(MCP), { authProvider: again }).finishAuth(
    new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '',
  );
});

let grantId = '';
await step('the website lists connected apps with their permissions', async () => {
  const res = await browser.fetch(`${BASE}/api/connections`);
  const body = (await res.json()) as {
    connections: { id: string; client: string; local: boolean; domain: string | null; scopes: string[] }[];
  };
  expect(res.status === 200, `got ${res.status}`);
  const mine = body.connections.filter((c) => c.client === 'Forklings E2E');
  expect(mine.length >= 1, JSON.stringify(body));
  expect(
    mine.every((c) => c.local && c.domain === null),
    'loopback, unverified',
  );
  grantId = mine[mine.length - 1].id;
  expect(mine[mine.length - 1].scopes.includes('pet:care') && !mine[mine.length - 1].scopes.includes('strategy:write'), 'scopes');
});

await step('a personal token can create, but not list, connections', async () => {
  const r = await browser.fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e' }),
  });
  personal = String(((await r.json()) as { token: string }).token);
  expect(personal.startsWith('fk_'), 'fk_ token');
  const list = await fetch(`${BASE}/api/connections`, { headers: { authorization: `Bearer ${personal}` } });
  expect(list.status === 403, `got ${list.status}`);
});

await step('a personal token still works on /mcp with every tool', async () => {
  const res = await mcpRaw(personal, 'tools/list');
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(res.status === 200 && body.result.tools.length === 6, JSON.stringify(body).slice(0, 200));
});

await step('disconnecting an app stops its tokens at once', async () => {
  // Disconnect every E2E connection, the remembered-consent one included.
  const all = (await (await browser.fetch(`${BASE}/api/connections`)).json()) as { connections: { id: string; client: string }[] };
  for (const c of all.connections.filter((c) => c.client === 'Forklings E2E')) {
    const r = await browser.fetch(`${BASE}/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE', headers: { origin: BASE } });
    expect(r.ok, `revoke ${r.status}`);
  }
  expect(grantId, 'had a grant');
  expect((await mcpRaw(access, 'tools/list')).status === 401, 'access token still works');
  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: provider.info?.client_id ?? '' });
  expect(r.status === 400, `refresh still works: ${JSON.stringify(r.body)}`);
  const left = (await (await browser.fetch(`${BASE}/api/connections`)).json()) as { connections: unknown[] };
  expect(left.connections.length === 0, JSON.stringify(left));
});

await step('a bad redirect URI is shown an error here, never redirected', async () => {
  const u = new URL(String(provider.authUrl));
  u.searchParams.set('redirect_uri', 'https://evil.example/cb');
  const res = await browser.fetch(String(u));
  expect(res.status === 400, `got ${res.status}`);
  expect(!res.headers.get('location'), 'redirected');
});

await step('an unreachable client metadata document is an error page', async () => {
  const u = new URL(String(provider.authUrl));
  u.searchParams.set('client_id', 'https://forklings-e2e.invalid/client.json');
  u.searchParams.set('redirect_uri', 'https://forklings-e2e.invalid/cb');
  const res = await browser.fetch(String(u));
  expect(res.status >= 400 && !res.headers.get('location'), `got ${res.status}`);
});

await step('an unknown scope is never shown or granted', async () => {
  const u = new URL(String(provider.authUrl));
  u.searchParams.set('scope', 'pet:read admin');
  const res = await browser.fetch(String(u));
  const html = await res.text();
  expect(res.status === 200 && !html.includes('admin'), `got ${res.status}`);
  const r = await approve(browser, html, ['pet:read', 'admin']);
  const code = new URL(r.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const t = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: provider.info?.client_id ?? '',
    code_verifier: provider.verifier,
  });
  expect(t.status === 200 && t.body.scope === 'pet:read', JSON.stringify(t.body));
  // Tidy up the connection it made.
  const all = (await (await browser.fetch(`${BASE}/api/connections`)).json()) as { connections: { id: string }[] };
  for (const c of all.connections) await browser.fetch(`${BASE}/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
});

// ---------- screenshots ----------
if (process.env.CHROMIUM) {
  await step('screenshots of the consent page and the connected-apps list', async () => {
    const { chromium } = await import('playwright-core');
    mkdirSync(OUT, { recursive: true });
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM });
    const ctx = await b.newContext({ viewport: { width: 760, height: 1100 } });
    // Only the session: the remembered-consent cookie would skip the page being photographed.
    await ctx.addCookies([{ name: 'fk_session', value: browser.jar.get('fk_session') ?? '', url: BASE }]);
    const p = await ctx.newPage();
    const shotProvider = new MemoryProvider();
    shotProvider.info = undefined;
    const client = new Client({ name: 'forklings-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: shotProvider })).catch(() => {});
    await p.goto(String(shotProvider.authUrl));
    await p.screenshot({ path: `${OUT}/oauth-consent.png`, fullPage: true });
    // Approve in the real browser, then show the list.
    const post = p.waitForResponse((r) => r.url() === `${BASE}/authorize` && r.request().method() === 'POST');
    // Nothing listens on the callback port, so the browser's trip back to the app fails.
    const back = p.waitForEvent('requestfailed', (r) => r.url().startsWith(REDIRECT));
    await p.click('button[value=approve]');
    const done = await post;
    expect(done.status() === 302 && (done.headers().location ?? '').startsWith(REDIRECT), `approve: ${done.status()}`);
    await back;
    // A fresh tab: the failed callback leaves Chrome's error page loading in this one.
    const s = await ctx.newPage();
    await s.goto(`${BASE}/#api`);
    await s.locator('#connList li .res').first().waitFor();
    await s.locator('#connList').scrollIntoViewIfNeeded();
    await s.screenshot({ path: `${OUT}/oauth-connected-apps.png`, fullPage: true });
    await b.close();
  });
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
