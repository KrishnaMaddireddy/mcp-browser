#!/usr/bin/env node
// Run MCP Browser as an MCP server over stdio, for Claude Desktop / Claude Code.
//   claude mcp add mcp-browser -- node /path/to/mcp-browser/bin/mcp-server.js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../src/mcp-server.js';

const { server, engine } = createMcpServer();
const info = engine.registryInfo();
if (!info.syncedAt || info.stale || Date.now() - Date.parse(info.syncedAt) > 24 * 3600_000) {
  engine.syncRegistry({ full: !info.syncedAt }).catch((e) => console.error('registry sync failed:', e.message));
} else engine.buildEmbeddings();
await server.connect(new StdioServerTransport());
const stop = async () => {
  await engine.close();
  process.exit(0);
};
process.stdin.on('close', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
