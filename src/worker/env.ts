import type { PlayerDO } from './player';
import type { BattleDO } from './battle';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PLAYER: DurableObjectNamespace<PlayerDO>;
  BATTLE: DurableObjectNamespace<BattleDO>;
  HATCH_SALT: string;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  PUBLIC_ORIGIN?: string;
  DEMO_LOGIN?: string; // "on" (default) or "off"
}
