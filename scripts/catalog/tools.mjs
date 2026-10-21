// List the tools of every hosted server that answers without a key, so the
// catalog can show what each server offers and suggest prompts from it.
// Results accumulate in `out` (name → { at, tools: [...] }); servers listed in
// the last `maxAgeDays` are skipped.
import { McpPool } from '../../src/pool.js';
import { classifyTool, cleanDescription } from '../../src/policy.js';

const MAX_TOOLS = 25;

function compactTool(t) {
  const ok = classifyTool(t).allowed;
  const schema = t.inputSchema || {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string' && props[k]) : [];
  const params = required.slice(0, 4).map((k) => {
    const p = props[k] || {};
    const e = Array.isArray(p.enum) ? p.enum.find((x) => typeof x === 'string' && x.length < 40) : undefined;
    const ex = Array.isArray(p.examples) ? p.examples.find((x) => typeof x === 'string' && x.length < 60) : undefined;
    return { k, t: typeof p.type === 'string' ? p.type : '', d: cleanDescription(p.description || '').slice(0, 120), ...(e ? { e } : {}), ...(ex ? { x: ex } : {}) };
  });
  return {
    n: String(t.name || '').slice(0, 80),
    // A tool flagged for hidden instructions keeps its name but not its words.
    d: /instructions aimed at the model/.test(classifyTool(t).reason || '') ? '' : cleanDescription(t.description || t.title || '').slice(0, 220),
    p: params,
    ...(ok ? {} : { w: 1 }), // not read-only (or otherwise not used by MCP Browser)
  };
}

/** servers: [{ id, url, transport }]. */
export async function probeTools(servers, out, { concurrency = 32, maxAgeDays = 7, deadline = Infinity, save = () => {}, log = console.log } = {}) {
  const fresh = Date.now() - maxAgeDays * 86400_000;
  const todo = servers.filter((s) => !(out[s.id]?.at > fresh));
  log(`  tools: ${todo.length} servers to list (${servers.length - todo.length} recent)`);
  const pool = new McpPool({ connectTimeoutMs: 8000, maxConnections: concurrency * 2, idleMs: 1000 });
  let i = 0;
  let n = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < todo.length && Date.now() < deadline) {
      const s = todo[i++];
      try {
        const { tools } = await pool.get({ ...s, source: 'registry', trust: 'community' });
        out[s.id] = { at: Date.now(), tools: (tools || []).slice(0, MAX_TOOLS).map(compactTool) };
      } catch {
        out[s.id] = { at: Date.now(), tools: [], failed: 1 };
      } finally {
        await pool.close(s.id).catch(() => {});
      }
      if (++n % 500 === 0) (save(), log(`  tools: ${n}/${todo.length}`));
    }
  }));
  await pool.closeAll().catch(() => {});
  save();
  return out;
}

/** Hosted servers worth listing: HTTPS, no template, no required headers. */
export function listable(latest) {
  const out = [];
  for (const s of latest) {
    const r = (s.remotes || []).find((x) => (x.type === 'streamable-http' || x.type === 'sse') && /^https:\/\//i.test(x.url || '') && !/[{}]/.test(x.url) && !x.headers);
    if (r && s.status !== 'deleted') out.push({ id: s.name, url: r.url, transport: r.type });
  }
  return out;
}
