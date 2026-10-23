// Watches: saved searches that re-run on a schedule while the app is open and
// report what changed since last time (new sources, a different answer).
import { runPipeline, pipelineText } from './pipelines.js';
import { figureIn, thresholdMet, saysItHappened, saidPattern, plausibleReading } from './track.js';
import { runDeps } from './deps.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';
import { errMsg, log, tokenize } from './util.js';

export const EVERY = { hourly: 3600_000, daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000 };
const MAX_WATCHES = 50;
const MAX_HISTORY = 12;
const MAX_SEEN = 600;

/** How similar two texts are by vocabulary (0–1). */
export function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Catalog servers a watch may ask without syncing: hosted HTTPS, no key, one of its servers. */
export function cleanAdhoc(adhoc, servers = []) {
  return (Array.isArray(adhoc) ? adhoc : [])
    .slice(0, 5)
    .filter((a) => a && typeof a === 'object' && servers.includes(String(a.id)) && /^https:\/\/[^\s{}]+$/i.test(String(a.url || '')) && String(a.url).length < 500)
    .map((a) => ({ id: String(a.id).slice(0, 200), title: String(a.title || a.id).slice(0, 120), description: String(a.description || '').slice(0, 400), url: String(a.url), transport: a.transport === 'sse' ? 'sse' : 'streamable-http', source: 'registry', trust: 'community', tags: [] }));
}


export class WatchStore {
  constructor({ file = path.join(dataDir(), 'watches.json'), now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.list = [];
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.watches)) this.list = d.watches;
    } catch {
      /* none yet */
    }
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ watches: this.list }, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /** Save, but never throw from the background scheduler (a full disk shouldn't crash the app). */
  trySave() {
    try {
      this.save();
      return true;
    } catch (e) {
      log.warn('could not save watches:', errMsg(e));
      return false;
    }
  }

  get(id) {
    return this.list.find((w) => w.id === id);
  }

  add({ query, every = 'daily', discovery = false, label = '', servers, adhoc, group = '', pipeline, input = '', until = '', pipeAdhoc, when, untilAbout, deps }) {
    // Packages to re-check for new advisories: names and versions only.
    const pkgs = (Array.isArray(deps) ? deps : [])
      .slice(0, 150)
      .map((p) => ({ name: String(p?.name || '').slice(0, 214), version: p?.version ? String(p.version).slice(0, 40) : null, ecosystem: String(p?.ecosystem || '') }))
      .filter((p) => /^[@\w][\w.@/-]*$/.test(p.name) && ['npm', 'pypi', 'cargo'].includes(p.ecosystem) && (!p.version || /^[\w.+-]+$/.test(p.version)));
    if (pkgs.length && !String(query || '').trim()) query = `Dependencies: ${pkgs.slice(0, 4).map((p) => p.name).join(', ')}${pkgs.length > 4 ? ` +${pkgs.length - 4}` : ''}`;
    query = String(query || '').trim().slice(0, 2000);
    if (!query) throw new Error('query required');
    if (!EVERY[every]) throw new Error('every must be hourly, daily or weekly');
    if (this.list.length >= MAX_WATCHES) throw new Error(`you can keep up to ${MAX_WATCHES} watches`);
    const w = {
      id: crypto.randomBytes(6).toString('hex'),
      query,
      label: String(label || '').trim().slice(0, 200),
      every,
      discovery: Boolean(discovery),
      // Ask these servers (ids) instead of routing; adhoc = catalog servers not synced yet.
      ...(Array.isArray(servers) && servers.length ? { servers: servers.slice(0, 10).map(String) } : {}),
      ...(Array.isArray(adhoc) && adhoc.length ? { adhoc: cleanAdhoc(adhoc, servers) } : {}),
      // Watches made from one workflow share a group (its title).
      ...(group ? { group: String(group).trim().slice(0, 120) } : {}),
      // A pipeline on a schedule (pipelines.js); "until": stop once its result says this.
      ...(pipeline ? { pipeline, input: String(input || '').slice(0, 200), ...(pipeAdhoc && Array.isArray(pipeAdhoc) ? { pipeAdhoc: cleanAdhoc(pipeAdhoc, pipeAdhoc.map((a) => a?.id)) } : {}) } : {}),
      ...(String(until || '').trim() ? { until: String(until).trim().slice(0, 120) } : {}),
      // "Tell me when it happened": the words that say so (built from the word, never sent in),
      // in a sentence naming the thing (plain words only).
      ...(Array.isArray(untilAbout) && untilAbout.length && saidPattern(String(until || '').trim().toLowerCase())
        ? { untilRe: saidPattern(String(until).trim().toLowerCase()), untilAbout: untilAbout.slice(0, 6).map((w) => String(w).toLowerCase().slice(0, 40)).filter((w) => /^[\p{L}\p{N}]+$/u.test(w)) }
        : {}),
      ...(pkgs.length ? { deps: pkgs } : {}),
      // A threshold on the answer's figure: { op: 'below' | 'above' | 'reach', value, unit? }.
      ...(when && ['below', 'above', 'reach'].includes(when.op) && Number.isFinite(Number(when.value)) ? { when: { op: when.op, value: Number(when.value), ...(when.unit === '%' ? { unit: '%' } : {}) } } : {}),
      createdAt: this.now(),
      nextRunAt: this.now(), // first run as soon as the scheduler ticks
      lastRun: null,
      history: [],
      seenUrls: [],
      unseen: 0,
      running: false,
    };
    this.list.push(w);
    this.save();
    return w;
  }

  update(id, patch) {
    const w = this.get(id);
    if (!w) throw new Error('unknown watch');
    if (patch.every !== undefined) {
      if (!EVERY[patch.every]) throw new Error('every must be hourly, daily or weekly');
      w.every = patch.every;
      w.nextRunAt = (w.lastRun?.at || this.now()) + EVERY[w.every];
    }
    if (patch.label !== undefined) w.label = String(patch.label).trim().slice(0, 200);
    if (patch.seen) w.unseen = 0;
    if (Number.isFinite(Number(patch.notifiedAt)) && Number(patch.notifiedAt) > (w.notifiedAt || 0)) w.notifiedAt = Math.min(Number(patch.notifiedAt), this.now());
    this.save();
    return w;
  }

  remove(id) {
    const n = this.list.length;
    this.list = this.list.filter((w) => w.id !== id);
    if (this.list.length === n) throw new Error('unknown watch');
    this.save();
  }

  due() {
    const t = this.now();
    return this.list.filter((w) => !w.running && w.nextRunAt <= t);
  }

  /** Record a finished run and work out what changed. */
  record(id, { mode, answer = '', results = [], sources = [], error = null }) {
    const w = this.get(id);
    if (!w) return null;
    const at = this.now();
    const seen = new Set(w.seenUrls);
    // Baseline = first *successful* run (a failed first run must not count).
    const first = !w.lastRun || w.lastRun.text == null;
    const newSources = error ? [] : sources.filter((s) => s?.url && !seen.has(s.url)).map((s) => ({ url: s.url, title: s.title || '' }));
    // For written answers compare the text; for raw results compare each server's output.
    const text = mode === 'llm' ? answer : results.map((r) => `${r.serverTitle}\n${r.text}`).join('\n\n');
    const prevText = w.lastRun?.text || '';
    const sim = first || error ? 1 : similarity(prevText, text);
    // A watch that waits for one thing (a price line, a release) only has news when that happens.
    const alertOnly = Boolean(w.when || w.untilRe);
    const changed = !alertOnly && !first && !error && (newSources.length > 0 || sim < 0.75);
    for (const s of newSources) seen.add(s.url);
    w.seenUrls = [...seen].slice(-MAX_SEEN);
    w.lastRun = error
      ? { ...(w.lastRun || {}), at, error }
      : { at, mode, answer: answer.slice(0, 20000), text: text.slice(0, 40000), sources: sources.slice(0, 40), error: null, similarity: Math.round(sim * 100) / 100 };
    const entry = { at, changed, first, error, newSources: newSources.slice(0, 20), similarity: Math.round(sim * 100) / 100 };
    w.history = [entry, ...w.history].slice(0, MAX_HISTORY);
    if (changed) w.unseen += 1;
    w.nextRunAt = at + EVERY[w.every];
    this.trySave();
    return entry;
  }

  /** Public view: no internal fields. */
  view(w) {
    const { seenUrls, ...rest } = w;
    if (rest.lastRun) {
      const { text, ...lr } = rest.lastRun;
      rest.lastRun = lr;
    }
    return rest;
  }
}

/**
 * Runs watches one at a time while the app is open. Scheduled runs, "Run now"
 * and the first run after adding all go through one queue.
 */
export class WatchScheduler {
  constructor({ store, agent, callTool = null, intervalMs = 60_000, runTimeoutMs = 5 * 60_000 }) {
    this.store = store;
    this.agent = agent;
    this.callTool = callTool;
    this.intervalMs = intervalMs;
    this.runTimeoutMs = runTimeoutMs;
    this.timer = null;
    this.queue = Promise.resolve();
    this.queued = new Set();
  }

  start() {
    // Runs that were interrupted by a restart are re-run.
    for (const w of this.store.list) w.running = false;
    const safeTick = () => this.tick().catch((e) => log.warn('watch tick failed', errMsg(e)));
    this.timer = setInterval(safeTick, this.intervalMs);
    this.timer.unref?.();
    setTimeout(safeTick, 5000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Queue every due watch. */
  async tick() {
    await Promise.all(this.store.due().map((w) => this.run(w.id)));
  }

  /** Queue one watch (no-op if it is already queued or running). Resolves when it has run. */
  run(id) {
    const w = this.store.get(id);
    if (!w || w.running || this.queued.has(id)) return Promise.resolve(null);
    this.queued.add(id);
    const job = this.queue.then(() => this._run(id)).finally(() => this.queued.delete(id));
    this.queue = job.catch(() => {});
    return job.catch((e) => {
      log.warn('watch run failed', errMsg(e));
      return null;
    });
  }

  /** Loops: once the result says what you were waiting for, stop running and flag it. */
  _until(w, text) {
    if (!w.until || w.met) return;
    let snippet;
    if (w.untilRe) {
      // (always the server's own pattern for the word, whatever an older file holds)
      const re = saidPattern(String(w.until).toLowerCase());
      if (!re) return;
      snippet = saysItHappened(text, re, w.untilAbout || []);
      if (!snippet) return;
    } else {
      const i = String(text).toLowerCase().indexOf(w.until.toLowerCase());
      if (i < 0) return;
      snippet = String(text).slice(Math.max(0, i - 80), i + w.until.length + 120).replace(/\s+/g, ' ').trim();
    }
    w.met = { at: this.store.now(), snippet };
    w.nextRunAt = Number.MAX_SAFE_INTEGER;
    w.unseen = (w.unseen || 0) + 1;
    this.store.save();
  }

  /** "Tell me when it drops below 200": the answer's figure, checked against the line. */
  _threshold(w, answer) {
    if (!w.when || w.met) return;
    const value = figureIn(answer, { unit: w.when.unit });
    // A figure far from the last reading is a misread or a stale page: noted, not acted on.
    if (value == null || !plausibleReading(value, w.lastValue?.value)) {
      w.lastMiss = { at: this.store.now(), text: String(answer).slice(0, 200), value: value ?? null };
      this.store.trySave();
      return;
    }
    // "reaches 300": toward the line from the first reading
    if (w.when.op === 'reach') w.when = { ...w.when, op: value < w.when.value ? 'above' : 'below', reach: true };
    w.lastValue = { value, at: this.store.now(), text: String(answer).slice(0, 200) };
    delete w.lastMiss;
    if (thresholdMet(w.when, value) || (w.when.reach && value === w.when.value)) {
      w.met = { at: this.store.now(), snippet: String(answer).slice(0, 240), value };
      w.nextRunAt = Number.MAX_SAFE_INTEGER;
      w.unseen = (w.unseen || 0) + 1;
    }
    this.store.trySave();
  }

  async _run(id) {
    const w = this.store.get(id);
    if (!w) return null;
    w.running = true;
    const results = [];
    const ac = new AbortController();
    let timer;
    try {
      const emit = (type, d) => {
        // Empty replies and sales pitches are not news: only useful results are compared.
        if (type === 'results' && !d.isError && (d.kind || 'ok') === 'ok') results.push({ serverTitle: d.serverTitle, text: String(d.text || '').slice(0, 8000) });
      };
      // A search that hangs (a stuck server or model) is cut off so later watches still run.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error('the search took longer than 5 minutes'));
        }, this.runTimeoutMs);
      });
      // Packages: each advisory is a source, so a new one is news.
      if (w.deps) {
        if (!this.callTool) throw new Error('dependency checks are not available here');
        const rows = [];
        await Promise.race([runDeps(w.deps, { callTool: (id, tool, args) => this.callTool(id, tool, args, { signal: ac.signal }), emit: (t, d) => t === 'deps_row' && rows.push(d) }), timeout]);
        const sources = rows.flatMap((r) => r.vulns.map((v) => ({ url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`, title: `${r.name} ${r.version}: ${v.summary || v.id}`.slice(0, 200) })));
        const text = rows.map((r) => `${r.name} ${r.version || ''}: ${r.vulns.length ? r.vulns.map((v) => v.id).join(', ') : r.counts.audit ? `${r.counts.audit} known` : 'none known'}${r.deprecated ? ' (deprecated)' : ''}`).join('\n');
        return this.store.record(id, { mode: 'llm', answer: text, results: [], sources });
      }
      if (w.pipeline) {
        const resolveServers = (ids) => ({ servers: ids, adhoc: (w.pipeAdhoc || []).filter((a) => ids.includes(a.id)) });
        const r = await Promise.race([runPipeline(this.agent, w.pipeline, { input: w.input || '', signal: ac.signal, resolveServers }), timeout]);
        const text = pipelineText(r);
        const sources = r.steps.flatMap((s) => s.runs.flatMap((x) => x.sources));
        const rec = this.store.record(id, { mode: 'llm', answer: text, results: [], sources });
        this._until(w, text);
        return rec;
      }
      const r = await Promise.race([this.agent.search(w.query, { emit, discovery: w.discovery, signal: ac.signal, servers: w.servers, adhoc: w.adhoc }), timeout]);
      const rec = this.store.record(id, { mode: r.mode, answer: r.answer || '', results, sources: r.sources || [] });
      this._until(w, [r.answer || '', ...results.map((x) => x.text)].join('\n'));
      this._threshold(w, r.quickAnswer?.text || r.answer || '');
      return rec;
    } catch (e) {
      log.warn('watch failed', errMsg(e));
      return this.store.record(id, { error: errMsg(e).slice(0, 200) });
    } finally {
      clearTimeout(timer);
      if (this.store.get(id)) this.store.get(id).running = false;
    }
  }
}
