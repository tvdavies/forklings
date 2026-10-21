// CI check for the Claude Code marketplace and plugin manifests: that they parse,
// that names and paths line up, and that the MCP server points at production.
// Locally, `claude plugin validate --strict .` does the full check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exitCode = 1;
};

const market = read('.claude-plugin/marketplace.json');
if (!market.name || !market.owner?.name || !Array.isArray(market.plugins)) fail('marketplace.json needs name, owner.name and plugins');
for (const entry of market.plugins) {
  const root = entry.source;
  if (typeof root !== 'string' || !root.startsWith('./') || root.includes('..'))
    fail(`${entry.name}: source must be a ./ path inside the repo`);
  const manifest = read(join(root, '.claude-plugin/plugin.json'));
  if (manifest.name !== entry.name) fail(`${entry.name}: plugin.json name is "${manifest.name}"`);
  const mcp = read(join(root, '.mcp.json'));
  for (const [name, server] of Object.entries(mcp.mcpServers ?? {})) {
    if (server.type !== 'http' || !server.url?.startsWith('https://')) fail(`${name}: expected an https streamable HTTP server`);
    for (const ref of JSON.stringify(server).matchAll(/\$\{user_config\.(\w+)\}/g))
      if (!manifest.userConfig?.[ref[1]]) fail(`${name}: uses undeclared user_config.${ref[1]}`);
  }
  for (const f of ['commands/forkling.md', 'statusline/forkling-status.sh'])
    if (!existsSync(join(root, f))) fail(`${entry.name}: missing ${f}`);
}
if (!process.exitCode) console.log('✔ plugin manifests look right');
