// HTTP API: request guards, static files, settings, SSE search, registry sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-server-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

// A fake registry with two pages: one keyless remote, one needing auth, one package-only.
const page1 = {
  servers: [
    { server: { name: 'io.test/weather', title: 'Test Weather', description: 'weather forecasts', version: '1', remotes: [{ type: 'streamable-http', url: 'https://weather.test/mcp' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
    { server: { name: 'io.test/locked', version: '1', remotes: [{ type: 'streamable-http', url: 'https://locked.test/mcp', headers: [{ name: 'Authorization', isRequired: true }] }] }, _meta: {} },
  ],
  metadata: { nextCursor: 'io.test/locked:1', count: 2 },
};
const page2 = { servers: [{ server: { name: 'io.test/pkg', version: '1', packages: [{ registryType: 'npm' }] }, _meta: {} }], metadata: { count: 1 } };
const registryReqs = [];
const registry = http.createServer((req, res) => {
  registryReqs.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url.includes('cursor=') ? page2 : page1));
});
await new Promise((r) => registry.listen(0, '127.0.0.1', r));
process.env.MCPB_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;

const { startMockServers, mockProvider } = await import('./fixtures/mock-servers.js');
const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');
const { HealthStore } = await import('../src/health.js');

let mock;
let app;
let base;
let port;
before(async () => {
  mock = await startMockServers();
  const provider = mockProvider((step, { tools }) =>
    step === 0 ? { toolCalls: [{ id: 'x1', name: tools.find((t) => t.name.endsWith('__search_docs')).name, args: { query: 'size' } }] } : { text: 'Size is 42 [1].' }
  );
  const engine = createEngine({ providerOverride: provider, curated: [], extraServers: [mock.servers.docs], health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h.json') }) });
  engine.updateSettings({ alwaysWebSearch: false });
  app = createServer({ engine, port: 0 });
  port = await app.listen();
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await app.close();
  await mock.close();
  registry.close();
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1', ...headers }, body: JSON.stringify(body) });

function rawRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('serves the UI with a strict CSP', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /MCP Browser/);
  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('blocks path traversal', async () => {
  const r = await rawRequest({ path: '/../src/config.js', method: 'GET', headers: { host: `127.0.0.1:${port}` } });
  assert.notEqual(r.status, 200);
  const r2 = await rawRequest({ path: '/%2e%2e/package.json', method: 'GET', headers: { host: `127.0.0.1:${port}` } });
  assert.notEqual(r2.status, 200);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  const r = await rawRequest({ path: '/api/settings', method: 'GET', headers: { host: 'attacker.example' } });
  assert.equal(r.status, 403);
});

test('writes need the custom header, JSON and a same-origin Origin', async () => {
  const noHeader = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const form = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-mcpb': '1' }, body: '{}' });
  assert.equal(form.status, 403);
  const cross = await post('/api/settings', { maxServers: 2 }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const ok = await post('/api/settings', { maxServers: 3 }, { origin: base });
  assert.equal(ok.status, 200);
});

test('settings never return the API key', async () => {
  await post('/api/settings', { apiKey: 'sk-secret-9876' });
  const s = await (await fetch(base + '/api/settings')).json();
  assert.equal(s.apiKey, '••••9876');
  assert.equal(s.hasApiKey, true);
  // Echoing the masked value back keeps the real key.
  await post('/api/settings', { apiKey: '••••9876', maxSteps: 4 });
  assert.equal(app.engine.settings.apiKey, 'sk-secret-9876');
  await post('/api/settings', { apiKey: '' });
});

test('rejects oversized and malformed bodies', async () => {
  const big = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ model: 'x'.repeat(70000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('search streams server-sent events end to end', async () => {
  const r = await post('/api/search', { query: 'widget size' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  const types = events.map((e) => e.type);
  for (const t of ['provider', 'route', 'server', 'step', 'tool_call', 'tool_result', 'text', 'answer', 'sources', 'done']) assert.ok(types.includes(t), `missing ${t}`);
  assert.equal(events.find((e) => e.type === 'answer').data.text, 'Size is 42 [1].');
  assert.equal(events.find((e) => e.type === 'sources').data.list[0].url, 'https://example.com/widgets');
  const empty = await post('/api/search', { query: '  ' });
  assert.equal(empty.status, 400);
});

test('servers list, toggle and route preview', async () => {
  const list = await (await fetch(base + '/api/servers?q=widget')).json();
  assert.equal(list.servers[0].id, 'docs');
  assert.equal(list.servers[0].enabled, true);
  const off = await (await post('/api/servers/toggle', { id: 'docs', enabled: false })).json();
  assert.equal(off.enabled, false);
  const route = await (await fetch(base + '/api/route?q=widget docs')).json();
  assert.equal(route.servers.length, 0);
  await post('/api/servers/toggle', { id: 'docs', enabled: null });
  const route2 = await (await fetch(base + '/api/route?q=widget docs')).json();
  assert.equal(route2.servers[0].id, 'docs');
  assert.equal((await post('/api/servers/toggle', { id: 'nope', enabled: true })).status, 404);
});

test('probe reports reachable servers', async () => {
  const r = await (await post('/api/servers/probe', { ids: ['docs'] })).json();
  assert.deepEqual(r.results[0], { id: 'docs', ok: true, tools: 4 });
});

test('registry sync pages through and keeps keyless remotes only', async () => {
  const r = await post('/api/registry/sync', { full: true });
  assert.equal(r.status, 202);
  for (let i = 0; i < 50 && app.engine.syncState.running; i++) await new Promise((x) => setTimeout(x, 50));
  const st = await (await fetch(base + '/api/status')).json();
  assert.equal(st.registry.keyless, 1);
  assert.deepEqual({ seen: st.registry.stats.seen, needsAuth: st.registry.stats.needsAuth, packageOnly: st.registry.stats.packageOnly }, { seen: 3, needsAuth: 1, packageOnly: 1 });
  assert.equal(registryReqs.length, 2);
  assert.match(registryReqs[1], /cursor=io.test%2Flocked%3A1/);
  // Registry servers stay off until discovery is on.
  const s1 = await (await fetch(base + '/api/servers?source=registry')).json();
  assert.equal(s1.servers[0].enabled, false);
  await post('/api/settings', { discovery: true });
  const s2 = await (await fetch(base + '/api/servers?source=registry')).json();
  assert.equal(s2.servers[0].enabled, true);
  // Incremental sync asks only for recent updates.
  await app.engine.syncRegistry();
  assert.match(registryReqs.at(-1) + registryReqs.at(-2), /updated_since=/);
  await post('/api/settings', { discovery: false });
});

test('watches API: add, list, run, mark seen, delete', async () => {
  const add = await post('/api/watches', { query: 'widget size', every: 'daily' });
  assert.equal(add.status, 201);
  const w = await add.json();
  assert.equal((await post('/api/watches', { query: 'x', every: 'secondly' })).status, 400);
  assert.equal((await post('/api/watches/run', { id: w.id })).status, 202);
  for (let i = 0; i < 40 && !(app.engine.watches.get(w.id).lastRun); i++) await new Promise((r) => setTimeout(r, 50));
  const list = await (await fetch(base + '/api/watches')).json();
  const got = list.watches.find((x) => x.id === w.id);
  assert.ok(got.lastRun.at);
  assert.equal(got.seenUrls, undefined);
  assert.equal((await post('/api/watches/update', { id: w.id, every: 'weekly', seen: true })).status, 200);
  assert.equal(app.engine.watches.get(w.id).every, 'weekly');
  assert.equal((await post('/api/watches/delete', { id: w.id })).status, 200);
  assert.equal((await post('/api/watches/delete', { id: w.id })).status, 404);
});

test('custom servers: add by URL (localhost allowed), probe, route, remove', async () => {
  const bad = await post('/api/servers/custom', { url: 'ftp://x' });
  assert.equal(bad.status, 400);
  const add = await post('/api/servers/custom', { url: mock.servers.docs.url.replace('/docs', '/twostep'), title: 'Acme Widget Library', description: 'acme widget library internal docs' });
  assert.equal(add.status, 201);
  const r = await add.json();
  assert.match(r.server.id, /^custom\/acme-widget-library-[0-9a-f]{6}$/);
  assert.equal(r.server.source, 'custom');
  assert.deepEqual({ ok: r.probe.ok, tools: r.probe.tools }, { ok: true, tools: 2 });
  assert.equal((await post('/api/servers/custom', { url: mock.servers.docs.url.replace('/docs', '/twostep') })).status, 409);
  const route = await (await fetch(base + '/api/route?q=' + encodeURIComponent('acme internal library'))).json();
  assert.ok(route.servers.some((s) => s.id === r.server.id));
  const listed = await (await fetch(base + '/api/servers?source=custom')).json();
  assert.ok(listed.servers.some((s) => s.id === r.server.id && s.source === 'custom'));
  assert.equal((await post('/api/servers/custom/delete', { id: r.server.id })).status, 200);
  assert.equal((await post('/api/servers/custom/delete', { id: r.server.id })).status, 404);
  assert.equal(app.engine.catalog.get(r.server.id), undefined);
});

test('review fix: adding a server that is already listed is refused cleanly', async () => {
  const r = await post('/api/servers/custom', { url: mock.servers.docs.url.toUpperCase().replace('HTTP://', 'http://') + '/' });
  assert.equal(r.status, 409);
  assert.equal(app.engine.settings.customServers.length, 0);
  assert.equal((await post('/api/servers/custom', { url: 'http://mcp.example.com/mcp' })).status, 400, 'plain http only for local servers');
});

test('subregistry: registry-compatible list, paging, lookup, rank metadata', async () => {
  const page1 = await (await fetch(base + '/v0.1/servers?limit=1')).json();
  assert.equal(page1.servers.length, 1);
  assert.ok(page1.metadata.nextCursor);
  assert.equal(page1.servers[0].server.$schema.includes('server.schema.json'), true);
  assert.ok(page1.servers[0].server.remotes[0].url.startsWith('http'));
  const page2 = await (await fetch(base + '/v0.1/servers?limit=1&cursor=' + encodeURIComponent(page1.metadata.nextCursor))).json();
  assert.notEqual(page2.servers[0].server.name, page1.servers[0].server.name);
  const name = page1.servers[0].server.name;
  const one = await (await fetch(base + `/v0.1/servers/${encodeURIComponent(name)}/versions/latest`)).json();
  assert.equal(one.server.name, name);
  assert.equal((await fetch(base + '/v0.1/servers/nope%2Fnope/versions/latest')).status, 404);
  const all = await (await fetch(base + '/v0.1/servers?limit=100')).json();
  // No saved keys or headers ever appear in the re-served metadata.
  assert.doesNotMatch(JSON.stringify(all), /sk-secret|serverAuth|headers/);
});
