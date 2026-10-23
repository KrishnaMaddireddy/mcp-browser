// Local HTTP server: serves the browser UI and a small JSON/SSE API.
// It listens on 127.0.0.1 only and rejects cross-site requests, so web pages
// open in other tabs can't drive it or read the API key.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './app.js';
import { publicSettings, cleanCustomServer } from './config.js';
import { randomBytes } from 'node:crypto';
import { tokenize } from './util.js';
import { TEMPLATES } from './templates.js';
import { exportLabels } from './rank.js';
import { listServers, getServer } from './subregistry.js';
import { errMsg, log } from './util.js';
import { catalogFile, catalogTools } from './catalog-data.js';
import { auditInstalled } from './audit.js';
import { searchCatalog, describe as describeCatalogRow, adhocFor, loadCatalog, scriptServers, runnable as catalogRunnable, trustOf, guideLib, testedView } from './catalog-index.js';
import { packageInfo, runtimes, sandboxStatus, healLaunch, explainFailure } from './local-servers.js';
import { WebMcpDirectory } from './webmcp-dir.js';
import { crossCheck, claimsIn } from './crosscheck.js';
import { detectEntity, detectPair, runCard } from './cards.js';
import { parseTrack, figureIn, thresholdMet } from './track.js';
import { parseManifest, runDeps, repoOf, fetchRepoDeps } from './deps.js';
import { STARTERS, TOPICS, loadLibrary, PipelineStore, cleanPipeline, runPipeline } from './pipelines.js';
import { pickQueryTool } from './agent.js';
import { langOf } from './quality.js';
import { StackStore } from './stack.js';
import { setupScript } from './stack-script.js';
import { applyStack, detectClients } from './stack-run.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// How Claude Desktop / Claude Code can start MCP server mode. From the project
// folder: node + the script. Inside the packaged app: the app's own binary in
// Node mode (ELECTRON_RUN_AS_NODE) + the script inside its archive.
// Changes whenever the server restarts or a UI file changes; the page polls it in
// dev mode and reloads itself, so synced updates show up without a manual restart.
const DEV = process.env.MCPB_DEV === '1';
const BOOT_ID = `${process.pid}-${Date.now()}`;
function buildId() {
  let newest = 0;
  try {
    for (const f of fs.readdirSync(PUBLIC)) newest = Math.max(newest, fs.statSync(path.join(PUBLIC, f)).mtimeMs);
  } catch {
    /* ignore */
  }
  return `${BOOT_ID}-${Math.round(newest)}`;
}

const MCP_LAUNCH = (() => {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-server.js');
  if (process.versions.electron && p.includes('.asar')) return { command: process.execPath, args: [p], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return fs.existsSync(p) ? { command: 'node', args: [p], env: {} } : null;
})();
const MIME = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

export function createServer({ engine = createEngine(), port = 7777 } = {}) {
  let server;
  let stackStore = null;
  const stack = () => (stackStore ||= new StackStore());
  const allowedHosts = () => {
    const p = server?.address()?.port ?? port;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  };

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }

  async function readJson(req, limit = 64 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
  }

  /** Same-origin checks: Host must be ours (DNS rebinding) and writes need our header + origin. */
  function guard(req) {
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) return 'bad host';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-mcpb'] !== '1') return 'missing x-mcpb header';
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, '').toLowerCase())) return 'cross-origin request';
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) return 'content-type must be application/json';
    }
    return null;
  }

  function serverView(s) {
    const h = engine.health.get(s.id);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      url: s.url,
      source: s.source,
      trust: s.trust,
      enabled: engine.catalog.isEnabled(s),
      needsAuth: Boolean(s.needsAuth),
      authHeaders: s.authHeaders || [],
      hasAuth: engine.catalog.hasAuth(s),
      github: engine.starsFor(s),
      signIn: engine.oauth.status(s) || (s.signIn ? 'needed' : null) || (h?.error && /needs sign-in|sign-in expired/.test(h.error) ? 'needed' : null),
      override: engine.settings.serverOverrides[s.id] ?? null,
      website: s.website,
      repo: typeof s.repo === 'string' && /^https?:\/\//i.test(s.repo) ? s.repo : null,
      updatedAt: s.updatedAt || null,
      health: h ? { status: h.status, checkedAt: h.checkedAt, latencyMs: h.latencyMs, tools: h.tools?.length ?? 0, error: h.error, available: engine.health.isAvailable(s.id) } : null,
    };
  }

  // ---------- WebMCP: tools offered by the web page open in a tab ----------
  let webmcpDir = null;
  const webmcp = () => (webmcpDir ||= new WebMcpDirectory());
  const pagePending = new Map(); // callId -> { resolve, reject, timer }
  const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
  /**
   * The page's tools as the app window reported them. Only script tools go to the
   * agent (forms act on the page); policy.js then hides any that look like they
   * change something, and the directory's "act"/"transact" labels hide more.
   */
  function cleanPage(p) {
    if (!p || typeof p !== 'object') return null;
    let u;
    try {
      u = new URL(String(p.url || ''));
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const listed = webmcp().data ? webmcp().byHost.get(host) : null;
    const kindOf = (n) => listed?.tools.find((t) => t.name === n)?.kind;
    const tools = (Array.isArray(p.tools) ? p.tools : [])
      .slice(0, 60)
      .filter((t) => t && TOOL_NAME.test(String(t.name || '')) && t.kind !== 'form' && !['act', 'transact'].includes(kindOf(t.name)))
      .map((t) => {
        let schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        if (JSON.stringify(schema).length > 20000) schema = { type: 'object', properties: {} };
        return { name: String(t.name), description: String(t.description || '').slice(0, 1200), inputSchema: schema, readOnly: t.readOnly === true };
      });
    return { host, url: u.href, title: String(p.title || host).slice(0, 120), tools };
  }
  function pageServer(page, emit, signal) {
    return {
      id: `page:${page.host}`,
      title: `${page.title} (this page)`,
      description: 'Tools this web page offers through WebMCP',
      url: `page://${page.host}`,
      kind: 'page',
      source: 'page',
      trust: 'community',
      tags: [],
      pageTools: page.tools,
      // The app window runs the tool in the page and posts the result back.
      callPage: (name, args) =>
        new Promise((resolve, reject) => {
          const callId = randomBytes(16).toString('hex');
          const done = (fn, v) => {
            const p = pagePending.get(callId);
            if (!p) return;
            clearTimeout(p.timer);
            pagePending.delete(callId);
            fn(v);
          };
          pagePending.set(callId, { resolve: (v) => done(resolve, v), timer: setTimeout(() => done(reject, new Error('the page didn’t answer within 60 seconds')), 60000) });
          signal?.addEventListener('abort', () => done(reject, new Error('stopped')), { once: true });
          emit('page_tool_call', { callId, name, args });
        }),
    };
  }

  async function handleSearch(req, res) {
    const body = await readJson(req, 512 * 1024);
    const query = String(body.query || '').trim();
    if (!query) return json(res, 400, { error: 'query required' });
    const history = Array.isArray(body.history)
      ? body.history.slice(-3).map((h) => ({ q: String(h?.q || '').slice(0, 2000), a: String(h?.a || '').slice(0, 6000) }))
      : [];
    let servers = Array.isArray(body.servers) ? body.servers.slice(0, 10).map(String) : undefined;
    // Catalog servers this browser hasn't synced: allow them for this one question,
    // only as hosted HTTPS servers with no key (the pool's network guard still applies).
    const adhoc = (Array.isArray(body.adhoc) ? body.adhoc : body.adhoc ? [body.adhoc] : [])
      .slice(0, 5)
      .filter((a) => a && typeof a === 'object' && servers?.includes(String(a.id)) && /^https:\/\/[^\s{}]+$/i.test(String(a.url || '')) && String(a.url).length < 500)
      .map((a) => ({ id: String(a.id).slice(0, 200), title: String(a.title || a.id).slice(0, 120), description: String(a.description || '').slice(0, 400), url: String(a.url), transport: a.transport === 'sse' ? 'sse' : 'streamable-http', source: 'registry', trust: 'community', tags: [] }));
    const discovery = body.discovery === true;
    const wide = body.wide === true; // "Search wider": one search with a bigger net
    const page = cleanPage(body.page);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const emit = (type, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
    // "Ask this page": the page's own tools answer (asked through the app window).
    if (page) {
      if (!page.tools.length) {
        emit('error', { message: 'This page has no tools that only read, so there is nothing to ask. Its other tools are under Tools on this page.' });
        emit('done', { mode: 'none' });
        clearInterval(ping);
        return res.end();
      }
      // Free mode can only use a tool that takes the question as text.
      if (engine.providerInfo().provider === 'none' && !pickQueryTool(page.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), query)) {
        emit('error', { message: 'This page’s tools need an AI model to fill in their inputs (none of them takes a plain question). Add a model in Settings, or run a tool yourself under Tools on this page.' });
        emit('done', { mode: 'none' });
        clearInterval(ping);
        return res.end();
      }
      const ps = pageServer(page, emit, ac.signal);
      adhoc.push(ps);
      servers = [ps.id];
    }
    try {
      emit('provider', engine.providerInfo());
      await engine.agent.search(query, { emit, signal: ac.signal, history, servers, discovery, wide, adhoc, route: typeof body.route === 'string' ? body.route.slice(0, 300) : undefined });
    } catch (e) {
      if (!ac.signal.aborted) {
        log.warn('search failed:', errMsg(e));
        emit('error', { message: errMsg(e) });
        emit('done', { mode: 'error' });
      }
    } finally {
      clearInterval(ping);
      res.end();
    }
  }

  // ---------- package servers run on this computer (local-servers.js) ----------
  const LOCAL_TYPES = new Set(['npm', 'pypi', 'oci']);
  /** The catalog facts behind an approval: what it is, its settings, how much to trust it. */
  function localFacts(id) {
    const c = loadCatalog();
    const r = c?.byName.get(String(id));
    if (!r) return null;
    const { F } = c;
    const type = r[F.pkgType];
    const settings = ((F.envs != null && r[F.envs]) || []).filter(([, , , kind]) => kind !== 'h').map(([name, secret, d]) => ({ name, secret: Boolean(secret), description: guideLib().explain(name, d).slice(0, 200) }));
    return { row: r, F, type, pkgId: r[F.pkgId], title: r[F.title] || r[F.name].split('/').pop(), description: r[F.desc] || '', settings, trust: trustOf(r), stars: r[F.stars], downloads: r[F.downloads], repo: r[F.repo], hosted: catalogRunnable(r, F) };
  }
  const shq = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, `'\\''`)}'`);
  /** The command an approval runs: argv is what follows npx / uvx / docker run (see argvFor). */
  function commandText(type, name, version, isolation, argv) {
    const rest = (argv?.length ? argv : [type === 'oci' ? name : `${name}@${version}`]).map(shq).join(' ');
    if (type === 'oci' || isolation === 'docker') return `docker run -i --rm --cap-drop ALL ${type === 'oci' ? rest : type === 'npm' ? `node:22-slim npx -y ${rest}` : `ghcr.io/astral-sh/uv:python3.12-bookworm-slim uvx ${rest}`}`;
    const cmd = type === 'npm' ? `npx -y ${rest}` : `uvx --no-build ${rest}`;
    return isolation === 'sandbox' ? `${cmd}   (inside the macOS sandbox)` : cmd;
  }
  /**
   * What follows npx / uvx / docker run for a catalog row pinned to version: the
   * registry's startup arguments (made safe) around the package. { argv, needs, note }
   */
  function argvFor(f, version, wheel) {
    const l = guideLib().launchOf(f.row, f.F, { pin: { version, wheel } });
    if (l.kind !== 'local') return { argv: [], needs: [] };
    let args = l.args.slice();
    if (f.type === 'npm' && args[0] === '-y') args = args.slice(1);
    if (f.type === 'pypi' && args[0] === '--no-build') args = args.slice(1);
    if (f.type === 'oci') {
      args = args.slice(3); // run -i --rm
      while (args[0] === '-e' && f.settings.some((s) => s.name === args[1])) args = args.slice(2); // MCP Browser passes settings itself
    }
    return { argv: args, needs: l.needsArgs || [], note: l.note || '' };
  }
  /** Current version (and wheel) of each package row, to pin setups to. */
  async function pinsFor(rows) {
    const c = loadCatalog();
    const out = {};
    await Promise.all(
      rows.map(async (r) => {
        const t = r[c.F.pkgType];
        if (t !== 'npm' && t !== 'pypi') return;
        const i = await packageInfo(t, r[c.F.pkgId]);
        if (i.version) out[r[c.F.name]] = { version: i.version, wheel: i.wheel !== false };
      })
    );
    return out;
  }

  /** Approvals from before startup arguments were known: add them (same pinned version). */
  function upgradeApprovals() {
    let changed = false;
    for (const a of engine.local.approved) {
      if (a.argv) continue;
      const f = localFacts(a.id);
      if (!f || f.F.args == null || !f.row[f.F.args]) continue;
      const av = argvFor(f, a.version, a.isolation !== 'docker');
      if (av.argv.length && !av.needs.length) (a.argv = av.argv), (changed = true);
    }
    if (changed) engine.local.save();
  }
  setImmediate(() => {
    try {
      upgradeApprovals();
    } catch (e) {
      log.warn('upgrading approvals:', errMsg(e));
    }
  });

  // Start it; when the start fails in a way we know how to fix (stale package index, a
  // differently named command, a source build in the sandbox), fix the approval and try once more.
  async function startLocal(id, { healed = null } = {}) {
    const server = engine.catalog.get(id);
    if (!server || server.kind !== 'local') return { ok: false, error: 'fill in its settings first' };
    try {
      const { tools } = await engine.pool.get(server);
      return { ok: true, tools: tools.map((t) => t.name), state: engine.pool.state(id), ...(healed ? { healed } : {}) };
    } catch (e) {
      const log = String(e.log || '');
      const text = `${errMsg(e)}\n${log}`;
      const a = engine.local.get(id);
      if (a && !healed) {
        const info = a.type === 'npm' ? await packageInfo('npm', a.name).catch(() => ({})) : {};
        const fix = healLaunch(a, text, info);
        if (fix) {
          engine.local.patch(id, fix);
          await engine.pool.close(id);
          return startLocal(id, { healed: fix.why });
        }
      }
      const why = explainFailure(text);
      return { ok: false, error: errMsg(e).slice(0, 1500), log: log.slice(-4000), ...(why ? { hint: why.hint } : {}), ...(healed ? { healed } : {}) };
    }
  }
  function localView(a) {
    const st = engine.pool.state(a.id);
    const h = engine.health.get(a.id);
    return { id: a.id, title: a.title, type: a.type, name: a.name, version: a.version, isolation: a.isolation, approvedAt: a.approvedAt, trusted: a.trusted, settings: a.settings, values: a.values, missing: engine.local.missing(a), state: st, lastError: h?.status === 'fail' ? h.error : null, command: commandText(a.type, a.name, a.version, a.isolation, a.argv) };
  }

  // Suggestions while typing (browser address bar via OpenSearch, and the app's own boxes):
  // sample prompts from the catalog that start with, or contain, what was typed.
  let promptList = null;
  function suggest(q, n = 8) {
    const c = loadCatalog();
    if (!c) return [];
    if (!promptList) {
      const seen = new Set();
      promptList = [];
      // Questions people would type, not prompts about MCP itself ("find a paid weather API my agent can call").
      const META = /\b(apis?|mcp|agents?|x402|tools?|servers?|endpoints?|sdk|llm|prompt|bazaar|uptime|paid|call)\b/i;
      for (const r of c.rows) for (const [p] of (c.F.prompts != null && r[c.F.prompts]) || []) if (p.length <= 80 && !META.test(p) && !seen.has(p.toLowerCase())) (seen.add(p.toLowerCase()), promptList.push([p, p.toLowerCase(), r._pop || 0]));
      promptList.sort((a, b) => b[2] - a[2]);
    }
    const t = String(q || '').toLowerCase().trim();
    if (t.length < 2) return [];
    const words = t.split(/\s+/);
    const starts = [];
    const has = [];
    for (const [p, low] of promptList) {
      if (low.startsWith(t)) starts.push(p);
      else if (words.every((w) => low.includes(w))) has.push(p);
      if (starts.length >= n) break;
    }
    return [...starts, ...has].slice(0, n);
  }

  // What the start page offers to discover: servers you can ask right now (newest
  // first), popular servers, and how many of each. Cached per catalog file.
  let discoverCache = null;
  const todayOne = async (query, { items = 0 } = {}) => {
    const out = { query, answer: null, items: [] };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      await engine.agent.search(query, {
        signal: ac.signal,
        direct: true,
        emit: (type, d) => {
          if (type === 'quick_answer' && d?.text) out.answer = { text: d.text, url: d.url || null, site: d.site || '', server: d.server || '' };
          if (items && type === 'results' && !d.isError && (d.kind || 'ok') === 'ok' && !d.offTopic && d.view?.kind === 'items')
            for (const it of d.view.items) {
              if (out.items.length >= items) break;
              if (it.url && it.title && !out.items.some((x) => x.url === it.url || x.title === it.title)) out.items.push({ title: it.title, url: it.url, site: it.site || '', date: it.date || '' });
            }
        },
      });
    } catch {}
    clearTimeout(timer);
    return out;
  };
  // Articles only: a front page ("cnn.com/world") or a social post isn't a headline.
  const article = (u) => {
    try {
      const x = new URL(u);
      if (/(?:^|\.)(?:bsky\.app|news\.ycombinator\.com|reddit\.com|x\.com|twitter\.com|youtube\.com|news\.google\.com)$/.test(x.hostname)) return false;
      const parts = x.pathname.split('/').filter(Boolean);
      // (a topic, tag or team page lists stories: it isn't one)
      if (parts.some((p) => /^(?:topics?|tags?|team|teams|category|categories|section|author|people)$/i.test(p))) return false;
      return parts.length >= 3 || parts.some((p) => p.length >= 20);
    } catch {
      return false;
    }
  };
  // Well-known newsrooms first; the rest keep their order.
  const known = /(?:^|\.)(?:reuters\.com|apnews\.com|bbc\.(?:com|co\.uk)|npr\.org|nytimes\.com|theguardian\.com|washingtonpost\.com|wsj\.com|bloomberg\.com|cnbc\.com|cnn\.com|nbcnews\.com|abcnews\.go\.com|cbsnews\.com|axios\.com|politico\.com|ft\.com|economist\.com|aljazeera\.com|dw\.com|france24\.com|euronews\.com|news\.un\.org|latimes\.com|usatoday\.com|theverge\.com|techcrunch\.com)$/;
  const host = (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };
  const foreignEdition = (u) => {
    try {
      const x = new URL(u);
      return /\.(?:br|it|de|fr|es|nl|pt|pl|ru|jp|cn|kr|tr|ar|mx|se|no|dk|fi|cz|hu|ro|gr)$/.test(x.hostname) || /^\/(?:nl|de|fr|es|it|pt|pt-br|ja|zh|ko|ru|tr|pl|ar)(?:\/|$)/i.test(x.pathname);
    } catch {
      return false;
    }
  };
  // Headlines: articles only, well-known newsrooms first, the rest in their order.
  const headlines = (items, n) =>
    items
      // (a section page lists its sections: "News, Results, Fixtures, Scores, Stats")
      .filter((it) => article(it.url) && !/breaking news|latest news|top stories|headlines/i.test(it.title) && (String(it.title).match(/\b(?:news|results|fixtures|scores|stats|highlights|schedule|standings|rumou?rs|videos?|games|roster|tables?)\b/gi) || []).length < 3)
      .map((it, i) => ({ it, i, k: known.test(host(it.url)) ? 0 : 1 }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.it)
      .slice(0, n);
  // "Your topics" on Today: the latest headlines about one topic, kept 20 minutes.
  const topicCache = new Map();
  async function topicNews(topic, readerLang = 'en') {
    const key = `${topic.toLowerCase()}|${readerLang}`;
    const hit = topicCache.get(key);
    if (hit && Date.now() - hit.at < 20 * 60e3) return hit.data;
    // Dated news searches return articles (the "latest news" form returns front pages): both, merged.
    const day = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const [r1, r2] = await Promise.all([todayOne(`${topic} news ${day}`, { items: 15 }), todayOne(`${topic} latest news`, { items: 15 })]);
    const r = { items: [...r1.items, ...r2.items.filter((x) => !r1.items.some((y) => y.url === x.url))] };
    // (fresh only: a story from months ago isn't the latest)
    const week = Date.now() - 8 * 86400e3;
    r.items = r.items.filter((it) => !it.date || !(Date.parse(it.date) < week));
    // In the topic's language, dated, one story per site and one site per story.
    const lang = (langOf(topic) || 'en') === 'en' && readerLang !== 'en' ? 'any' : langOf(topic) || 'en';
    const seen = new Set();
    const lead = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 6).join(' ');
    const picked = headlines(r.items, 15).filter((it) => {
      if (lang !== 'any' && langOf(it.title) !== lang && langOf(it.title)) return false;
      // (an English topic: an edition in another language is another language's news)
      if (lang === 'en' && foreignEdition(it.url)) return false;
      const k1 = host(it.url).replace(/^www\./, '');
      const k2 = lead(it.title);
      if (seen.has(k1) || seen.has(k2)) return false;
      seen.add(k1).add(k2);
      return true;
    });
    const items = [...picked.filter((it) => it.date), ...picked.filter((it) => !it.date)].slice(0, 3);
    const data = { topic, items, at: new Date().toISOString() };
    topicCache.set(key, { at: Date.now(), data });
    if (topicCache.size > 50) topicCache.delete(topicCache.keys().next().value);
    return data;
  }
  // "Today" on the start page: the weather where you are, the market, the headlines.
  // Three ordinary searches (free mode works), kept for 10 minutes per city.
  const todayCache = new Map();
  async function today(city, lang = 'en') {
    const key = `${city.toLowerCase()}|${lang}`;
    const hit = todayCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
    // Dated news searches return articles; "latest news" returns news sites' front pages.
    const day = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const [weather, market, news] = await Promise.all([
      city ? todayOne(`weather in ${city}`) : null,
      todayOne('SPY stock price today'),
      todayOne(`news ${day}`, { items: 12 }),
    ]);
    // (in the reader's language: an English reader's front page isn't Arabic and Spanish headlines)
    // (and not "What happens on October 23, 2026" pages: a date isn't a headline)
    const dated = new RegExp(`${day.replace(/,/g, ',?')}|\\bon this day\\b|^(?:important )?news (?:by|for|on) `, 'i');
    if (news) news.items = headlines(news.items.filter((it) => !dated.test(it.title) && (lang !== 'en' || ((langOf(it.title) || 'en') === 'en' && !foreignEdition(it.url)))), 5);
    const data = { city, weather, market, news, at: new Date().toISOString() };
    todayCache.set(key, { at: Date.now(), data });
    if (todayCache.size > 20) todayCache.delete(todayCache.keys().next().value);
    return data;
  }

  function discover() {
    const c = loadCatalog();
    if (!c) return null;
    if (discoverCache?.at === c.mtime) return discoverCache.data;
    const { F, rows, D } = c;
    const ok = (r) => !r[F.deprecated] && !r[F.archived] && r[F.pubCount] < 100 && r[F.desc] && (r[F.title] || '').length < 60;
    const cat = (r) => D.cats[r[F.cat]]?.[1] || '';
    // A start-page example has to work for anyone: not "List my VPS instances" or
    // "Review this component", which need your account or your files.
    // Nor one that makes or changes something, or names a file you'd have to have.
    const openPrompt = (r) =>
      ((F.prompts != null && r[F.prompts]) || [])
        .map((p) => p[0])
        .find((p) => !/\b(?:my|mine|this|these|our)\b/i.test(p) && !/^(?:create|run|cut|deploy|delete|remove|send|post|write|build|generate|make|export|upload|install|book|buy|order|schedule|update|edit|add)\b/i.test(p) && !/\b[\w-]+\.(?:mp4|mov|mp3|wav|js|ts|py|pdf|csv|xlsx?|docx?|png|jpe?g|json|ya?ml|txt|md)\b/i.test(p)) || null;
    const brief = (r) => ({ id: r[F.name], title: r[F.title] || r[F.name].split('/').pop(), desc: String(r[F.desc]).slice(0, 140), category: cat(r), stars: r[F.stars], downloads: r[F.downloads], added: r[F.added] });
    const day = 864e5;
    const now = Date.now();
    // (servers that answered their sample question in our tests come first)
    const answered = (r) => (F.tested != null && r[F.tested]?.[0] === 'a' ? 1 : 0);
    const askable = rows
      .filter((r) => ok(r) && catalogRunnable(r, F) && r[F.reach] === 1 && openPrompt(r) && !(F.tested != null && ['f', 'k'].includes(r[F.tested]?.[0])))
      .sort((a, b) => answered(b) - answered(a) || (b._pop || 0) - (a._pop || 0));
    // The best-known servers that answer without a key, one per category so the list isn't six of a kind.
    const seenCat = new Set();
    const tryNow = [];
    for (const r of askable) {
      if (seenCat.has(r[F.cat]) || D.cats[r[F.cat]]?.[0] === 'other') continue;
      seenCat.add(r[F.cat]);
      tryNow.push({ ...brief(r), prompt: openPrompt(r), adhoc: adhocFor(r) });
      if (tryNow.length >= 8) break;
    }
    // New in the last two weeks, with a little adoption already.
    const fresh = askable
      .filter((r) => r[F.added] && now - Date.parse(r[F.added]) < 14 * day && (r[F.stars] >= 5 || r[F.rank] > 0 || r[F.downloads] >= 100))
      .sort((a, b) => String(b[F.added]).localeCompare(String(a[F.added])))
      .slice(0, 6)
      .map((r) => ({ ...brief(r), prompt: openPrompt(r), adhoc: adhocFor(r) }));
    const popular = rows
      .filter((r) => ok(r) && r[F.downloads] > 0 && r[F.updated] && now - Date.parse(r[F.updated]) < 60 * day)
      .sort((a, b) => b[F.downloads] - a[F.downloads])
      .slice(0, 6)
      .map(brief);
    const newest = rows
      .filter((r) => ok(r) && (r[F.stars] >= 20 || r[F.downloads] >= 500))
      .sort((a, b) => String(b[F.added]).localeCompare(String(a[F.added])))
      .slice(0, 6)
      .map(brief);
    // Package servers that started and answered in our test runs, best known first: run them on this Mac.
    const local = F.tested == null
      ? []
      : rows
          // (the sample question our test asked, so the example is one we saw answered)
          .filter((r) => r[F.tested]?.[0] === 'a' && ok(r) && !catalogRunnable(r, F) && trustOf(r).trusted && openPrompt(r) === r[F.prompts][0][0])
          .sort((a, b) => (b._pop || 0) - (a._pop || 0))
          .slice(0, 6)
          .map((r) => ({ ...brief(r), prompt: openPrompt(r), type: r[F.pkgType] }));
    const data = { tryNow, fresh, popular, newest, local, counts: { servers: rows.length, askable: rows.filter((r) => catalogRunnable(r, F)).length } };
    discoverCache = { at: c.mtime, data };
    return data;
  }

  // ---------- pipelines: servers working together ----------
  let pipeStore = null;
  const pipes = () => (pipeStore ||= new PipelineStore());
  /** Step server ids → what agent.search needs: catalog servers it hasn't synced go as adhoc. */
  function resolveServers(ids) {
    const c = loadCatalog();
    const adhoc = ids.filter((id) => !engine.catalog.get(id)).map((id) => c?.byName.get(id)).filter(Boolean).map(adhocFor).filter(Boolean);
    return { servers: ids, adhoc };
  }
  const titleOf = (id) => engine.catalog.get(id)?.title || (loadCatalog()?.byName.get(id)?.[loadCatalog().F.title]) || id;

  const routes = {
    'GET /api/pipelines': async (req, res) => {
      // (one lookup table per request: catalog.get() scans every server, and the library names hundreds)
      const known = new Map(engine.catalog.all().map((sv) => [sv.id, sv.title]));
      const c = loadCatalog();
      const title = (id) => known.get(id) || c?.byName.get(id)?.[c.F.title] || id;
      const withTitles = (p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, serverTitles: (s.servers || []).map(title) })) });
      json(res, 200, { starters: STARTERS.map(withTitles), library: loadLibrary().map(withTitles), topics: TOPICS, mine: pipes().list.map(withTitles) });
    },
    'POST /api/pipelines/save': async (req, res) => {
      try {
        json(res, 200, { pipeline: pipes().put((await readJson(req)).pipeline) });
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    'POST /api/pipelines/delete': async (req, res) => {
      pipes().remove(String((await readJson(req)).id || ''));
      json(res, 200, { ok: true });
    },
    // On a schedule, optionally until the result says something (a loop).
    'POST /api/pipelines/watch': async (req, res) => {
      const b = await readJson(req);
      try {
        const p = cleanPipeline(b.pipeline);
        const ids = [...new Set(p.steps.flatMap((s) => s.servers || []))];
        const w = engine.watches.add({ query: `${p.title}: ${String(b.input || '').slice(0, 200)}`, every: b.every, label: p.title, pipeline: p, input: b.input, until: b.until, pipeAdhoc: resolveServers(ids).adhoc });
        json(res, 200, { watch: { id: w.id } });
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    // Run one: a stream of pipe_step / pipe_run / pipe_result / pipe_done events.
    'POST /api/pipelines/run': async (req, res) => {
      const b = await readJson(req);
      let p;
      try {
        p = cleanPipeline(b.pipeline);
      } catch (e) {
        return json(res, 400, { error: errMsg(e) });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
      try {
        emit('provider', engine.providerInfo());
        await runPipeline(engine.agent, p, { input: String(b.input || '').slice(0, 200), emit, signal: ac.signal, resolveServers });
      } catch (e) {
        if (!ac.signal.aborted) emit('error', { message: errMsg(e) });
      } finally {
        clearInterval(ping);
        res.end();
      }
    },
    'GET /api/today/topic': async (req, res, url) => {
      const topic = String(url.searchParams.get('q') || '').replace(/[^\p{L}\p{N} &.'+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (topic.length < 2) return json(res, 400, { error: 'topic required' });
      const lang = /^en\b/i.test(String(req.headers['accept-language'] || 'en')) ? 'en' : 'any';
      json(res, 200, await topicNews(topic, lang));
    },
    'GET /api/today': async (req, res, url) => {
      const city = String(url.searchParams.get('city') || '').replace(/[^\p{L}\p{N} ,.'-]/gu, '').trim().slice(0, 60);
      // The reader's language from the browser: only English is told apart for now.
      const lang = /^en\b/i.test(String(req.headers['accept-language'] || 'en')) ? 'en' : 'any';
      json(res, 200, await today(city, lang));
    },
    // Cross-check a claim across independent sources (SSE: check_source …, check_verdict, done).
    'POST /api/crosscheck': async (req, res) => {
      const b = await readJson(req);
      const claim = String(b.claim || '').trim().slice(0, 300);
      if (!claim) return json(res, 400, { error: 'claim required' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
      const t0 = Date.now();
      try {
        await crossCheck(engine.agent, claim, { emit, signal: ac.signal });
      } catch (e) {
        if (!ac.signal.aborted) emit('error', { message: errMsg(e) });
      } finally {
        emit('done', { ms: Date.now() - t0 });
        clearInterval(ping);
        res.end();
      }
    },
    // A whole paragraph (an AI answer, an article): each plain fact in it cross-checked on its own
    // (SSE: para_claims, para_verdict per fact, done). Two at a time, so servers aren't flooded.
    'POST /api/crosscheck/text': async (req, res) => {
      const b = await readJson(req);
      const text = String(b.text || '').slice(0, 4000);
      const claims = claimsIn(text, { max: 8 });
      if (!claims.some((c) => c.claim)) return json(res, 400, { error: claims.length ? 'No plain facts to check in that text (who did what, a figure or a year). Opinions, questions and hedged sentences are left out.' : 'Paste a paragraph to check.' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
      const t0 = Date.now();
      try {
        emit('para_claims', { claims });
        const todo = claims.map((c, n) => ({ ...c, n })).filter((c) => c.claim);
        let next = 0;
        const worker = async () => {
          while (next < todo.length && !ac.signal.aborted) {
            const c = todo[next++];
            emit('para_start', { n: c.n });
            try {
              const r = await crossCheck(engine.agent, c.claim, { signal: ac.signal });
              // (the two clearest quotes each way, so the list reads without opening every check)
              const pick = (st) => r.evidence.filter((e) => e.stance === st).slice(0, 2).map((e) => ({ sentence: e.sentence.slice(0, 300), source: e.source, url: e.url, kind: e.kind, figure: e.figure, other: e.other }));
              emit('para_verdict', { n: c.n, claim: c.claim, verdict: r.verdict, label: r.label, supports: r.supports, differs: r.differs, mentions: r.mentions, official: r.official, quotes: { supports: pick('supports'), differs: pick('differs') } });
            } catch (e) {
              if (!ac.signal.aborted) emit('para_verdict', { n: c.n, claim: c.claim, verdict: 'error', label: errMsg(e) });
            }
          }
        };
        await Promise.all([worker(), worker()]);
      } finally {
        emit('done', { ms: Date.now() - t0 });
        clearInterval(ping);
        res.end();
      }
    },
    // Dependency check: a pasted manifest, two OSV servers side by side and a registry server
    // (SSE: deps_start, deps_server…, deps_row…, deps_done). A server switched off is skipped.
    'POST /api/deps': async (req, res) => {
      // (a lockfile can be a few megabytes)
      // (JSON escaping adds a little to an 8 MB file)
      const b = await readJson(req, 10 * 1024 * 1024);
      const text = String(b.text || '').slice(0, 8 * 1024 * 1024);
      // A public GitHub repo link: its lockfile or manifest, read by the page server.
      const repo = repoOf(b.repo || (text.trim().split(/\s+/).length === 1 ? text : ''));
      let pkgs = null;
      if (!repo) {
        try {
          pkgs = parseManifest(text);
        } catch (e) {
          return json(res, 400, { error: errMsg(e) });
        }
        if (!pkgs.length) return json(res, 400, { error: 'No packages found. Paste a package.json, a requirements.txt, a lockfile, a GitHub repo link, or one package per line like lodash@4.17.15.' });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const callTool = (id, tool, args) => engine.callCatalogTool(id, tool, args, { signal: ac.signal });
      try {
        if (repo) {
          emit('deps_repo', { repo: `${repo.owner}/${repo.repo}`, dir: repo.dir, ref: repo.ref });
          const got = await fetchRepoDeps(repo, { callTool, emit });
          if (!got.pkgs) {
            const where = `${repo.owner}/${repo.repo}${repo.dir ? `/${repo.dir}` : ''}`;
            emit('error', { message: got.error && /switched off|disabled/i.test(got.error) ? 'Reading GitHub needs the Page Fetch server, which is switched off in Settings.' : got.found?.length ? `${where} has ${got.found.join(', ')}, but no packages could be read from it.` : `No package-lock.json, yarn.lock, pnpm-lock.yaml, uv.lock, poetry.lock, Cargo.lock, package.json, requirements.txt, pyproject.toml or Cargo.toml at the top of ${where}${got.error ? ` (the page server didn’t answer${/\b(4\d\d|5\d\d)\b/.test(got.error) ? `: ${/\b(4\d\d|5\d\d)\b/.exec(got.error)[1]}` : ''}; try again in a minute)` : ''}. In a monorepo, open the package’s folder on GitHub and use that link.` });
            return;
          }
          pkgs = got.pkgs;
        }
        await runDeps(pkgs, { callTool, titleOf, emit });
      } catch (e) {
        if (!ac.signal.aborted) emit('error', { message: errMsg(e) });
      } finally {
        res.end();
      }
    },
    // An answer card for a question that names one thing (SSE: card_start, card_section…, card_done),
    // or card_none right away.
    'POST /api/card': async (req, res) => {
      const b = await readJson(req);
      const q = String(b.query || '').slice(0, 200);
      // Cards ask a fixed set of vetted servers on their own, so: only with the setting on,
      // and never a server the user switched off.
      const settings = engine.settings || {};
      const off = settings.serverOverrides || {};
      const cardServers = (ids) => {
        const r = resolveServers(ids.filter((id) => off[id] !== false));
        return { ...r, reason: 'answer card' };
      };
      const pair = settings.answerCards === false ? null : detectPair(q);
      const entity = pair || settings.answerCards === false ? null : detectEntity(q);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (pair) {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        emit('card_pair', { type: pair[0].type, titles: pair.map((e) => e.title) });
        try {
          await Promise.all(pair.map((e, side) => runCard(engine.agent, e, { emit, signal: ac.signal, resolveServers: cardServers, side })));
        } catch (e) {
          if (!ac.signal.aborted) emit('error', { message: errMsg(e) });
        } finally {
          emit('card_done', { all: true });
          res.end();
        }
        return;
      }
      if (!entity) {
        emit('card_none', {});
        return res.end();
      }
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      try {
        await runCard(engine.agent, entity, { emit, signal: ac.signal, resolveServers: cardServers });
      } catch (e) {
        if (!ac.signal.aborted) emit('error', { message: errMsg(e) });
      } finally {
        res.end();
      }
    },
    'GET /api/discover': async (req, res) => {
      const d = discover();
      const w = webmcpDir?.data ? webmcp().info() : null;
      json(res, 200, { ...(d || {}), sites: w ? { count: w.sites, tools: w.tools } : null, pipelines: loadLibrary().length });
    },
    'GET /api/suggest': async (req, res, url) => {
      const q = url.searchParams.get('q') || '';
      // OpenSearch format: [query, [suggestions]]
      json(res, 200, [q, suggest(q)]);
    },
    // Lets a browser add MCP Browser as a search engine (address bar searches go to /?q=…).
    'GET /opensearch.xml': async (req, res) => {
      const origin = `http://${String(req.headers.host)}`;
      res.writeHead(200, { 'content-type': 'application/opensearchdescription+xml; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>MCP Browser</ShortName>
  <Description>Answers from the MCP servers that know</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">${origin}/icon.svg</Image>
  <Url type="text/html" method="get" template="${origin}/?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" method="get" template="${origin}/api/suggest?q={searchTerms}"/>
</OpenSearchDescription>`);
    },
    // The result of a page tool the agent asked for (see pageServer).
    'POST /api/page-tool-result': async (req, res) => {
      const b = await readJson(req, 1024 * 1024);
      const p = pagePending.get(String(b.callId || ''));
      if (!p) return json(res, 404, { error: 'no such call' });
      p.resolve({ ok: b.ok === true, text: String(b.text ?? '').slice(0, 100000) });
      json(res, 200, { ok: true });
    },
    // The WebMCP directory (webmcp.com), checked locally.
    'GET /api/webmcp/lookup': async (req, res, url) => {
      const d = webmcp();
      d.ready().catch(() => {});
      json(res, 200, { site: d.lookup(url.searchParams.get('url') || ''), info: d.info() });
    },
    'GET /api/webmcp/sites': async (req, res, url) => {
      const d = webmcp();
      await d.ready();
      const q = url.searchParams;
      json(res, 200, { ...d.search({ q: q.get('q') || '', kind: q.get('kind') || '', category: q.get('category') || '', offset: Number(q.get('offset')) || 0, limit: Number(q.get('limit')) || 30 }), info: d.info() });
    },
    'GET /api/webmcp/site': async (req, res, url) => {
      try {
        json(res, 200, { site: await webmcp().site(url.searchParams.get('host')) });
      } catch (e) {
        json(res, 502, { error: errMsg(e) });
      }
    },
    'POST /api/webmcp/refresh': async (req, res) => {
      const d = webmcp();
      await d.ready({ refresh: true });
      json(res, 200, d.info());
    },
    // Package servers approved to run here, and what this computer can run them with.
    'GET /api/local': async (req, res) => {
      const rt = runtimes();
      json(res, 200, { platform: process.platform, runtimes: { npx: Boolean(rt.npx), uvx: Boolean(rt.uvx), docker: Boolean(rt.docker) }, sandbox: await sandboxStatus(), servers: engine.local.approved.map(localView) });
    },
    // Everything the approval dialog shows before anything is downloaded or started.
    'GET /api/local/check': async (req, res, url) => {
      const f = localFacts(url.searchParams.get('id'));
      if (!f) return json(res, 404, { error: 'not in the catalog' });
      if (!LOCAL_TYPES.has(f.type)) return json(res, 400, { error: f.type ? `MCP Browser can't start ${f.type} packages yet` : 'this server has no package to run' });
      const [info, sandbox] = await Promise.all([packageInfo(f.type, f.pkgId), sandboxStatus()]);
      const rt = runtimes();
      const needs = f.type === 'npm' ? 'npx' : f.type === 'pypi' ? 'uvx' : 'docker';
      const how = {
        sandbox: f.type === 'oci' ? { available: false, reason: 'Docker images already run in their own container.' } : !rt[needs] ? { available: false, reason: `${needs} isn’t installed` } : sandbox,
        docker: rt.docker ? { available: true } : { available: false, reason: 'Docker isn’t installed.' },
        none: f.type === 'oci' ? { available: false, reason: 'Docker images run in Docker.' } : rt[needs] ? { available: true } : { available: false, reason: `${needs} isn’t installed: ${needs === 'uvx' ? 'brew install uv' : 'get Node.js from nodejs.org'}` },
      };
      if (f.type === 'pypi' && info.wheel === false) Object.assign(how, { sandbox: { available: false, reason: 'This package must be built from source, which runs its code during install. That only happens inside Docker.' }, none: { available: false, reason: 'This package must be built from source; run it in Docker.' } });
      const prefer = ['sandbox', 'docker', 'none'].find((k) => how[k].available) || null;
      const a = engine.local.get(f.row[f.F.name]);
      json(res, 200, {
        id: f.row[f.F.name],
        title: f.title,
        description: f.description,
        type: f.type,
        package: info,
        hosted: f.hosted,
        github: /^[\w.-]+\/[\w.-]+$/.test(f.repo || '') ? `https://github.com/${f.repo}` : null,
        stars: f.stars,
        downloads: f.downloads,
        trust: f.trust,
        tested: f.F.tested != null && f.row[f.F.tested] ? testedView(f.row[f.F.tested]) : null,
        settings: f.settings,
        how,
        prefer,
        commands: Object.fromEntries(['sandbox', 'docker', 'none'].map((k) => [k, info.version ? commandText(f.type, info.name, info.version, k, argvFor(f, info.version, k === 'docker' ? false : info.wheel !== false).argv) : ''])),
        args: info.version ? (({ needs, note }) => ({ needs, note }))(argvFor(f, info.version, info.wheel !== false)) : { needs: [], note: '' },
        approved: a ? localView(a) : null,
        stackValues: stack().items.find((x) => x.id === f.row[f.F.name])?.values || {},
      });
    },
    // Approve (pin version, choose isolation), keep keys in memory, start it.
    'POST /api/local/approve': async (req, res) => {
      const b = await readJson(req);
      const f = localFacts(b.id);
      if (!f) return json(res, 404, { error: 'not in the catalog' });
      if (!LOCAL_TYPES.has(f.type)) return json(res, 400, { error: 'this server has no package MCP Browser can start' });
      const info = await packageInfo(f.type, f.pkgId);
      if (info.error) return json(res, 502, { error: `couldn’t look up the package: ${info.error}` });
      const version = String(b.version || info.version);
      if (version !== info.version) return json(res, 409, { error: `the package changed to ${info.version} since you looked: check again` });
      const isolation = f.type === 'oci' ? 'docker' : String(b.isolation || '');
      if (!['sandbox', 'docker', 'none'].includes(isolation)) return json(res, 400, { error: 'choose how to run it' });
      if (isolation === 'sandbox' && !(await sandboxStatus()).available) return json(res, 400, { error: 'the sandbox isn’t available on this computer' });
      if (isolation === 'docker' && !runtimes().docker) return json(res, 400, { error: 'Docker isn’t installed' });
      if (f.type === 'pypi' && info.wheel === false && isolation !== 'docker') return json(res, 400, { error: 'this package must be built from source: run it in Docker' });
      if (!f.trust.trusted && b.acceptRisk !== true) return json(res, 400, { error: 'this server has warning signs: confirm you want to run it anyway' });
      if (isolation === 'none' && b.acceptNoSandbox !== true) return json(res, 400, { error: 'confirm you want to run it without a sandbox' });
      const av = argvFor(f, info.version, isolation === 'docker' ? false : info.wheel !== false);
      if (av.needs.length) return json(res, 400, { error: `this server needs startup arguments only you can fill in (${av.needs.join('; ')}), so MCP Browser can’t start it yet. Its README says what to use.` });
      const a = engine.local.approve({ id: f.row[f.F.name], title: f.title, description: f.description, type: f.type, name: info.name, version: info.version, isolation, settings: f.settings, values: b.values, secrets: b.secrets, trusted: f.trust.trusted, argv: av.argv });
      // Keep non-secret settings with the stack too, if it's there.
      if (stack().has(a.id) && a.values && Object.keys(a.values).length) stack().setValues(a.id, a.values, a.settings.filter((s) => s.secret).map((s) => s.name));
      await engine.pool.close(a.id);
      json(res, 200, { approved: localView(a), ...(await startLocal(a.id)) });
    },
    // Keys again after MCP Browser restarted (they are never saved).
    'POST /api/local/keys': async (req, res) => {
      const b = await readJson(req);
      try {
        engine.local.setKeys(String(b.id), b.secrets);
      } catch (e) {
        return json(res, 400, { error: errMsg(e) });
      }
      json(res, 200, await startLocal(String(b.id)));
    },
    'POST /api/local/start': async (req, res) => {
      const b = await readJson(req);
      if (!engine.local.get(String(b.id))) return json(res, 404, { error: 'not approved' });
      json(res, 200, await startLocal(String(b.id)));
    },
    'POST /api/local/stop': async (req, res) => {
      const b = await readJson(req);
      await engine.pool.close(String(b.id));
      json(res, 200, { ok: true });
    },
    // Stop it, drop the approval and delete its folder (package cache included).
    'POST /api/local/forget': async (req, res) => {
      const b = await readJson(req);
      await engine.pool.close(String(b.id));
      engine.local.forget(String(b.id));
      json(res, 200, { ok: true });
    },
    'GET /api/status': async (req, res) => {
      json(res, 200, {
        provider: engine.providerInfo(),
        registry: engine.registryInfo(),
        sync: { running: engine.syncState.running, progress: engine.syncState.progress, error: engine.syncState.error, last: engine.syncState.last },
        health: engine.health.summary(),
        pool: engine.pool.stats(),
        discovery: engine.settings.discovery,
        semantic: engine.embeddings ? engine.embeddings.state : { status: 'off' },
        watchesUnseen: engine.watches.list.reduce((n, w) => n + (w.unseen || 0), 0),
        mcpLaunch: MCP_LAUNCH,
        stars: engine.starsInfo(),
        ...(DEV ? { dev: true, build: buildId() } : {}),
      });
    },
    'GET /api/dev/build': async (req, res) => {
      if (!DEV) return json(res, 404, { error: 'not in dev mode' });
      json(res, 200, { build: buildId() });
    },
    'GET /api/settings': async (req, res) => json(res, 200, publicSettings(engine.settings)),
    'POST /api/settings': async (req, res) => {
      const body = await readJson(req);
      if (typeof body.apiKey === 'string' && body.apiKey.startsWith('••••')) delete body.apiKey; // masked echo
      if (typeof body.githubToken === 'string' && body.githubToken.startsWith('••••')) delete body.githubToken;
      json(res, 200, publicSettings(engine.updateSettings(body)));
    },
    'GET /api/servers': async (req, res, url) => {
      const q = (url.searchParams.get('q') || '').trim();
      const source = url.searchParams.get('source') || 'all';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      let list;
      const w = (r) => r.score * (r.server.source === 'registry' ? 1 : 1.4);
      if (q) {
        let scored = engine.catalog.score(q).sort((a, b) => w(b) - w(a));
        // Sorting a search by stars: keep it to clearly relevant matches first.
        if (url.searchParams.get('sort') === 'stars' && scored.length) scored = scored.filter((r) => w(r) >= 0.3 * w(scored[0]));
        list = scored.map((r) => r.server);
      }
      else list = engine.catalog.all();
      if (source !== 'all') list = list.filter((s) => (source === 'enabled' ? engine.catalog.isEnabled(s) : s.source === source));
      // sort=stars: most-starred first (servers without a known repo last; keeps search order among ties).
      if (url.searchParams.get('sort') === 'stars') {
        const st = (s) => engine.starsFor(s)?.stars ?? -1;
        list = list.map((s, i) => ({ s, i, n: st(s) })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.s);
      }
      // since=N: only servers whose registry entry changed in the last N days.
      const since = Number(url.searchParams.get('since')) || 0;
      if (since > 0) {
        const cutoff = new Date(Date.now() - since * 86400_000).toISOString();
        list = list.filter((s) => s.updatedAt && s.updatedAt >= cutoff);
      }
      // sort=updated / oldest: by the registry's last update; pushed: by the repo's last push.
      const sortBy = url.searchParams.get('sort');
      if (sortBy === 'updated' || sortBy === 'oldest' || sortBy === 'pushed') {
        const key = sortBy === 'pushed' ? (s) => engine.starsFor(s)?.pushedAt || '' : (s) => s.updatedAt || '';
        const dir = sortBy === 'oldest' ? 1 : -1;
        list = list
          .map((s, i) => ({ s, i, k: key(s) }))
          .sort((a, b) => (!a.k !== !b.k ? (a.k ? -1 : 1) : a.k === b.k ? a.i - b.i : (a.k < b.k ? -1 : 1) * dir))
          .map((x) => x.s);
      }
      json(res, 200, { total: list.length, servers: list.slice(offset, offset + limit).map(serverView) });
    },
    'POST /api/servers/toggle': async (req, res) => {
      const { id, enabled } = await readJson(req);
      if (!engine.catalog.get(String(id))) return json(res, 404, { error: 'unknown server' });
      engine.updateSettings({ serverOverrides: { [id]: enabled === null ? null : Boolean(enabled) } });
      json(res, 200, serverView(engine.catalog.get(String(id))));
    },
    'POST /api/servers/auth': async (req, res) => {
      const { id, header, value, url, clear } = await readJson(req);
      const srv = engine.catalog.get(String(id));
      if (!srv) return json(res, 404, { error: 'unknown server' });
      if (clear) engine.updateSettings({ serverAuth: { [srv.id]: null } });
      else {
        const prev = engine.settings.serverAuth[srv.id] || {};
        const hasValue = typeof value === 'string' && value.trim() !== '';
        const hasUrl = typeof url === 'string' && url.trim() !== '';
        if (!hasValue && !hasUrl) return json(res, 400, { error: 'enter a key, or a full https:// URL' });
        // Keep whatever part wasn't re-entered (a new key keeps a saved URL and vice versa).
        const next = {
          header: hasValue ? header || srv.authHeaders?.[0]?.name || 'Authorization' : prev.header,
          value: hasValue ? value : prev.value,
          url: hasUrl ? url : prev.url,
        };
        engine.updateSettings({ serverAuth: { [srv.id]: next } });
        const saved = engine.settings.serverAuth[srv.id] || {};
        if ((hasValue && saved.value !== value.trim()) || (hasUrl && saved.url !== url.trim())) {
          return json(res, 400, { error: hasUrl ? 'the URL must start with https:// and contain no spaces' : 'that key contains characters a header cannot carry' });
        }
      }
      engine.catalog.invalidate();
      json(res, 200, serverView(srv));
    },
    'POST /api/servers/custom': async (req, res) => {
      const b = await readJson(req);
      const slug = String(b.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
      const entry = cleanCustomServer({ id: `custom/${slug}-${randomBytes(3).toString('hex')}`, title: b.title, url: b.url, description: b.description, transport: b.transport });
      if (!entry) return json(res, 400, { error: 'enter a full http(s):// URL for the MCP endpoint' });
      if (engine.settings.customServers.length >= 50) return json(res, 400, { error: 'you can add up to 50 servers' });
      const norm = (u) => u.replace(/\/+$/, '').toLowerCase();
      const dupe = engine.catalog.all().find((s) => norm(s.url) === norm(entry.url));
      if (dupe) return json(res, 409, { error: dupe.source === 'custom' ? 'that server is already added' : `that server is already in the list as "${dupe.title}"` });
      engine.updateSettings({ customServers: [...engine.settings.customServers, entry] });
      const added = engine.catalog.get(entry.id);
      if (!added) {
        engine.updateSettings({ customServers: engine.settings.customServers.filter((s) => s.id !== entry.id) });
        return json(res, 409, { error: 'that server is already in the list' });
      }
      const [probe] = await engine.probe([entry.id]);
      json(res, 201, { server: serverView(added), probe });
    },
    'POST /api/servers/custom/delete': async (req, res) => {
      const { id } = await readJson(req);
      const left = engine.settings.customServers.filter((s) => s.id !== String(id));
      if (left.length === engine.settings.customServers.length) return json(res, 404, { error: 'unknown server' });
      engine.updateSettings({ customServers: left, serverAuth: { [String(id)]: null }, serverOverrides: { [String(id)]: null } });
      await engine.pool.close(String(id));
      json(res, 200, { deleted: true });
    },
    'POST /api/servers/oauth/start': async (req, res) => {
      const b = await readJson(req);
      json(res, 200, await engine.oauth.start(String(b.id || '')));
    },
    'POST /api/servers/oauth/signout': async (req, res) => {
      const b = await readJson(req);
      await engine.oauth.signOut(String(b.id || ''));
      json(res, 200, { ok: true });
    },
    // The sign-in page sends the browser back here (a plain GET navigation).
    'GET /oauth/callback': async (req, res, url) => {
      const page = (code, title, msg) => {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer' });
        const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;margin:3em;max-width:36em"><h1 style="font-size:1.3em">${esc(title)}</h1><p>${esc(msg)}</p>`);
      };
      const p = url.searchParams;
      if (p.get('error')) {
        // Show the server's words only for a sign-in we started (no text injection on our origin).
        const ours = engine.oauth.cancel(p.get('state'));
        return page(400, 'Sign-in cancelled', ours ? `The server said: ${String(p.get('error_description') || p.get('error')).slice(0, 300)}` : 'Start again from the servers page.');
      }
      try {
        const s = await engine.oauth.finish({ code: p.get('code'), state: p.get('state') });
        engine.probe([s.id]).catch(() => {});
        page(200, 'Signed in', `MCP Browser can now use ${s.title}. You can close this tab.`);
      } catch (e) {
        page(e.status || 500, 'Sign-in failed', errMsg(e));
      }
    },
    'POST /api/stars/refresh': async (req, res) => {
      const b = await readJson(req);
      const started = engine.refreshStars({ limit: Number(b.limit) || undefined });
      json(res, started ? 202 : 409, { ...engine.starsInfo(), ...(started ? {} : { error: 'a refresh is already running' }) });
    },
    'POST /api/servers/probe': async (req, res) => {
      const { ids } = await readJson(req);
      if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: 'ids required' });
      json(res, 200, { results: await engine.probe(ids.slice(0, 50).map(String)) });
    },
    'POST /api/registry/sync': async (req, res) => {
      const { full } = await readJson(req);
      if (engine.syncState.running) return json(res, 409, { error: 'sync already running' });
      engine.syncRegistry({ full: Boolean(full) }).catch((e) => log.warn('sync failed', errMsg(e)));
      json(res, 202, { started: true });
    },
    'GET /api/route': async (req, res, url) => {
      const q = url.searchParams.get('q') || '';
      const routed = tokenize(q).length ? await engine.catalog.routeAsync(q, engine.settings) : [];
      json(res, 200, { servers: routed.map((r) => ({ id: r.server.id, title: r.server.title, trust: r.server.trust, reason: r.reason, score: Number(r.score.toFixed(2)) })) });
    },
    'POST /api/search': handleSearch,
    'GET /api/watches': async (req, res) => {
      const list = engine.watches.list.map((w) => ({ ...engine.watches.view(w), running: w.running || engine.scheduler.queued.has(w.id) }));
      json(res, 200, { watches: list, unseen: list.reduce((n, w) => n + (w.unseen || 0), 0) });
    },
    'POST /api/watches': async (req, res) => {
      const b = await readJson(req);
      try {
        // (the "it happened" pattern is built here from the word; a client's regex is never run)
        const w = engine.watches.add({ query: b.query, every: b.every, discovery: b.discovery === true, label: b.label, route: b.route, servers: Array.isArray(b.servers) ? b.servers : undefined, adhoc: b.adhoc, group: b.group, until: b.until, untilAbout: b.untilAbout, when: b.when, deps: b.deps, page: b.page, repo: b.repo });
        engine.scheduler.run(w.id).catch(() => {}); // baseline run now
        json(res, 201, engine.watches.view(w));
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    // "tell me when NVDA drops below 200" → a proposed watch to confirm.
    'POST /api/track/parse': async (req, res) => {
      const b = await readJson(req);
      const p = parseTrack(String(b.text || '').slice(0, 300));
      if (!p || p.error) return json(res, 400, { error: p?.error || 'Start with “tell me when …”, e.g. “tell me when NVDA drops below 200”.' });
      // A threshold: read the figure now, so the preview can show it (and say if it's already past the line).
      if (p.kind === 'threshold') {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        try {
          const r = await engine.agent.search(p.query, { signal: ac.signal, direct: true, emit: () => {} });
          const pr = /^([A-Z]{3}) to ([A-Z]{3}) exchange rate$/.exec(p.query);
          const value = figureIn(r?.quickAnswer?.text || '', { unit: p.when.unit, pair: pr ? [pr[1], pr[2]] : null });
          p.nowChecked = true;
          if (value != null) p.now = { value, text: String(r.quickAnswer.text).slice(0, 200), met: p.when.op !== 'reach' && thresholdMet(p.when, value) };
        } catch {
          /* the preview just doesn't show it */
        }
        clearTimeout(timer);
      }
      json(res, 200, p);
    },
    'POST /api/watches/update': async (req, res) => {
      const b = await readJson(req);
      try {
        json(res, 200, engine.watches.view(engine.watches.update(String(b.id), { every: b.every, label: b.label, seen: b.seen === true, notifiedAt: b.notifiedAt })));
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    'POST /api/watches/delete': async (req, res) => {
      const b = await readJson(req);
      try {
        engine.watches.remove(String(b.id));
        json(res, 200, { deleted: true });
      } catch (e) {
        json(res, 404, { error: errMsg(e) });
      }
    },
    'POST /api/watches/run': async (req, res) => {
      const b = await readJson(req);
      const w = engine.watches.get(String(b.id));
      if (!w) return json(res, 404, { error: 'unknown watch' });
      if (w.running || engine.scheduler.queued.has(w.id)) return json(res, 409, { error: 'already running' });
      engine.scheduler.run(w.id).catch(() => {});
      json(res, 202, { started: true });
    },
    'GET /api/templates': async (req, res) => json(res, 200, { templates: TEMPLATES }),
    'GET /api/rank/labels': async (req, res) => json(res, 200, exportLabels(undefined, { github: (id) => engine.githubById(id) })),
    // The MCP server catalog (every registry server with categories, stars and
    // downloads), built by scripts/catalog. Sent gzipped when the client accepts it.
    'GET /api/catalog': async (req, res) => {
      const f = catalogFile();
      if (!f) return json(res, 404, { error: 'No catalog yet. Run npm run catalog to build one.' });
      fs.readFile(f.path, (err, data) => {
        if (err) return json(res, 500, { error: 'could not read the catalog' });
        const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
        if (!f.gzip) return res.writeHead(200, headers), res.end(data);
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.writeHead(200, { ...headers, 'content-encoding': 'gzip' }), res.end(data);
        zlib.gunzip(data, (e, raw) => (e ? json(res, 500, { error: 'catalog is damaged' }) : (res.writeHead(200, headers), res.end(raw))));
      });
    },
    // ---------- My MCP stack ----------
    'GET /api/stack': async (req, res, url) => {
      if (url.searchParams.get('ids') === '1') return json(res, 200, { ids: stack().items.map((x) => x.id) });
      const c = loadCatalog();
      let installed = [];
      try {
        installed = auditInstalled().servers;
      } catch {
        /* no configs readable */
      }
      const items = stack().items.map((it) => {
        const row = c?.byName.get(it.id);
        const inst = installed.filter((s) => s.catalog?.server_id === it.id).map((s) => s.client);
        return { id: it.id, addedAt: it.addedAt, values: it.values || {}, found: Boolean(row), installedIn: [...new Set(inst)], ...(row ? { server: describeCatalogRow(row, { full: true }), runnable: catalogRunnable(row, c.F), adhoc: adhocFor(row), trust: trustOf(row) } : {}) };
      });
      json(res, 200, { items });
    },
    'POST /api/stack/add': async (req, res) => {
      const { id } = await readJson(req);
      if (!loadCatalog()?.byName.has(String(id))) return json(res, 404, { error: 'not in the catalog' });
      try {
        json(res, 200, { ids: stack().add(String(id)).map((x) => x.id) });
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    'POST /api/stack/remove': async (req, res) => {
      const { id } = await readJson(req);
      json(res, 200, { ids: stack().remove(String(id)).map((x) => x.id) });
    },
    'POST /api/stack/move': async (req, res) => {
      const { id, delta } = await readJson(req);
      json(res, 200, { ids: stack().move(String(id), Number(delta) || 0).map((x) => x.id) });
    },
    'POST /api/stack/values': async (req, res) => {
      const { id, values } = await readJson(req);
      const c = loadCatalog();
      const row = c?.byName.get(String(id));
      const secrets = row && c.F.envs != null ? (row[c.F.envs] || []).filter(([, s]) => s).map(([n]) => n) : [];
      try {
        json(res, 200, stack().setValues(String(id), values, secrets));
      } catch (e) {
        json(res, 400, { error: errMsg(e) });
      }
    },
    // A setup script for the stack (or the ids given): node setup-mcp.mjs / npx tsx setup-mcp.ts
    'GET /api/stack/script': async (req, res, url) => {
      const c = loadCatalog();
      if (!c) return json(res, 404, { error: 'no catalog' });
      const want = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const items = stack().items.filter((it) => !want.length || want.includes(it.id));
      const rows = items.map((it) => c.byName.get(it.id)).filter(Boolean);
      if (!rows.length) return json(res, 400, { error: 'your stack is empty' });
      const format = url.searchParams.get('format') === 'ts' ? 'ts' : 'mjs';
      const servers = scriptServers(rows, Object.fromEntries(items.map((it) => [it.id, it.values || {}])), await pinsFor(rows)).map((s, i) => {
        const t = trustOf(rows[i]);
        return t.trusted ? s : { ...s, warning: t.why.join('; ') };
      });
      const body = setupScript(servers, { format });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="setup-mcp.${format}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    },
    // Which MCP apps (Claude Desktop, Claude Code, Cursor, VS Code) are on this computer.
    'GET /api/stack/clients': async (req, res) => json(res, 200, { clients: await detectClients() }),
    // Set up (or remove) the stack's servers in those apps from here. dry: true previews.
    // Keys come in the request, go only to the setup run, and are never stored or echoed.
    'POST /api/stack/apply': async (req, res) => {
      const b = await readJson(req);
      const c = loadCatalog();
      if (!c) return json(res, 404, { error: 'no catalog' });
      const want = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const items = stack().items.filter((it) => !want.length || want.includes(it.id));
      let rows = items.map((it) => c.byName.get(it.id)).filter(Boolean);
      if (!rows.length) return json(res, 400, { error: 'your stack is empty' });
      // Servers with warning signs are only set up when you said so for each one.
      const accepted = new Set(Array.isArray(b.acceptRisk) ? b.acceptRisk.map(String) : []);
      const held = b.remove ? [] : rows.filter((r) => !trustOf(r).trusted && !accepted.has(r[c.F.name]));
      rows = rows.filter((r) => !held.includes(r));
      const heldNote = held.length ? `Not set up, because of warning signs you haven’t confirmed: ${held.map((r) => r[c.F.title] || r[c.F.name]).join(', ')}.\n\n` : '';
      if (!rows.length) return json(res, 200, { ok: false, output: heldNote.trim() });
      const servers = scriptServers(rows, Object.fromEntries(items.map((it) => [it.id, it.values || {}])), b.remove ? {} : await pinsFor(rows));
      const r = await applyStack(servers, { clients: Array.isArray(b.clients) ? b.clients.map(String) : [], secrets: b.secrets && typeof b.secrets === 'object' ? b.secrets : {}, dry: b.dry !== false, remove: Boolean(b.remove) });
      json(res, 200, { ...r, output: heldNote + r.output });
    },
    // Read-only check of the MCP servers installed in this computer's clients.
    'GET /api/audit': async (req, res) => {
      try {
        json(res, 200, auditInstalled());
      } catch (e) {
        json(res, 500, { error: `Could not check the installed servers: ${errMsg(e)}` });
      }
    },
    // Catalog servers for a task (used by "Open with" for links).
    'GET /api/catalog/find': async (req, res, url) => {
      const q = String(url.searchParams.get('q') || '').slice(0, 300);
      const runnableOnly = url.searchParams.get('runnable') === '1';
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 3));
      try {
        const rows = searchCatalog(q, { limit, runnableOnly });
        json(res, 200, { servers: rows.map((r) => ({ ...describeCatalogRow(r), adhoc: adhocFor(r) })) });
      } catch (e) {
        json(res, 200, { servers: [], error: errMsg(e) });
      }
    },
    'GET /api/catalog/tools': async (req, res, url) => {
      const id = String(url.searchParams.get('id') || '').slice(0, 300);
      let t = null;
      try {
        t = catalogTools(id);
      } catch {
        return json(res, 500, { error: 'could not read the tool lists' });
      }
      json(res, 200, { id, listedAt: t?.at || null, tools: t?.tools || [] });
    },
    'GET /api/rank': async (req, res) => {
      const data = engine.rankData();
      // Attach GitHub stars to each result for display (the score itself ignores them).
      for (const cat of Object.values(data.categories || {})) for (const x of cat.results || []) x.github = engine.githubById(x.id);
      json(res, 200, { ...data, state: engine.rankState });
    },
    'POST /api/rank/run': async (req, res) => {
      const { category, limit } = await readJson(req);
      if (engine.rankState.running) return json(res, 409, { error: 'a ranking run is already in progress' });
      if (!engine.rankData().suites[category]) return json(res, 400, { error: 'unknown category' });
      engine.runRank(String(category), { limit: Math.min(200, Math.max(1, Number(limit) || 20)) }).catch((e) => log.warn('rank failed', errMsg(e)));
      json(res, 202, { started: true });
    },
  };

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  }

  server = http.createServer(async (req, res) => {
    const bad = guard(req);
    if (bad) return json(res, 403, { error: bad });
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      if (handler) return await handler(req, res, url);
      // MCP Registry-compatible read API (subregistry) with MCP Rank metadata.
      if (req.method === 'GET' && url.pathname === '/v0.1/servers') return json(res, 200, listServers(engine, url.searchParams));
      const m = req.method === 'GET' && url.pathname.match(/^\/v0\.1\/servers\/([^/]+)\/versions(?:\/([^/]+))?$/);
      if (m) {
        let name;
        try {
          name = decodeURIComponent(m[1]);
        } catch {
          return json(res, 400, { error: 'bad server name' });
        }
        const one = getServer(engine, name, m[2] ? decodeURIComponent(m[2]) : 'latest');
        if (!one) return json(res, 404, { error: 'server not found' });
        return json(res, 200, m[2] ? one : { servers: [one], metadata: { count: 1 } });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: errMsg(e) });
      else res.end();
    }
  });
  return {
    server,
    engine,
    listen() {
      return new Promise((resolve) =>
        server.listen(port, '127.0.0.1', () => {
          engine.oauth.setRedirectBase(`http://127.0.0.1:${server.address().port}`);
          resolve(server.address().port);
        })
      );
    },
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await engine.close();
    },
  };
}

// `node src/server.js` (or `npm start`)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 7777;
  const app = createServer({ port });
  app.listen().then((p) => {
    console.log(`MCP Browser running at http://127.0.0.1:${p}`);
    app.engine.startWatches();
    const info = app.engine.registryInfo();
    if (!info.syncedAt) {
      console.log('First run: downloading the MCP Registry in the background (2–3 minutes)…');
      app.engine.syncRegistry({ full: true }).then(
        (r) => console.log(`Registry ready: ${r.kept} keyless remote servers.`),
        (e) => console.warn('Registry sync failed (curated servers still work):', errMsg(e))
      );
    } else if (info.stale || Date.now() - Date.parse(info.syncedAt) > 24 * 3600_000) {
      app.engine.syncRegistry().catch(() => app.engine.buildEmbeddings());
    } else app.engine.buildEmbeddings();
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
