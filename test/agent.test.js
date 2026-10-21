import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-agent-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { startMockServers, mockProvider } = await import('./fixtures/mock-servers.js');
const { createEngine } = await import('../src/app.js');
const { HealthStore } = await import('../src/health.js');

let mock;
before(async () => {
  mock = await startMockServers();
});
after(async () => {
  await mock.close();
});

function engineWith(provider, servers, settings = {}) {
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, `h-${Math.random()}.json`) });
  const e = createEngine({ providerOverride: provider, curated: [], extraServers: servers, health });
  e.updateSettings({ alwaysWebSearch: false, discovery: false, maxSteps: 3, toolTimeoutMs: 2000, connectTimeoutMs: 3000, ...settings });
  return e;
}

function collect() {
  const events = [];
  const emit = (type, data) => events.push({ type, data });
  const of = (t) => events.filter((e) => e.type === t).map((e) => e.data);
  return { events, emit, of };
}

test('LLM mode: routes, hides write tools, flags injection, cites sources', async () => {
  const provider = mockProvider((step, { tools }) => {
    if (step === 0) {
      const docs = tools.find((t) => t.name.endsWith('__search_docs'));
      const evil = tools.find((t) => t.name.endsWith('__lookup'));
      return { text: 'Let me look.', toolCalls: [{ id: 't1', name: docs.name, args: { query: 'max size' } }, { id: 't2', name: evil.name, args: { q: 'widgets' } }] };
    }
    return { text: 'The max widget size is **42** [1].' };
  });
  const e = engineWith(provider, [mock.servers.docs, mock.servers.evil]);
  const c = collect();
  const r = await e.agent.search('what is the max widget size', { emit: c.emit, servers: ['docs', 'evil'] });
  await e.close();

  const names = provider.seen[0].tools.map((t) => t.name);
  assert.ok(names.some((n) => n.endsWith('__search_docs')));
  assert.ok(names.some((n) => n.endsWith('__get_order_status')));
  assert.ok(!names.some((n) => /create_order|wipe|helper/.test(n)), `write/poisoned tools exposed: ${names}`);
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/);

  const ready = c.of('server').filter((s) => s.status === 'ready');
  const docsReady = ready.find((s) => s.id === 'docs');
  assert.deepEqual(docsReady.blocked.map((b) => b.name).sort(), ['create_order', 'wipe']);
  assert.ok(ready.find((s) => s.id === 'evil').blocked.some((b) => b.name === 'helper'));

  const results = c.of('tool_result');
  assert.equal(results.length, 2);
  const evilRes = results.find((x) => x.callId === 't2');
  assert.ok(evilRes.flags.length >= 1, 'injection should be flagged');

  // What the model saw: wrapped, invisible chars removed, wrapper not breakable.
  const toolMsg = provider.seen[1].messages.find((m) => m.role === 'tool');
  const evilContent = toolMsg.results.find((x) => x.id === 't2').content;
  assert.doesNotMatch(evilContent, /[​‮]/);
  assert.equal(evilContent.match(/<\/untrusted_tool_result>/g).length, 1);
  assert.match(evilContent, /WARNING/);
  assert.match(toolMsg.results.find((x) => x.id === 't1').content, /\[1\] Widget guide — https:\/\/example.com\/widgets/);

  assert.equal(r.answer, 'The max widget size is **42** [1].');
  assert.equal(r.sources[0].url, 'https://example.com/widgets');
  assert.ok(c.of('text').length > 1, 'text should stream');
  assert.equal(c.of('done')[0].mode, 'llm');
  assert.match(provider.seen[0].system, /untrusted_tool_result/);
});

test('LLM mode: unknown tools, timeouts and paywalls become tool errors; loop ends at budget', async () => {
  let steps = 0;
  const provider = mockProvider((step, { tools }) => {
    steps++;
    if (!tools.length) return { text: 'Final answer without more tools.' };
    const slow = tools.find((t) => t.name.endsWith('__slow_search'));
    const paid = tools.find((t) => t.name.endsWith('__search'));
    return {
      toolCalls: [
        { id: `a${step}`, name: 'nope__tool', args: {} },
        { id: `b${step}`, name: slow.name, args: { query: 'x' } },
        { id: `c${step}`, name: paid.name, args: { query: 'x' } },
      ],
    };
  });
  const e = engineWith(provider, [mock.servers.slow, mock.servers.paid], { maxSteps: 2, toolTimeoutMs: 2000 });
  const c = collect();
  const t0 = Date.now();
  const r = await e.agent.search('widget prices', { emit: c.emit, servers: ['slow', 'paid'] });
  const health = e.health;
  await e.close();
  assert.equal(steps, 3, 'two tool rounds + one forced final answer');
  assert.equal(provider.seen[2].tools.length, 0);
  assert.equal(r.answer, 'Final answer without more tools.');
  const errs = c.of('tool_result').filter((x) => !x.ok);
  assert.ok(errs.some((x) => x.error === 'unknown tool'));
  assert.ok(errs.some((x) => /timed out/i.test(x.error)));
  assert.ok(errs.some((x) => /payment/.test(x.error)));
  assert.ok(Date.now() - t0 < 12000);
  assert.equal(health.get('paid').paywalled, true);
  assert.equal(health.isAvailable('paid'), false);
  assert.equal(r.sources.length, 0);
});

test('free mode calls search tools directly and skips broken servers', async () => {
  const e = engineWith(null, [mock.servers.docs, mock.servers.broken, mock.servers.evil], { maxServers: 3 });
  const c = collect();
  const before = mock.calls.length;
  const r = await e.agent.search('widget size', { emit: c.emit, servers: ['docs', 'broken', 'evil'] });
  const health = e.health;
  await e.close();
  assert.equal(r.mode, 'direct');
  const res = c.of('results');
  assert.deepEqual(res.map((x) => x.serverId).sort(), ['docs', 'evil']);
  assert.ok(res.find((x) => x.serverId === 'evil').flags.length);
  assert.equal(c.of('server').find((s) => s.id === 'broken' && s.status === 'failed') !== undefined, true);
  assert.equal(health.get('broken').status, 'fail');
  const made = mock.calls.slice(before);
  assert.ok(made.every((x) => !['create_order', 'wipe', 'helper'].includes(x.tool)));
  assert.ok(r.sources.some((s) => s.url === 'https://example.com/widgets'));
  // Trailing period is not part of the URL; query string survives.
  assert.ok(r.sources.some((s) => s.url === 'https://example.com/faq?x=1&y=2'));
});

test('registry servers on private addresses are refused', async () => {
  const e = engineWith(null, []);
  e.catalog.addServers([{ ...mock.servers.docs, id: 'sneaky', source: 'registry' }]);
  e.updateSettings({ serverOverrides: { sneaky: true } });
  const c = collect();
  await e.agent.search('widget docs', { emit: c.emit, servers: ['sneaky'] });
  await e.close();
  const failed = c.of('server').find((s) => s.status === 'failed');
  assert.match(failed.error, /only https|private/);
  assert.equal(c.of('error').length, 1);
});

test('automatic routing picks matching servers only', async () => {
  const e = engineWith(mockProvider(() => ({ text: 'ok' })), Object.values(mock.servers));
  const ids = e.catalog.route('widget documentation search', e.settings).map((r) => r.server.id);
  await e.close();
  assert.equal(ids[0], 'docs');
  assert.ok(ids.length <= 4);
});

test('history is passed to the model for follow-ups', async () => {
  const provider = mockProvider(() => ({ text: 'ok' }));
  const e = engineWith(provider, [mock.servers.docs]);
  await e.agent.search('and the min size?', { history: [{ q: 'max widget size', a: '42' }] });
  await e.close();
  const msgs = provider.seen[0].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, 'max widget size');
  assert.equal(msgs[1].text, '42');
});

test('connection pool reuses connections across searches', async () => {
  const provider = mockProvider(() => ({ text: 'ok' }));
  const e = engineWith(provider, [mock.servers.docs]);
  await e.agent.search('widget docs');
  const first = e.pool.conns.get('docs').client;
  await e.agent.search('widget docs again');
  assert.equal(e.pool.conns.get('docs').client, first);
  await e.close();
  assert.equal(e.pool.conns.size, 0);
});

test('servers that need a key stay off until one is added, then send it', async () => {
  const e = engineWith(null, [mock.servers.locked]);
  assert.equal(e.catalog.isEnabled(mock.servers.locked), false);
  assert.equal(e.catalog.route('vault search', e.settings).length, 0);
  e.updateSettings({ serverAuth: { locked: { header: 'X-Api-Key', value: 'wrong' } } });
  assert.equal(e.catalog.isEnabled(mock.servers.locked), true);
  let c = collect();
  await e.agent.search('vault search', { emit: c.emit });
  assert.equal(c.of('server').find((x) => x.status === 'failed').id, 'locked');
  e.updateSettings({ serverAuth: { locked: { header: 'X-Api-Key', value: 'good-key' } } });
  e.health.map.delete('locked'); // skip the back-off for the test
  c = collect();
  const r = await e.agent.search('vault search', { emit: c.emit });
  await e.close();
  assert.equal(r.mode, 'direct');
  assert.equal(c.of('results')[0].text, 'vault hit');
});

test('the model can discover and connect a registry server mid-search', async () => {
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-disc.json') });
  const provider = mockProvider((step, { tools }) => {
    if (step === 0) {
      assert.ok(tools.some((t) => t.name === 'mcpb__find_more_servers'));
      return { toolCalls: [{ id: 'd1', name: 'mcpb__find_more_servers', args: { topic: 'widget documentation' } }] };
    }
    if (step === 1) {
      const t = tools.find((x) => x.name.endsWith('__search_docs'));
      assert.ok(t, 'discovered tools should be offered next turn');
      return { toolCalls: [{ id: 'x1', name: t.name, args: { query: 'size' } }] };
    }
    return { text: 'Found it [1].' };
  });
  const e = createEngine({ providerOverride: provider, curated: [], health, allowPrivate: () => true });
  e.catalog.setRegistry({ servers: [{ ...mock.servers.docs, id: 'io.test/docs', source: 'registry' }, { ...mock.servers.broken, id: 'io.test/broken', source: 'registry', description: 'widget documentation mirror' }] });
  e.catalog.addServers([{ ...mock.servers.slow, title: 'Starter' }]);
  e.updateSettings({ alwaysWebSearch: false, discovery: true, discoveryMax: 0, maxSteps: 4 });
  const c = collect();
  const r = await e.agent.search('starter question', { emit: c.emit, servers: ['slow'] });
  await e.close();
  assert.ok(c.of('route_add').some((x) => x.server.id === 'io.test/docs'));
  assert.equal(r.answer, 'Found it [1].');
  assert.equal(r.sources[0].url, 'https://example.com/widgets');
  assert.match(provider.seen[1].messages.at(-1).results[0].content, /New tools available/);
});

test('free mode keeps long search replies whole (Exa sends ~12k characters)', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const long = Array.from({ length: 4 }, (_, i) => `Title: Article ${i}\nURL: https://news.example/${i}\n${'word '.repeat(700)}`).join('\n---\n');
  const server = { id: 'longweb', title: 'Long Web', url: 'https://x', source: 'curated', trust: 'trusted' };
  const pool = { get: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] }), callTool: async () => ({ content: [{ type: 'text', text: long }] }) };
  const catalog = { routeAsync: async () => [{ server, reason: 'test' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('q', { emit: (t, d) => events.push([t, d]) });
  const res = events.find(([t]) => t === 'results')[1];
  assert.ok(long.length > 8000);
  assert.equal((res.text.match(/^Title:/gm) || []).length, 4);
  assert.equal(res.sources.length, 4);
});

test('free mode asks a place-shaped tool with the place, and retries empties with simpler forms', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const server = { id: 'wx', title: 'Weather', url: 'https://x', source: 'registry', trust: 'community' };
  const asked = [];
  const pool = {
    get: async () => ({ tools: [{ name: 'forecast', inputSchema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }] }),
    callTool: async (_s, _t, args) => {
      asked.push(args.location);
      return { content: [{ type: 'text', text: args.location === 'Seattle' ? 'Seattle, WA: rain, 52°F today, clearing Saturday with a high of 61°F.' : '{"results":[]}' }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server, reason: 'test' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('weather in Seattle this weekend', { emit: (t, d) => events.push([t, d]) });
  // A location input gets the place first; it answered, so no more calls.
  assert.deepEqual(asked, ['Seattle']);
  const res = events.find(([t]) => t === 'results')[1];
  assert.equal(res.kind, 'ok');
  assert.match(res.text, /rain/);
});

test('a query-shaped tool that returns nothing is asked again with keywords, then the name', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const server = { id: 'facts', title: 'Facts', url: 'https://x', source: 'registry', trust: 'community' };
  const asked = [];
  const pool = {
    get: async () => ({ tools: [{ name: 'search_facts', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] }),
    callTool: async (_s, _t, args) => {
      asked.push(args.query);
      return { content: [{ type: 'text', text: args.query === 'Australia' ? 'Australia: capital Canberra; population 27.2 million; largest city Sydney.' : 'No results found.' }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server, reason: 'test' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('capital of Australia', { emit: (t, d) => events.push([t, d]) });
  assert.deepEqual(asked, ['capital of Australia', 'capital Australia', 'Australia']);
  assert.equal(events.find(([t]) => t === 'results')[1].kind, 'ok');
});

test('free mode keeps a page budget: a slow server is skipped, fast results stay', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const fast = { id: 'fast', title: 'Fast', url: 'https://f', source: 'curated', trust: 'trusted' };
  const slow = { id: 'slow', title: 'Slow', url: 'https://s', source: 'registry', trust: 'community' };
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const pool = {
    get: async () => ({ tools: [tool] }),
    callTool: async (s) => {
      if (s.id === 'slow') await new Promise((r) => setTimeout(r, 3000));
      return { content: [{ type: 'text', text: `Title: Budget answer from ${s.id}\nURL: https://${s.id}.example/a\nHighlights:\nBudget answers arrive quickly here.` }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server: fast, reason: 't' }, { server: slow, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({ freeModeBudgetMs: 600 }), getProvider: () => null });
  const events = [];
  const t0 = Date.now();
  await agent.search('budget answer', { emit: (t, d) => events.push([t, d]) });
  assert.ok(Date.now() - t0 < 1500, 'the page finished near its budget');
  assert.deepEqual(events.filter(([t]) => t === 'results').map(([, d]) => d.serverId), ['fast']);
  assert.ok(events.some(([t, d]) => t === 'tool_result' && /too slow/.test(d.error || '')));
});

test('free mode asks each server as it connects: a hanging connection holds nobody up', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const fast = { id: 'fast', title: 'Fast', url: 'https://f', source: 'curated', trust: 'trusted' };
  const hang = { id: 'hang', title: 'Hang', url: 'https://h', source: 'registry', trust: 'community' };
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const pool = {
    get: async (s) => {
      if (s.id === 'hang') await new Promise((r) => setTimeout(r, 5000));
      return { tools: [tool] };
    },
    callTool: async (s) => {
      await new Promise((r) => setTimeout(r, 300)); // a normal reply time
      return { content: [{ type: 'text', text: `Title: Connect answer from ${s.id}\nURL: https://${s.id}.example/a\nHighlights:\nConnect answers arrive while others still connect.` }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server: hang, reason: 't' }, { server: fast, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({ freeModeBudgetMs: 1000 }), getProvider: () => null });
  const events = [];
  const t0 = Date.now();
  let resultAt = null;
  await agent.search('connect answer', { emit: (t, d) => { events.push([t, d]); if (t === 'results' && resultAt == null) resultAt = Date.now() - t0; } });
  assert.deepEqual(events.filter(([t]) => t === 'results').map(([, d]) => d.serverId), ['fast']);
  assert.ok(resultAt < 900, `fast result came at ${resultAt} ms, before the slow connection gave up`);
});

test('free mode picks the works/papers search over an organisation lookup', async () => {
  const { pickQueryTool } = await import('../src/agent.js');
  const tool = (name, param, description) => ({ name, description, inputSchema: { type: 'object', properties: { [param]: { type: 'string' } }, required: [param] } });
  const tools = [tool('ror__search', 'q', 'Search the Research Organization Registry for research institutions.'), tool('scholarly__works-search', 'search', 'Search scholarly works.'), tool('scholarly__institutions-search', 'search', 'Search institutions.')];
  assert.equal(pickQueryTool(tools, 'latest research on solid-state batteries').tool.name, 'scholarly__works-search');
  assert.equal(pickQueryTool(tools, 'which institutions research fusion energy').tool.name, 'scholarly__institutions-search');
});

test('free mode: coordinates from a place lookup lead to the forecast tool', async () => {
  const { followUpTool, findCoords } = await import('../src/agent.js');
  const tool = (name, description, props, required) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'number' }])), required } });
  const tools = [
    tool('geocode', 'Convert a city name into coordinates', ['address'], ['address']),
    tool('weather_forecast', 'Multi-day weather forecast by latitude/longitude', ['lat', 'lon'], ['lat', 'lon']),
    tool('weather_current', 'Latest observed weather by latitude/longitude', ['lat', 'lon'], ['lat', 'lon']),
    tool('elevation', 'Ground elevation at a latitude/longitude', ['lat', 'lon', 'units'], ['lat', 'lon', 'units']),
  ];
  const geo = JSON.stringify({ query: 'Seattle', matches: [{ name: 'Seattle, WA', latitude: 47.62, longitude: -122.35 }] });
  assert.deepEqual(findCoords(geo), { lat: 47.62, lon: -122.35 });
  const f = followUpTool(tools, tools[0], 'weather in Seattle this weekend', geo);
  assert.equal(f.tool.name, 'weather_forecast');
  assert.deepEqual([f.latParam, f.lonParam, f.lat, f.lon], ['lat', 'lon', 47.62, -122.35]);
  assert.equal(followUpTool(tools, tools[0], 'weather in Seattle right now', geo).tool.name, 'weather_current');
  assert.equal(followUpTool(tools, tools[0], 'Seattle population', geo), null, 'nothing fits the question');
  assert.equal(followUpTool(tools, tools[0], 'Seattle elevation', geo), null, 'a tool needing other inputs is not called');
  assert.equal(followUpTool(tools, tools[0], 'weather in Seattle', '{"name":"Seattle"}'), null, 'no coordinates, no follow-up');
});

test('free mode: ticker-only tools get a ticker or a company name, never a sentence', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const { entityOf, tickersOf } = await import('../src/quality.js');
  assert.equal(entityOf('Nvidia stock price today'), 'Nvidia');
  assert.equal(entityOf('Weather in Seattle this weekend'), 'Seattle');
  assert.deepEqual(tickersOf('is NVDA a buy? compare with $AAPL and the US market'), ['NVDA', 'AAPL']);
  const server = { id: 'quotes', title: 'Quotes', url: 'https://q', source: 'registry', trust: 'community' };
  const tool = { name: 'get_quote', description: 'Stock quote by ticker', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } };
  const asked = [];
  const pool = {
    get: async () => ({ tools: [tool] }),
    callTool: async (s, name, args) => {
      asked.push(args.symbol);
      return { content: [{ type: 'text', text: JSON.stringify({ symbol: args.symbol, name: 'NVIDIA Corp', price: 181.2, change_pct: 1.4, exchange: 'NASDAQ' }) }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('top stocks to buy next week', { emit: (t, d) => events.push([t, d]) });
  assert.deepEqual(asked, [], 'no ticker, no company: not asked');
  assert.ok(events.some(([t, d]) => t === 'server' && d.status === 'skipped' && /ticker/.test(d.error)));
  await agent.search('NVDA stock price today', { emit: () => {} });
  assert.deepEqual(asked, ['NVDA']);
});

test('free mode follow-up: the forecast counts as on-topic, and a failed follow-up closes its activity', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const server = { id: 'wx', title: 'Weather', url: 'https://wx', source: 'curated', trust: 'community' };
  const num = { type: 'number' };
  const tools = [
    { name: 'geocode', description: 'Find coordinates for a city name', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
    { name: 'get_forecast', description: 'Weather forecast for a latitude/longitude', inputSchema: { type: 'object', properties: { lat: num, lon: num }, required: ['lat', 'lon'] } },
  ];
  for (const mode of ['ok', 'empty']) {
    const pool = {
      get: async () => ({ tools }),
      callTool: async (s, name) =>
        name === 'geocode'
          ? { content: [{ type: 'text', text: JSON.stringify({ query: 'Seattle', matches: [{ name: 'Seattle, WA', latitude: 47.6, longitude: -122.3 }] }) }] }
          : { content: [{ type: 'text', text: mode === 'ok' ? JSON.stringify({ periods: ['Saturday', 'Sunday', 'Monday'].map((d) => ({ name: d, detailed: 'Showers likely, with a high near 55 and a light south breeze.', temperature: '55°F', wind: '5 mph S' })) }) : '{"periods":[]}' }] },
    };
    const catalog = { routeAsync: async () => [{ server, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
    const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
    const events = [];
    await agent.search('weather in Seattle this weekend', { emit: (t, d) => events.push([t, d]) });
    const calls = events.filter(([t]) => t === 'tool_call').map(([, d]) => d.callId);
    const done = new Set(events.filter(([t]) => t === 'tool_result').map(([, d]) => d.callId));
    assert.ok(calls.every((c) => done.has(c)), `${mode}: every call reports a result`);
    const res = events.find(([t]) => t === 'results')[1];
    if (mode === 'ok') {
      assert.equal(res.tool, 'get_forecast');
      assert.equal(res.offTopic, false);
      assert.ok(events.some(([t, d]) => t === 'quick_answer' && /Saturday/.test(d.text)));
    } else assert.equal(res.tool, 'geocode');
  }
});

test('free mode: a web engine that errors is backed up by another one, once', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const exa = { id: 'exa', title: 'Exa', url: 'https://e', source: 'curated', trust: 'trusted', general: true };
  const keen = { id: 'keen', title: 'Keen', url: 'https://k', source: 'curated', trust: 'trusted', general: true };
  const third = { id: 'third', title: 'Third', url: 'https://t', source: 'curated', trust: 'trusted', general: true };
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const called = [];
  const pool = {
    get: async () => ({ tools: [tool] }),
    callTool: async (s) => {
      called.push(s.id);
      if (s.id === 'exa') return { isError: true, content: [{ type: 'text', text: 'rate limited (429)' }] };
      return { content: [{ type: 'text', text: `Title: Backup engines answer\nURL: https://${s.id}.example/a\nHighlights:\nBackup engines answer when the first one is rate limited.` }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server: exa, reason: 't' }], rankScores: null, all: () => [exa, keen, third], get: (id) => [exa, keen, third].find((s) => s.id === id), isSignedIn: () => false, isEnabled: () => true, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('backup engines answer', { emit: (t, d) => events.push([t, d]) });
  assert.deepEqual(called, ['exa', 'keen'], 'one backup only');
  assert.deepEqual(events.filter(([t]) => t === 'results').map(([, d]) => d.serverId), ['keen']);
  assert.ok(events.some(([t, d]) => t === 'server' && d.id === 'keen' && d.backupFor === 'exa'));
  called.length = 0;
  await agent.search('backup engines answer', { servers: ['exa'], emit: () => {} });
  assert.deepEqual(called, ['exa'], 'servers you picked are not swapped');
});

test('free mode stops early: three useful results and 4 s, the slow server is let go', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const mk = (id) => ({ id, title: id, url: `https://${id}`, source: 'curated', trust: 'trusted' });
  const servers = ['a', 'b', 'c', 'slow'].map(mk);
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const pool = {
    get: async () => ({ tools: [tool] }),
    callTool: async (s) => {
      await new Promise((r) => setTimeout(r, s.id === 'slow' ? 20000 : 100));
      return { content: [{ type: 'text', text: `Title: Early stop answer ${s.id}\nURL: https://${s.id}.example/a\nHighlights:\nEarly stop answers come from several servers here.` }] };
    },
  };
  const catalog = { routeAsync: async () => servers.map((server) => ({ server, reason: 't' })), rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({ freeModeBudgetMs: 30000 }), getProvider: () => null });
  const events = [];
  const t0 = Date.now();
  await agent.search('early stop answer', { emit: (t, d) => events.push([t, d]) });
  const ms = Date.now() - t0;
  assert.ok(ms >= 3900 && ms < 6000, `finished at ${ms} ms`);
  assert.equal(events.filter(([t]) => t === 'results').length, 3);
  assert.ok(events.some(([t, d]) => t === 'tool_result' && /enough results/.test(d.error || '')));
});

test('early stop: a let-go web engine does not start a backup, and conversions are flagged as calculated', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const mk = (id, general) => ({ id, title: id, url: `https://${id}`, source: 'curated', trust: 'trusted', general });
  const servers = [mk('a'), mk('b'), mk('c'), mk('exa', true)];
  const backup = mk('keen', true);
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const called = [];
  const pool = {
    get: async (s) => {
      if (s.id === 'keen') await new Promise((r) => setTimeout(r, 3000));
      return { tools: [tool] };
    },
    callTool: async (s) => {
      called.push(s.id);
      await new Promise((r) => setTimeout(r, s.id === 'exa' ? 20000 : 100));
      return { content: [{ type: 'text', text: `Title: Early backup answer ${s.id}\nURL: https://${s.id}.example/a\nHighlights:\nEarly backup answers come from several servers here.` }] };
    },
  };
  const all = [...servers, backup];
  const catalog = { routeAsync: async () => servers.map((server) => ({ server, reason: 't' })), rankScores: null, all: () => all, get: (id) => all.find((s) => s.id === id), isSignedIn: () => false, isEnabled: () => true, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({ freeModeBudgetMs: 30000 }), getProvider: () => null });
  const t0 = Date.now();
  await agent.search('early backup answer', { emit: () => {} });
  assert.ok(Date.now() - t0 < 5500, `finished at ${Date.now() - t0} ms`);
  assert.ok(!called.includes('keen'), 'no backup after the early stop');
  const events = [];
  await agent.search('convert 5 miles to km', { emit: (t, d) => events.push([t, d]) });
  const qa = events.find(([t]) => t === 'quick_answer')[1];
  assert.equal(qa.calculated, true);
});

test('stock price questions use a quote tool with the ticker, and lead with the quote', async () => {
  const { SearchAgent, quoteTool } = await import('../src/agent.js');
  const { tickerFor } = await import('../src/quality.js');
  assert.equal(tickerFor('Nvidia stock price today'), 'NVDA');
  assert.equal(tickerFor('AAPL share price'), 'AAPL');
  assert.equal(tickerFor('top stocks to buy next week'), null);
  assert.equal(tickerFor('USD to JPY exchange rate'), null);
  const t = (name, description, props, required = []) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required } });
  const tools = [
    t('public_search_news', 'Semantic news search', ['query'], ['query']),
    t('get_price_history', 'Daily OHLCV price history for a ticker', ['ticker', 'period_days'], ['ticker']),
    t('get_instrument_info', 'Current snapshot of one instrument: price and recent changes', ['instrument_id', 'ticker']),
  ];
  assert.equal(quoteTool(tools).tool.name, 'get_instrument_info');
  const server = { id: 'mkt', title: 'Market Data', url: 'https://m', source: 'curated', trust: 'community' };
  const asked = [];
  const pool = {
    get: async () => ({ tools }),
    callTool: async (s, name, args) => {
      asked.push([name, args]);
      return { content: [{ type: 'text', text: JSON.stringify({ ticker: 'NVDA', full_name: 'NVIDIA Corporation', type: 'Stock', currency: 'USD', current_price: 216.47, price_changes: { '1d_pct': -0.2856 }, sector: 'Technology' }) }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('Nvidia stock price today', { emit: (t2, d) => events.push([t2, d]) });
  assert.deepEqual(asked[0], ['get_instrument_info', { ticker: 'NVDA' }]);
  assert.equal(events.find(([e]) => e === 'quick_answer')[1].text, 'NVIDIA Corporation (NVDA): 216.47 USD (1-day change -0.29%).');
});

test('recipes: currency pairs fill rate tools; resolve-then-query docs chains an ID', async () => {
  const { currencyPair, fxPick, fxAnswer, resolveChain, SearchAgent } = await import('../src/agent.js');
  assert.deepEqual(currencyPair('USD to JPY exchange rate'), ['USD', 'JPY']);
  assert.deepEqual(currencyPair('convert 100 dollars to yen'), ['USD', 'JPY']);
  assert.equal(currencyPair('who won the world cup in dollars'), null);
  const t = (name, props, required) => ({ name, description: name, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required } });
  const fx = fxPick([t('start_checkout', ['plan'], ['plan']), t('get_rate', ['base', 'quote', 'date'], ['base', 'quote']), t('convert', ['from', 'to', 'amount'], ['from', 'to', 'amount'])], 'USD to JPY exchange rate');
  assert.equal(fx.tool.name, 'get_rate');
  assert.deepEqual([fx.param, fx.value, fx.extra], ['base', 'USD', { quote: { fixed: 'JPY' } }]);
  const { formatResult } = await import('../src/format.js');
  const rec = JSON.stringify({ base: 'USD', quote: 'JPY', rate: 158.136, source: 'live' });
  assert.equal(fxAnswer([{ text: rec, view: formatResult(rec), score: 20, serverTitle: 'FX' }], 'USD to JPY exchange rate').text, '1 USD = 158.136 JPY');
  // Context7-style docs: resolve-library-id(libraryName, query) → query-docs(libraryId, query)
  const tools = [t('resolve-library-id', ['query', 'libraryName'], ['query', 'libraryName']), t('query-docs', ['libraryId', 'query'], ['libraryId', 'query'])];
  const chain = resolveChain(tools, 'how to upgrade Next.js 14 to 15');
  assert.equal(chain.name, 'Next.js');
  assert.equal(chain.idFrom('- Title: Next.js\n- Context7-compatible library ID: /vercel/next.js\n- Description: …'), '/vercel/next.js');
  const server = { id: 'docs', title: 'Docs', url: 'https://d', source: 'curated', trust: 'trusted' };
  const asked = [];
  const pool = {
    get: async () => ({ tools }),
    callTool: async (s, name, args) => {
      asked.push([name, args]);
      return { content: [{ type: 'text', text: name === 'resolve-library-id' ? '- Title: Next.js\n- Context7-compatible library ID: /vercel/next.js\n- Description: Next.js framework for upgrades and more.' : '### Upgrading to Next.js 15\nRun the codemod: npx @next/codemod@canary upgrade latest to upgrade Next.js 14 to 15 with the new APIs.' }] };
    },
  };
  const catalog = { routeAsync: async () => [{ server, reason: 't' }], rankScores: null, all: () => [], isSignedIn: () => false, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health: null, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('how to upgrade Next.js 14 to 15', { emit: (e, d) => events.push([e, d]) });
  assert.deepEqual(asked, [
    ['resolve-library-id', { libraryName: 'Next.js', query: 'how to upgrade Next.js 14 to 15' }],
    ['query-docs', { libraryId: '/vercel/next.js', query: 'how to upgrade Next.js 14 to 15' }],
  ]);
  assert.equal(events.find(([e]) => e === 'results')[1].tool, 'query-docs');
});

test('a stock-price question always asks a server known to have a quote tool', async () => {
  const { SearchAgent } = await import('../src/agent.js');
  const docs = { id: 'docs', title: 'Docs', url: 'https://d', source: 'curated', trust: 'trusted' };
  const mkt = { id: 'mkt', title: 'Market Data', url: 'https://m', source: 'curated', trust: 'community' };
  const tools = { docs: [{ name: 'search_docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }], mkt: [{ name: 'get_instrument_info', description: 'Current snapshot: price', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } } }] };
  const health = { get: (id) => (id === 'mkt' ? { status: 'ok', tools: [{ name: 'get_instrument_info' }] } : { status: 'ok', tools: [{ name: 'search_docs' }] }), isAvailable: () => true, usefulness: () => 0.5, recordOutcome() {}, recordAnswer() {}, markDirect() {} };
  const asked = [];
  const pool = { get: async (s) => ({ tools: tools[s.id] }), callTool: async (s, name, args) => (asked.push([s.id, name, args]), { content: [{ type: 'text', text: JSON.stringify({ ticker: 'MSFT', full_name: 'Microsoft Corporation', currency: 'USD', current_price: 531.87 }) }] }) };
  const catalog = { routeAsync: async () => [{ server: docs, reason: 'matched: microsoft' }], rankScores: null, all: () => [docs, mkt], get: (id) => [docs, mkt].find((x) => x.id === id), isSignedIn: () => false, isEnabled: () => true, settings: {} };
  const agent = new SearchAgent({ catalog, pool, health, getSettings: () => ({}), getProvider: () => null });
  const events = [];
  await agent.search('Microsoft stock price', { emit: (t, d) => events.push([t, d]) });
  assert.ok(asked.some(([id, name, args]) => id === 'mkt' && name === 'get_instrument_info' && args.ticker === 'MSFT'));
  assert.match(events.find(([t]) => t === 'quick_answer')[1].text, /^Microsoft Corporation \(MSFT\): 531\.87 USD/);
});

test('weather questions: the place from the question (any language) goes to a weather tool', async () => {
  const { placeOf, pickQueryTool } = await import('../src/agent.js');
  assert.equal(placeOf('ベルリンの天気'), 'Berlin');
  assert.equal(placeOf('clima en Ciudad de México mañana'), 'Mexico City');
  assert.equal(placeOf('will it rain in London this weekend'), 'London');
  const t = (name, props, required) => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required } });
  const tools = [t('search', ['query'], ['query']), t('get_weather', ['location', 'latitude', 'longitude']), t('get_forecast', ['location', 'start_time']), t('explain_weather', ['location', 'question']), t('clothing_recommendation', ['location', 'activity'])];
  const now = pickQueryTool(tools, 'Paris weather');
  assert.deepEqual([now.tool.name, now.param, now.place], ['get_weather', 'location', 'Paris']);
  assert.equal(pickQueryTool(tools, 'will it rain in London this weekend').tool.name, 'get_forecast');
});

test('weather intent is about weather, not forecasts of sales or weather API docs', async () => {
  const { pickQueryTool } = await import('../src/agent.js');
  const t = (name, props, required) => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required } });
  const tools = [t('search', ['query'], ['query']), t('get_forecast', ['city'])];
  assert.equal(pickQueryTool(tools, 'sales forecast for Q3 retail').tool.name, 'search');
  assert.equal(pickQueryTool(tools, 'how does the weather API search work').tool.name, 'search');
  assert.equal(pickQueryTool(tools, 'is it cold in Boston').tool.name, 'get_forecast');
});
