#!/usr/bin/env node
// Build src/data/reachability.json: connect once to every keyless registry
// server (initialize + tools/list, nothing else) and record whether it answers.
// Routing skips servers this snapshot found dead, sign-in-only or blocked,
// unless the user's own app has since seen them work.
//
//   MCPB_DATA_DIR=<dir with registry.json> node scripts/probe-registry.js [hours=1.9] [concurrency=16]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { McpPool } = await import('../src/pool.js');
const { loadRegistry } = await import('../src/registry.js');
const { mapLimit, errMsg } = await import('../src/util.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'data', 'reachability.json');
const deadline = Date.now() + Number(process.argv[2] || 1.9) * 3600_000;
const concurrency = Number(process.argv[3] || 16);

let data = { checkedAt: null, servers: {} };
try {
  data = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {}
const servers = (loadRegistry().servers || []).filter((s) => !s.needsAuth && !data.servers[s.id]);
console.log(`${servers.length} servers to probe`);

/** Short, stable categories (never the raw error text). */
function category(msg) {
  const m = String(msg);
  if (/needs sign-in|\b401\b|unauthori[sz]ed|invalid_token/i.test(m)) return 'auth';
  if (/\b403\b|forbidden|cloudflare|blocked/i.test(m)) return 'blocked';
  if (/\b402\b|payment/i.test(m)) return 'paid';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|certificate|SSL|TLS|\b404\b|\b410\b|\b5\d\d\b|timed out|timeout|fetch failed|socket|terminated/i.test(m)) return 'dead';
  return 'error';
}

const pool = new McpPool({ connectTimeoutMs: 8000, maxConnections: concurrency * 2, idleMs: 1000 });
let n = 0;
const save = () => {
  data.checkedAt = new Date().toISOString();
  fs.writeFileSync(out + '.tmp', JSON.stringify(data));
  fs.renameSync(out + '.tmp', out);
};
await mapLimit(servers, concurrency, async (s) => {
  if (Date.now() > deadline) return;
  try {
    const { tools } = await pool.get(s);
    data.servers[s.id] = tools?.length ? 'ok' : 'error';
  } catch (e) {
    data.servers[s.id] = category(errMsg(e));
  } finally {
    await pool.close(s.id).catch(() => {});
  }
  if (++n % 200 === 0) {
    save();
    const c = {};
    for (const v of Object.values(data.servers)) c[v] = (c[v] || 0) + 1;
    console.log(`${n}/${servers.length}`, JSON.stringify(c));
  }
});
save();
await pool.closeAll();
const c = {};
for (const v of Object.values(data.servers)) c[v] = (c[v] || 0) + 1;
console.log('done', JSON.stringify(c));
process.exit(0);
