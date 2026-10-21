// Runs the whole end-to-end suite (run.ts, then oauth.ts) against a throwaway local Worker,
// with no GitHub OAuth app and nothing touching forklings.dev.
//
// It starts `wrangler dev` on a fresh local D1 and Durable Object store in a temporary
// directory, with its own random secrets, then sets up what production already has:
// - house NPCs, by firing the cron once (they're seeded on the schedule, not at start-up);
// - signed-in GitHub players: the players row that the GitHub callback writes at sign-in,
//   and an fk_session cookie signed with the run's SESSION_SECRET.
// A session cookie on its own isn't a whole player: without that row the player is left off
// the leaderboard and their API tokens are refused, as they would be for a retired account.
//
// wrangler.jsonc pins local dev to localhost:8787, so that port must be free.
//
//   CHROMIUM=/usr/bin/chromium bun test/e2e/local.ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSession } from '../../src/worker/auth';

const BASE = 'http://localhost:8787';
const state = mkdtempSync(join(tmpdir(), 'forklings-e2e-'));
const local = ['--local', '--persist-to', state];
// Passed with --env-file, which wins over any .dev.vars, so a developer's own secrets are never used.
const envFile = join(state, 'dev.vars');
const SESSION_SECRET = randomBytes(32).toString('hex');
writeFileSync(envFile, `HATCH_SALT=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${SESSION_SECRET}\nPUBLIC_ORIGIN=${BASE}\n`);

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
}
/** Set-up steps stay quiet unless they fail. */
function must(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed\n${r.stdout}${r.stderr}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A GitHub player as sign-in leaves them: a players row (verified, with a year-old GitHub
 * account so they're ranked) and a session cookie. The id is made up and never reaches GitHub.
 */
async function newPlayer(): Promise<string> {
  const pid = `gh:${900000000 + Math.floor(Math.random() * 99999999)}`;
  const handle = `e2e-${randomBytes(3).toString('hex')}`;
  const now = Date.now();
  const sql = `INSERT INTO players (pid, handle, verified, created_at, updated_at, gh_created_at) VALUES ('${pid}', '${handle}', 1, ${now}, ${now}, ${now - 365 * 86400e3})`;
  must('npx', ['wrangler', 'd1', 'execute', 'forklings-db', ...local, '--command', sql]);
  return signSession({ SESSION_SECRET } as Parameters<typeof signSession>[0], { pid, h: handle, exp: now + 86400e3 });
}

let dev: ChildProcess | undefined;
let devLog = '';
let code = 1;
try {
  if (
    await fetch(BASE).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`Something is already listening on ${BASE}. Stop it first.`);
  must('node', ['scripts/build.mjs']);
  must('npx', ['wrangler', 'd1', 'migrations', 'apply', 'forklings-db', ...local]);
  dev = spawn(
    'npx',
    ['wrangler', 'dev', ...local.slice(1), '--env-file', envFile, '--test-scheduled', '--show-interactive-dev-session=false'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1' } },
  );
  dev.stdout?.on('data', (d) => {
    devLog += d;
  });
  dev.stderr?.on('data', (d) => {
    devLog += d;
  });
  await until('wrangler dev to start', async () => (await fetch(`${BASE}/api/config`)).ok);

  // House NPCs: one cron tick seeds them.
  await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  await until('the house NPCs to be seeded', async () => {
    const r = (await (await fetch(`${BASE}/api/leaderboard`)).json()) as { npcs: object[] };
    return r.npcs.length > 0;
  });

  // Each script plays a new player, so one's care cooldowns and tired pet don't trip the other.
  const browser = run('bun', ['test/e2e/run.ts', BASE], { FORKLINGS_SESSION: await newPlayer() });
  const oauth = run('bun', ['test/e2e/oauth.ts', BASE], { FORKLINGS_SESSION: await newPlayer() });
  code = browser || oauth;
  console.log(code ? '\nThe local end-to-end suite failed' : '\nThe local end-to-end suite passed');
} catch (e) {
  console.error((e as Error).message);
  if (devLog) console.error(`\nwrangler dev output:\n${devLog.slice(-4000)}`);
} finally {
  try {
    // detached, so this stops wrangler and the workerd it started
    if (dev?.pid) process.kill(-dev.pid, 'SIGTERM');
  } catch {}
  await sleep(500);
  rmSync(state, { recursive: true, force: true });
}
process.exit(code);
