// Pipelines: the brief, research before writing, checks in code, a named site's own files, and a
// result at the end of every pipeline. Tools are stubbed: these tests assert on what each step
// sends and on the result (the regression tests from the Oct 23 pipeline report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-steps-'));
process.env.MCPB_LOG = 'silent';
const { runPipeline, cleanPipeline, loadLibrary, stepKind } = await import('../src/pipelines.js');
const { briefOf, stripInstruction, checkAdHeadlines, parseRobots, robotsAllows, aboutSubject } = await import('../src/pipeline-steps.js');
const { AI_CRAWLERS } = await import('../src/ai-crawlers.js');

const AD = loadLibrary().find((p) => p.id === 'ad-headline-research');
const ROBOTS = loadLibrary().find((p) => p.id === 'ai-crawler-policy');

// A search that records what it was asked and lists two pages, one on the subject and one not.
function stubAgent(log) {
  return {
    async search(q, { emit, route, servers }) {
      log.push({ q, route, servers });
      emit('results', { kind: 'ok', serverTitle: 'Web', score: 1, view: { kind: 'items', items: [{ title: `${route || q}: a guide`, url: `https://guide.example/${encodeURIComponent(route || q)}`, text: `About ${route || q}.` }, { title: 'Ten unrelated brand surveys', url: 'https://other.example/brands', text: 'Brand survey results.' }] } });
      return { mode: 'direct', answer: '', sources: [] };
    },
  };
}
const GENERATED = [
  'Find Federal Contracts Fast  [Benefit-Driven]',
  'Who Won It Last Time?  [Question]',
  'Official SAM.gov Contract Search  [Authority]',
  'Win Every Bid, Guaranteed  [Promise]',
  'The Secret to Federal Contracts  [Curiosity]',
  'Find Free Federal Contracts for Your Growing Business Today  [Benefit-Driven]',
  'See Every Open Federal Bid  [Specificity]',
  'Find Federal Contracts Quickly  [Benefit-Driven]',
  'Imagine your company as a trusted supplier to the nation  [Aspirational]',
  'Track Contract Recompetes for Small Businesses  [Specificity]',
].map((h, k) => `  ${k + 1}. ${h}`).join('\n');
function stubTools(calls, { robots = 'User-Agent: *\nAllow: /\nDisallow: /admin\nDisallow: /market$\n\nSitemap: https://spendquery.com/sitemap.xml' } = {}) {
  return async (id, tool, args) => {
    calls.push({ id, tool, args });
    if (tool === 'generate_ad_headlines') return { content: [{ type: 'text', text: `AdCreator AI — ad headlines for: ${args.product}\n\n${GENERATED}` }] };
    if (tool === 'fetch_page') return { structuredContent: { status: 'ok', url: args.url, final_url: args.url, content_type: 'text/plain', markdown: robots, fetched_at: '2026-10-23T20:42:27.121Z' } };
    if (tool === 'check_robots') return { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] };
    throw new Error(`unexpected tool ${tool}`);
  };
}
async function run(p, input, opts = {}) {
  const log = [];
  const calls = [];
  const events = [];
  const res = await runPipeline(stubAgent(log), p, { input, emit: (t, d) => events.push([t, d]), callTool: stubTools(calls, opts) });
  return { log, calls, events, res };
}

test('the brief: subject, count, product, audience and channel read from the request, in code', () => {
  const a = briefOf('Write 10 ad headlines for a us government contracts');
  assert.deepEqual([a.subject, a.count, a.channel, a.limit, a.channelGiven], ['US government contracts', 10, 'Google Search', 30, false]);
  const b = briefOf('10 Google ad headlines for SpendQuery, a free federal contract search for small businesses');
  assert.deepEqual([b.product, b.benefit, b.audience, b.channel, b.limit], ['SpendQuery', 'free federal contract search', 'small businesses', 'Google Search', 30]);
  assert.equal(briefOf('Write 5 LinkedIn ad headlines for our payroll app').limit, 70);
  assert.equal(briefOf('ad headlines').subject, '');
  assert.equal(briefOf('spendquery.com').domain, 'spendquery.com');
  assert.equal(stripInstruction('Write 10 ad headlines for a bamboo standing desk'), 'bamboo standing desk');
});

test('1. headlines from a raw request: no tool input contains "Write 10"', async () => {
  const { log, calls, res } = await run(AD, 'Write 10 ad headlines for a us government contracts');
  const sent = [...log.flatMap((x) => [x.q, x.route]), ...calls.flatMap((c) => Object.values(c.args).flat())].map(String);
  assert.ok(sent.length > 3);
  assert.ok(sent.every((t) => !/write 10/i.test(t)), JSON.stringify(sent));
  assert.ok(calls.some((c) => c.tool === 'generate_ad_headlines' && c.args.product === 'US government contracts'), JSON.stringify(calls));
  // research ran before writing, and every query is built from the brief (no glued-on words)
  const order = res.steps.map((s) => s.kind);
  assert.ok(order.indexOf('research') < order.indexOf('generate'), JSON.stringify(order));
  assert.ok(log.every((x) => /US government contracts/.test(x.q) && !/best selling|brands|marketing/i.test(x.q)), JSON.stringify(log));
  // an old-style step ("Write 10 ad headlines for a {input}") asks its tools about the subject only
  const old = cleanPipeline({ steps: [{ ask: 'Write 10 ad headlines for a {input}' }] });
  const r2 = await run(old, 'bamboo standing desk');
  assert.equal(r2.log[0].route, 'bamboo standing desk');
});

test('2. headlines with the channel given: every one within 30 characters, no risky words, counts shown', async () => {
  const { events, res } = await run(AD, '10 Google ad headlines for SpendQuery, a free federal contract search for small businesses');
  const fin = events.find(([t]) => t === 'pipe_final')[1];
  assert.equal(fin.format, 'ad-table');
  assert.ok(fin.table.rows.length >= 3);
  for (const [headline, chars] of fin.table.rows) {
    assert.ok([...headline].length <= 30, headline);
    assert.equal(Number(chars), [...headline].length);
    assert.doesNotMatch(headline, /official|guaranteed|secret/i);
  }
  // the brief says what it used, and the result ends the run
  assert.equal(events.at(-2)[0], 'pipe_final');
  assert.ok(res.result);
  const check = res.steps.find((s) => s.kind === 'check').runs[0].check;
  assert.ok(check.dropped.some((d) => /over the 30-character limit/.test(d.reason)));
  // (a long one shortened in code when the shorter form still names the subject)
  assert.ok(check.kept.some((k) => k.text === 'Track Contract Recompetes' && k.from), JSON.stringify(check.kept));
  assert.ok(check.dropped.some((d) => d.reason === 'looks like a government site'));
  assert.ok(check.dropped.some((d) => d.reason === 'promises a result'));
  assert.ok(check.dropped.some((d) => d.reason === 'clickbait'));
});

test('no product named: the brief asks once, and no tool is called', async () => {
  const { calls, log, events } = await run(AD, 'ad headlines');
  assert.equal(calls.length + log.length, 0);
  const fin = events.find(([t]) => t === 'pipe_final')[1];
  assert.equal(fin.format, 'question');
  assert.match(fin.text, /What are you advertising, and where will the ads run\?/);
});

test('3. a named site\'s robots.txt: read from the site itself, once, and reported', async () => {
  const { calls, log, events } = await run(ROBOTS, 'spendquery.com');
  const fetches = calls.filter((c) => c.tool === 'fetch_page');
  assert.deepEqual(fetches.map((c) => c.args.url), ['https://spendquery.com/robots.txt']);
  assert.equal(log.length, 0); // (no web search for the file)
  const fin = events.find(([t]) => t === 'pipe_final')[1];
  assert.match(fin.text, /spendquery\.com's robots\.txt \(fetched 2026-10-23 20:42 UTC\) blocks none of these AI crawlers/);
  assert.equal(fin.citations[0].url, 'https://spendquery.com/robots.txt');
  // and a robots.txt that does block GPTBot says so
  const r2 = await run(ROBOTS, 'example.com', { robots: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /' });
  const f2 = r2.events.find(([t]) => t === 'pipe_final')[1];
  assert.match(f2.text, /blocks GPTBot/);
  assert.doesNotMatch(f2.text, /blocks[^;]*ClaudeBot/);
});

test('4. the crawler list: owners\' sources, kinds, and Bytespider not marked as obeying', async () => {
  const by = (t) => AI_CRAWLERS.find((c) => c.token.toLowerCase() === t.toLowerCase());
  for (const t of ['GPTBot', 'ClaudeBot', 'PerplexityBot']) {
    assert.ok(by(t), t);
    assert.match(by(t).source, /^https:\/\//);
    assert.ok(by(t).kind);
  }
  assert.doesNotMatch(String(by('Bytespider').follows), /^yes/i);
  const g = by('Googlebot');
  if (g) assert.equal(g.kind, 'search-engine');
  const { events } = await run(ROBOTS, 'spendquery.com');
  const fin = events.find(([t]) => t === 'pipe_final')[1];
  const tokens = fin.table.rows.map((r) => r[0]);
  for (const t of ['GPTBot', 'ClaudeBot', 'PerplexityBot']) assert.ok(tokens.includes(t), t);
  // the difference between crawlers and fetchers a person triggers, with sources
  assert.ok(fin.notes.some((n) => /user-triggered|asks? an assistant|a person ask/i.test(n) && /\[\d+\]/.test(n)), JSON.stringify(fin.notes));
});

test('5. every library pipeline: no research after writing, and a result at the end that cites earlier steps', async () => {
  for (const p of loadLibrary()) {
    const kinds = p.steps.map(stepKind);
    const gen = kinds.indexOf('generate');
    assert.ok(gen < 0 || !kinds.slice(gen + 1).includes('research'), p.id);
    const { events } = await run(p, p.input?.example || 'test');
    const last = events.at(-2);
    assert.equal(last[0], 'pipe_final', p.id);
    if (last[1].format === 'summary' && last[1].citations.length) assert.ok(last[1].citations.every((c) => c.step >= 1 && c.step <= p.steps.length), p.id);
  }
  assert.throws(() => cleanPipeline({ steps: [{ ask: 'Write 10 ad headlines for {input}' }, { kind: 'research', ask: 'x', queries: ['{subject}'] }] }), /research step can’t come after a generate step/);
});

test('results that don\'t mention the subject are left out', () => {
  const { kept, dropped } = aboutSubject([{ title: 'Federal contracts for small business', url: 'https://a.example' }, { title: 'Top brands survey', url: 'https://b.example/brands' }], 'US government contracts');
  assert.deepEqual([kept.length, dropped.length], [1, 1]);
  assert.equal(aboutSubject([{ title: 'Nvidia shares rise', url: 'https://x' }], 'NVDA').kept.length, 1); // (a ticker isn't filtered)
});

test('robots.txt read by RFC 9309: own group first, longest rule wins, Allow wins a tie', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n');
  assert.equal(robotsAllows(g, 'GPTBot', '/').allowed, false);
  assert.equal(robotsAllows(g, 'ccbot', '/x').allowed, false);
  assert.equal(robotsAllows(g, 'ClaudeBot', '/').allowed, true);
  assert.equal(robotsAllows(g, 'ClaudeBot', '/private/a').allowed, false);
  assert.equal(robotsAllows(g, 'ClaudeBot', '/private/ok').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /market$'), 'x', '/market/2').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /market$'), 'x', '/market').allowed, false);
  assert.equal(checkAdHeadlines([{ text: 'Find Federal Contracts Fast' }, { text: 'Find Federal Contracts Quickly' }], { limit: 30 }).kept.length, 1);
});

test('Applebot follows Googlebot\'s group when it has none of its own', () => {
  const g = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /');
  assert.equal(robotsAllows(g, 'Applebot', '/', { fallback: 'Googlebot' }).allowed, false);
  assert.equal(robotsAllows(g, 'Applebot', '/').allowed, true);
});

test('with an AI model set, the model writes the headlines from the brief; research notes go in as data', async () => {
  const log = [];
  const calls = [];
  const asked = [];
  const agent = { ...stubAgent(log), getProvider: () => ({ chat: async (req) => (asked.push(req), { text: '1. Find Federal Contracts Fast [benefit]\n2. Who Won It Last Time? [question]\n3. Official Federal Bid Portal [proof]\n4. Bids Close Soon: Search Now [urgency]' }) }) };
  const events = [];
  await runPipeline(agent, AD, { input: '10 Google ad headlines for SpendQuery, a free federal contract search for small businesses', emit: (t, d) => events.push([t, d]), callTool: stubTools(calls) });
  assert.equal(calls.filter((c) => c.tool === 'generate_ad_headlines').length, 0);
  assert.match(asked[0].system, /at most 30 characters/);
  assert.match(asked[0].messages[0].content, /"product":"SpendQuery"/);
  const fin = events.find(([t]) => t === 'pipe_final')[1];
  assert.deepEqual(fin.table.rows.map((r) => r[0]), ['Find Federal Contracts Fast', 'Who Won It Last Time?', 'Bids Close Soon: Search Now']);
});
