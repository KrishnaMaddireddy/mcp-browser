// Try MCP server mode the way Claude sees it: node scripts/try-mcp.js "question" ...
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const { createMcpServer } = await import('../src/mcp-server.js');
const { server, engine } = createMcpServer();
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: 'me', version: '1' });
await c.connect(b);
for (const q of process.argv.slice(2)) {
  const t0 = Date.now();
  const r = await c.callTool({ name: 'quick_search', arguments: { query: q } });
  const txt = r.content.map((x) => x.text).join('\n');
  console.log(`\n===== ${q}  (${Date.now() - t0} ms, ${txt.length} chars, error=${Boolean(r.isError)})`);
  console.log(process.env.FULL ? txt : txt.slice(0, 1800));
}
await c.close();
await engine.close();
process.exit(0);
