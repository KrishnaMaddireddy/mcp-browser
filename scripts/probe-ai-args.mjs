#!/usr/bin/env node
// Second pass for servers whose tools need structured inputs (free mode can't fill
// them): call one read-only tool with inputs an AI model wrote for the server's
// sample question, and grade the reply. Input: a JSON list [{ id, tool, args }]
// (written by a model from the tools' schemas). Output: <data dir>/catalog-build/
// ai-probe.jsonl; build-catalog.js shows passes as "answers with an AI model".
//
//   node scripts/probe-ai-args.mjs <args.json> [--concurrency 6]
import fs from 'node:fs';
import path from 'node:path';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { dataDir } = await import('../src/config.js');
const { loadCatalog, adhocFor } = await import('../src/catalog-index.js');
const { classifyTool, resultToText, detectBlocked } = await import('../src/policy.js');
const { classifyResult } = await import('../src/quality.js');
const { createEngine } = await import('../src/app.js');

const file = process.argv[2];
const CONC = Number(process.argv.includes('--concurrency') ? process.argv[process.argv.indexOf('--concurrency') + 1] : 6);
const list = JSON.parse(fs.readFileSync(file, 'utf8'));
const OUT = path.join(dataDir(), 'catalog-build', 'ai-probe.jsonl');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const engine = createEngine({ providerOverride: null, curated: [] });
engine.updateSettings({ connectTimeoutMs: 15000 });
const c = loadCatalog();
const { F } = c;
const short = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function one(x) {
  const r = c.byName.get(x.id);
  const rec = { id: x.id, testedAt: new Date().toISOString().slice(0, 10), tool: x.tool, status: 'fails-ai' };
  const a = r && adhocFor(r);
  if (!a) return { ...rec, error: 'not a hosted server MCP Browser can call' };
  try {
    const { tools } = await engine.pool.get({ ...a, kind: undefined });
    const t = tools.find((y) => y.name === x.tool);
    if (!t) return { ...rec, error: 'no such tool' };
    if (!classifyTool(t).allowed) return { ...rec, error: 'tool hidden (it may change things)' };
    const res = await engine.pool.callTool(a, x.tool, x.args || {}, { timeoutMs: 30000 });
    const text = resultToText(res, 40000);
    const blocked = detectBlocked(text, { isError: res?.isError });
    const q = classifyResult(text, x.why || '');
    rec.preview = short(text, 160);
    if (!res?.isError && !blocked && q.kind === 'ok') rec.status = 'answers-ai';
    else rec.error = blocked ? blocked.reason : res?.isError ? short(text, 160) : q.reason;
  } catch (e) {
    rec.error = short(e.message);
  } finally {
    await engine.pool.close(x.id).catch(() => {});
  }
  return rec;
}

let i = 0;
const counts = {};
async function worker() {
  while (i < list.length) {
    const x = list[i++];
    const rec = await one(x);
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    counts[rec.status] = (counts[rec.status] || 0) + 1;
    console.log(rec.status.padEnd(10), x.id.slice(0, 45).padEnd(45), x.tool, '|', (rec.preview || rec.error || '').slice(0, 80));
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('done:', JSON.stringify(counts));
await engine.close().catch(() => {});
process.exit(0);
