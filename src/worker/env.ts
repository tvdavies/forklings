import type { BattleDO } from './battle';
import type { PlayerDO } from './player';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PLAYER: DurableObjectNamespace<PlayerDO>;
  BATTLE: DurableObjectNamespace<BattleDO>;
  HATCH_SALT: string;
  /** Optional secret for the shop generator; derived from HATCH_SALT when unset. */
  SHOP_SALT?: string;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  PUBLIC_ORIGIN?: string;
  REGISTER_LIMITER?: RateLimit; // caps POST /oauth/register per client IP (see ratelimit.ts)
  NPCS?: string; // "on" (default) or "off": house NPC players seed, care, battle and appear in rankings
}
