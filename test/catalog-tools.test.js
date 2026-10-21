import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-cattools-'));
process.env.MCPB_LOG = 'silent';
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = await import('../src/mcp-server.js');
const { createEngine } = await import('../src/app.js');
const { searchCatalog, loadCatalog, setupFor, describe } = await import('../src/catalog-index.js');

let client;
before(async () => {
  const { server } = createMcpServer({ engine: createEngine({ providerOverride: null, curated: [], extraServers: [], embeddings: null }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 't', version: '1' });
  await client.connect(b);
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
};

test('the catalog loads server-side and finds servers by task', () => {
  const c = loadCatalog();
  assert.ok(c.rows.length > 40000);
  const pg = searchCatalog('query postgres database', { limit: 5 });
  assert.ok(pg.length >= 3);
  assert.ok(pg.every((r) => /postgres|sql|database/i.test(r._hay)));
  const d = describe(pg[0], { full: true });
  assert.ok(d.server_id && Array.isArray(d.sample_prompts) && Array.isArray(d.checks));
});

test('setup snippets come from the same code as the browser', () => {
  const c = loadCatalog();
  const s = setupFor([c.byName.get('io.github.upstash/context7')], 'all');
  assert.equal(s.clients.length, 4);
  assert.match(s.clients[0].snippet, /^claude mcp add/);
});

test('MCP tools: find_server_for_task, get_server_setup', async () => {
  const { tools } = await client.listTools();
  for (const n of ['find_server_for_task', 'get_server_setup', 'try_server']) assert.ok(tools.some((t) => t.name === n), n);
  const f = await call('find_server_for_task', { task: 'sentry errors' });
  assert.equal(f.isError, false);
  assert.match(f.text, /sentry/i);
  const s = await call('get_server_setup', { server_ids: ['io.github.getsentry/sentry-mcp'], client: 'desktop' });
  assert.match(s.text, /mcpServers/);
  assert.match(s.text, /checks/);
  const bad = await call('get_server_setup', { server_ids: ['nope/nope'] });
  assert.equal(bad.isError, true);
  const t = await call('try_server', { server_id: 'nope/nope', question: 'hi' });
  assert.equal(t.isError, true);
});
