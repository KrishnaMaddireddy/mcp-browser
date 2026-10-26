// The WebMCP directory (webmcp.com, run by nekuda.ai): websites whose pages offer
// tools to AI agents through WebMCP (document.modelContext). MCP Browser downloads
// the whole site list about once a day and answers "does this site have tools?"
// locally, so the pages you visit are never sent to webmcp.com. Only opening one
// site's details asks webmcp.com about that one host.
// Everything in the directory is written by site owners: shown as data, escaped,
// and never given to the AI model as instructions.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dataDir } from './config.js';
import { guardedFetch } from './netguard.js';
import { errMsg, log } from './util.js';

const BASE = 'https://webmcp.com';
const MAX_AGE = 24 * 3600_000;
const KINDS = new Set(['answer', 'act', 'transact']);

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** One site from the API, reduced to what MCP Browser shows. */
function cleanSite(s) {
  const host = str(s.host, 200).toLowerCase().replace(/^www\./, '');
  let url = str(s.url, 500);
  if (!/^https:\/\//i.test(url)) url = `https://${host}/`;
  const tools = (Array.isArray(s.tools) ? s.tools : []).slice(0, 200).map((t) => ({
    name: str(t.name, 80),
    kind: KINDS.has(t.kind) ? t.kind : t.kind === 'action' ? 'act' : 'answer',
    impl: t.impl === 'declarative' ? 'declarative' : 'imperative',
    description: str(t.description, 400),
    page: typeof t.page === 'string' && t.page.startsWith('/') ? str(t.page, 300) : '/',
    ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema } : {}),
  }));
  return { host, url, type: s.type === 'demo' ? 'demo' : 'live', category: str(s.category, 60), desc: str(s.desc, 400), apiSurface: str(s.apiSurface, 20), tools };
}

export class WebMcpDirectory {
  constructor({ file = path.join(dataDir(), 'webmcp-sites.json.gz'), fetchImpl, lookup, now = () => Date.now() } = {}) {
    this.file = file;
    this.get = guardedFetch({ fetchImpl, lookup });
    this.now = now;
    this.data = null; // { fetchedAt, total, sites: [...] }
    this.byHost = new Map();
    this.loading = null;
    this.error = null;
    this.details = new Map(); // host -> { at, site }
  }

  _index() {
    this.byHost = new Map(this.data.sites.map((s) => [s.host, s]));
  }

  _readDisk() {
    try {
      this.data = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file)).toString('utf8'));
      this._index();
    } catch {
      /* none yet */
    }
  }

  async _download() {
    const sites = [];
    let total = Infinity;
    for (let offset = 0; offset < total && offset < 20000; offset += 500) {
      const r = await this.get(`${BASE}/api/v1/sites?fields=minimal&limit=500&offset=${offset}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`webmcp.com says ${r.status}`);
      const j = await r.json();
      total = Number(j.total) || 0;
      const page = Array.isArray(j.sites) ? j.sites : [];
      sites.push(...page.map(cleanSite).filter((s) => s.host && s.tools.length));
      if (!page.length) break;
    }
    this.data = { fetchedAt: new Date(this.now()).toISOString(), total, sites };
    this._index();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', zlib.gzipSync(JSON.stringify(this.data)));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /** The site list, downloaded when missing or a day old (a stale copy is used meanwhile). */
  async ready({ refresh = false } = {}) {
    if (!this.data) this._readDisk();
    const old = !this.data || this.now() - Date.parse(this.data.fetchedAt) > MAX_AGE;
    if ((old || refresh) && !this.loading) {
      this.loading = this._download()
        .then(() => (this.error = null))
        .catch((e) => {
          this.error = errMsg(e);
          log.warn('webmcp directory:', this.error);
        })
        .finally(() => (this.loading = null));
    }
    if (!this.data && this.loading) await this.loading;
    return this.data;
  }

  info() {
    const d = this.data;
    return { fetchedAt: d?.fetchedAt || null, sites: d?.sites.length || 0, tools: d ? d.sites.reduce((n, s) => n + s.tools.length, 0) : 0, error: this.error, loading: Boolean(this.loading) };
  }

  /** Whether a page's site is in the directory (checked locally). */
  lookup(url) {
    const h = hostOf(url);
    if (!h || !this.data) return null;
    const s = this.byHost.get(h) || this.byHost.get(h.split('.').slice(-2).join('.'));
    if (!s) return null;
    let p = '/';
    try {
      p = new URL(url).pathname;
    } catch {
      /* keep / */
    }
    const here = s.tools.filter((t) => t.page === '/' || p.startsWith(t.page));
    return { host: s.host, url: s.url, desc: s.desc, toolCount: s.tools.length, kinds: kindCounts(s.tools), here: here.length, sample: s.tools.slice(0, 5).map((t) => t.name) };
  }

  /** Search the directory (locally). kind: answer | act | transact. */
  search({ q = '', kind = '', category = '', offset = 0, limit = 30 } = {}) {
    const d = this.data;
    if (!d) return { total: 0, sites: [], categories: [] };
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const out = [];
    for (const s of d.sites) {
      if (category && s.category !== category) continue;
      if (kind && !s.tools.some((t) => t.kind === kind)) continue;
      if (words.length) {
        const hay = `${s.host} ${s.desc} ${s.category} ${s.tools.map((t) => `${t.name} ${t.description}`).join(' ')}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      out.push(s);
    }
    // Live sites first, then by number of tools that only read.
    out.sort((a, b) => (a.type === 'demo') - (b.type === 'demo') || kindCounts(b.tools).answer - kindCounts(a.tools).answer || b.tools.length - a.tools.length);
    const categories = [...new Set(d.sites.map((s) => s.category).filter(Boolean))].sort();
    return { total: out.length, sites: out.slice(offset, offset + Math.min(100, limit)), categories };
  }

  /**
   * Tools across the directory that fit a task, best first: { host, url, site, name, kind,
   * description, page }. Scored on the task's words in the tool's name and description (and a
   * little for the site's), live sites before demos, tools that only read before ones that act.
   */
  findTools(task, { kind = '', limit = 10 } = {}) {
    const d = this.data;
    if (!d) return [];
    const STOP = new Set('a an the and or of for to in on with by from my me i that this which can could would tool tools site sites website websites web page pages find look up get do does use using want need'.split(' '));
    const words = [...new Set(String(task).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 10);
    if (!words.length) return [];
    const stem = (w) => (w.length > 5 ? w.slice(0, -2) : w);
    const out = [];
    for (const s of d.sites) {
      const siteHay = `${s.host} ${s.desc} ${s.category}`.toLowerCase();
      for (const t of s.tools) {
        if (kind && t.kind !== kind) continue;
        const hay = `${t.name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')} ${t.description}`.toLowerCase();
        // (most of the task's words in the tool itself: "search flights" isn't "book a flight")
        const inTool = words.filter((w) => hay.includes(stem(w))).length;
        if (inTool < Math.max(1, Math.ceil(words.length * 0.6))) continue;
        let score = inTool * 2;
        for (const w of words) if (!hay.includes(stem(w)) && siteHay.includes(stem(w))) score += 0.5;
        score += (s.type === 'live' ? 1 : 0) + (t.kind === 'answer' ? 0.5 : t.kind === 'act' ? 0.2 : 0);
        out.push({ score, host: s.host, url: s.url, site: s.desc, type: s.type, name: t.name, kind: t.kind, description: t.description, page: t.page });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.min(25, limit)).map(({ score, ...x }) => x);
  }

  /** One site with tool inputs (asks webmcp.com about this one host; cached an hour). */
  async site(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!/^[a-z0-9.-]{3,200}$/.test(host)) throw new Error('not a host name');
    const hit = this.details.get(host);
    if (hit && this.now() - hit.at < 3600_000) return hit.site;
    const r = await this.get(`${BASE}/api/v1/sites/${encodeURIComponent(host)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`webmcp.com says ${r.status}`);
    const j = await r.json();
    const site = cleanSite(j.site || j);
    this.details.set(host, { at: this.now(), site });
    return site;
  }
}

export function kindCounts(tools) {
  const c = { answer: 0, act: 0, transact: 0 };
  for (const t of tools) c[t.kind] = (c[t.kind] || 0) + 1;
  return c;
}
