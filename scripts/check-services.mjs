#!/usr/bin/env node
// Are the servers the app relies on by name still answering? One real question to each part of
// the answer cards, the Dependency check services, the page reader behind page and repo watches,
// and the web search engines behind Cross-check. Free mode, through the app's own code and HTTP API.
//
//   node scripts/check-services.mjs [--md report.md] [--json report.json]
//
// Exit code 0 when everything answered, 1 when something didn't (the report says what).
import fs from 'node:fs';

process.env.MCPB_LOG ||= 'silent';
process.env.MCPB_SEMANTIC ||= 'off';

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');
const { checkDependencies } = await import('../src/reports.js');
const { DEP_TITLES, DEP_SERVERS, PAGE_FETCH } = await import('../src/deps.js');
const engine = createEngine({ providerOverride: null });
const app = createServer({ engine, port: 0 });
const port = await app.listen();
const rows = [];
const add = (feature, part, servers, ok, note, ms) => rows.push({ feature, part, servers, ok, note: String(note || '').replace(/\s+/g, ' ').slice(0, 140), ms });

async function sse(path, body, timeoutMs = 90000) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const c of r.body) {
    buf += dec.decode(c, { stream: true });
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, k);
      buf = buf.slice(k + 2);
      const t = /^event: (.*)$/m.exec(block)?.[1];
      const d = /^data: (.*)$/m.exec(block)?.[1];
      if (t && d) events.push([t, JSON.parse(d)]);
    }
  }
  return events;
}

// 1. The web search engines and Wikipedia behind Cross-check (first: the cards ask some of them too).
for (const id of ['keenable', 'exa', 'agentsearch', 'tanod-web', 'wikexa']) {
  const t0 = Date.now();
  let ok = false;
  let note = 'no results';
  try {
    await engine.agent.search('Eiffel Tower height', {
      direct: true,
      servers: [id],
      emit: (t, d) => {
        if (t === 'results' && !d.isError && (d.kind || 'ok') === 'ok' && !d.offTopic) (ok = true), (note = d.sources?.[0]?.title || d.view?.items?.[0]?.title || 'answered');
        if (t === 'server' && d.status === 'failed') note = d.error || 'failed';
        if (t === 'tool_result' && !d.ok && !ok) note = d.error || 'error';
      },
    });
  } catch (e) {
    note = String(e.message || e);
  }
  add('Cross-check', 'Web search', id, ok, note, Date.now() - t0);
}

// 2. Answer cards: every part of one card of each kind.
const CARDS = [
  ['Company card', 'NVDA stock'],
  ['City card', 'Lisbon travel'],
  ['CVE card', 'CVE-2021-44228'],
  ['Website card', 'is github.com safe'],
  ['Software card', 'log4j vulnerabilities'],
];
const { cardSections, detectEntity } = await import('../src/cards.js');
for (const [feature, q] of CARDS) {
  const t0 = Date.now();
  let events = [];
  try {
    events = await sse('/api/card', { query: q });
  } catch (e) {
    add(feature, '(whole card)', '', false, String(e.message || e), Date.now() - t0);
    continue;
  }
  const ms = Date.now() - t0;
  const want = cardSections(detectEntity(q) || {});
  for (const s of want) {
    const got = events.find(([t, d]) => t === 'card_section' && d.key === s.key)?.[1];
    const answered = got && !got.empty && (got.answer || got.links?.length || got.details?.length);
    add(feature, s.label, s.servers.join(', '), Boolean(answered), answered ? got.answer || got.links?.[0]?.title || got.details?.[0]?.title || got.details?.[0]?.text || 'answered' : 'no answer', ms);
  }
}

// 3. Dependency check: a package with known advisories, on all three services.
{
  const t0 = Date.now();
  const res = await checkDependencies({ text: 'lodash@4.17.15', callTool: (id, tool, args, o) => engine.callCatalogTool(id, tool, args, o) }).catch((e) => ({ error: String(e.message || e), servers: {} }));
  const ms = Date.now() - t0;
  for (const key of ['osv', 'audit', 'health']) {
    const sv = res.servers?.[key];
    const row = res.rows?.[0];
    const ok = Boolean(sv?.ok) && (key === 'health' ? Boolean(row?.latest) : (row?.counts?.[key] ?? row?.vulns?.length ?? 0) > 0);
    add('Dependency check', { osv: 'Advisories', audit: 'Second count', health: 'Latest version' }[key], DEP_TITLES[DEP_SERVERS[key]], ok, ok ? (key === 'health' ? `lodash latest ${row.latest}` : 'lodash 4.17.15 has known advisories') : sv?.error || res.error || 'no answer', sv?.ms ?? ms);
  }
}

// 4. The page reader behind page watches and repo checks.
{
  const t0 = Date.now();
  let ok = false;
  let note = '';
  try {
    const r = await engine.callCatalogTool(PAGE_FETCH, 'fetch_page', { url: 'https://example.com/', max_chars: 2000 }, { signal: AbortSignal.timeout(30000) });
    const sc = r?.structuredContent;
    ok = sc?.status === 'ok' && /example/i.test(`${sc.title || ''} ${sc.markdown || ''}`);
    note = ok ? 'read example.com' : sc?.status || 'no page text';
  } catch (e) {
    note = String(e.message || e);
  }
  add('Page and repo watches', 'Read a page', PAGE_FETCH, ok, note, Date.now() - t0);
}

await app.close?.();
await engine.close?.();

const failed = rows.filter((r) => !r.ok);
const cell = (x) => String(x).replace(/\|/g, '\\|').replace(/[<>]/g, '');
const md = [
  `## Server check: ${failed.length ? `${failed.length} of ${rows.length} not answering` : `all ${rows.length} answering`}`,
  '',
  `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, free mode, one real question each.`,
  '',
  '| Feature | Part | Server | Answered | What came back | Time |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${cell(r.feature)} | ${cell(r.part)} | ${cell(r.servers)} | ${r.ok ? 'yes' : '**no**'} | ${cell(r.note)} | ${(r.ms / 1000).toFixed(1)}s |`),
].join('\n');
console.log(md);
if (opt('--md')) fs.writeFileSync(opt('--md'), md + '\n');
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ failed: failed.length, rows }, null, 1));
// (for an issue: what isn't answering, with server text that can't mention anyone or add links)
const safe = (x) => cell(x).replace(/[\\`*_[\]!#]/g, '\\$&').replace(/@/g, '@\u2060').replace(/:\/\//g, ':\u2060//');
if (opt('--issue') && failed.length) fs.writeFileSync(opt('--issue'), `**Not answering:**\n\n${failed.map((r) => `- ${safe(r.feature)}: ${safe(r.part)} (${safe(r.servers)}): ${safe(r.note)}`).join('\n')}\n`);
process.exit(failed.length ? 1 : 0);
