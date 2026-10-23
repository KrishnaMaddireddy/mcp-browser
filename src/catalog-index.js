// Server-side view of the MCP server catalog (the same data mcp://catalog shows):
// search by task, setup snippets and "before you rely on it" checks, shared by
// the MCP tools (find_server_for_task, get_server_setup, try_server), the
// installed-server audit and "Open with" for links.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { catalogFile } from './catalog-data.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The browser's setup and checks code, run here in a sandbox so both sides agree.
let guide = null;
export function guideLib() {
  if (guide) return guide;
  const ctx = { window: {}, Date, JSON, String, Object, Array, Math, Number, RegExp };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'catalog-guide.js'), 'utf8'), ctx, { filename: 'catalog-guide.js' });
  guide = ctx.window.MCPGuide;
  return guide;
}

let cache = null; // { path, mtime, D, F, byName, rows }
export function loadCatalog() {
  const f = catalogFile();
  if (!f) return null;
  const mtime = fs.statSync(f.path).mtimeMs;
  if (cache && cache.path === f.path && cache.mtime === mtime) return cache;
  const buf = fs.readFileSync(f.path);
  const D = JSON.parse((f.gzip ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  const F = Object.fromEntries(D.fields.map((k, i) => [k, i]));
  const byName = new Map();
  for (const r of D.rows) {
    byName.set(r[F.name], r);
    r._hay = [r[F.title], r[F.name], r[F.desc], r[F.pkgId], D.cats[r[F.cat]]?.[1], ...((F.tools != null && r[F.tools]) || [])].join(' ').toLowerCase();
    r._title = `${r[F.title]} ${r[F.name]}`.toLowerCase();
    r._pop = Math.log10(Math.max(0, r[F.stars]) + 1) + Math.log10(Math.max(0, r[F.downloads]) + 1) * 0.75 + (r[F.rank] ? r[F.rank] / 40 : 0) + (r[F.reach] === 1 ? 0.3 : 0) - (r[F.archived] ? 1 : 0) - (r[F.pubCount] >= 100 ? 0.6 : 0);
  }
  cache = { path: f.path, mtime, D, F, byName, rows: D.rows };
  return cache;
}

const STOP = new Set('a an and are as at be by can do does for from get give have help how i if in into is it its me my of on or our please show so some that the their them then this to up us use want we what when where which who why will with you your would like need make find tell about able just more any all also server servers mcp tool tools'.split(' '));
export const taskWords = (s) =>
  [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(?<=\w{3})(ies)$/, 'y').replace(/(?<=\w{3})s$/, '')))].slice(0, 12);

/** MCP Browser can call it as-is: hosted over HTTPS, no key, last seen answering. */
export function runnable(r, F) {
  if (F.listed != null && r[F.listed] === 1) return true;
  const u = r[F.remoteUrl];
  return Boolean(u) && /^https:\/\/[^\s{}]+$/i.test(u) && !(r[F.required] > 0) && ![2, 3, 5].includes(r[F.reach]);
}

/** Catalog servers for a task, best first. */
export function searchCatalog(task, { limit = 8, runnableOnly = false, hostedOnly = false } = {}) {
  const c = loadCatalog();
  if (!c) return [];
  const { F, rows } = c;
  const terms = taskWords(task);
  if (!terms.length) return [];
  // Short queries (2–3 words) need every word; longer descriptions most of them.
  const need = terms.length <= 3 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.6));
  const out = [];
  for (const r of rows) {
    if (r[F.deprecated] || r[F.pubCount] >= 100) continue;
    if (runnableOnly && !runnable(r, F)) continue;
    if (hostedOnly && !r[F.remoteUrl]) continue;
    let hit = 0;
    let score = 0;
    for (const t of terms) {
      if (r._title.includes(t)) (hit++, (score += 4));
      else if (r._hay.includes(t)) (hit++, (score += 1));
    }
    if (hit < need) continue;
    out.push([score * 1.5 + r._pop + (runnable(r, F) ? 0.8 : 0), r]);
  }
  out.sort((a, b) => b[0] - a[0]);
  return out.slice(0, limit).map(([, r]) => r);
}

/** A plain object describing one catalog row, for JSON replies. */
export function describe(r, { full = false } = {}) {
  const c = loadCatalog();
  const { F, D } = c;
  const g = guideLib();
  const repo = r[F.repo];
  const o = {
    server_id: r[F.name],
    title: r[F.title] || r[F.name].split('/').pop(),
    description: r[F.desc],
    category: D.cats[r[F.cat]]?.[1] || '',
    github: /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : repo || null,
    website: r[F.website] || null,
    github_stars: r[F.stars] >= 0 ? r[F.stars] : null,
    downloads: r[F.downloads] >= 0 ? { count: r[F.downloads], source: r[F.pkgType] } : null,
    how_it_runs: r[F.pkgType] ? `${r[F.pkgType]} package ${r[F.pkgId]}` : r[F.remoteUrl] ? `hosted at ${r[F.remoteUrl]}` : 'unknown',
    runs_in_mcp_browser: runnable(r, F),
    required_settings: ((F.envs != null && r[F.envs]) || []).map(([n, secret]) => (secret ? `${n} (secret)` : n)),
    sample_prompts: ((F.prompts != null && r[F.prompts]) || []).map(([p]) => p),
    ...(F.tested != null && r[F.tested] ? { tested: testedView(r[F.tested]) } : {}),
  };
  if (full) {
    o.tools = (F.tools != null && r[F.tools]) || [];
    o.checks = g.gotchas(r, F).map(([level, t]) => `${level}: ${t}`);
    o.added = r[F.added] || null;
    o.last_release = r[F.updated] || null;
    o.last_github_push = r[F.pushed] || null;
  }
  return o;
}

/** Our test run of a package server, in words: { status, on, tools, detail, version }. */
export function testedView([code, on, tools, why, version]) {
  const status = { a: 'starts and answers', m: 'answers when an AI model fills in its inputs', s: 'starts', n: 'starts but has no tools', f: 'didn’t start', k: 'needs a key to test', g: 'needs arguments to test' }[code] || 'unknown';
  return { status, ok: code === 'a' || code === 'm' || code === 's', on, tools, detail: why || '', version: version || '' };
}

/** Setup snippets for one or more catalog rows. client: code | desktop | cursor | vscode | all */
export function setupFor(rows, client = 'all') {
  const c = loadCatalog();
  const s = guideLib().setupFor(rows, c.F);
  const clients = client === 'all' ? s.clients : s.clients.filter((x) => x.id === client);
  return { clients: clients.map((x) => ({ client: x.label, where: x.where, snippet: x.text })), notes: s.notes };
}

/** What MCP Browser needs to ask a catalog server it hasn't synced. */
export function adhocFor(r) {
  const c = loadCatalog();
  const { F } = c;
  if (!runnable(r, F)) return null;
  return { id: r[F.name], title: r[F.title] || r[F.name].split('/').pop(), description: r[F.desc] || '', url: r[F.remoteUrl], transport: r[F.remoteType] === 'sse' ? 'sse' : 'streamable-http', source: 'registry', trust: 'community', tags: [] };
}

/**
 * Script-ready description of catalog rows (for the stack setup script).
 * values: id → { NAME: value }. pins: id → { version, wheel } from the package
 * registry: packages are pinned to that version, npm install scripts are turned
 * off and PyPI packages with wheels are installed without building.
 */
export function scriptServers(rows, values = {}, pins = {}) {
  const c = loadCatalog();
  const { F } = c;
  const g = guideLib();
  const used = new Set();
  return rows.map((r) => {
    const pin = pins[r[F.name]];
    const okPin = pin?.version && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(pin.version);
    const l = g.launchOf(r, F, okPin ? { pin } : {});
    // Startup arguments only you can fill in (a path, a region): set it up by hand.
    if (l.needsArgs) (l.kind = 'none'), (l.note = l.note || 'Fill in its arguments first (see its README).');
    let key = l.name;
    for (let i = 2; used.has(key); i++) key = `${l.name}-${i}`;
    used.add(key);
    const v = values[r[F.name]] || {};
    const fixedEnv = l.kind === 'local' && okPin && r[F.pkgType] === 'npm' ? { npm_config_ignore_scripts: 'true' } : undefined;
    const settings = ((F.envs != null && r[F.envs]) || []).map(([name, secret, d, kind]) => ({ name, secret: Boolean(secret), description: g.explain(name, d).slice(0, 200), header: kind === 'h', ...(!secret && v[name] ? { value: v[name] } : {}) }));
    return {
      key,
      id: r[F.name],
      title: r[F.title] || r[F.name].split('/').pop(),
      kind: l.kind,
      ...(l.kind === 'local' ? { command: l.command, args: l.args, ...(fixedEnv ? { fixedEnv } : {}), ...(okPin ? { version: pin.version } : {}) } : {}),
      ...(l.kind === 'remote' ? { url: l.url, transport: l.transport } : {}),
      settings: l.kind === 'none' ? [] : settings,
      ...(l.note ? { note: l.note } : {}),
    };
  });
}

/**
 * Whether MCP Browser offers to run a package server with a plain approval, or
 * only after an explicit "run it anyway": real adoption, maintained, and the
 * publisher matches the code's owner.
 */
export function trustOf(r) {
  const c = loadCatalog();
  const { F } = c;
  const checks = guideLib().gotchas(r, F);
  const why = [];
  const stars = r[F.stars] ?? -1;
  const dl = r[F.downloads] ?? -1;
  if (!(stars >= 100 || dl >= 5000)) why.push(`little adoption so far (${stars >= 0 ? `${stars} GitHub stars` : 'no GitHub stars'}, ${dl >= 0 ? `${dl.toLocaleString()} downloads a month` : 'downloads unknown'})`);
  if (r[F.archived]) why.push('its GitHub repo is archived');
  if (r[F.deprecated]) why.push('it is marked deprecated');
  if (r[F.pubCount] >= 100) why.push(`its publisher has ${r[F.pubCount]} servers in the registry, many generated from templates`);
  for (const [level, t] of checks) if (level === 'bad' || (level === 'warn' && /^Published by GitHub user/.test(t))) why.push(t.replace(/[.\s]+$/, '').replace(/^./, (x) => x.toLowerCase()));
  return { trusted: !why.length, why: [...new Set(why)], checks: checks.map(([level, t]) => [level, t]) };
}
