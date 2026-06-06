import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { TfsClient } from './tfs-client.js';
import { allTools } from './tools/index.js';
import { formatErrorResponse } from './formatting/markdown.js';

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

/**
 * Process image name shown by monitoring tools instead of the generic "node".
 * No tier suffix (unlike the memory plugin): the TFS server loads no model, so the
 * name is static. No "claude-code" prefix either — the server already runs *under*
 * the Claude Code process.
 */
const PROCESS_NAME = 'yoannyviquel_microsoft-tfs';

/**
 * Windows: make the server run under a "yoannyviquel_microsoft-tfs.exe" image name instead of "node.exe".
 *
 * Done at server startup (not in postinstall) on purpose: Claude Code installs plugin deps with
 * `npm install --ignore-scripts`, so postinstall never runs at install — but the MCP server is
 * always launched, which makes startup the only reliable hook.
 *
 * The current process can't rename itself, so we self-heal for the NEXT launch: copy the running
 * node binary to <pluginRoot>/bin/<name>.exe and repoint .mcp.json#command at it. After the standard
 * post-install `/reload-plugins`, the server relaunches from the renamed copy. Entirely best-effort
 * and cosmetic: the committed command stays "node", so a failure here never blocks start.
 */
function ensureNamedBinary(name: string): void {
  if (process.env.TFS_DISABLE_RENAME === '1') return; // tests / dev: don't copy the exe or touch .mcp.json
  if (process.platform !== 'win32') return; // Linux/macOS CLI is already covered by process.title
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path.resolve(path.dirname(scriptPath), '..'); // <root>/dist/server.js → <root>
    const binDir = path.join(root, 'bin');
    const exe = path.join(binDir, `${name}.exe`);

    if (path.basename(process.execPath).toLowerCase() === `${name}.exe`) return; // already named

    if (!existsSync(exe)) {
      mkdirSync(binDir, { recursive: true });
      copyFileSync(process.execPath, exe); // ~85 MB, one-time (until node upgrades)
    }

    // Prune orphan copies (e.g. left over from a node upgrade). Skip the running exe and the target.
    try {
      const running = path.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith('yoannyviquel_microsoft-tfs') && low.endsWith('.exe') && low !== `${name}.exe` && low !== running) {
          unlinkSync(path.join(binDir, f));
        }
      }
    } catch {
      /* best-effort prune */
    }

    const mcpPath = path.join(root, '.mcp.json');
    const desired = '${CLAUDE_PLUGIN_ROOT}/bin/' + name + '.exe';
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    if (mcp?.mcpServers?.tfs && mcp.mcpServers.tfs.command !== desired) {
      mcp.mcpServers.tfs.command = desired;
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
    }
  } catch {
    /* best-effort: cosmetic rename must never block startup */
  }
}

async function main(): Promise<void> {
  try {
    process.title = PROCESS_NAME; // Linux/macOS: rewrites the cmdline (ps; top/htop/comm cap at 15 chars)
  } catch {
    /* best-effort: never block startup on a cosmetic rename */
  }
  ensureNamedBinary(PROCESS_NAME);
  const config = loadConfig();
  const client = new TfsClient(config);
  const ctx = { client };

  const server = new Server(
    { name: 'microsoft-tfs', version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `❌ Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const text = formatErrorResponse(`the execution of ${tool.name}`, err);
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`microsoft-tfs v${PKG_VERSION} ready (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
