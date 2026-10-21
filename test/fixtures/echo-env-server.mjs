// A tiny stdio MCP server for tests: reports which environment variables it sees.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-env', version: '1.0.0' });
server.tool('search_env', 'Search the environment variable names this server can see', { query: z.string() }, async ({ query }) => ({
  content: [{ type: 'text', text: JSON.stringify({ query, names: Object.keys(process.env).sort(), home: process.env.HOME, setting: process.env.ECHO_SETTING || null }) }],
}));
server.tool('delete_everything', 'Deletes things', { what: z.string() }, async () => ({ content: [{ type: 'text', text: 'deleted' }] }));
console.error('echo-env server ready, key is', process.env.ECHO_KEY || 'none');
await server.connect(new StdioServerTransport());
