import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-catalog-'));
process.env.MCPB_LOG = 'silent';
const { createServer } = await import('../src/server.js');
const { createEngine } = await import('../src/app.js');
const { catalogFile } = await import('../src/catalog-data.js');
const { categorize } = await import('../scripts/catalog/categories.mjs');

let app;
let base;
before(async () => {
  const engine = createEngine({ providerOverride: null, curated: [], extraServers: [], embeddings: null });
  app = createServer({ engine, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(() => app.close());

test('the bundled catalog ships and is served, gzipped or plain', async () => {
  assert.match(catalogFile().path, /src[\\/]data[\\/]catalog\.json\.gz$/);
  const r = await fetch(`${base}/api/catalog`);
  assert.equal(r.status, 200);
  const d = await r.json(); // fetch decodes content-encoding: gzip
  assert.ok(d.rows.length > 1000);
  for (const f of ['name', 'cat', 'stars', 'downloads', 'added', 'repo', 'website']) assert.ok(d.fields.includes(f), f);
  assert.equal(d.rows[0].length, d.fields.length);
});

test('a fresh build in the data dir wins over the bundled snapshot', async () => {
  const mine = { generatedAt: '2026-10-21T00:00:00Z', cats: [['other', 'Other']], fields: ['name'], rows: [['x/y']] };
  fs.writeFileSync(path.join(process.env.MCPB_DATA_DIR, 'catalog.json.gz'), zlib.gzipSync(JSON.stringify(mine)));
  const d = await fetch(`${base}/api/catalog`).then((r) => r.json());
  assert.deepEqual(d.rows, [['x/y']]);
  fs.rmSync(path.join(process.env.MCPB_DATA_DIR, 'catalog.json.gz'));
});

test('category rules read what a server does, not who it is for', () => {
  assert.equal(categorize({ name: 'io.github.someone/pg', title: 'Postgres MCP', description: 'Read-only SQL queries against PostgreSQL for AI agents' }).cat, 'data');
  assert.equal(categorize({ name: 'io.github.someone/wx', title: 'Weather', description: 'Forecasts for any city, for Claude and Cursor' }).cat, 'places');
  assert.equal(categorize({ name: 'io.github.someone/x', title: 'Thing', description: 'Does stuff' }).cat, 'other');
});

test('setup snippets cover packages, hosted servers and required settings', async () => {
  globalThis.window = {};
  await import('../public/catalog-guide.js?' + Date.now());
  const G = globalThis.window.MCPGuide;
  const fields = ['name', 'title', 'pkgType', 'pkgId', 'remoteUrl', 'remoteType', 'envs'];
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  const npm = ['io.github.acme/weather', 'Weather', 'npm', '@acme/weather-mcp', '', '', [['WEATHER_KEY', 1, 'API key']]];
  const hosted = ['com.acme/docs', 'Docs', '', '', 'https://docs.acme.com/mcp', 'streamable-http', [['Authorization', 1, 'Bearer token', 'h']]];
  const s = G.setupFor([npm, hosted], F);
  const by = Object.fromEntries(s.clients.map((c) => [c.id, c.text]));
  assert.match(by.code, /claude mcp add weather -e 'WEATHER_KEY=<WEATHER_KEY>' -- npx -y @acme\/weather-mcp/);
  assert.match(by.code, /claude mcp add --transport http docs https:\/\/docs\.acme\.com\/mcp --header 'Authorization: <Authorization>'/);
  const desktop = JSON.parse(by.desktop);
  assert.deepEqual(desktop.mcpServers.weather, { command: 'npx', args: ['-y', '@acme/weather-mcp'], env: { WEATHER_KEY: '<WEATHER_KEY>' } });
  assert.equal(desktop.mcpServers.docs.command, 'npx'); // Claude Desktop reaches hosted servers through mcp-remote
  assert.ok(desktop.mcpServers.docs.args.includes('mcp-remote'));
  assert.deepEqual(JSON.parse(by.cursor).mcpServers.docs, { url: 'https://docs.acme.com/mcp', headers: { Authorization: '<Authorization>' } });
  assert.equal(JSON.parse(by.vscode).servers.weather.type, 'stdio');
});

test('guide warnings flag publisher mismatches, archived repos and write tools', async () => {
  const G = globalThis.window.MCPGuide;
  const fields = ['name', 'repo', 'website', 'reach', 'required', 'pubCount', 'archived', 'deprecated', 'pushed', 'stars', 'downloads', 'envs', 'writeTools'];
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  const row = ['io.github.mallory/stripe-mcp', 'stripe/agent-toolkit', '', 2, 0, 1, 1, 0, '2020-01-01', 3, 10, [], 2];
  const text = G.gotchas(row, F).map(([, t]) => t).join(' | ');
  assert.match(text, /Published by GitHub user mallory, but the code is in stripe’s repo/);
  assert.match(text, /archived/);
  assert.match(text, /2 tools can change things/);
  assert.match(text, /sign-in or an API key/);
  const ok = G.gotchas(['com.stripe/mcp', '', 'https://docs.stripe.com', 1, 0, 1, 0, 0, '', 2000, 5000, [], 0], F);
  assert.ok(ok.some(([l, t]) => l === 'ok' && /stripe\.com/.test(t)));
});

test('the tool list of one catalog server is served on demand', async () => {
  const tools = { 'com.acme/docs': { at: 1, tools: [{ n: 'search_docs', d: 'Search the docs', p: [{ k: 'query', t: 'string' }] }] } };
  fs.writeFileSync(path.join(process.env.MCPB_DATA_DIR, 'catalog-tools.json.gz'), zlib.gzipSync(JSON.stringify(tools)));
  const r = await fetch(`${base}/api/catalog/tools?id=com.acme/docs`).then((x) => x.json());
  assert.equal(r.tools[0].n, 'search_docs');
  const none = await fetch(`${base}/api/catalog/tools?id=nope`).then((x) => x.json());
  assert.deepEqual(none.tools, []);
});

test('use cases point at servers that exist in the shipped catalog', async () => {
  globalThis.window = {};
  await import('../public/use-cases.js?' + Date.now());
  const U = globalThis.window.MCP_USE_CASES;
  const d = await fetch(`${base}/api/catalog`).then((x) => x.json());
  const names = new Set(d.rows.map((r) => r[0]));
  const ids = [...U.goals.flatMap((g) => g.needs.flatMap((n) => n.prefer || [])), ...U.workflows.flatMap((w) => w.steps.flatMap((s) => s.need.prefer || []))];
  assert.ok(U.goals.length >= 25 && U.workflows.length >= 6);
  assert.deepEqual(ids.filter((i) => !names.has(i)), []);
  for (const g of U.goals) assert.ok(g.prompts.length >= 2 && g.needs.length >= 1, g.id);
});

test('a question can name a catalog server the browser has not synced (HTTPS only)', async () => {
  const body = (adhoc) => JSON.stringify({ query: 'hello', servers: ['com.acme/x'], adhoc });
  const send = async (adhoc) => {
    const r = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: body(adhoc) });
    const text = await r.text();
    const route = text.split('\n\n').find((b) => b.startsWith('event: route'));
    return route ? JSON.parse(route.split('\ndata: ')[1]) : null;
  };
  const ok = await send({ id: 'com.acme/x', url: 'https://127.0.0.1:9/mcp', title: 'Acme' });
  assert.deepEqual(ok.servers.map((s) => s.id), ['com.acme/x']);
  // Plain http, templated URLs and ids not asked for are ignored: normal routing instead.
  for (const bad of [{ id: 'com.acme/x', url: 'http://acme.com/mcp' }, { id: 'com.acme/x', url: 'https://acme.com/{tenant}/mcp' }, { id: 'other/y', url: 'https://acme.com/mcp' }]) {
    const r = await send(bad);
    assert.ok(!r || !r.servers.some((s) => s.id === 'com.acme/x'));
  }
});
