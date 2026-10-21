#!/usr/bin/env node
// Second pass over src/data/reachability.json: for every server the first probe
// found answering ("ok"), connect again and record whether free mode can use it
// on its own (a tool that takes just a question, a place or a name) — "ok" — or
// whether its tools all need an AI model to fill structured arguments — "needs-ai".
// Routing ranks "needs-ai" servers lower in free mode, so first questions don't
// spend slots on servers that would be skipped.
//
//   MCPB_DATA_DIR=<dir with registry.json> node scripts/probe-direct.js [hours=1.5] [concurrency=24]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { McpPool } = await import('../src/pool.js');
const { loadRegistry } = await import('../src/registry.js');
const { mapLimit } = await import('../src/util.js');
const { pickQueryTool } = await import('../src/agent.js');
const { classifyTool } = await import('../src/policy.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'data', 'reachability.json');
const deadline = Date.now() + Number(process.argv[2] || 1.5) * 3600_000;
const concurrency = Number(process.argv[3] || 24);

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map((loadRegistry().servers || []).map((s) => [s.id, s]));
const todo = Object.entries(data.servers)
  .filter(([id, v]) => v === 'ok' && byId.has(id))
  .map(([id]) => byId.get(id));
console.log(`${todo.length} answering servers to check`);

const pool = new McpPool({ connectTimeoutMs: 8000, maxConnections: concurrency * 2, idleMs: 1000 });
const save = () => {
  data.directCheckedAt = new Date().toISOString();
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
};
let n = 0;
let needsAi = 0;
await mapLimit(todo, concurrency, async (s) => {
  if (Date.now() > deadline) return;
  try {
    const { tools } = await pool.get(s);
    const allowed = (tools || []).filter((t) => classifyTool(t, { trust: 'community' }).allowed);
    // A neutral question: the pick depends on the tools' inputs, not on the words.
    const usable = allowed.length && pickQueryTool(allowed, 'example question about something');
    if (!usable) {
      data.servers[s.id] = 'needs-ai';
      needsAi++;
    }
  } catch {
    /* unreachable now: leave the first probe's answer; live health decides */
  } finally {
    await pool.close(s.id).catch(() => {});
  }
  if (++n % 500 === 0) {
    save();
    console.log(`${n}/${todo.length} checked, ${needsAi} need an AI model`);
  }
});
save();
await pool.closeAll();
console.log(`done: ${n} checked, ${needsAi} need an AI model`);
process.exit(0);
