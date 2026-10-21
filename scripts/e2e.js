#!/usr/bin/env node
// End-to-end quality run: asks every question in scripts/e2e-questions.json
// through the real HTTP API (SSE) of a local server and records what came back.
//
//   MCPB_DATA_DIR=<dir with registry.json> node scripts/e2e.js <out.json> [profile] [filter]
//
// profile: "default" (curated, Discovery off), "wide" (Discovery on, 100/100),
//          "mid" (Discovery on, 12 servers / 8 community).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || 'e2e-result.json';
const profile = process.argv[3] || 'default';
const filter = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
const PROFILES = {
  default: { discovery: false, maxServers: 4, discoveryMax: 2 },
  mid: { discovery: true, maxServers: 12, discoveryMax: 8 },
  wide: { discovery: true, maxServers: 100, discoveryMax: 100 },
};
const questions = JSON.parse(fs.readFileSync(process.env.MCPB_QUESTIONS || path.join(root, 'scripts', 'e2e-questions.json'), 'utf8')).filter((x) => !filter || filter.test(x.q) || filter.test(x.cat));

const engine = createEngine({ providerOverride: null });
const saved = { ...engine.settings };
engine.updateSettings({ ...PROFILES[profile], alwaysWebSearch: true });
// Same as the app: meaning-based routing on (only changed servers are embedded).
const st = await engine.buildEmbeddings();
console.log(`semantic routing: ${st?.status || 'off'}`);
const app = createServer({ engine, port: 0 });
const port = await app.listen();

async function ask(q) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mcpb': '1' },
    body: JSON.stringify({ query: q }),
    signal: AbortSignal.timeout(180_000),
  });
  const rec = { q, routed: [], servers: {}, results: [], sources: 0, firstResultMs: null, errors: [] };
  // Read the stream as it arrives, so time to first result is real.
  let buf = '';
  const blocks = [];
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^event: results/m.test(block) && /"kind":"ok"/.test(block) && !/"offTopic":true/.test(block) && rec.firstResultMs == null) rec.firstResultMs = Date.now() - t0; // first useful result
      blocks.push(block);
    }
  }
  for (const block of blocks) {
    const ev = /^event: (\w+)/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!ev || !data) continue;
    const d = JSON.parse(data);
    if (ev === 'route') rec.routed = d.servers.map((s) => s.id);
    else if (ev === 'server') rec.servers[d.id] = d.status === 'failed' ? `failed: ${String(d.error || '').slice(0, 80)}` : d.status;
    else if (ev === 'results') {
      rec.results.push({ server: d.serverId, tool: d.tool, chars: d.text.length, sources: d.sources?.length || 0, kind: d.kind || null, reason: d.reason || null, score: d.score ?? null, offTopic: Boolean(d.offTopic), head: d.text.slice(0, 160).replace(/\s+/g, ' ') });
    } else if (ev === 'sources') rec.sources = d.list?.length ?? rec.sources;
    else if (ev === 'quick_answer') {
      rec.quickAnswer = { text: d.text, site: d.site };
      if (rec.quickAnswerMs == null) rec.quickAnswerMs = Date.now() - t0;
    }
    else if (ev === 'error') rec.errors.push(d.message);
  }
  rec.ms = Date.now() - t0;
  const st = Object.values(rec.servers);
  rec.summary = {
    routed: rec.routed.length,
    answered: rec.results.length,
    useful: rec.results.filter((x) => (x.kind || 'ok') === 'ok' && !x.offTopic).length,
    offTopic: rec.results.filter((x) => (x.kind || 'ok') === 'ok' && x.offTopic).length,
    empty: rec.results.filter((x) => x.kind === 'empty').length,
    ads: rec.results.filter((x) => x.kind === 'ad').length,
    failed: st.filter((s) => String(s).startsWith('failed')).length,
    skipped: st.filter((s) => s === 'skipped').length,
    sources: rec.sources,
    firstResultMs: rec.firstResultMs,
    ms: rec.ms,
    topServer: rec.results[0]?.server || null,
    quickAnswer: Boolean(rec.quickAnswer),
    quickAnswerMs: rec.quickAnswerMs ?? null,
  };
  return rec;
}

const results = [];
for (const { q, cat } of questions) {
  try {
    const rec = await ask(q);
    rec.cat = cat;
    results.push(rec);
    const s = rec.summary;
    console.log(`${String(s.ms).padStart(6)}ms  routed ${String(s.routed).padStart(3)}  ok ${String(s.useful).padStart(2)}  empty ${String(s.empty).padStart(2)}  ads ${String(s.ads).padStart(2)}  fail ${String(s.failed).padStart(2)}  src ${String(s.sources).padStart(3)}  ${s.quickAnswer ? 'QA' : '  '}  ${q}`);
  } catch (e) {
    console.log(`ERROR ${q}: ${e.message}`);
    results.push({ q, cat, error: e.message });
  }
}
fs.writeFileSync(out, JSON.stringify({ profile, at: new Date().toISOString(), results }, null, 1));
engine.updateSettings({ discovery: saved.discovery, maxServers: saved.maxServers, discoveryMax: saved.discoveryMax });
await app.close();
console.log(`wrote ${out}`);
