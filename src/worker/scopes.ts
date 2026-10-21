// OAuth scopes for MCP clients and the small pure helpers around them. Kept apart from
// oauth.ts so tests can load them without the Workers runtime (the OAuth library imports
// `cloudflare:workers`).

/**
 * The seven scopes from the architecture proposal (§8). None of them lets a client choose
 * ranked opponents or act during a battle: coach, don't control.
 */
export const SCOPES = {
  'pet:read': 'See your Forkling: its needs, mood, level and wardrobe',
  'pet:care': 'Feed, play with, pat or nap your Forkling',
  'strategy:read': 'Read its battle strategy',
  'battle:read': 'Read its recent battles and results',
  'battle:spar': 'Start unranked practice battles. They cost energy like any battle and never change its rating',
  'strategy:write': 'Change its battle strategy: tactics or a strategy script',
  'battle:simulate': 'Dry-run strategies against the house gauntlet. Nothing is saved',
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const isScope = (s: string): s is Scope => s in SCOPES;

/** Coaching scopes: the consent page shows them as their own, named choice. */
export const COACH_SCOPES: readonly Scope[] = ['strategy:write', 'battle:simulate'];
/** Granting a broader scope grants these too (the MCP spec asks servers to honour hierarchies). */
const IMPLIES: Partial<Record<Scope, Scope[]>> = { 'strategy:write': ['strategy:read'] };

/**
 * What a client asks for by default: every scope an MCP tool uses today, so one sign-in
 * covers the whole plugin. It's the 401 challenge's `scope` and the resource metadata's
 * `scopes_supported`, which Claude Code, Codex and Pi request. (battle:simulate has no tool
 * yet, so nobody is asked for it.) A tool needing an ungranted scope sends the player back
 * through sign-in, so asking for everything once, with each box untickable, is kinder.
 */
export const DEFAULT_SCOPES: Scope[] = ['pet:read', 'pet:care', 'strategy:read', 'strategy:write', 'battle:read', 'battle:spar'];

/** Every scope a token effectively has, hierarchy applied. Unknown scopes are ignored. */
export function effectiveScopes(granted: readonly string[]): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted)
    if (isScope(s)) {
      out.add(s);
      for (const t of IMPLIES[s] ?? []) out.add(t);
    }
  return out;
}

/** The scopes a player approved: known ones (and offline_access) only, with pet:read always in. */
export function approvedScopes(list: readonly string[]): string[] {
  const out = new Set(list.filter((s) => isScope(s) || s === 'offline_access'));
  out.add('pet:read');
  return [...out];
}

/** The library forbids ':' in user IDs (it separates token parts); player IDs are `gh:123`. */
export const oauthUserId = (pid: string) => encodeURIComponent(pid);

/** Whether `next` is a /authorize URL on this site, the only place sign-in may send a player back to. */
export function isAuthorizeReturn(next: unknown): next is string {
  // A path-absolute URL that starts "/authorize?" can only resolve to this origin.
  return typeof next === 'string' && next.length < 4096 && /^\/authorize\?[^\s\\]*$/.test(next);
}
