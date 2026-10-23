#!/usr/bin/env node
// Ask hosted, keyless MCP servers one real question each, the way MCP Browser's
// free mode would (scripts/probe-packages.mjs does the same for npm/PyPI ones).
// Results: <data dir>/catalog-build/hosted-probe.jsonl (resumable); build-catalog.js
// merges them into the catalog's "tested" labels and the start page.
//
//   node scripts/probe-hosted.mjs [--limit 3000] [--concurrency 8] [--retest]
import fs from 'node:fs';
import path from 'node:path';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { dataDir } = await import('../src/config.js');
const { loadCatalog, adhocFor, runnable } = await import('../src/catalog-index.js');
const { classifyTool } = await import('../src/policy.js');
const { createEngine } = await import('../src/app.js');

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const LIMIT = Number(opt('--limit', 3000));
const CONC = Number(opt('--concurrency', 8));
const RETEST = argv.includes('--retest');
const work = path.join(dataDir(), 'catalog-build');
fs.mkdirSync(work, { recursive: true });
const OUT = path.join(work, 'hosted-probe.jsonl');
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l.trim()) try {
  done.add(JSON.parse(l).id);
} catch {}

const engine = createEngine({ providerOverride: null, curated: [] });
engine.updateSettings({ discovery: false, freeModeBudgetMs: 25000, toolTimeoutMs: 20000, connectTimeoutMs: 12000 });
engine.pool.maxConnections = 64;
const c = loadCatalog();
const { F } = c;
let rows = c.rows.filter((r) => runnable(r, F) && !r[F.deprecated] && r[F.pubCount] < 100 && ((F.prompts != null && r[F.prompts]) || []).length);
rows.sort((a, b) => (b._pop || 0) - (a._pop || 0));
if (!RETEST) rows = rows.filter((r) => !done.has(r[F.name]));
rows = rows.slice(0, LIMIT);
console.log(`${rows.length} hosted servers to ask (${done.size} already asked), ${CONC} at a time → ${OUT}`);
const short = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function probe(r) {
  const a = adhocFor(r);
  const id = r[F.name];
  const prompt = r[F.prompts][0][0];
  const rec = { id, type: 'hosted', testedAt: new Date().toISOString().slice(0, 10), status: 'fails' };
  const t0 = Date.now();
  let tools = null;
  let useful = null;
  let skipped = '';
  let failed = '';
  let lastError = '';
  const calls = [];
  try {
    await engine.agent.search(prompt, {
      servers: [id],
      adhoc: [a],
      emit: (type, d) => {
        if (type === 'server' && d.status === 'ready') tools = d.tools;
        if (type === 'server' && d.status === 'skipped') skipped = d.error || 'skipped';
        if (type === 'server' && d.status === 'failed') failed = d.error || 'failed';
        if (type === 'tool_call') calls.push(d.tool);
        if (type === 'tool_result' && d.ok === false && d.error) lastError = short(d.error, 160);
        if (type === 'results' && !d.isError && (d.kind || 'ok') === 'ok' && !d.offTopic && !useful) useful = { tool: d.tool, preview: short(d.text, 160) };
      },
    });
  } catch (e) {
    failed ||= short(e.message);
  }
  rec.ms = Date.now() - t0;
  const ent = engine.pool.conns.get(id);
  if (ent?.tools) rec.tools = ent.tools.length;
  else if (tools != null) rec.tools = tools;
  if (useful) Object.assign(rec, { status: 'answers', call: { prompt: short(prompt, 120), tool: useful.tool, preview: useful.preview } });
  else if (failed && tools == null) Object.assign(rec, { status: 'fails', error: failed });
  else Object.assign(rec, { status: 'starts', call: { prompt: short(prompt, 120), tools: calls.slice(0, 3), ...(lastError ? { error: lastError } : {}) }, note: skipped ? (/AI model/.test(skipped) ? 'no tool takes a plain question (needs an AI model)' : short(skipped, 120)) : calls.length ? 'replied, but not with anything useful for the sample question' : 'not asked' });
  await engine.pool.close(id).catch(() => {});
  return rec;
}

let i = 0;
let n = 0;
const counts = {};
async function worker() {
  while (i < rows.length) {
    const r = rows[i++];
    let rec;
    try {
      rec = await probe(r);
    } catch (e) {
      rec = { id: r[F.name], type: 'hosted', status: 'fails', error: short(e.message), testedAt: new Date().toISOString().slice(0, 10) };
    }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    counts[rec.status] = (counts[rec.status] || 0) + 1;
    if (++n % 50 === 0) console.log(`${n}: ${JSON.stringify(counts)}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('done:', JSON.stringify(counts));
await engine.close().catch(() => {});
process.exit(0);
