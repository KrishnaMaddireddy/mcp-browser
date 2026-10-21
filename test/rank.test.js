// MCP Rank against local mock servers with known behavior.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-rank-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { startMockServers } = await import('./fixtures/mock-servers.js');
const { createEngine } = await import('../src/app.js');
const { HealthStore } = await import('../src/health.js');
const { runRank, rankServer, metadataQuality, loadRank, SUITES } = await import('../src/rank.js');

let mock, engine;
before(async () => {
  mock = await startMockServers();
  engine = createEngine({ providerOverride: null, curated: [], extraServers: Object.values(mock.servers), health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h.json') }) });
});
after(async () => {
  await engine.close();
  await mock.close();
});

const suite = { title: 'Widgets', topic: 'widget', tests: [{ q: 'max widget size', expect: [/42/] }, { q: 'widget colour', expect: [/blue/i] }] };

test('accurate, honest server scores high; issues are explained', async () => {
  const r = await rankServer(engine, mock.servers.docs, suite);
  assert.equal(r.reachable, true);
  assert.equal(r.testable, true);
  assert.equal(r.accuracy, 0.5); // knows the size, not the colour
  assert.equal(r.writeTools, 2);
  assert.ok(r.issues.some((i) => /write\/action/.test(i)));
  assert.ok(r.score > 40 && r.score < 100);
});

test('injected ads, paywalls, dead and untestable servers are scored down', async () => {
  const evil = await rankServer(engine, mock.servers.evil, suite);
  assert.equal(evil.injected, true);
  assert.ok(evil.issues.some((i) => /aimed at the AI/.test(i)));
  const paid = await rankServer(engine, mock.servers.paid, suite);
  assert.equal(paid.paywall, true);
  assert.equal(paid.tests.length, 1, 'stops asking a paywall');
  const dead = await rankServer(engine, mock.servers.broken, suite);
  assert.equal(dead.reachable, false);
  assert.equal(dead.score, 0);
  const docs = await rankServer(engine, mock.servers.docs, suite);
  assert.ok(docs.score > evil.score && docs.score > paid.score);
});

test('metadata quality report', () => {
  const good = metadataQuality([{ name: 'a', description: 'Search the full archive of widget documentation by keyword.', inputSchema: { properties: { q: { description: 'Words to search for' } } }, annotations: { readOnlyHint: true } }]);
  const bad = metadataQuality([{ name: 'a', description: 'search', inputSchema: { properties: { q: {} } } }]);
  assert.ok(good.q > 0.9 && good.issues.length === 0);
  assert.ok(bad.q < 0.2 && bad.issues.length === 3);
});

test('runRank saves results best-first and nudges routing', async () => {
  SUITES.widgets = suite;
  try {
    const r = await engine.runRank('widgets', { servers: [mock.servers.evil, mock.servers.docs, mock.servers.broken] });
    assert.deepEqual(r.results.map((x) => x.id), ['docs', 'evil', 'broken']);
    assert.equal(loadRank().categories.widgets.results.length, 3);
    assert.ok(engine.catalog.rankScores.get('docs') > engine.catalog.rankScores.get('broken'));
    await assert.rejects(runRank(engine, 'nope'), /unknown category/);
  } finally {
    delete SUITES.widgets;
  }
});

test('AI-assisted ranking tests servers that need structured arguments', async () => {
  const { mockProvider } = await import('./fixtures/mock-servers.js');
  // A model that resolves the id first, then queries docs with it.
  const provider = mockProvider((step, { tools, messages }) => {
    const resolve = tools.find((t) => t.name.endsWith('resolve_widget_id'));
    const query = tools.find((t) => t.name.endsWith('query_widget_docs'));
    const q = messages[0].content;
    if (step % 2 === 0) return { toolCalls: [{ id: `r${step}`, name: resolve.name, args: { name: 'widgets', region: 'eu' } }] };
    return { toolCalls: [{ id: `q${step}`, name: query.name, args: { id: '/acme/widgets', topic: q } }] };
  });
  const without = await rankServer(engine, mock.servers.twostep, suite);
  assert.equal(without.testable, false);
  assert.equal(without.accuracy, null);
  const r = await rankServer(engine, mock.servers.twostep, suite, { provider });
  assert.equal(r.method, 'ai');
  assert.equal(r.accuracy, 1);
  assert.match(r.tests[0].tool, /resolve_widget_id → query_widget_docs/);
  assert.ok(r.score > without.score);
});

test('AI grading uses tool output, not the model\'s own answer', async () => {
  const { mockProvider } = await import('./fixtures/mock-servers.js');
  const liar = mockProvider(() => ({ text: 'The answer is 42 and they are blue.' })); // calls no tool
  const r = await rankServer(engine, mock.servers.twostep, suite, { provider: liar });
  assert.equal(r.accuracy, null, 'a model that answers from memory measures nothing');
  assert.match(r.tests[0].untested, /no tool/);
  assert.ok(r.issues.some((i) => /not measured/.test(i)));
});

test('labels export merges categories into one stable record per server', async () => {
  const { exportLabels, methodologyMarkdown } = await import('../src/rank.js');
  const fake = {
    categories: {
      a: { ranAt: '2026-10-20T00:00:00Z', results: [{ id: 's1', title: 'S1', url: 'https://s1', source: 'registry', reachable: true, score: 80, accuracy: 1, tests: [{ pass: true }], issues: [] }] },
      b: { ranAt: '2026-10-20T01:00:00Z', results: [{ id: 's1', title: 'S1', url: 'https://s1', source: 'registry', reachable: true, paywall: true, score: 30, accuracy: 0, tests: [{ pass: false }], issues: ['x'] }, { id: 's2', title: 'S2', reachable: false, score: 0, tests: [], issues: [] }] },
    },
  };
  const l = exportLabels(fake);
  assert.equal(l.schema, 'mcp-rank-labels/1');
  assert.deepEqual(l.servers.map((s) => s.id), ['s1', 's2']);
  assert.equal(l.servers[0].free, false);
  assert.equal(l.servers[0].bestScore, 80);
  assert.deepEqual(Object.keys(l.servers[0].categories), ['a', 'b']);
  assert.match(methodologyMarkdown(), /What is the capital city of Australia\?/);
});


test('review fix: an echoing server cannot pass by repeating what the model typed', async () => {
  const { mockProvider } = await import('./fixtures/mock-servers.js');
  // The model "helpfully" types the answer into the arguments.
  const leaky = mockProvider((step, { tools, messages }) => {
    if (messages.at(-1).role === 'tool') return { text: 'done' };
    return { toolCalls: [{ id: `e${step}`, name: tools[0].name, args: { name: 'max widget size 42 blue', kind: 'widget' } }] };
  });
  const r = await rankServer(engine, mock.servers.echo, suite, { provider: leaky, aiMode: 'always' });
  assert.notEqual(r.accuracy, 1);
  assert.ok(r.tests.every((t) => !t.pass));
});

test('review fix: one canned response for every question does not count', async () => {
  const s3 = { ...suite, tests: [...suite.tests, { q: 'widget weight', expect: [/blue/i, /42/] }] };
  const r = await rankServer(engine, mock.servers.canned, s3);
  assert.equal(r.accuracy, 0);
  assert.ok(r.issues.some((i) => /canned/.test(i)));
});

test('review fix: model failures are not blamed on the server, and stop AI use after 3', async () => {
  const failing = { name: 'mock', async chat() { throw new Error('429 rate_limit_error'); } };
  const budget = { calls: 0, maxCalls: 100, errors: 0, maxErrors: 3 };
  const r = await rankServer(engine, mock.servers.twostep, suite, { provider: failing, aiBudget: budget });
  assert.equal(r.accuracy, null);
  assert.ok(r.tests.every((t) => t.untested && /AI model failed/.test(t.untested)));
  const before = r.score;
  const untested = await rankServer(engine, mock.servers.twostep, suite);
  assert.equal(before, untested.score, 'same score as never testing it');
  budget.errors = 3;
  const r2 = await rankServer(engine, mock.servers.twostep, suite, { provider: failing, aiBudget: budget });
  assert.equal(r2.method, 'direct');
});

test('each run asks one phrasing per question, the same for every server', async () => {
  const { choosePhrasings, SUITES: S } = await import('../src/rank.js');
  const suiteW = S['web-search'];
  const first = choosePhrasings(suiteW, () => 0);
  const last = choosePhrasings(suiteW, () => 0.999);
  for (const t of suiteW.tests) {
    assert.equal(first.get(t), t.q);
    assert.equal(last.get(t), t.alts.at(-1));
  }
  for (const s of Object.values(S)) for (const t of s.tests) assert.ok(t.alts?.length >= 2, `${t.q} needs alternatives`);
});

test('review 4: no question phrasing contains its own answer', async () => {
  const { SUITES: S } = await import('../src/rank.js');
  for (const [k, s] of Object.entries(S)) {
    // At least one answer pattern must not be satisfiable by the question's own words.
    for (const t of s.tests) for (const q of [t.q, ...(t.alts || [])]) assert.ok(!t.expect.every((re) => re.test(q)), `${k}: "${q}" contains its own answer`);
  }
});

test('review 4: answer patterns are not fooled by look-alike words', async () => {
  const { SUITES: S } = await import('../src/rank.js');
  const swiss = S.geography.tests.find((t) => /Switzerland/.test(t.q));
  assert.ok(!swiss.expect.some((re) => re.test('Neighbours: France, Germany; San Francisco franchise')));
  assert.ok(swiss.expect.every((re) => re.test('Currency: Swiss franc (CHF)')));
  const resnet = S.papers.tests.find((t) => /Residual/.test(t.q));
  assert.ok(!resnet.expect.some((re) => re.test('the key idea of the kernel')));
});

test('review 4: an echo of the question never counts as the answer', async () => {
  const { grade, stripEchoes } = await import('../src/rank.js');
  const t = { expect: [/vaswani/i, /1706\.03762/] };
  const q = 'Vaswani transformer paper';
  const echo = `No results for "${q}"`;
  assert.equal(grade(t, q, echo, stripEchoes(echo, [q])), false);
  const real = 'Attention Is All You Need. Vaswani et al. arXiv:1706.03762';
  assert.equal(grade(t, q, real, stripEchoes(real, [q])), true);
  // Direct mode on a live mock: topic word from the question + real answer passes.
  const r = await rankServer(engine, mock.servers.docs, { title: 'E', topic: 'x', tests: [{ q: 'widget size', alts: [], expect: [/size/, /42/] }] });
  assert.equal(r.tests[0].pass, true);
});

test('review 4: one honest list reused for two questions is counted once, not as canned', async () => {
  const { mockProvider } = await import('./fixtures/mock-servers.js');
  // The model calls the same lookup with the same arguments for both questions.
  const same = mockProvider((step, { tools, messages }) => {
    if (messages.at(-1).role === 'tool') return { text: 'done' };
    return { toolCalls: [{ id: `s${step}`, name: tools.find((t) => t.name.endsWith('query_widget_docs')).name, args: { id: '/acme/widgets', topic: 'all' } }] };
  });
  const r = await rankServer(engine, mock.servers.twostep, suite, { provider: same, aiMode: 'always' });
  assert.ok(!r.issues.some((i) => /canned/.test(i)));
  assert.equal(r.tests.filter((t) => !t.untested).length, 1);
  assert.equal(r.accuracy, 1);
});

test('rankings average each server\'s recent runs', async () => {
  SUITES.avg = suite;
  try {
    await engine.runRank('avg', { servers: [mock.servers.docs] });
    const r2 = await engine.runRank('avg', { servers: [mock.servers.docs] });
    const x = r2.results[0];
    assert.equal(x.runs, 2);
    assert.equal(x.avgScore, Math.round((loadRank().history.avg.docs[0] + loadRank().history.avg.docs[1]) / 2));
    assert.equal(engine.catalog.rankScores.get('docs') >= x.avgScore, true);
  } finally {
    delete SUITES.avg;
  }
});

test('subregistry entries carry MCP Rank metadata under a namespaced key', async () => {
  const { listServers, META_KEY } = await import('../src/subregistry.js');
  SUITES.sub = suite;
  try {
    await engine.runRank('sub', { servers: [mock.servers.docs] });
    const r = listServers(engine, new URLSearchParams('ranked_only=true&sort=rank&limit=5'));
    const docs = r.servers.find((x) => x.server.name.endsWith('custom.docs') || x.server.name.includes('docs'));
    assert.ok(docs, 'ranked server listed');
    assert.equal(typeof docs._meta[META_KEY].bestScore, 'number');
    assert.ok(docs._meta[META_KEY].categories.sub);
  } finally {
    delete SUITES.sub;
  }
});
