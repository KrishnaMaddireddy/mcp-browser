// Wires the pieces together. Used by the HTTP server, the CLI and tests.
import { Catalog } from './catalog.js';
import { HealthStore } from './health.js';
import { McpPool } from './pool.js';
import { createOAuth } from './oauth.js';
import { StarsStore, fetchStars, repoKeys, starsView } from './github.js';
import { guardedFetch } from './netguard.js';
import { SearchAgent } from './agent.js';
import { loadSettings, saveSettings, resolveProvider, isLocalHost } from './config.js';
import { makeProvider } from './llm/index.js';
import { loadRegistry, syncRegistry, FORMAT } from './registry.js';
import { errMsg, mapLimit, log } from './util.js';
import { EmbeddingIndex } from './embeddings.js';
import { runRank, rankScores, loadRank, SUITES } from './rank.js';
import { WatchStore, WatchScheduler } from './watches.js';

function isLocalHostUrl(url) {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Keep every server of one question connected at once, plus some reuse across questions. */
const poolSize = (s) => Math.max(12, (s.maxServers || 4) + 8);

let answeringCache = { key: undefined, n: 0 };

export function createEngine({ providerOverride, curated, extraServers = [], allowPrivate, health, fetchImpl, embeddings } = {}) {
  let settings = loadSettings();
  health = health || new HealthStore();
  if (embeddings === undefined) embeddings = process.env.MCPB_SEMANTIC === 'off' ? null : new EmbeddingIndex();
  const catalog = new Catalog({ health, settings, curated, embeddings });
  catalog.rankScores = rankScores();
  if (extraServers.length) catalog.addServers(extraServers);
  const pool = new McpPool({
    connectTimeoutMs: settings.connectTimeoutMs,
    health,
    fetchImpl,
    // Only servers the user added by hand (source: custom) may live on localhost/LAN.
    // A server you added that points at this computer or your LAN may use private addresses;
    // a public one you added gets the same DNS-rebinding protection as the registry.
    allowPrivate: allowPrivate || ((s) => s.source === 'custom' && isLocalHostUrl(s.url)),
    // Keys the user saved for a server: a replacement URL and/or one header.
    authFor: (s) => settings.serverAuth?.[s.id] || null,
    oauthFor: (s) => oauth.providerFor(s),
  });
  pool.maxConnections = poolSize(settings);
  const oauth = createOAuth({ catalog, pool, allowPrivate: pool.allowPrivate, fetchImpl });
  catalog.isSignedIn = (s) => oauth.status(s) === 'signed-in';
  pool.onAuthExpired = (s) => oauth.expire(s);
  let providerCache = null;
  const getProvider = () => {
    if (providerOverride !== undefined) return providerOverride;
    const r = resolveProvider(settings);
    const key = JSON.stringify(r);
    if (!providerCache || providerCache.key !== key) providerCache = { key, p: makeProvider(r) };
    return providerCache.p;
  };
  const agent = new SearchAgent({ catalog, pool, health, getSettings: () => settings, getProvider });

  const watches = new WatchStore();
  const scheduler = new WatchScheduler({ store: watches, agent });
  const sync = { running: false, progress: null, error: null, last: null };
  const rank = { running: false, category: null, progress: null, error: null };
  const stars = new StarsStore();
  const starsRun = { running: false, progress: null, error: null, last: null };
  // repo → number of catalog servers using it. Rebuilt only when the server
  // lists change (by reference), so per-server lookups stay O(1).
  let shared = null;
  const sharedCounts = () => {
    const sig = [catalog.registry?.servers, catalog.settings?.customServers, catalog._extra?.length, catalog.curated];
    if (!shared || shared.sig.some((v, i) => v !== sig[i])) shared = { sig, map: repoKeys(catalog.all()) };
    return shared.map;
  };

  return {
    catalog,
    pool,
    oauth,
    stars,
    /** GitHub stars for a server: { repo, url, stars, pushedAt, archived, fork, sharedWith } or null. */
    starsFor(s) {
      return starsView(stars, s, sharedCounts());
    },
    starsInfo() {
      return { repos: stars.size, fetchedAt: stars.fetchedAt, source: stars.source, hasToken: Boolean(settings.githubToken || process.env.GITHUB_TOKEN), ...starsRun };
    },
    /**
     * Refresh stars in the background. With a GitHub token: every repo, straight
     * from GitHub. Without: ecosyste.ms open data, oldest-missing first, capped.
     */
    refreshStars({ limit } = {}) {
      if (starsRun.running) return false;
      const token = settings.githubToken || process.env.GITHUB_TOKEN || '';
      const source = token ? 'github' : 'ecosystems';
      const known = (k) => Number(Boolean(stars.repos[k] && !stars.repos[k].u));
      const keys = [...sharedCounts().entries()]
        .sort((a, b) => known(a[0]) - known(b[0]) || b[1] - a[1])
        .map(([k]) => k)
        .slice(0, limit || (token ? 20000 : 1000));
      Object.assign(starsRun, { running: true, progress: { done: 0, total: keys.length }, error: null, source });
      (async () => {
        try {
          const r = await fetchStars(keys, { source, token, fetchFn: guardedFetch({ fetchImpl }), onProgress: (p) => (starsRun.progress = p) });
          stars.merge(r.repos, { source: source === 'github' ? 'GitHub API' : 'ecosyste.ms (GitHub data)' });
          starsRun.error = r.error;
          starsRun.last = { at: new Date().toISOString(), updated: r.done };
        } catch (e) {
          starsRun.error = errMsg(e);
        } finally {
          starsRun.running = false;
        }
      })();
      return true;
    },
    health,
    agent,
    get settings() {
      return settings;
    },
    updateSettings(patch) {
      settings = saveSettings(patch);
      catalog.setSettings(settings);
      pool.connectTimeoutMs = settings.connectTimeoutMs;
      pool.maxConnections = poolSize(settings);
      if (patch?.semanticRouting === true && embeddings && !embeddings.ready) this.buildEmbeddings();
      return settings;
    },
    providerInfo() {
      if (providerOverride !== undefined) return { provider: providerOverride ? providerOverride.name : 'none' };
      const r = resolveProvider(settings);
      return { provider: r.provider, model: r.model, reason: r.reason, baseUrl: r.baseUrl };
    },
    syncState: sync,
    async syncRegistry({ full = false } = {}) {
      if (sync.running) return { started: false, message: 'already running' };
      sync.running = true;
      sync.error = null;
      sync.progress = { pages: 0, seen: 0, kept: 0 };
      try {
        const r = await syncRegistry({ full, fetchImpl, onProgress: (p) => (sync.progress = p) });
        catalog.setRegistry(r);
        sync.last = { at: r.syncedAt, ...r.lastRun, kept: r.servers.length };
        this.buildEmbeddings();
        return { started: true, ...sync.last };
      } catch (e) {
        sync.error = errMsg(e);
        throw e;
      } finally {
        sync.running = false;
      }
    },
    /** Connect to servers to check they answer without credentials. */
    async probe(ids, concurrency = 8) {
      const servers = ids.map((id) => catalog.get(id)).filter(Boolean);
      const res = await mapLimit(servers, concurrency, async (s) => {
        const { tools } = await pool.get(s);
        return { id: s.id, ok: true, tools: tools.length };
      });
      catalog.invalidate();
      return res.map((r, i) => (r.ok ? r.value : { id: servers[i].id, ok: false, error: errMsg(r.error) }));
    },
    embeddings,
    /** Build/refresh meaning-based routing vectors in the background (no-op if unavailable). */
    buildEmbeddings() {
      if (!embeddings || settings.semanticRouting === false) return Promise.resolve(null);
      return embeddings.build(catalog.all(), (id) => health.knownTools(id)).then(
        (st) => {
          if (st?.status === 'ready') log.info(`semantic routing ready (${st.total} servers)`);
          return st;
        },
        (e) => log.warn('embedding build failed:', errMsg(e))
      );
    },
    watches,
    scheduler,
    /** Start re-running saved searches on their schedule (browser process only). */
    startWatches() {
      scheduler.start();
    },
    rankState: rank,
    /** Stars lookup by server id (for MCP Rank labels and pages). */
    githubById(id) {
      const s = catalog.get(id);
      return s ? starsView(stars, s, sharedCounts()) : null;
    },
    rankData: () => ({ ...loadRank(), suites: Object.fromEntries(Object.entries(SUITES).map(([k, v]) => [k, { title: v.title, tests: v.tests.length }])) }),
    /** Run MCP Rank for one category (one run at a time). */
    async runRank(category, opts = {}) {
      if (rank.running) throw new Error(`a ranking run is already in progress (${rank.category})`);
      Object.assign(rank, { running: true, category, progress: { done: 0, total: 0 }, error: null });
      try {
        // Candidates are chosen by meaning: bring vectors up to date first
        // (only new or changed servers are embedded).
        await this.buildEmbeddings();
        const r = await runRank(this, category, { ...opts, onProgress: (p) => (rank.progress = { done: p.done, total: p.total, last: p.last?.title }) });
        catalog.rankScores = rankScores();
        return r;
      } catch (e) {
        rank.error = errMsg(e);
        throw e;
      } finally {
        rank.running = false;
      }
    },
    registryInfo() {
      const r = catalog.registry || loadRegistry();
      // How many of them answer without a key (per the reachability probe); cached per sync.
      if (answeringCache.key !== r.syncedAt) {
        const list = (r.servers || []).filter((x) => !x.needsAuth);
        answeringCache = { key: r.syncedAt, n: list.filter((x) => catalog.reachable({ source: 'registry', ...x })).length };
      }
      return { syncedAt: r.syncedAt, keyless: r.stats?.keyless ?? r.servers?.length ?? 0, answering: answeringCache.n, stats: r.stats || null, stale: Boolean(r.syncedAt) && r.format !== FORMAT };
    },
    async close() {
      scheduler.stop();
      health.flush();
      await pool.closeAll();
    },
  };
}
