// Pipelines: MCP servers working together. Each step is a question to one or more
// servers; a step can use what the step before found:
//   {input}          what you typed when you ran the pipeline
//   {answer}         the step before's answer (quick answer in free mode)
//   {titles}         the titles the step before found, comma-separated
// and a "for each" step runs once per result of the step before, with
//   {title} {url} {host}   that result.
// Loops: a pipeline can run on a schedule (watches.js) and stop when its result
// says something ("until"). Every step goes through the normal search, so the
// same safety rules apply (write tools hidden, results treated as untrusted).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';

const MAX_STEPS = 5;
const MAX_EACH = 5;

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Starter pipelines: real cross-server chains that work in free mode. */
export const STARTERS = [
  {
    id: 'papers-to-code',
    title: 'Papers, then code for each',
    description: 'Find recent papers on a topic, then look for an implementation or discussion of each paper.',
    input: { label: 'Research topic', example: 'retrieval augmented generation evaluation' },
    steps: [
      { ask: '{input}', servers: ['io.github.MCPServings/paper-mcp'], max: 4 },
      { ask: '{title} code implementation github', each: true, servers: ['keenable'] },
    ],
  },
  {
    id: 'news-full-story',
    title: 'Headlines, then the full story',
    description: 'Get the latest headlines on a topic, then more coverage of each headline from other sources.',
    input: { label: 'Topic', example: 'Federal Reserve interest rates' },
    steps: [
      { ask: 'latest news about {input}', servers: ['keenable'], max: 3 },
      { ask: '{title}', each: true, servers: ['exa', 'tanod-web'] },
    ],
  },
  {
    id: 'company-brief',
    title: 'Company brief',
    description: 'Stock quote, what the company is, and the latest news, side by side.',
    input: { label: 'Company', example: 'Nvidia' },
    steps: [
      { ask: '{input} stock price today', servers: ['marketcrew'] },
      { ask: '{input} company', servers: ['wikexa'] },
      { ask: 'latest news about {input}', servers: ['keenable'] },
    ],
  },
  {
    id: 'repo-explained',
    title: 'Understand a GitHub repo',
    description: 'How a repository works, then what people are saying about it.',
    input: { label: 'GitHub repo (owner/name)', example: 'vllm-project/vllm' },
    steps: [
      { ask: '{input} github how it works architecture', servers: ['keenable', 'deepwiki'] },
      { ask: '{input} discussion problems', servers: ['keenable'] },
    ],
  },
  {
    id: 'library-upgrade',
    title: 'Upgrade a library',
    description: 'The official upgrade guide, then problems other people ran into.',
    input: { label: 'Library and versions', example: 'Next.js 14 to 15' },
    steps: [
      { ask: 'how to upgrade {input}', servers: ['context7'] },
      { ask: '{input} upgrade breaking changes problems', servers: ['keenable'] },
    ],
  },
  {
    id: 'health-evidence',
    title: 'A treatment: studies, then trials',
    description: 'Published studies on a treatment, then clinical trials and news about each study topic.',
    input: { label: 'Treatment or condition', example: 'metformin longevity' },
    steps: [
      { ask: '{input}', servers: ['pubmed-community'], max: 3 },
      { ask: '{title}', each: true, servers: ['keenable'] },
    ],
  },
];

// The pipeline library: tested pipelines by topic (src/data/pipeline-library.json, built
// by running each one end to end in free mode). Topics, in the order the page shows them.
export const TOPICS = [
  ['featured', 'Featured'],
  ['finance', 'Money & markets'],
  ['science', 'Health, science & law'],
  ['travel', 'Travel, places & media'],
  ['business', 'Business & marketing'],
  ['developer', 'Developers & data'],
  ['security', 'Security & web checks'],
  ['learning', 'Learning & work'],
  ['everyday', 'Everyday life'],
];
const LIBRARY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'pipeline-library.json');
let library = null;
/** Tested pipelines with their topic and when they last passed; the starters are "featured". */
export function loadLibrary(file = LIBRARY_FILE) {
  if (library && file === LIBRARY_FILE) return library;
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const topics = new Set(TOPICS.map((t) => t[0]));
  const out = [...STARTERS.map((p) => ({ ...p, category: 'featured' }))];
  const seen = new Set(out.map((p) => p.id));
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const p = cleanPipeline(raw);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ ...p, category: topics.has(raw.category) ? raw.category : 'everyday', ...(raw.tested ? { tested: { on: String(raw.tested.on || '').slice(0, 10), ms: Number(raw.tested.ms) || 0 } } : {}) });
    } catch {}
  }
  if (file === LIBRARY_FILE) library = out;
  return out;
}

/** A pipeline from outside (the app, a saved file): checked and trimmed. */
export function cleanPipeline(p) {
  if (!p || typeof p !== 'object') throw new Error('not a pipeline');
  const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, MAX_STEPS).map((s, i) => {
    const ask = String(s?.ask || '').trim().slice(0, 300);
    if (!ask) throw new Error(`step ${i + 1} has no question`);
    return {
      ask,
      ...(i > 0 && s.each ? { each: true } : {}),
      ...(Array.isArray(s.servers) && s.servers.length ? { servers: s.servers.slice(0, 3).map((x) => String(x).slice(0, 200)) } : {}),
      ...(Number(s.max) > 0 ? { max: Math.min(MAX_EACH, Math.floor(Number(s.max))) } : {}),
    };
  });
  if (!steps.length) throw new Error('a pipeline needs at least one step');
  return {
    id: String(p.id || crypto.randomBytes(5).toString('hex')).replace(/[^\w-]/g, '').slice(0, 40),
    title: String(p.title || 'My pipeline').trim().slice(0, 100),
    description: String(p.description || '').trim().slice(0, 300),
    input: { label: String(p.input?.label || 'Input').slice(0, 60), example: String(p.input?.example || '').slice(0, 120) },
    steps,
  };
}

/** Fill {input} {answer} {titles} {title} {url} {host}; values are flattened to one line. */
export function fill(template, vars) {
  return String(template)
    .replace(/\{(input|answer|titles|title|url|host)\}/g, (m, k) => String(vars[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, k === 'answer' ? 200 : 160))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Run a pipeline. emit(type, data): pipe_step { i, total, each, runs }, pipe_run { i, j, q, item },
 * pipe_result { i, j, q, item, answer, sources, servers }, pipe_done { ms }.
 * resolveServers(ids) → { servers, adhoc } for agent.search.
 */
export async function runPipeline(agent, p, { input = '', emit = () => {}, signal, resolveServers = (ids) => ({ servers: ids }) } = {}) {
  const t0 = Date.now();
  const out = [];
  let items = [];
  let answer = '';
  for (let i = 0; i < p.steps.length; i++) {
    const st = p.steps[i];
    const each = st.each ? items.slice(0, st.max || 3) : [null];
    emit('pipe_step', { i, total: p.steps.length, each: Boolean(st.each), runs: each.length });
    if (st.each && !items.length) {
      emit('pipe_result', { i, j: 0, q: '', item: null, answer: '', sources: [], servers: [], note: 'The step before found nothing to go through.' });
      out.push({ i, runs: [] });
      break;
    }
    const runs = [];
    const found = [];
    for (let j = 0; j < each.length; j++) {
      if (signal?.aborted) throw new Error('stopped');
      const item = each[j];
      const q = fill(st.ask, { input, answer, titles: items.map((x) => x.title).join(', '), ...(item || {}) });
      emit('pipe_run', { i, j, q, item });
      const servers = [];
      const listed = []; // the items each server returned, best server first
      const details = []; // what a server said when it wasn't a list of links (a quote, a rating, a record)
      let quick = null;
      const sub = (type, d) => {
        if (type === 'results' && (d.kind || 'ok') === 'ok' && !d.offTopic && !d.isError) {
          servers.push(d.serverTitle);
          const linked = (d.view?.kind === 'items' ? d.view.items : []).filter((it) => it?.url && it.title);
          for (const it of linked) listed.push({ title: String(it.title).slice(0, 200), url: it.url, host: hostOf(it.url), score: d.score || 0 });
          if (!linked.length && details.length < 2) {
            const d2 = detailOf(d.view, d.text);
            if (d2) details.push({ server: d.serverTitle, ...d2 });
          }
        }
        if (type === 'quick_answer') quick = d;
      };
      let r = { answer: '', sources: [] };
      try {
        r = await agent.search(q, { emit: sub, signal, ...(st.servers?.length ? resolveServers(st.servers) : {}) });
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      const text = r.answer || r.quickAnswer?.text || quick?.text || '';
      // Items the servers listed (paper, article, repo…) come first; other links found in replies after.
      listed.sort((a, b) => b.score - a.score);
      const seenU = new Set();
      const sources = [...listed, ...(r.sources || []).filter((s) => s?.url && s.title && s.title !== hostOf(s.url)).map((s) => ({ title: String(s.title).slice(0, 200), url: s.url, host: hostOf(s.url) }))]
        // the same link, or the same headline from two places, once
        .filter((s) => {
          const k = s.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
          if (seenU.has(s.url) || seenU.has(k)) return false;
          seenU.add(s.url);
          seenU.add(k);
          return true;
        })
        .slice(0, 8)
        .map(({ title, url, host }) => ({ title, url, host }));
      const run = { q, item, answer: text.slice(0, 2000), sources, servers: [...new Set(servers)], ...(details.length ? { details } : {}) };
      runs.push(run);
      emit('pipe_result', { i, j, ...run });
      found.push(...sources.slice(0, st.max || 5));
      if (text) answer = text;
    }
    // What the next step can go through: this step's results, each link once.
    const seen = new Set();
    items = found.filter((s) => !seen.has(s.url) && seen.add(s.url));
    out.push({ i, runs });
  }
  emit('pipe_done', { ms: Date.now() - t0 });
  return { steps: out };
}

/**
 * A short, readable form of a reply that isn't a list of links: a record's title and
 * first facts, a table's first rows, or the start of the text. Null when there's nothing.
 */
export function detailOf(view, text) {
  const cut = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (view?.kind === 'record' && view.facts?.length) return { title: cut(view.title, 120), facts: view.facts.slice(0, 6).map((f) => ({ label: cut(f.label, 40), value: cut(f.value, 120) })) };
  if (view?.kind === 'table' && view.rows?.length) return { title: '', facts: view.rows.slice(0, 4).map((r) => ({ label: cut(r[0], 40), value: cut(r.slice(1).join(' · '), 120) })) };
  if (view?.kind === 'items' && view.items?.length) return { title: '', facts: view.items.slice(0, 4).map((it) => ({ label: cut(it.title, 60), value: cut(it.text || (it.facts || []).map((f) => `${f.label}: ${f.value}`).join(', '), 140) })) };
  const t = cut(view?.text || text, 300);
  return t.length >= 20 ? { title: '', text: t } : null;
}

/** One line per result, for watches ("what changed") and "until" checks. */
export function pipelineText(result) {
  return result.steps
    .flatMap((s) => s.runs.map((r) => [r.q, r.answer, ...r.sources.map((x) => `${x.title} ${x.url}`), ...(r.details || []).map((d) => [d.title, d.text, ...(d.facts || []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join(' '))].filter(Boolean).join('\n')))
    .join('\n\n');
}

/** Pipelines you saved (pipelines.json in the data dir). */
export class PipelineStore {
  constructor({ file = path.join(dataDir(), 'pipelines.json') } = {}) {
    this.file = file;
    this.list = [];
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.pipelines)) this.list = d.pipelines;
    } catch {
      /* none yet */
    }
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ pipelines: this.list }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  put(p) {
    const c = cleanPipeline(p);
    if (STARTERS.some((s) => s.id === c.id)) c.id = crypto.randomBytes(5).toString('hex');
    this.list = [...this.list.filter((x) => x.id !== c.id), c].slice(-50);
    this.save();
    return c;
  }
  remove(id) {
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
  }
}
