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
import { loadCatalog, adhocFor } from './catalog-index.js';
import { LocalServers } from './local-servers.js';
import { classifyTool } from './policy.js';

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
  const local = new LocalServers({ onChange: () => catalog.invalidate() });
  catalog.local = local;
  const pool = new McpPool({
    localLaunch: (s) => local.launch(s),
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

  /**
   * Call one tool of a catalog server by id (for features that ask a fixed, vetted server:
   * Dependency check). A server switched off in Settings is never called.
   */
  async function callCatalogTool(id, tool, args, { signal, timeoutMs = 30000 } = {}) {
    if (settings.serverOverrides?.[id] === false) throw new Error('switched off in Settings');
    const c = loadCatalog();
    const server = catalog.get(id) || (c?.byName.get(id) ? adhocFor(c.byName.get(id)) : null);
    if (!server) throw new Error('not in the catalog');
    const r = await pool.callTool(server, tool, args, { timeoutMs, signal });
    if (r?.isError) throw new Error(String(r.content?.[0]?.text || 'the server returned an error').slice(0, 200));
    return r;
  }
  /**
   * The same, for a pipeline step that names a server and a tool: only a tool that reads (the
   * same rule that hides write tools from the AI model), never one you switched off. own: the
   * pipeline is one you saved yourself, so it may use any server you set up (see pipelineServerAllowed).
   */
  async function callReadOnlyTool(id, tool, args, { own = false, ...opts } = {}) {
    // (switched off: refused before anything connects to it)
    if (settings.serverOverrides?.[id] === false) throw new Error('switched off in Settings');
    const c = loadCatalog();
    const server = catalog.get(id) || (c?.byName.get(id) ? adhocFor(c.byName.get(id)) : null);
    if (!server) throw new Error('not in the catalog');
    // A pipeline file can come from anyone, so its steps may only call a hosted server from the
    // curated list or the registry, over HTTPS, that needs no key or sign-in: never a server on this
    // computer, one you added, or one that would act as you.
    // A pipeline you saved yourself may use your own servers too: you chose them.
    if (!(own ? ownServerOk(server) : pipelineServerOk(server))) throw new Error(own ? `${id} needs a key or sign-in you haven't added` : `${id} can't be called from this pipeline: only hosted servers that need no key or sign-in can (only pipelines you build and save yourself can use your own servers)`);
    const { tools } = await pool.get(server);
    const t = (tools || []).find((x) => x.name === tool);
    if (!t) throw new Error(`${id} has no tool called ${tool}`);
    const v = classifyTool(t, { trust: server.trust });
    if (!v.allowed) throw new Error(`${tool} isn't a read-only tool (${v.reason})`);
    return callCatalogTool(id, tool, args, opts);
  }
  // (nothing that would act as you: no key or address you saved for it, no sign-in you made)
  const pipelineServerOk = (s) =>
    (s.source === 'curated' || s.source === 'registry') &&
    /^https:\/\//i.test(String(s.url || '')) &&
    !s.needsAuth &&
    !s.signIn &&
    !s.command &&
    !(s.headers && Object.keys(s.headers).length) &&
    !(s.env && Object.keys(s.env).length) &&
    !settings.serverAuth?.[s.id] &&
    !catalog.hasAuth(s) &&
    oauth.status(s) !== 'signed-in';
  // (in a pipeline you saved: any server you set up that's usable — a key it needs added, a sign-in
  // it needs made; package servers are in the catalog only once you approved running them)
  const ownServerOk = (s) => (!s.needsAuth || catalog.hasAuth(s)) && (!s.signIn || oauth.status(s) === 'signed-in');
  const serverById = (id) => {
    const c = loadCatalog();
    return catalog.get(id) || (c?.byName.get(id) ? adhocFor(c.byName.get(id)) : null);
  };
  /**
   * May a pipeline step use this server, by id? A pipeline anyone could have written (the library,
   * one not saved): only hosted servers that need no key or sign-in. One you saved yourself
   * ({ own: true }): any server you set up. Never one you switched off.
   */
  function pipelineServerAllowed(id, { own = false } = {}) {
    if (settings.serverOverrides?.[id] === false) return false;
    const server = serverById(id);
    return Boolean(server) && (own ? ownServerOk(server) : pipelineServerOk(server));
  }
  /** The same rule for a server object (for routing, where servers are picked, not named). */
  function pipelineServerFits(server, { own = false } = {}) {
    if (!server || settings.serverOverrides?.[server.id] === false) return false;
    return own ? ownServerOk(server) : pipelineServerOk(server);
  }
  /** The servers a pipeline names that only your own saved copy may use (keys, sign-ins, yours). */
  function ownOnlyServers(p) {
    const ids = [...new Set((p?.steps || []).flatMap((st) => [...(st.servers || []), ...(st.call?.server ? [st.call.server] : [])]))];
    return ids.filter((id) => !pipelineServerAllowed(id) && pipelineServerAllowed(id, { own: true }));
  }
  const watches = new WatchStore();
  const scheduler = new WatchScheduler({ store: watches, agent, callTool: callCatalogTool, pipelineTool: callReadOnlyTool, pipelineServerAllowed, pipelineServerFits: (sv, o) => pipelineServerFits(sv, o) });
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
    callCatalogTool,
    callReadOnlyTool,
    pipelineServerAllowed,
    pipelineServerFits,
    ownOnlyServers,
    /** How a schedule checks, each run, that its pipeline is still your saved copy (set by the app server). */
    setPipelineOwnCheck(fn) {
      scheduler.ownCheck = fn;
    },
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
    local,
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
