// Read the whole official MCP Registry quickly: the name space is split into
// alphabetical shards (the API accepts any name as a cursor), and the shards are
// paged in parallel, each stopping where the next one starts.
const BASE = process.env.MCPB_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';
const GH = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => 'io.github.' + c);
const STARTS = [...new Set(['', 'ai.', 'ai.m', 'app', 'b', 'c', 'com.', 'com.c', 'com.g', 'com.m', 'com.p', 'com.s', 'com.v', 'd', 'dev.', 'e', 'f', 'g', 'h', 'i', 'io.', 'io.c', 'io.f', ...GH, 'io.h', 'io.m', 'io.p', 'io.s', 'io.w', 'j', 'k', 'l', 'm', 'n', 'net.', 'o', 'org.', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'])].sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compact record of one registry entry (latest version). */
function compact(e) {
  const s = e.server || {};
  const m = e._meta?.['io.modelcontextprotocol.registry/official'] || {};
  return {
    name: s.name, title: s.title || '', description: s.description || '', version: s.version || '',
    website: s.websiteUrl || '', repo: s.repository?.url || '',
    packages: (s.packages || []).map((p) => ({ type: p.registryType || p.registry_type || '', id: p.identifier || p.name || '', env: (p.environmentVariables || []).filter((v) => v.isRequired).length })),
    remotes: (s.remotes || []).map((r) => ({ type: r.type, url: r.url, headers: (r.headers || []).filter((h) => h.isRequired).length })),
    status: m.status || '', published: m.publishedAt || '', updated: m.updatedAt || '',
  };
}

/**
 * latest: true → Map name → compact record of the latest version.
 * latest: false → Map name → { first: earliest publishedAt, versions: count } over every version.
 */
export async function fetchRegistry({ latest = true, concurrency = 12, log = console.log } = {}) {
  const rows = new Map();
  let pages = 0;
  async function shard(i) {
    const start = STARTS[i];
    const end = STARTS[i + 1];
    let cursor = start || null;
    for (;;) {
      const q = new URLSearchParams({ limit: '100' });
      if (latest) q.set('version', 'latest');
      if (cursor) q.set('cursor', cursor);
      let j;
      for (let a = 0; a < 8 && !j; a++) {
        try {
          const r = await fetch(`${BASE}/v0.1/servers?${q}`, { signal: AbortSignal.timeout(60000) });
          if (r.status === 429 || r.status >= 500) {
            await sleep(3000 * (a + 1));
            continue;
          }
          j = await r.json();
        } catch {
          await sleep(2000);
        }
      }
      if (!j) throw new Error(`registry shard ${start || '(start)'} failed at ${cursor}`);
      pages++;
      let stop = false;
      for (const e of j.servers || []) {
        const n = e.server?.name || '';
        if (end && n >= end) {
          stop = true;
          break;
        }
        if (latest) rows.set(n, compact(e));
        else {
          const p = e._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt || '';
          const o = rows.get(n) || { first: p, versions: 0 };
          if (p && (!o.first || p < o.first)) o.first = p;
          o.versions++;
          rows.set(n, o);
        }
      }
      cursor = j.metadata?.nextCursor;
      if (stop || !cursor) return;
    }
  }
  let next = 0;
  const timer = setInterval(() => log(`  registry: ${pages} pages, ${rows.size} servers`), 30000);
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < STARTS.length) await shard(next++);
    }));
  } finally {
    clearInterval(timer);
  }
  return rows;
}
