#!/usr/bin/env node
// Build the MCP server catalog shown at mcp://catalog: every server in the
// official MCP Registry with a category, links, GitHub stars, package downloads,
// version history, reachability and MCP Rank score.
//
//   node scripts/build-catalog.js [--bundle] [--fresh] [--skip-stars] [--skip-downloads] [--skip-neighbours] [--skip-tools]
//
// Steps are cached in <data dir>/catalog-build, so a rerun only redoes what is
// stale (registry: 12 hours; downloads: 7 days). Output: <data dir>/catalog.json.gz,
// which the app prefers over the bundled snapshot; --bundle also refreshes that
// snapshot (src/data/catalog.json.gz). A full first run takes about 30-60 minutes,
// mostly waiting on the public download-count APIs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../src/config.js';
import { parseGithubRepo } from '../src/github.js';
import { fetchRegistry } from './catalog/registry.mjs';
import { fetchDownloads, dockerKey } from './catalog/downloads.mjs';
import { CATEGORIES, categorize } from './catalog/categories.mjs';
import { classifyNeighbours } from './catalog/neighbours.mjs';
import { probeTools, listable } from './catalog/tools.mjs';
import { samplePrompts } from './catalog/prompts.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const work = path.join(dataDir(), 'catalog-build');
fs.mkdirSync(work, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const file = (n) => path.join(work, n);
const fresh = (n, hours) => !args.has('--fresh') && fs.existsSync(file(n)) && Date.now() - fs.statSync(file(n)).mtimeMs < hours * 3600_000;
const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v));

// 1. Registry: latest version of every server, then the version history.
let latest;
if (fresh('registry-latest.json', 12)) latest = readJson(file('registry-latest.json'));
else {
  log('Reading the registry (latest versions)…');
  latest = [...(await fetchRegistry({ latest: true, log })).values()];
  writeJson('registry-latest.json', latest);
}
log(`${latest.length} servers`);
let versions;
if (fresh('registry-versions.json', 12)) versions = readJson(file('registry-versions.json'));
else {
  log('Reading the registry (every version, for first-listed dates)…');
  versions = Object.fromEntries(await fetchRegistry({ latest: false, log }));
  writeJson('registry-versions.json', versions);
}

// 2. Downloads (resumable; started over once a week).
const dlPath = file('downloads.json');
const partial = dlPath + '.partial';
const resuming = fs.existsSync(partial);
let dl = resuming ? readJson(partial, {}) : readJson(dlPath, {});
if (!args.has('--skip-downloads') && (resuming || !fresh('downloads.json', 24 * 7))) {
  if (!resuming) dl = {}; // a week old: count again from scratch
  log('Reading package download counts…');
  dl = await fetchDownloads(latest, dl, { save: () => fs.writeFileSync(partial, JSON.stringify(dl)), log });
  fs.renameSync(partial, dlPath);
}
for (const k of ['npm', 'pypi', 'cargo', 'docker']) dl[k] ||= {};

// 3. GitHub stars for every repo (the app's own collector; it skips repos it has).
if (!args.has('--skip-stars')) {
  log('Reading GitHub stars…');
  const reg = file('repos-for-stars.json');
  fs.writeFileSync(reg, JSON.stringify({ servers: latest.filter((s) => s.repo).map((s) => ({ id: s.name, repo: s.repo })) }));
  spawnSync(process.execPath, [path.join(root, 'scripts', 'collect-stars.js'), reg, '1.5'], { stdio: 'inherit' });
}
const stars = { ...readJson(path.join(root, 'src', 'data', 'github-stars.json'), { repos: {} }).repos, ...readJson(path.join(dataDir(), 'github-stars.json'), { repos: {} }).repos };

// 3b. Tool lists of hosted servers that answer without a key (re-listed weekly).
const toolsPath = file('tools.json');
const tools = readJson(toolsPath, {});
if (!args.has('--skip-tools')) {
  log('Listing tools of hosted servers…');
  const reachNow = readJson(path.join(root, 'src', 'data', 'reachability.json'), { servers: {} }).servers;
  const todo = listable(latest).filter((s) => !['dead', 'auth', 'paid'].includes(reachNow[s.id]));
  await probeTools(todo, tools, { concurrency: 64, deadline: Date.now() + 2 * 3600_000, save: () => fs.writeFileSync(toolsPath, JSON.stringify(tools)), log });
}

// Prompts written for popular servers (src/data/catalog-prompts.json) win over generated ones.
const written = readJson(path.join(root, 'src', 'data', 'catalog-prompts.json'), {});

// 4. Categories, with neighbours for what keywords miss.
let knn = fresh('neighbours.json', 24 * 7) ? readJson(file('neighbours.json'), {}) : null;
if (!knn) {
  knn = args.has('--skip-neighbours') ? {} : await classifyNeighbours(latest, { modelDir: path.join(dataDir(), 'models'), log });
  writeJson('neighbours.json', knn);
}

// 5. Join.
const reach = readJson(path.join(root, 'src', 'data', 'reachability.json'), { servers: {} }).servers;
const rank = new Map((readJson(path.join(root, 'docs', 'mcp-rank-labels.json'), { servers: [] }).servers || []).map((s) => [s.id, s]));
const catIdx = Object.fromEntries([...CATEGORIES.map((c) => c[0]), 'other'].map((id, i) => [id, i]));
const REACH = { ok: 1, 'needs-ai': 1, auth: 2, paid: 3, blocked: 4, dead: 5, error: 5 };
const day = (s) => (s || '').slice(0, 10);
const MOJIBAKE = [['â€”', '—'], ['â€“', '–'], ['â€™', '’'], ['â€œ', '“'], ['â€˜', '‘'], ['â€¦', '…'], ['â†’', '→']];
const clean = (s) => {
  let t = String(s || '');
  for (const [a, b] of MOJIBAKE) t = t.split(a).join(b);
  return t.replace(/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
};
const pubCount = {};
for (const s of latest) pubCount[s.name.split('/')[0]] = (pubCount[s.name.split('/')[0]] || 0) + 1;

// [text, source]: source 'w' = written for this server, 't:<tool>' = from that tool, 'd' = from its description.
function promptsFor(s, cat) {
  if (Array.isArray(written[s.name]) && written[s.name].length) return written[s.name].slice(0, 3).map((p) => [clean(p).slice(0, 160), 'w']);
  return samplePrompts({ ...s, title: clean(s.title), description: clean(s.description) }, cat, tools[s.name]?.tools || []).map(([p, t]) => [p, t ? 't:' + t : 'd']);
}

const rows = [];
for (const s of latest) {
  if (!s.name || s.status === 'deleted') continue;
  let { cat, also } = categorize(s);
  let guessed = 0;
  if (cat === 'other' && knn[s.name]) (cat = knn[s.name]), (guessed = 1);
  const key = parseGithubRepo(s.repo);
  const st = key ? stars[key] : null;
  let pkgType = '';
  let pkgId = '';
  let downloads = -1;
  let env = 0;
  let envs = [];
  for (const p of s.packages || []) {
    const n = p.type === 'npm' ? dl.npm[p.id] : p.type === 'pypi' ? dl.pypi[(p.id || '').toLowerCase()] : p.type === 'cargo' ? dl.cargo[p.id] : p.type === 'oci' ? dl.docker[dockerKey(p.id)] : undefined;
    const v = typeof n === 'number' ? n : -1;
    if (!pkgType || v > downloads) (pkgType = p.type), (pkgId = p.id), (downloads = v), (env = p.env || 0), (envs = (p.envNames || []).map((e) => [e.n, e.s ? 1 : 0, clean(e.d).slice(0, 100)]));
  }
  const remote = (s.remotes || [])[0];
  if (remote && !pkgType) (env = remote.headers || 0), (envs = (remote.headerNames || []).map((e) => [e.n, e.s ? 1 : 0, clean(e.d).slice(0, 100), 'h']));
  rows.push([
    s.name, clean(s.title), clean(s.description).slice(0, 240), catIdx[cat], also.map((a) => catIdx[a]),
    /^https?:\/\//i.test(s.website) ? s.website : '', key || (/^https?:\/\//i.test(s.repo) ? s.repo : ''),
    st && typeof st.s === 'number' ? st.s : -1, pkgType, pkgId, downloads, remote?.url || '', remote?.type || '',
    REACH[reach[s.name]] || 0, rank.get(s.name)?.bestScore || 0, day(s.updated || s.published), s.version || '', env,
    st?.p || '', st?.a ? 1 : 0, pubCount[s.name.split('/')[0]] || 1, guessed, s.status === 'deprecated' ? 1 : 0,
    day(versions[s.name]?.first || s.published || s.updated), versions[s.name]?.versions || 1,
    promptsFor(s, cat), (tools[s.name]?.tools || []).filter((t) => !t.w).map((t) => t.n).slice(0, 12), tools[s.name]?.tools?.length ? 1 : 0,
    envs, (tools[s.name]?.tools || []).filter((t) => t.w).length,
  ]);
}
const out = {
  generatedAt: new Date().toISOString(),
  sources: { registry: 'registry.modelcontextprotocol.io', stars: 'ecosyste.ms and ungh open indexes', downloads: dl.fetchedAt || '' },
  cats: [...CATEGORIES.map((c) => [c[0], c[1]]), ['other', 'Other']],
  fields: ['name', 'title', 'desc', 'cat', 'also', 'website', 'repo', 'stars', 'pkgType', 'pkgId', 'downloads', 'remoteUrl', 'remoteType', 'reach', 'rank', 'updated', 'version', 'required', 'pushed', 'archived', 'pubCount', 'guessed', 'deprecated', 'added', 'versions', 'prompts', 'tools', 'listed', 'envs', 'writeTools'],
  rows,
};
const gz = zlib.gzipSync(JSON.stringify(out).replace(/�/g, ''), { level: 9 });
fs.writeFileSync(path.join(dataDir(), 'catalog.json.gz'), gz);
if (args.has('--bundle')) fs.writeFileSync(path.join(root, 'src', 'data', 'catalog.json.gz'), gz);
// Full tool lists (descriptions, inputs) for the per-server guide, fetched one server at a time.
const toolsOut = {};
for (const [id, v] of Object.entries(tools)) if (v.tools?.length) toolsOut[id] = { at: v.at, tools: v.tools };
const tgz = zlib.gzipSync(JSON.stringify(toolsOut), { level: 9 });
fs.writeFileSync(path.join(dataDir(), 'catalog-tools.json.gz'), tgz);
if (args.has('--bundle')) fs.writeFileSync(path.join(root, 'src', 'data', 'catalog-tools.json.gz'), tgz);
log(`Tool lists: ${Object.keys(toolsOut).length} servers, ${(tgz.length / 1e6).toFixed(1)} MB`);
log(`Catalog: ${rows.length} servers, ${(gz.length / 1e6).toFixed(1)} MB → ${path.join(dataDir(), 'catalog.json.gz')}${args.has('--bundle') ? ' and src/data/catalog.json.gz' : ''}`);
