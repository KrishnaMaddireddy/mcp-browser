// Routing regressions from real questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-route-'));
process.env.MCPB_LOG = 'silent';

const { Catalog, queryTerms } = await import('../src/catalog.js');
const { DEFAULTS } = await import('../src/config.js');
const cat = new Catalog({ registry: { servers: [] }, settings: { ...DEFAULTS, serverOverrides: {} } });
const ids = (q) => cat.route(q).map((r) => r.server.id);

test('time phrases say when, not what: "next week" is not Next.js', () => {
  assert.deepEqual(queryTerms('top stocks to buy next week'), ['top', 'stock', 'buy']);
  assert.ok(!ids('top stocks to buy next week').includes('context7'));
  assert.ok(ids('how do I upgrade Next.js 14 to 15').includes('context7'), 'Next.js itself still routes to docs');
  assert.ok(!ids('what happened in tech news yesterday').includes('context7'));
});

test('stock questions reach market data, plus two independent web engines', () => {
  const r = ids('top stocks to buy next week');
  assert.equal(r[0], 'marketcrew');
  assert.ok(r.includes('exa') && r.includes('keenable'));
});

test('general questions get both web engines; specialist-heavy ones keep their slots', () => {
  assert.deepEqual(ids('who won the 2022 world cup').sort(), ['exa', 'keenable']);
  const dev = cat.route('how do I cancel a fetch request in JavaScript?');
  assert.ok(dev.length <= DEFAULTS.maxServers);
  assert.ok(dev.some((r) => r.server.id === 'exa'));
});

test('logos and other assets in results are not counted as sources', async () => {
  const { extractSources } = await import('../src/sources.js');
  const text = 'Title: Best stocks\nURL: https://news.example/best\nlogo https://cdn.example/static/logos/BAC.svg and https://cdn.example/a.png?x=1 and https://site.example/app.js\nmore https://site.example/report.pdf';
  assert.deepEqual(extractSources(text).map((s) => s.url), ['https://news.example/best', 'https://site.example/report.pdf']);
});

test('one publisher cannot fill the list; farms count less; empty-replying servers sink', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const mk = (id, extra = {}) => ({ id, title: `Capital facts ${id}`, description: 'capital city facts about countries', url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: ['capital', 'country'], ...extra });
  const farm = Array.from({ length: 320 }, (_, i) => mk(`io.github.farm/util-${i}`));
  const others = [mk('com.atlas/capitals'), mk('org.geo/countries'), mk('io.github.solo/capital')];
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-route.json') });
  const c = new Catalog({ curated: [], registry: { servers: [...farm, ...others] }, settings: { ...DEFAULTS, discovery: true, maxServers: 10, discoveryMax: 10, alwaysWebSearch: false, serverOverrides: {} }, health });
  const ids = c.route('capital of Australia').map((r) => r.server.id);
  assert.equal(ids.filter((id) => id.startsWith('io.github.farm/')).length, 1, 'a farm gets one slot');
  assert.ok(others.every((o) => ids.includes(o.id)));
  // A server that keeps answering "nothing" drops below one that answers.
  for (let i = 0; i < 6; i++) {
    health.recordOutcome('com.atlas/capitals', 'empty');
    health.recordOutcome('org.geo/countries', 'ok');
  }
  c.invalidate();
  const order = c.route('capital of Australia').map((r) => r.server.id);
  const atlas = order.indexOf('com.atlas/capitals');
  assert.ok(order.includes('org.geo/countries') && (atlas === -1 || atlas > order.indexOf('org.geo/countries')), 'the empty one sinks or drops out');
  assert.ok(health.usefulness('com.atlas/capitals') < 0.2 && health.usefulness('org.geo/countries') > 0.8);
});

test('a server that answered this very question with nothing ranks low for it (only for it)', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const mk = (id) => ({ id, title: `Tech news ${id}`, description: 'technology news headlines and stories', url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: ['tech', 'news'] });
  const servers = [mk('com.alpha/news'), mk('com.beta/news'), mk('com.gamma/news')];
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-recent.json') });
  const c = new Catalog({ curated: [], registry: { servers }, settings: { ...DEFAULTS, discovery: true, maxServers: 10, discoveryMax: 10, alwaysWebSearch: false, serverOverrides: {} }, health });
  const first = c.route('tech news yesterday').map((r) => r.server.id)[0];
  health.recordAnswer(first, 'what happened in tech news yesterday', 'empty');
  health.recordAnswer(first, 'tech news yesterday', 'empty');
  c.invalidate();
  assert.notEqual(c.route('Tech news yesterday?').map((r) => r.server.id)[0], first, 'same question, other wording: asked later');
  assert.equal(health.recentFor(first, 'AI chip news today'), null, 'a different question is not affected');
});

test('servers the probe found dead are skipped unless this app has seen them work', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const mk = (id) => ({ id, title: `Tide tables ${id}`, description: 'tide tables and tide times for harbours', url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: ['tide'] });
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-reach.json') });
  const c = new Catalog({ curated: [], registry: { servers: [mk('com.dead/tides'), mk('com.live/tides'), mk('com.back/tides')] }, settings: { ...DEFAULTS, discovery: true, alwaysWebSearch: false, serverOverrides: {} }, health });
  c.reach = { servers: new Map([['com.dead/tides', 'dead'], ['com.back/tides', 'auth'], ['com.live/tides', 'ok']]), checkedAt: '2026-10-21' };
  health.recordOk('com.back/tides', { latencyMs: 10, tools: [{ name: 'tides' }] });
  const ids = c.route('tide times').map((r) => r.server.id);
  assert.ok(!ids.includes('com.dead/tides'));
  assert.ok(ids.includes('com.live/tides') && ids.includes('com.back/tides'));
});

test('free mode skips servers known to need an AI model; AI mode keeps them', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const mk = (id) => ({ id, title: `Flight search ${id}`, description: 'flight search and fares', url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: ['flight'] });
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-free.json') });
  const c = new Catalog({ curated: [], registry: { servers: [mk('com.form/flights'), mk('com.simple/flights')] }, settings: { ...DEFAULTS, discovery: true, alwaysWebSearch: false, serverOverrides: {} }, health });
  for (const id of ['com.form/flights', 'com.simple/flights']) health.recordOk(id, { latencyMs: 5, tools: [{ name: 'x' }] });
  health.markDirect('com.form/flights', false);
  health.markDirect('com.simple/flights', true);
  assert.deepEqual(c.route('flight fares', { freeMode: true }).map((r) => r.server.id), ['com.simple/flights']);
  assert.equal(c.route('flight fares', { freeMode: false }).length, 2);
  health.recordOk('com.form/flights', { latencyMs: 5, tools: [{ name: 'x' }] });
  assert.equal(health.get('com.form/flights').direct, false, 'the flag survives a reconnect');
});

test('when the main web search is backing off, a backup engine takes its place', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const health = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-backup.json') });
  const c = new Catalog({ registry: { servers: [] }, settings: { ...DEFAULTS, serverOverrides: {} }, health });
  health.recordFail('exa', 'the free rate limit is used up');
  const ids = c.route('who won the 2022 world cup').map((r) => r.server.id);
  assert.ok(!ids.includes('exa'));
  assert.deepEqual(ids.sort(), ['agentsearch', 'keenable']);
});

test('review fix: a changed tool list re-learns whether free mode can use a server', async () => {
  const { HealthStore } = await import('../src/health.js');
  const { default: path } = await import('node:path');
  const h = new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h-direct.json') });
  h.recordOk('s', { latencyMs: 1, tools: [{ name: 'get_by_id' }] });
  h.markDirect('s', false);
  h.recordOk('s', { latencyMs: 1, tools: [{ name: 'get_by_id' }] });
  assert.equal(h.get('s').direct, false, 'same tools: kept');
  h.recordOk('s', { latencyMs: 1, tools: [{ name: 'get_by_id' }, { name: 'search' }] });
  assert.equal(h.get('s').direct, undefined, 'new tools: forgotten, learned again on next use');
  for (let i = 0; i < 4; i++) h.recordOutcome('off-topic', 'off');
  assert.ok(h.usefulness('off-topic') < 0.2, 'answering about something else counts against a server');
  h.recordOutcome('only-outcomes', 'ok');
  assert.equal(h.summary().fail, 0, 'an entry with only outcome counts is not a failure');
});

test('"Search wider" really widens: weaker matches qualify when asked', () => {
  const mk = (id, desc) => ({ id, title: id, description: desc, url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: [] });
  const servers = [mk('a.strong/stocks', 'stock market stocks to buy picks screener ideas'), mk('b.weak/markets', 'markets overview'), mk('c.weak/finance', 'personal finance stock tips'), mk('d.weak/news', 'business news and stock headlines')];
  const c = new Catalog({ curated: [], registry: { servers }, settings: { ...DEFAULTS, discovery: true, maxServers: 20, discoveryMax: 14, alwaysWebSearch: false, serverOverrides: {} } });
  const normal = c.route('top stocks to buy next week').length;
  const wide = c.route('top stocks to buy next week', { wide: true }).length;
  assert.ok(wide > normal, `wide ${wide} vs normal ${normal}`);
});

test('free mode ranks servers the probe found needing an AI model below ones that take a question', () => {
  const mk = (id) => ({ id, title: `Tide tables ${id}`, description: 'tide tables and tide times for harbours', url: `https://${id.replace(/\W/g, '-')}.example/mcp`, source: 'registry', trust: 'community', tags: ['tide'] });
  const servers = [mk('a.needs/ai'), mk('b.plain/question')];
  const c = new Catalog({ curated: [], registry: { servers }, settings: { ...DEFAULTS, discovery: true, maxServers: 10, discoveryMax: 10, alwaysWebSearch: false, serverOverrides: {} } });
  c.reach = { servers: new Map([['a.needs/ai', 'needs-ai'], ['b.plain/question', 'ok']]), checkedAt: null };
  c.invalidate?.();
  assert.equal(c.route('tide times', { freeMode: true })[0].server.id, 'b.plain/question');
  assert.ok(c.route('tide times', { freeMode: false }).some((r) => r.server.id === 'a.needs/ai'), 'AI mode still uses it');
});
