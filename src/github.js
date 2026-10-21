// GitHub stars for MCP servers. A popularity signal shown next to MCP Rank's
// measured quality, never mixed into the accuracy score (stars can be bought
// and say nothing about whether a server answers correctly).
//
// Sources, best first:
//   github     – GitHub GraphQL, 50 repos per query. Needs a token (settings.githubToken
//                or GITHUB_TOKEN). All ~12,600 registry repos take ~250 queries.
//   ecosystems – repos.ecosyste.ms open data, no token, 5,000 requests/hour.
//   ungh       – ungh.cc cached GitHub mirror, no token.
// A snapshot ships in src/data/github-stars.json; refreshed data is saved to the
// data dir and wins over the snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';
import { mapLimit, errMsg, log } from './util.js';

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'github-stars.json');
const UA = 'mcp-browser (https://github.com/modelcontextprotocol/registry consumer)';
const NAME_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** "https://github.com/Owner/Repo/tree/main/x" → "owner/repo" (lowercase key), else null. */
export function parseGithubRepo(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/^(?:git\+)?(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([^/\s]+)\/([^/#?\s]+)/i);
  if (!m) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/i, '');
  if (!NAME_RE.test(owner) || !REPO_RE.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`.toLowerCase();
}

/**
 * Compact record: s stars, p last push (YYYY-MM-DD), a archived, f fork,
 * x confirmed missing on GitHub, u not in the open-data index (unknown: it may
 * be new, or gone; only GitHub itself can tell).
 */
function record({ stars, pushedAt, archived, fork, fullName }) {
  const r = { s: Number(stars) || 0 };
  if (pushedAt) r.p = String(pushedAt).slice(0, 10);
  if (archived) r.a = 1;
  if (fork) r.f = 1;
  // Canonical name from the source goes into links: accept only a plain owner/repo.
  if (typeof fullName === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(fullName) && !/\/\.\.?$/.test(fullName)) r.n = fullName;
  return r;
}

class RateLimited extends Error {
  constructor(resetAt) {
    super('rate limited');
    this.resetAt = resetAt;
  }
}

const SOURCES = {
  async ecosystems(key, { fetchFn }) {
    const r = await fetchFn(`https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/${encodeURIComponent(key)}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 404) return { u: 1 }; // not indexed: not proof the repo is gone
    if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) throw new RateLimited(Number(r.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 60_000);
    if (!r.ok) throw new Error(`ecosyste.ms ${r.status}`);
    const j = await r.json();
    return record({ stars: j.stargazers_count, pushedAt: j.pushed_at, archived: j.archived, fork: j.fork, fullName: j.full_name });
  },
  async ungh(key, { fetchFn }) {
    const r = await fetchFn(`https://ungh.cc/repos/${key}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 404) return { x: 1 };
    if (r.status === 429 || r.status === 403) throw new RateLimited(Date.now() + 60_000);
    if (!r.ok) throw new Error(`ungh ${r.status}`);
    const j = (await r.json()).repo;
    if (!j) return { x: 1 };
    return record({ stars: j.stars, pushedAt: j.pushedAt, fullName: j.repo });
  },
};

/** GitHub GraphQL: up to 50 repositories per query. */
async function githubBatch(keys, { fetchFn, token }) {
  const parts = keys.map((k, i) => {
    const [o, n] = k.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { nameWithOwner stargazerCount pushedAt isArchived isFork }`;
  });
  const r = await fetchFn('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ query: `{ ${parts.join('\n')} rateLimit { remaining resetAt } }` }),
  });
  if (r.status === 401) throw new Error('GitHub rejected the token');
  if (r.status === 403 || r.status === 429) throw new RateLimited(Date.now() + 60_000);
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  const out = {};
  keys.forEach((k, i) => {
    const d = j.data?.[`r${i}`];
    out[k] = d ? record({ stars: d.stargazerCount, pushedAt: d.pushedAt, archived: d.isArchived, fork: d.isFork, fullName: d.nameWithOwner }) : { x: 1 };
  });
  const rl = j.data?.rateLimit;
  if (rl && rl.remaining < 10) throw Object.assign(new RateLimited(Date.parse(rl.resetAt)), { partial: out });
  return out;
}

/**
 * Fetch star records for repo keys. Stops early (keeping what it has) when a
 * source is rate limited; `deadline` caps total time. Returns { repos, done, error }.
 */
export async function fetchStars(keys, { source, token, fetchFn = fetch, concurrency = 4, onProgress, deadline = Infinity, signal } = {}) {
  const repos = {};
  let error = null;
  let n = 0;
  const report = () => onProgress?.({ done: n, total: keys.length });
  if (source === 'github') {
    if (!token) throw new Error('a GitHub token is needed for the github source');
    const batches = [];
    for (let i = 0; i < keys.length; i += 50) batches.push(keys.slice(i, i + 50));
    for (const b of batches) {
      if (signal?.aborted || Date.now() > deadline || error) break;
      try {
        Object.assign(repos, await githubBatch(b, { fetchFn, token }));
      } catch (e) {
        if (e.partial) Object.assign(repos, e.partial);
        error = e instanceof RateLimited ? `GitHub rate limit reached; resets ${new Date(e.resetAt).toLocaleTimeString()}` : errMsg(e);
      }
      n = Object.keys(repos).length;
      report();
    }
    return { repos, done: n, error };
  }
  const fn = SOURCES[source];
  if (!fn) throw new Error(`unknown source ${source}`);
  await mapLimit(keys, concurrency, async (k) => {
    if (error || signal?.aborted || Date.now() > deadline) return;
    try {
      repos[k] = await fn(k, { fetchFn });
    } catch (e) {
      if (e instanceof RateLimited) error = `${source} rate limit reached; resets ${new Date(e.resetAt).toLocaleTimeString()}`;
      else log.debug('stars', k, errMsg(e)); // one bad repo doesn't stop the run
    }
    if (++n % 50 === 0) report();
  });
  report();
  return { repos, done: Object.keys(repos).length, error };
}

/** Snapshot + refreshed data, merged by fetch date per repo. */
export class StarsStore {
  constructor({ file = path.join(dataDir(), 'github-stars.json'), snapshot = SNAPSHOT } = {}) {
    this.file = file;
    this.repos = {};
    this.fetchedAt = null;
    this.source = null;
    for (const f of [snapshot, file]) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        Object.assign(this.repos, j.repos || {});
        if (!this.fetchedAt || (j.fetchedAt && j.fetchedAt > this.fetchedAt)) {
          this.fetchedAt = j.fetchedAt || this.fetchedAt;
          this.source = j.source || this.source;
        }
      } catch {
        /* missing is fine */
      }
    }
  }
  get(url) {
    const key = parseGithubRepo(url);
    return key ? this.repos[key] || null : null;
  }
  merge(repos, { source } = {}) {
    // An "unknown" answer never overwrites something we actually know.
    for (const [k, v] of Object.entries(repos)) if (!(v.u && this.repos[k] && !this.repos[k].u)) this.repos[k] = v;
    this.fetchedAt = new Date().toISOString();
    this.source = source || this.source;
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, source: this.source, repos: this.repos }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.warn('could not save stars', errMsg(e));
    }
  }
  get size() {
    return Object.keys(this.repos).length;
  }
}

/** Repo keys for a list of servers, with how many servers share each repo (monorepos). */
export function repoKeys(servers) {
  const count = new Map();
  for (const s of servers) {
    const k = parseGithubRepo(s.repo);
    if (k) count.set(k, (count.get(k) || 0) + 1);
  }
  return count;
}

/** A short public view for a server: null when it has no GitHub repo. */
export function starsView(store, s, shared) {
  const key = parseGithubRepo(s.repo);
  if (!key) return null;
  const r = store.repos[key];
  const out = { repo: r?.n || key, url: `https://github.com/${r?.n || key}` };
  if (!r || r.u) return { ...out, unknown: true };
  if (r.x) return { ...out, missing: true };
  const view = { ...out, stars: r.s, pushedAt: r.p || null, archived: Boolean(r.a), fork: Boolean(r.f), sharedWith: Math.max(0, (shared?.get(key) || 1) - 1) };
  // The registry verifies an io.github.<user> name, but not the repository link: a
  // server can point at someone else's popular repo. Flag it (often legitimate:
  // a personal account publishing for its company's org).
  const owner = /^io\.github\.([^/]+)\//i.exec(s.id || '')?.[1];
  if (owner && owner.toLowerCase() !== key.split('/')[0]) view.otherOwner = true;
  return view;
}
