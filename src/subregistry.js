// MCP Browser as an MCP Registry *subregistry*: the official registry's read API
// (GET /v0.1/servers, /v0.1/servers/{name}/versions[/{version}]) re-served from
// the local catalog, with MCP Rank measurements attached under
// _meta["local.mcp-browser/rank"]. Any client that speaks the registry API can
// consume the rankings. Spec: https://modelcontextprotocol.io/registry/registry-aggregators
import { exportLabels } from './rank.js';

export const META_KEY = 'local.mcp-browser/rank';
export const GITHUB_KEY = 'local.mcp-browser/github';
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const MAX_LIMIT = 100;

/** Registry-style name: registry ids are kept; curated/custom ids get a namespace. */
export function registryName(s) {
  return s.source === 'registry' ? s.id : s.source === 'custom' ? `local.mcp-browser.${s.id}` : `local.mcp-browser/${s.id}`;
}

/** Rebuild a minimal server.json from the catalog entry (no keys or headers). */
export function toServerJson(s) {
  const j = {
    $schema: SCHEMA,
    name: registryName(s),
    title: s.title,
    description: s.description || '',
    version: s.version || '1.0.0',
    remotes: [{ type: s.transport === 'sse' ? 'sse' : 'streamable-http', url: s.url }],
  };
  if (s.website) j.websiteUrl = s.website;
  if (s.repo) j.repository = { url: s.repo, source: /github\.com/.test(s.repo) ? 'github' : 'other' };
  return j;
}

function rankMeta(label) {
  if (!label) return null;
  return {
    bestScore: label.bestScore,
    reachableWithoutKey: label.reachableWithoutKey,
    free: label.free,
    rateLimited: label.rateLimited,
    injectsTextAimedAtAI: label.injectsTextAimedAtAI,
    writeToolsHidden: label.writeToolsHidden,
    metadataQuality: label.metadataQuality,
    categories: label.categories,
  };
}

/** A paginated, registry-compatible list. Extensions: ranked_only=true, sort=rank. */
export function listServers(engine, params) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || 30));
  const cursor = params.get('cursor') || '';
  const search = (params.get('search') || '').trim().toLowerCase();
  const rankedOnly = params.get('ranked_only') === 'true';
  const byRank = params.get('sort') === 'rank';
  const since = params.get('updated_since') ? Date.parse(params.get('updated_since')) : null;
  const labels = new Map(exportLabels().servers.map((l) => [l.id, l]));

  let rows = engine.catalog.all().map((s) => ({ s, name: registryName(s), label: labels.get(s.id) }));
  if (rankedOnly) rows = rows.filter((r) => r.label);
  if (search) rows = rows.filter((r) => `${r.name} ${r.s.title} ${r.s.description}`.toLowerCase().includes(search));
  if (since && Number.isFinite(since)) rows = rows.filter((r) => !r.s.updatedAt || Date.parse(r.s.updatedAt) >= since);
  rows.sort(byRank ? (a, b) => (b.label?.bestScore ?? -1) - (a.label?.bestScore ?? -1) || a.name.localeCompare(b.name) : (a, b) => a.name.localeCompare(b.name));

  // Cursor = the last name returned (as in the official API); for sort=rank it's an offset.
  let start = 0;
  if (cursor) {
    if (byRank) start = Math.max(0, Number(cursor) || 0);
    else start = rows.findIndex((r) => r.name > cursor);
    if (start < 0) start = rows.length;
  }
  const page = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return {
    servers: page.map((r) => wrap(r, engine)),
    metadata: {
      count: page.length,
      ...(more ? { nextCursor: byRank ? String(start + limit) : page[page.length - 1].name } : {}),
    },
  };
}

function wrap({ s, label }, engine) {
  // Only entries that really came from the official registry carry its metadata key.
  const meta = s.source === 'registry' ? { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}) } } : {};
  const rm = rankMeta(label);
  if (rm) meta[META_KEY] = rm;
  const g = engine?.starsFor?.(s);
  if (g && !g.unknown) meta[GITHUB_KEY] = g.missing ? { repo: g.repo, missing: true } : { repo: g.repo, stars: g.stars, pushedAt: g.pushedAt, archived: g.archived };
  return { server: toServerJson(s), _meta: meta };
}

/** One server by registry name (only the latest version is kept locally). */
export function getServer(engine, name, version) {
  const s = engine.catalog.all().find((x) => registryName(x) === name);
  if (!s) return null;
  if (version && version !== 'latest' && version !== (s.version || '1.0.0')) return null;
  const label = exportLabels().servers.find((l) => l.id === s.id);
  return wrap({ s, label }, engine);
}
