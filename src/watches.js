// Watches: saved searches that re-run on a schedule while the app is open and
// report what changed since last time (new sources, a different answer).
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

  add({ query, every = 'daily', discovery = false, label = '' }) {
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
    const changed = !first && !error && (newSources.length > 0 || sim < 0.75);
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
  constructor({ store, agent, intervalMs = 60_000, runTimeoutMs = 5 * 60_000 }) {
    this.store = store;
    this.agent = agent;
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
      const r = await Promise.race([this.agent.search(w.query, { emit, discovery: w.discovery, signal: ac.signal }), timeout]);
      return this.store.record(id, { mode: r.mode, answer: r.answer || '', results, sources: r.sources || [] });
    } catch (e) {
      log.warn('watch failed', errMsg(e));
      return this.store.record(id, { error: errMsg(e).slice(0, 200) });
    } finally {
      clearTimeout(timer);
      if (this.store.get(id)) this.store.get(id).running = false;
    }
  }
}
