import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { TfsClient } from './tfs-client.js';
import { allTools } from './tools/index.js';
import { formatErrorResponse } from './formatting/markdown.js';

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

async function main(): Promise<void> {
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
