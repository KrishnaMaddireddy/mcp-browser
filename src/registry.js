// Mirror of the official MCP Registry (registry.modelcontextprotocol.io),
// reduced to the servers this browser can actually reach: remote, active,
// HTTPS, and not declaring a required credential header.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { cleanText, log, errMsg } from './util.js';

export const REGISTRY_URL = process.env.MCPB_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';
const PAGE = 100;
const MAX_PAGES = 1500;
export const FORMAT = 2; // bump when toCandidate changes, forcing a full re-sync

function cachePath() {
  return path.join(dataDir(), 'registry.json');
}

/**
 * Turn one registry record into our compact server shape, or explain why it
 * was skipped. Exported for tests.
 */
export function toCandidate(rec) {
  const s = rec?.server;
  if (!s?.name) return { skip: 'malformed' };
  const meta = rec._meta?.['io.modelcontextprotocol.registry/official'] || {};
  if (meta.status && meta.status !== 'active') return { skip: 'inactive', id: s.name };
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  if (!remotes.length) return { skip: 'package-only', id: s.name };
  const shapeOk = (r) =>
    r && typeof r.url === 'string' && (r.type === 'streamable-http' || r.type === 'sse') &&
    /^https:\/\//i.test(r.url) && // never plain http from the internet
    !/[{}]/.test(r.url); // templated URL needs user values
  const required = (r) => (Array.isArray(r.headers) ? r.headers : []).filter((h) => h?.isRequired);
  const byType = (a, b) => (a.type === 'streamable-http' ? -1 : 1) - (b.type === 'streamable-http' ? -1 : 1);
  let r = remotes.filter((x) => shapeOk(x) && required(x).length === 0).sort(byType)[0];
  let authHeaders;
  if (!r) {
    // Keep servers that need a key, so the user can add one; they stay off until then.
    r = remotes.filter((x) => shapeOk(x) && required(x).every((h) => /^[A-Za-z0-9-]{1,64}$/.test(h.name || ''))).sort(byType)[0];
    if (!r) return { skip: 'unusable', id: s.name };
    authHeaders = required(r).slice(0, 3).map((h) => ({ name: h.name, description: cleanText(h.description || '').slice(0, 200) }));
  }
  const server = {
    id: s.name,
    title: cleanText(s.title || prettyName(s.name)).slice(0, 120),
    description: cleanText(s.description || '').slice(0, 400),
    url: r.url,
    transport: r.type,
    version: String(s.version || '').slice(0, 40),
    website: typeof s.websiteUrl === 'string' ? s.websiteUrl.slice(0, 300) : undefined,
    repo: typeof s.repository?.url === 'string' ? s.repository.url.slice(0, 300) : undefined,
    updatedAt: meta.updatedAt,
    source: 'registry',
    trust: 'community',
    tags: [],
  };
  if (authHeaders) {
    server.needsAuth = true;
    server.authHeaders = authHeaders;
  }
  return { server };
}

function prettyName(name) {
  const last = String(name).split('/').pop() || name;
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function loadRegistry() {
  try {
    const d = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (Array.isArray(d.servers)) return d;
  } catch {
    /* none yet */
  }
  return { syncedAt: null, servers: [], stats: null };
}

/**
 * Download the registry. Full crawl the first time, then only records
 * updated since the last sync. onProgress({pages, seen}) is called per page.
 */
export async function syncRegistry({ full = false, fetchImpl = fetch, onProgress, signal } = {}) {
  const prev = loadRegistry();
  const incremental = !full && prev.syncedAt && prev.servers.length > 0 && prev.format === FORMAT;
  const byId = new Map(incremental ? prev.servers.map((s) => [s.id, s]) : []);
  const stats = incremental && prev.stats ? { ...prev.stats } : { seen: 0, packageOnly: 0, needsAuth: 0, inactive: 0 };
  if (incremental) stats.seen = stats.seen || 0;
  const startedAt = new Date().toISOString();
  // Overlap by an hour so clock skew never drops an update.
  const since = incremental ? new Date(Date.parse(prev.syncedAt) - 3600_000).toISOString() : null;

  let cursor = null;
  let pages = 0;
  let seenThisRun = 0;
  do {
    if (signal?.aborted) throw new Error('sync aborted');
    const q = new URLSearchParams({ limit: String(PAGE), version: 'latest' });
    if (cursor) q.set('cursor', cursor);
    if (since) q.set('updated_since', since);
    const url = `${REGISTRY_URL}/v0.1/servers?${q}`;
    let data;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal });
        if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (e) {
        if (attempt >= 2 || signal?.aborted) throw e;
        log.warn('registry page failed, retrying:', errMsg(e));
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    const recs = Array.isArray(data?.servers) ? data.servers : [];
    for (const rec of recs) {
      seenThisRun++;
      const c = toCandidate(rec);
      if (c.server) byId.set(c.server.id, c.server);
      else if (c.id) byId.delete(c.id); // deprecated, deleted or no longer usable
      if (!incremental) {
        if (c.skip === 'package-only') stats.packageOnly++;
        else if (c.skip === 'inactive') stats.inactive++;
        else if (c.skip === 'unusable') stats.unusable = (stats.unusable || 0) + 1;
      }
    }
    pages++;
    onProgress?.({ pages, seen: seenThisRun, kept: byId.size });
    const next = data?.metadata?.nextCursor;
    cursor = next && next !== cursor && recs.length > 0 ? next : null;
  } while (cursor && pages < MAX_PAGES);

  if (!incremental) stats.seen = seenThisRun;
  stats.keyless = 0;
  stats.needsAuth = 0;
  for (const v of byId.values()) v.needsAuth ? stats.needsAuth++ : stats.keyless++;
  const out = { format: FORMAT, syncedAt: startedAt, servers: [...byId.values()], stats, lastRun: { incremental, pages, seen: seenThisRun } };
  const file = cachePath();
  fs.writeFileSync(file + '.tmp', JSON.stringify(out));
  fs.renameSync(file + '.tmp', file);
  return out;
}
