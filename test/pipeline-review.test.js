// Pipelines, second round: what an independent review of the Oct 23 pipeline work broke, each
// fixed and checked here. Tools are stubbed; nothing goes to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-review-'));
process.env.MCPB_LOG = 'silent';
const { runPipeline, cleanPipeline, loadLibrary, pipelineText, headlinesFromBrief } = await import('../src/pipelines.js');
const { briefOf, stripInstruction, checkAdHeadlines, shortenHeadline, headlinesIn, parseRobots, robotsAllows, aboutSubject } = await import('../src/pipeline-steps.js');

const AD = loadLibrary().find((p) => p.id === 'ad-headline-research');
const ROBOTS = loadLibrary().find((p) => p.id === 'ai-crawler-policy');
const finalOf = (events) => events.find(([t]) => t === 'pipe_final')[1];

function agentListing(items) {
  const log = [];
  return {
    log,
    async search(q, { emit, route }) {
      log.push({ q, route });
      emit('results', { kind: 'ok', serverTitle: 'Web', score: 1, view: { kind: 'items', items } });
      return { mode: 'direct', answer: '', sources: [] };
    },
  };
}
function tools(calls, reply) {
  return async (id, tool, args) => {
    calls.push({ id, tool, args });
    if (tool === 'fetch_page') return { structuredContent: reply(args.url) };
    if (tool === 'check_robots') return { content: [{ type: 'text', text: '{"results":[]}' }] };
    if (tool === 'generate_ad_headlines') return { content: [{ type: 'text', text: 'Too many requests, try again later.' }] };
    throw new Error(`unexpected tool ${tool}`);
  };
}
const ok = (markdown, extra = {}) => () => ({ status: 'ok', content_type: 'text/plain', markdown, fetched_at: '2026-10-23T20:42:27.121Z', ...extra });
async function robotsRun(domain, reply) {
  const calls = [];
  const events = [];
  await runPipeline(agentListing([]), ROBOTS, { input: domain, emit: (t, d) => events.push([t, d]), callTool: tools(calls, reply) });
  return { calls, fin: finalOf(events) };
}

test('instruction words: whole words only, and only after a verb or a count', () => {
  for (const t of ['Adobe stock price today', 'Advil vs Tylenol', 'Linear algebra course', 'Copyright fair use rules', 'Lines of code in Linux kernel', 'Ad blockers for chrome', 'Headlines today', 'Titles of Taylor Swift albums']) assert.equal(stripInstruction(t), t, t);
  assert.equal(stripInstruction('Write 10 Google ad headlines for a bamboo standing desk'), 'bamboo standing desk');
  assert.equal(stripInstruction('Give me some ad copy about our new CRM'), 'new CRM');
});

test('the brief: no subject when only asking words are left; channel only where the ads run', () => {
  for (const t of ['Write 10 ad headlines', 'Write me some ads', 'Give me 10 Google headlines', 'Write Facebook ads']) assert.equal(briefOf(t).subject, '', t);
  assert.equal(briefOf('Write Facebook ads').limit, 40);
  // (a channel's name inside the product isn't where the ads run)
  assert.equal(briefOf('10 headlines for Meta Quest 3 accessories').channel, 'Google Search');
  assert.equal(briefOf('10 headlines for Meta Quest 3 accessories').subject, 'Meta Quest 3 accessories');
  assert.equal(briefOf('Write 10 headlines for Linked In Learning courses').limit, 30);
  assert.equal(briefOf('Write 5 LinkedIn ad headlines for our payroll app').limit, 70);
  assert.equal(briefOf('Ad headlines for a payroll app on LinkedIn').limit, 70);
  assert.equal(briefOf('5 headlines: a CRM for real estate agents').subject, 'CRM for real estate agents');
  // (an audience is people: "youth soccer" isn't one)
  assert.equal(briefOf('Write ad headlines for small-sided games for youth soccer').audience, '');
  // (a file name before the site: the site is the domain)
  assert.equal(briefOf('check the robots.txt of theguardian.com').domain, 'theguardian.com');
  assert.equal(briefOf('read config.json on example.org').domain, 'example.org');
});

test('no subject: the reported request without its subject asks once, and calls nothing', async () => {
  const calls = [];
  const events = [];
  const agent = agentListing([]);
  await runPipeline(agent, AD, { input: 'Write 10 ad headlines', emit: (t, d) => events.push([t, d]), callTool: tools(calls, ok('')) });
  assert.equal(calls.length + agent.log.length, 0);
  assert.match(finalOf(events).text, /What are you advertising, and where will the ads run\?/);
});

test('subjects with hyphens, codes and accents still match their results', () => {
  const cve = aboutSubject([{ title: 'NVD - CVE-2021-44228', url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228' }, { title: 'Log4Shell explained', url: 'https://x.example/cve-2021-44228' }], 'CVE-2021-44228');
  assert.equal(cve.kept.length, 2);
  assert.equal(aboutSubject([{ title: 'paypal-account-verify.com - URLVoid', url: 'https://www.urlvoid.com/scan/paypal-account-verify.com/' }], 'paypal-account-verify.com').kept.length, 1);
  assert.equal(aboutSubject([{ title: 'Türkiye travel advisory', url: 'https://t.example' }], 'Turkiye').kept.length, 1);
  assert.equal(aboutSubject([{ title: 'Chain of thought: a survey', url: 'https://a.example' }], 'chain-of-thought prompting').kept.length, 1);
});

test('only research steps drop results that miss the subject; a plain step keeps what its servers found', async () => {
  const items = [{ title: 'NVDA stock quote', url: 'https://q.example/nvda', text: '' }];
  const plain = cleanPipeline({ steps: [{ ask: 'Nvidia stock news' }] });
  const a1 = agentListing(items);
  const r1 = await runPipeline(a1, plain, { input: 'Nvidia' });
  assert.equal(r1.steps[0].runs[0].sources.length, 1);
  const research = cleanPipeline({ steps: [{ kind: 'research', ask: 'Research', queries: ['{subject} stock news'] }] });
  const r2 = await runPipeline(agentListing(items), research, { input: 'Bruxelles' });
  assert.equal(r2.steps[0].runs[0].sources.length, 0);
  assert.match(r2.steps[0].runs[0].note, /Nothing relevant found/);
  // (a plain step's tools are asked what it says, not a stripped version: "Make up of the S&P 500")
  const a3 = agentListing([]);
  await runPipeline(a3, cleanPipeline({ steps: [{ ask: 'Make up of the S&P 500' }] }), { input: '' });
  assert.ok(a3.log[0].route === undefined || a3.log[0].route === 'Make up of the S&P 500', a3.log[0].route);
});

test('old-style pipelines whose questions start with Make, Create or Write still load', () => {
  for (const p of loadLibrary()) assert.doesNotThrow(() => cleanPipeline(p), p.id);
  assert.doesNotThrow(() => cleanPipeline({ steps: [{ ask: 'Create React App error {input}' }, { kind: 'research', ask: 'r', queries: ['{subject}'] }] }));
});

test('a site with no robots.txt: Page Fetch\'s "not found" reads as allowing everything', async () => {
  const { fin } = await robotsRun('example.com', () => ({ status: 'skipped', reason: 'not_found', url: 'https://example.com/robots.txt' }));
  assert.match(fin.text, /example\.com has no robots\.txt/);
  // (a server error on a site whose name has "404" in it isn't "not found")
  const r2 = await robotsRun('404media.co', () => ({ status: 'error', reason: 'http_error', http_status: 500 }));
  assert.match(r2.fin.text, /Couldn’t read 404media\.co's robots\.txt/);
});

test('the fetched file is cited at a web address only', async () => {
  const { fin } = await robotsRun('example.com', ok('User-agent: *\nAllow: /', { final_url: 'javascript:alert(1)' }));
  assert.equal(fin.citations[0].url, 'https://example.com/robots.txt');
});

test('robots.txt: groups across Sitemap lines, versioned names, CR line ends, percent-encoding', () => {
  assert.equal(robotsAllows(parseRobots('User-agent: ClaudeBot\nSitemap: https://x/s.xml\nUser-agent: GPTBot\nDisallow: /'), 'GPTBot', '/').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: ClaudeBot\nCrawl-delay: 5\nUser-agent: GPTBot\nDisallow: /'), 'ClaudeBot', '/').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: GPTBot/1.0\nDisallow: /'), 'GPTBot', '/').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: GPTBot\rDisallow: /\r'), 'GPTBot', '/').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /%7Euser/'), 'x', '/~user/a').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /~user/'), 'x', '/%7euser/a').allowed, false);
  const fb = robotsAllows(parseRobots('User-agent: Googlebot\nDisallow: /'), 'Applebot', '/', { fallback: 'Googlebot' });
  assert.equal(fb.group, 'fallback');
});

test('the crawler table: tokens are opted out or not, search crawlers labelled plainly, notes on AI use', async () => {
  const { fin } = await robotsRun('example.com', ok('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /'));
  const row = (t) => fin.table.rows.find((r) => r[0] === t);
  assert.match(row('Google-Extended')[4], /^not opted out/);
  assert.match(row('Google-Extended')[4], /Googlebot is blocked/);
  assert.equal(row('Googlebot')[2].startsWith('search crawler ('), true);
  assert.doesNotMatch(row('Googlebot')[2], /not AI/);
  assert.match(row('Applebot')[4], /Googlebot's group, which it follows/);
  assert.match(row('Applebot')[2], /Applebot-Extended/);
  assert.match(row('Amzn-SearchBot')[4], /no group of its own/);
  // (the sentence names crawlers that are blocked, not tokens)
  assert.match(fin.text, /blocks Googlebot, Applebot from the home page/);
  const r2 = await robotsRun('example.com', ok('User-agent: Google-Extended\nDisallow: /'));
  assert.match(r2.fin.table.rows.find((r) => r[0] === 'Google-Extended')[4], /^opted out/);
});

test('headline checks: money, weight and cure promises, numbers to prove, and fair wording passes', () => {
  const r = checkAdHeadlines(['Make $10K This Week', 'Lose 20 lbs Fast', 'Cure Back Pain Today', 'Approved by 10,000 Firms', 'Our Secrets Revealed', 'Search SAM Faster', 'Endorsed by Small Businesses', '100% Free Contract Search', 'GSA Schedule Help'].map((text) => ({ text })), { limit: 30 });
  const why = Object.fromEntries(r.dropped.map((d) => [d.text, d.reason]));
  assert.equal(why['Make $10K This Week'], 'promises a result');
  assert.equal(why['Lose 20 lbs Fast'], 'promises a result');
  assert.equal(why['Cure Back Pain Today'], 'promises a result');
  assert.equal(why['Approved by 10,000 Firms'], 'a claim to back up');
  assert.equal(why['Our Secrets Revealed'], 'clickbait');
  assert.equal(why['Search SAM Faster'], 'looks like a government site');
  assert.deepEqual(r.kept.map((k) => k.text), ['Endorsed by Small Businesses', '100% Free Contract Search', 'GSA Schedule Help']);
  // (a shortened headline never ends on "Not Just")
  assert.equal(shortenHeadline('Government Contracts: Not Just for Big Firms', 30, ['government']), null);
  // (Markdown bold around a headline or its angle is taken off)
  assert.deepEqual(headlinesIn('1. **Find Federal Contracts Fast** **[Benefit]**'), [{ text: 'Find Federal Contracts Fast', angle: 'Benefit' }]);
});

test('free mode, generator busy: the reported request still ends with checked headlines from its own words', async () => {
  const calls = [];
  const events = [];
  await runPipeline(agentListing([{ title: 'US government contracts for small business', url: 'https://g.example/a', text: '' }]), AD, { input: 'Write 10 ad headlines for a us government contracts', emit: (t, d) => events.push([t, d]), callTool: tools(calls, ok('')) });
  const fin = finalOf(events);
  assert.ok(fin.table.rows.length >= 2, JSON.stringify(fin.table.rows));
  for (const [h, n, angle] of fin.table.rows) {
    assert.ok([...h].length <= 30, h);
    assert.equal(Number(n), [...h].length);
    assert.match(angle, /from your words/);
    assert.match(h, /US Government Contracts/);
  }
  assert.equal(fin.table.columns[3], 'Related note (shared words)');
  assert.ok(fin.notes.some((n) => /put together in code from the words in your request/.test(n)));
  // (the step says the free tool took no research notes)
  const gen = events.filter(([t, d]) => t === 'pipe_result' && d.i === 2).map(([, d]) => d);
  assert.ok(gen.some((d) => /research notes weren't given to it/.test(d.answer || '')), JSON.stringify(gen));
  // (never a claim the user didn't make)
  const own = headlinesFromBrief(briefOf('10 Google ad headlines for SpendQuery, a free federal contract search for small businesses'));
  assert.ok(own.every((h) => !/guarantee|official|#1|best/i.test(h.text)));
  assert.ok(own.some((h) => h.text === 'Free Federal Contract Search'));
});

test('a watch on a pipeline doesn\'t see a change just because the file was fetched again', async () => {
  const a = await robotsRun('example.com', ok('User-agent: *\nAllow: /'));
  const b = await robotsRun('example.com', ok('User-agent: *\nAllow: /', { fetched_at: '2026-10-24T08:00:00.000Z' }));
  const asText = (fin) => pipelineText({ steps: [], result: fin });
  assert.equal(asText(a.fin), asText(b.fin));
  assert.ok(asText(a.fin).includes('GPTBot'));
});

test('pipeline tool calls: refused for a switched-off server before connecting, and for a server you added', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.method);
    res.writeHead(500);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const { createEngine } = await import('../src/app.js');
  const engine = createEngine({ providerOverride: null, extraServers: [{ id: 'test/off', title: 'Off', url }, { id: 'test/mine', title: 'Mine', url: url + '2' }], allowPrivate: () => true });
  engine.updateSettings({ serverOverrides: { 'test/off': false } });
  await assert.rejects(engine.callReadOnlyTool('test/off', 'search', { q: 'x' }), /switched off in Settings/);
  await assert.rejects(engine.callReadOnlyTool('test/mine', 'search', { q: 'x' }), /can't be called from a pipeline/);
  assert.equal(hits.length, 0);
  await engine.close();
  srv.close();
});
