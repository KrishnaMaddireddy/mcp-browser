#!/usr/bin/env node
// Run pipelines end to end, the way the Pipelines page does (free mode, through the
// app's own HTTP API), and grade every step: a step passes when it got an answer, a
// link or an on-topic reply; a "for each" step when at least half its runs did.
//
//   node scripts/test-pipelines.mjs [pipelines.json] [--only id,id] [--write] [--prune]
//
// Default file: src/data/pipeline-library.json. --write stamps passing pipelines with
// tested: { on, ms }; --prune also drops the ones that failed twice in a row.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && a.endsWith('.json')) || path.join(root, 'src', 'data', 'pipeline-library.json');
const only = new Set((argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean));
const WRITE = argv.includes('--write');
const PRUNE = argv.includes('--prune');
// --dump out.json: everything each step got, to read through or review.
const DUMP = argv.includes('--dump') ? argv[argv.indexOf('--dump') + 1] : null;
const dump = [];

const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');
const engine = createEngine({ providerOverride: null });
const app = createServer({ engine, port: 0 });
const port = await app.listen();

const list = JSON.parse(fs.readFileSync(file, 'utf8'));
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function run(p) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/pipelines/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mcpb': '1' },
    body: JSON.stringify({ pipeline: p, input: p.input?.example || '' }),
    signal: AbortSignal.timeout(240000),
  });
  const dec = new TextDecoder();
  let buf = '';
  const steps = [];
  for await (const c of r.body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const b = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(b)?.[1];
      const d = /^data: (.*)$/m.exec(b)?.[1];
      if (ev === 'pipe_result' && d) {
        const x = JSON.parse(d);
        (steps[x.i] ||= []).push({ q: x.q, answer: x.answer || '', sources: x.sources || [], servers: x.servers || [], details: x.details || [] });
      }
    }
  }
  return { steps, ms: Date.now() - t0 };
}

function grade(p, res) {
  const g = p.steps.map((st, i) => {
    const runs = res.steps[i] || [];
    // Something you can read: an answer, a link, or what a server said (a record, a quote).
    const good = runs.filter((x) => x.answer || x.sources.length || x.details.length).length;
    return { runs: runs.length, good, ok: st.each ? good >= Math.max(1, Math.ceil(runs.length / 2)) : good >= 1 };
  });
  return { pass: g.every((x) => x.ok), g };
}

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
let passed = 0;
const failed = new Set();
for (const p of list) {
  if (only.size && !only.has(p.id)) continue;
  let res;
  let verdict = { pass: false, g: [] };
  // Servers can be slow or busy: a failing pipeline gets a second try.
  for (let attempt = 0; attempt < 2 && !verdict.pass; attempt++) {
    try {
      res = await run(p);
      verdict = grade(p, res);
    } catch (e) {
      res = { steps: [], ms: 0, error: e.message };
    }
  }
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${p.id.padEnd(40)} ${String(res.ms).padStart(6)}ms  ${verdict.g.map((x) => `${x.good}/${x.runs}`).join(' ')}  ${short(p.title, 50)}${res.error ? ` (${res.error})` : ''}`);
  if (DUMP)
    dump.push({
      id: p.id,
      title: p.title,
      description: p.description,
      input: p.input?.example,
      pass: verdict.pass,
      steps: p.steps.map((st, i) => ({
        ask: st.ask,
        each: Boolean(st.each),
        servers: st.servers || [],
        runs: (res.steps[i] || []).map((x) => ({ q: x.q, answer: short(x.answer, 300), sources: x.sources.slice(0, 4).map((y) => `${short(y.title, 90)} (${y.host})`), details: x.details.map((d) => `${d.server}: ${short([d.title, d.text, ...(d.facts || []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join(' | '), 400)}`) })),
      })),
    });
  if (verdict.pass) {
    passed++;
    if (WRITE) p.tested = { on: today, ms: res.ms };
  } else failed.add(p.id);
}
console.log(`\n${passed} passed, ${failed.size} failed`);
if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(dump, null, 1));
if (WRITE || PRUNE) {
  const out = PRUNE ? list.filter((p) => !failed.has(p.id)) : list;
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${out.length} pipelines to ${path.relative(root, file)}`);
}
await app.close?.();
await engine.close?.().catch(() => {});
process.exit(0);
