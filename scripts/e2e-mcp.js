#!/usr/bin/env node
// What Claude receives: asks every suite question through the MCP server's
// quick_search tool (the way Claude Code / Claude Desktop call it) and records
// whether the reply carries on-topic results and a citable sources list.
//
//   MCPB_DATA_DIR=<dir> node scripts/e2e-mcp.js <out.json> [filter]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = await import('../src/mcp-server.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || 'e2e-mcp.json';
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const questions = JSON.parse(fs.readFileSync(process.env.MCPB_QUESTIONS || path.join(root, 'scripts', 'e2e-questions.json'), 'utf8')).filter((x) => !filter || filter.test(x.q) || filter.test(x.cat));

const { server, engine } = createMcpServer();
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'e2e-mcp', version: '1' });
await client.connect(b);

const results = [];
for (const { q, cat } of questions) {
  const t0 = Date.now();
  let text = '';
  let isError = false;
  try {
    const r = await client.callTool({ name: 'quick_search', arguments: { query: q } });
    text = r.content.map((x) => x.text).join('\n');
    isError = Boolean(r.isError);
  } catch (e) {
    text = String(e?.message || e);
    isError = true;
  }
  const servers = [...text.matchAll(/<untrusted_tool_result server="([^"]+)" tool="(?!sources"|quick_answer")/g)].map((m) => m[1]);
  const sources = (text.match(/^\[\d+\] .+ — https?:\/\//gm) || []).length;
  const rec = { q, cat, ms: Date.now() - t0, isError, chars: text.length, servers, sources, citable: !isError && servers.length > 0 && sources > 0 };
  results.push(rec);
  console.log(`${String(rec.ms).padStart(6)}ms  ${rec.citable ? 'cite' : '    '}  servers ${String(servers.length).padStart(2)}  sources ${String(sources).padStart(2)}  ${String(Math.round(rec.chars / 100) / 10).padStart(5)}k  ${q}`);
}
const citable = results.filter((r) => r.citable).length;
const ms = results.map((r) => r.ms).sort((x, y) => x - y);
const chars = results.map((r) => r.chars).sort((x, y) => x - y);
const summary = { questions: results.length, citable, medianMs: ms[Math.floor(ms.length / 2)], p90Ms: ms[Math.floor(ms.length * 0.9)], medianChars: chars[Math.floor(chars.length / 2)] };
console.log(JSON.stringify(summary));
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 1));
await engine.close?.();
process.exit(0);
