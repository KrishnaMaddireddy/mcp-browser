import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-webmcp-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';
const { mockProvider } = await import('./fixtures/mock-servers.js');
const { createServer } = await import('../src/server.js');
const { createEngine } = await import('../src/app.js');
const { WebMcpDirectory } = await import('../src/webmcp-dir.js');

const PAGE = {
  url: 'https://shop.example/recipes',
  title: 'Recipe shop',
  tools: [
    { name: 'search_recipes', description: 'Search recipes by keyword', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, readOnly: true, kind: 'script' },
    { name: 'add_to_cart', description: 'Add an item to the cart', inputSchema: { type: 'object', properties: { item: { type: 'string' } } }, kind: 'script' },
    { name: 'book_table', description: 'Book a table', inputSchema: { type: 'object', properties: { people: { type: 'number' } } }, kind: 'form' },
    { name: 'bad name!', description: 'x', inputSchema: {}, kind: 'script' },
  ],
};

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});
async function start(provider) {
  const engine = createEngine({ providerOverride: provider, curated: [] });
  const app = createServer({ engine, port: 0 });
  const base = `http://127.0.0.1:${await app.listen()}`;
  servers.push({ close: async () => (await engine.close(), app.close()) });
  return base;
}

/** POST /api/search and play the app window: run page tools when asked. */
async function ask(base, body, runTool) {
  const res = await fetch(base + '/api/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!type || !data) continue;
      const d = JSON.parse(data);
      events.push({ type, d });
      if (type === 'page_tool_call') {
        const r = runTool(d.name, d.args);
        await fetch(base + '/api/page-tool-result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ callId: d.callId, ...r }) });
      }
    }
  }
  return events;
}

test('Ask this page with an AI model: only the page tools that read are offered, and calls go through the page', async () => {
  const provider = mockProvider((step, { tools }) => {
    if (step === 0) return { text: '', toolCalls: [{ id: 'c1', name: tools.find((t) => t.name.endsWith('__search_recipes')).name, args: { query: 'tomato' } }] };
    return { text: 'Try the tomato soup [1].' };
  });
  const base = await start(provider);
  const calls = [];
  const events = await ask(base, { query: 'a tomato recipe', page: PAGE }, (name, args) => (calls.push([name, args]), { ok: true, text: JSON.stringify({ results: [{ title: 'Tomato soup', url: 'https://shop.example/soup', snippet: 'Easy tomato soup' }] }) }));
  const seen = provider.seen[0].tools.map((t) => t.name);
  assert.ok(seen.some((n) => n.endsWith('__search_recipes')));
  assert.ok(!seen.some((n) => /add_to_cart|book_table|bad/.test(n)), `exposed: ${seen}`);
  assert.deepEqual(calls, [['search_recipes', { query: 'tomato' }]]);
  const toolMsg = provider.seen[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.results[0].content, /<untrusted_tool_result[^>]*>[\s\S]*Tomato soup/, 'page results are wrapped as untrusted');
  assert.equal(events.find((e) => e.type === 'route').d.servers[0].id, 'page:shop.example');
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.d.text ?? e.d.delta ?? '').join('') || JSON.stringify(events.at(-1)), /tomato|done/i);
});

test('Ask this page in free mode: a tool that takes the question answers; otherwise it says an AI model is needed', async () => {
  const base = await start(null);
  const events = await ask(base, { query: 'tomato soup', page: PAGE }, (name, args) => ({ ok: true, text: JSON.stringify({ results: [{ title: `Result for ${args.query}`, url: 'https://shop.example/r', snippet: 'tomato soup recipe' }] }) }));
  assert.ok(events.some((e) => e.type === 'tool_call' && e.d.tool === 'search_recipes'));
  const structured = { ...PAGE, tools: [{ name: 'read_scene', description: 'Read the scene', inputSchema: { type: 'object', properties: { sceneId: { type: 'string' } }, required: ['sceneId'] }, kind: 'script' }] };
  const ev2 = await ask(base, { query: 'what is in the scene', page: structured }, () => ({ ok: false, text: 'should not be called' }));
  assert.match(ev2.find((e) => e.type === 'error').d.message, /need an AI model/);
  const ev3 = await ask(base, { query: 'buy', page: { ...PAGE, tools: [PAGE.tools[2]] } }, () => ({ ok: false, text: '' }));
  assert.match(ev3.find((e) => e.type === 'error').d.message, /no tools that only read/);
  const nope = await fetch(base + '/api/page-tool-result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ callId: 'made-up', ok: true, text: 'x' }) });
  assert.equal(nope.status, 404);
});

test('the WebMCP directory downloads once and answers lookups locally', async () => {
  let fetches = 0;
  const sites = Array.from({ length: 3 }, (_, i) => ({ host: `www.site${i}.example`, url: `https://site${i}.example/`, type: 'live', category: 'Food', desc: `Site ${i}‮`, tools: [{ name: 'search', kind: 'answer', impl: 'imperative', description: 'Search', page: '/' }, { name: 'checkout', kind: 'transact', impl: 'imperative', description: 'Pay', page: '/cart' }] }));
  const fetchImpl = async (url) => {
    fetches++;
    const u = new URL(url);
    const off = Number(u.searchParams.get('offset'));
    return new Response(JSON.stringify({ ok: true, total: 3, sites: off === 0 ? sites : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const file = path.join(process.env.MCPB_DATA_DIR, 'wm.json.gz');
  const d = new WebMcpDirectory({ file, fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await d.ready();
  assert.equal(d.info().sites, 3);
  const n = fetches;
  const hit = d.lookup('https://www.site1.example/cart/view');
  assert.equal(hit.host, 'site1.example');
  assert.deepEqual(hit.kinds, { answer: 1, act: 0, transact: 1 });
  assert.equal(hit.here, 2);
  assert.equal(d.lookup('https://unknown.example/'), null);
  assert.equal(fetches, n, 'lookups never go to webmcp.com');
  assert.ok(!d.search({ q: 'site 2' }).sites[0].desc.includes('‮'), 'direction-override characters are removed');
  assert.equal(d.search({ kind: 'transact' }).total, 3);
  // A fresh copy reads the saved list without downloading.
  const d2 = new WebMcpDirectory({ file, fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await d2.ready();
  assert.equal(fetches, n);
  assert.equal(d2.info().sites, 3);
});

test('the page bridge and its preload wrapper are valid scripts', () => {
  const src = fs.readFileSync(new URL('../electron/webmcp-bridge.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(src));
  assert.doesNotThrow(() => new Function(`function f() {\n${src}\n}`));
});
