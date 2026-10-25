// MCP Browser exposed as an MCP server (for Claude Desktop / Claude Code).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-mcp-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { startMockServers } = await import('./fixtures/mock-servers.js');
const { createEngine } = await import('../src/app.js');
const { createMcpServer } = await import('../src/mcp-server.js');
const { HealthStore } = await import('../src/health.js');

let mock, client, engine;
before(async () => {
  mock = await startMockServers();
  engine = createEngine({
    providerOverride: null,
    curated: [],
    extraServers: [mock.servers.docs, mock.servers.evil, mock.servers.paid, mock.servers.locked],
    health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h.json') }),
  });
  engine.updateSettings({ alwaysWebSearch: false });
  const { server } = createMcpServer({ engine });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});
after(async () => {
  await client.close();
  await engine.close();
  await mock.close();
});

// Results are wrapped as untrusted; pull the JSON out of the wrapper.
const unwrap = (t) => JSON.parse(t.slice(t.indexOf('\n') + 1, t.lastIndexOf('\n</untrusted_tool_result>')));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
};

test('advertises read-only tools and instructions', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['call_tool', 'check_dependencies', 'check_paragraph', 'cross_check', 'find_server_for_task', 'find_servers', 'get_server_setup', 'quick_search', 'route', 'try_server']);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  // (all four hints, each an explicit true or false, on every tool: some directories reject a tool missing one)
  for (const t of tools) for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name} ${h}`);
  assert.ok(tools.every((t) => t.annotations.destructiveHint === false && t.annotations.idempotentHint === true));
  assert.match(client.getInstructions(), /untrusted/);
});

test('route connects servers and lists only read-only tools', async () => {
  const r = await call('route', { question: 'widget documentation size' });
  assert.match(r.text, /^<untrusted_tool_result/);
  const data = unwrap(r.text);
  const docs = data.servers.find((s) => s.server_id === 'docs');
  const names = docs.tools.map((t) => t.name);
  assert.ok(names.includes('search_docs'));
  assert.ok(!names.includes('create_order') && !names.includes('wipe'));
  assert.ok(docs.tools[0].input_schema);
});

test('call_tool wraps results, flags injection and lists sources', async () => {
  const ok = await call('call_tool', { server_id: 'docs', tool: 'search_docs', arguments: { query: 'size' } });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /<untrusted_tool_result server="Widget Docs"/);
  assert.match(ok.text, /Sources: Widget guide <https:\/\/example.com\/widgets>/);
  const evil = await call('call_tool', { server_id: 'evil', tool: 'lookup', arguments: { q: 'x' } });
  assert.match(evil.text, /WARNING/);
  assert.doesNotMatch(evil.text, /​/);
});

test('call_tool refuses write tools, unknown servers, paywalls and missing keys', async () => {
  assert.match((await call('call_tool', { server_id: 'docs', tool: 'create_order', arguments: { sku: 'a' } })).text, /No read-only tool/);
  assert.match((await call('call_tool', { server_id: 'nope', tool: 'x' })).text, /unknown server/);
  const paid = await call('call_tool', { server_id: 'paid', tool: 'search', arguments: { query: 'x' } });
  assert.equal(paid.isError, true);
  assert.match(paid.text, /payment/);
  assert.match((await call('call_tool', { server_id: 'paid', tool: 'search', arguments: { query: 'x' } })).text, /failed recently/);
  assert.match((await call('call_tool', { server_id: 'locked', tool: 'search_vault', arguments: { query: 'x' } })).text, /needs a key/);
  assert.ok(!mock.calls.some((c) => c.tool === 'create_order'));
});

test('quick_search and find_servers', async () => {
  const q = await call('quick_search', { query: 'widget docs' });
  assert.match(q.text, /Widget guide/);
  const f = unwrap((await call('find_servers', { topic: 'vault' })).text);
  assert.equal(f.servers[0].server_id, 'locked');
  assert.equal(f.servers[0].needs_key, true);
});

test('quick_search leaves out replies about something else', async () => {
  const real = engine.agent.search;
  engine.agent.search = async (q, { emit }) => {
    const r = (id, text, offTopic) => emit('results', { serverId: id, serverTitle: id, tool: 't', text, view: null, kind: 'ok', score: 20, offTopic });
    r('papers', 'Solid-state battery electrolytes, 2026 review.', false);
    r('market', 'Market-state research notes.', true);
    emit('quick_answer', { text: 'Sulfide electrolytes lead 2026 work.', url: 'https://papers.example/1', server: 'papers' });
  };
  try {
    const q = await call('quick_search', { query: 'solid-state batteries' });
    assert.match(q.text, /Solid-state battery electrolytes/);
    assert.doesNotMatch(q.text, /Market-state/);
    assert.match(q.text, /1 replied about something else/);
    assert.match(q.text, /^<untrusted_tool_result server="papers[^"]*" tool="quick_answer">\nSulfide electrolytes lead 2026 work\.\nhttps:\/\/papers\.example\/1/);
  } finally {
    engine.agent.search = real;
  }
});

test('quick_search says when the question is about an app that is not signed in', async () => {
  const real = engine.agent.search;
  engine.agent.search = async (q, { emit }) => {
    emit('route', { signIn: [{ id: 'linear', title: 'Linear' }], servers: [] });
    emit('results', { serverId: 'web', serverTitle: 'Web', tool: 't', text: 'Linear bug tracking guide.', view: null, kind: 'ok', score: 20, offTopic: false });
  };
  try {
    const q = await call('quick_search', { query: 'my open Linear bugs' });
    assert.match(q.text, /^Note: this looks like a question about the user's own Linear data/);
  } finally {
    engine.agent.search = real;
  }
});

test('stdio binary starts and answers tools/list', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [new URL('../bin/mcp-server.js', import.meta.url).pathname], {
    env: { ...process.env, MCPB_REGISTRY_URL: 'http://127.0.0.1:9' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  let out = '';
  const got = new Promise((resolve) => child.stdout.on('data', (d) => {
    out += d;
    if (out.includes('"id":2')) resolve();
  }));
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await got;
  child.kill();
  // stdout must carry only JSON-RPC lines.
  for (const line of out.trim().split('\n')) JSON.parse(line);
  assert.match(out, /"name":"route"/);
});

test('review fix: source titles written by servers stay inside the untrusted block', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/mcp-server.js', import.meta.url), 'utf8'));
  assert.match(src, /wrapUntrusted\('MCP Browser', 'sources'/);
  assert.match(src, /wrapUntrusted\(safeLabel\(srv\), tool, \(body \|\| '\(empty result\)'\) \+ list/);
});
