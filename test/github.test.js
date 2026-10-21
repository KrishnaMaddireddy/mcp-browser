// GitHub stars: repo parsing, the three sources (with fake fetch), storage,
// the API fields, sorting, and that stars never touch MCP Rank scores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-stars-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';
delete process.env.GITHUB_TOKEN;

const { parseGithubRepo, fetchStars, StarsStore, starsView, repoKeys } = await import('../src/github.js');
const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');
const { HealthStore } = await import('../src/health.js');
const { saveSettings, publicSettings, loadSettings } = await import('../src/config.js');

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('repo URLs are normalised; non-GitHub and odd paths are ignored', () => {
  assert.equal(parseGithubRepo('https://github.com/Exa-Labs/exa-mcp-server'), 'exa-labs/exa-mcp-server');
  assert.equal(parseGithubRepo('https://github.com/a/b/tree/main/servers/x'), 'a/b');
  assert.equal(parseGithubRepo('git+https://github.com/a/b.git'), 'a/b');
  assert.equal(parseGithubRepo('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseGithubRepo('https://github.com/../x'), null);
  assert.equal(parseGithubRepo('https://evil.com/github.com/a/b'), null);
  assert.equal(parseGithubRepo(undefined), null);
});

test('ecosyste.ms source: records, not-found, and stops cleanly on rate limit', async () => {
  const seen = [];
  const fetchFn = async (u) => {
    seen.push(u);
    if (u.includes('a%2Fgood')) return json(200, { full_name: 'A/good', stargazers_count: 1234, pushed_at: '2026-10-01T00:00:00Z', archived: false, fork: false });
    if (u.includes('a%2Fold')) return json(200, { full_name: 'a/old', stargazers_count: 5, pushed_at: '2023-01-01T00:00:00Z', archived: true });
    if (u.includes('a%2Fgone')) return json(404, { error: 'Repository not found' });
    return json(429, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  };
  const r = await fetchStars(['a/good', 'a/old', 'a/gone', 'a/limited'], { source: 'ecosystems', fetchFn, concurrency: 1 });
  assert.deepEqual(r.repos['a/good'], { s: 1234, p: '2026-10-01', n: 'A/good' });
  assert.deepEqual(r.repos['a/old'], { s: 5, p: '2023-01-01', a: 1, n: 'a/old' });
  assert.deepEqual(r.repos['a/gone'], { u: 1 }, 'not indexed is unknown, not gone');
  const odd = await fetchStars(['a/odd'], { source: 'ecosystems', fetchFn: async () => json(200, { full_name: 'evil.com/x?y', stargazers_count: 1 }) });
  assert.deepEqual(odd.repos['a/odd'], { s: 1 });
  assert.equal(r.repos['a/limited'], undefined);
  assert.match(r.error, /rate limit/);
  assert.ok(seen.every((u) => u.startsWith('https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/')));
});

test('GitHub source: 50 repos per GraphQL query, token sent, missing repos marked', async () => {
  const calls = [];
  const fetchFn = async (u, init) => {
    calls.push({ u, auth: init.headers.authorization, n: (init.body.match(/repository\(/g) || []).length });
    const q = JSON.parse(init.body).query;
    const data = { rateLimit: { remaining: 4000, resetAt: new Date().toISOString() } };
    for (const m of q.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
      data[m[1]] = m[3] === 'missing' ? null : { nameWithOwner: `${m[2]}/${m[3]}`, stargazerCount: 7, pushedAt: '2026-09-09T00:00:00Z', isArchived: false, isFork: true };
    }
    return json(200, { data });
  };
  const keys = Array.from({ length: 120 }, (_, i) => `o/r${i}`).concat(['o/missing']);
  const r = await fetchStars(keys, { source: 'github', token: 'ghp_test', fetchFn });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.n), [50, 50, 21]);
  assert.ok(calls.every((c) => c.u === 'https://api.github.com/graphql' && c.auth === 'bearer ghp_test'));
  assert.deepEqual(r.repos['o/r3'], { s: 7, p: '2026-09-09', f: 1, n: 'o/r3' });
  assert.deepEqual(r.repos['o/missing'], { x: 1 });
  await assert.rejects(fetchStars(['o/r'], { source: 'github', fetchFn }), /token/);
});

test('store: refreshed data wins over the snapshot; views count shared monorepos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-'));
  const snap = path.join(dir, 'snap.json');
  fs.writeFileSync(snap, JSON.stringify({ fetchedAt: '2026-10-01T00:00:00Z', source: 'snapshot', repos: { 'a/b': { s: 1 }, 'c/d': { s: 2 } } }));
  const file = path.join(dir, 'mine.json');
  const st = new StarsStore({ file, snapshot: snap });
  st.merge({ 'a/b': { s: 100, n: 'A/b' } }, { source: 'GitHub API' });
  const again = new StarsStore({ file, snapshot: snap });
  assert.equal(again.get('https://github.com/a/b').s, 100);
  assert.equal(again.get('https://github.com/c/d').s, 2);
  assert.equal(again.source, 'GitHub API');
  const servers = [{ repo: 'https://github.com/a/b' }, { repo: 'https://github.com/A/b/tree/main/x' }, { repo: 'https://github.com/c/d' }];
  const shared = repoKeys(servers);
  assert.equal(starsView(again, servers[0], shared).sharedWith, 1);
  assert.equal(starsView(again, servers[0], shared).repo, 'A/b');
  assert.equal(starsView(again, { repo: 'https://github.com/x/y' }, shared).unknown, true);
  again.merge({ 'a/b': { u: 1 }, 'u/v': { u: 1 } });
  assert.equal(again.repos['a/b'].s, 100, 'an unknown answer never erases known stars');
  assert.equal(starsView(again, { repo: 'https://github.com/u/v' }, shared).unknown, true);
  assert.equal(starsView(again, { url: 'https://x' }, shared), null);
  // Registry name io.github.<user> but the repo belongs to someone else.
  assert.equal(starsView(again, { id: 'io.github.mallory/x', repo: 'https://github.com/c/d' }, shared).otherOwner, true);
  assert.equal(starsView(again, { id: 'io.github.C/x', repo: 'https://github.com/c/d' }, shared).otherOwner, undefined);
  assert.equal(starsView(again, { id: 'com.example/x', repo: 'https://github.com/c/d' }, shared).otherOwner, undefined);
});

test('GitHub token setting: validated, stored, masked', () => {
  saveSettings({ githubToken: 'not a token!' });
  assert.equal(loadSettings().githubToken, '');
  saveSettings({ githubToken: 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
  const pub = publicSettings(loadSettings());
  assert.equal(pub.hasGithubToken, true);
  assert.equal(pub.githubToken, '••••6789');
  saveSettings({ githubToken: '' });
  assert.equal(loadSettings().githubToken, '');
});

let app;
let base;
before(async () => {
  fs.mkdirSync(path.join(process.env.MCPB_DATA_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MCPB_DATA_DIR, 'github-stars.json'),
    JSON.stringify({ fetchedAt: '2026-10-20T00:00:00Z', source: 'test', repos: { 'big/one': { s: 5000, p: '2026-10-01', n: 'Big/one' }, 'small/one': { s: 3 }, 'gone/one': { x: 1 } } })
  );
  const mk = (id, repo) => ({ id, title: `Weather ${id}`, description: 'weather forecasts', url: `https://${id}.test/mcp`, source: 'registry', trust: 'community', tags: ['weather'], repo });
  const engine = createEngine({
    providerOverride: null,
    curated: [],
    extraServers: [mk('small', 'https://github.com/small/one'), mk('big', 'https://github.com/big/one'), mk('gone', 'https://github.com/gone/one'), mk('norepo')],
    health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h.json') }),
    embeddings: null,
  });
  app = createServer({ engine, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(() => app.close());

test('the servers API carries stars and can sort by them', async () => {
  const r = await fetch(`${base}/api/servers?q=weather&sort=stars`).then((x) => x.json());
  assert.deepEqual(r.servers.map((s) => s.id), ['big', 'small', 'gone', 'norepo']);
  assert.equal(r.servers[0].github.stars, 5000);
  assert.equal(r.servers[0].github.url, 'https://github.com/Big/one');
  assert.equal(r.servers[2].github.missing, true);
  assert.equal(r.servers[3].github, null);
  const st = await fetch(`${base}/api/status`).then((x) => x.json());
  assert.equal(st.stars.repos >= 3, true);
  assert.equal(st.stars.hasToken, false);
  // The subregistry passes stars on under its own namespaced key.
  const one = await fetch(`${base}/v0.1/servers/big/versions/latest`).then((x) => x.json());
  assert.equal(one._meta['local.mcp-browser/github'].stars, 5000);
});

test('stars never change MCP Rank scores or routing', async () => {
  const { rankScores } = await import('../src/rank.js');
  const before = JSON.stringify([...rankScores().entries()]);
  app.engine.stars.merge({ 'small/one': { s: 999999 } });
  assert.equal(JSON.stringify([...rankScores().entries()]), before);
  const routed = app.engine.catalog.route('weather forecasts', { discovery: true }).map((r) => r.server.id);
  app.engine.stars.merge({ 'small/one': { s: 3 } });
  assert.deepEqual(app.engine.catalog.route('weather forecasts', { discovery: true }).map((r) => r.server.id), routed);
});
