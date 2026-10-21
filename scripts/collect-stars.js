#!/usr/bin/env node
// Build src/data/github-stars.json (the snapshot that ships with the app) from
// the registry mirror, using the no-token sources in parallel and waiting out
// rate limits. Usage: node scripts/collect-stars.js <registry.json> [hours=3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchStars, parseGithubRepo } from '../src/github.js';
import { guardedFetch } from '../src/netguard.js';
import { CURATED } from '../src/curated.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'data', 'github-stars.json');
const reg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const deadline = Date.now() + Number(process.argv[3] || 3) * 3600_000;
const servers = [...CURATED, ...reg.servers];

let labels = [];
try {
  labels = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'mcp-rank-labels.json'), 'utf8')).servers.map((l) => l.id);
} catch {}
const ranked = new Set(labels);
const count = new Map();
const priority = new Map();
for (const s of servers) {
  const k = parseGithubRepo(s.repo);
  if (!k) continue;
  count.set(k, (count.get(k) || 0) + 1);
  if (s.source === 'curated' || ranked.has(s.id)) priority.set(k, 1);
}
let data = { repos: {} };
try {
  data = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {}
const queue = [...count.keys()]
  .filter((k) => !data.repos[k])
  .sort((a, b) => (priority.get(b) || 0) - (priority.get(a) || 0) || count.get(b) - count.get(a));
console.log(`${count.size} repos, ${Object.keys(data.repos).length} already done, ${queue.length} to fetch`);

const fetchFn = guardedFetch({});
const tries = new Map();
const save = () => {
  fs.writeFileSync(out + '.tmp', JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'ecosyste.ms + ungh.cc (GitHub data)', repos: data.repos }));
  fs.renameSync(out + '.tmp', out);
};

async function worker(source, concurrency) {
  while (queue.length && Date.now() < deadline) {
    const chunk = queue.splice(0, 100);
    const r = await fetchStars(chunk, { source, fetchFn, concurrency, deadline });
    Object.assign(data.repos, r.repos);
    const missed = chunk.filter((k) => !r.repos[k]);
    if (r.error) {
      queue.unshift(...missed);
      console.log(`[${source}] ${r.error}; waiting`);
      await new Promise((ok) => setTimeout(ok, 5 * 60_000));
    } else if (missed.length) {
      // Transient failures: retry each repo once more, then give up on it.
      for (const k of missed) if ((tries.set(k, (tries.get(k) || 0) + 1), tries.get(k)) < 2) queue.push(k);
    }
    save();
    console.log(`[${source}] ${Object.keys(data.repos).length}/${count.size}`);
  }
}
await Promise.all([worker('ecosystems', 4), worker('ungh', 3)]);
save();
console.log('done', Object.keys(data.repos).length, 'of', count.size);
