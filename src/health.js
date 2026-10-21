// Remembers which servers answered, how fast, and what tools they offer.
// Failing servers are skipped for a back-off period so one dead entry in the
// registry doesn't cost every query a 10-second timeout.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { tokenize } from './util.js';

const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 3600_000, 24 * 3600_000];
const TOOL_CACHE_MS = 7 * 24 * 3600_000;

export class HealthStore {
  constructor({ file = path.join(dataDir(), 'health.json'), now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.map = new Map();
    this.version = 0; // bumps when a tool list changes (catalog re-indexes)
    this._timer = null;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(d)) this.map.set(k, v);
    } catch {
      /* first run */
    }
  }
  get(id) {
    return this.map.get(id);
  }
  recordOk(id, { latencyMs, tools, serverName }) {
    const prevTools = JSON.stringify((this.map.get(id)?.tools || []).map((t) => t.name));
    if (prevTools !== JSON.stringify((tools || []).slice(0, 100).map((t) => t.name))) this.version++;
    const prev = this.map.get(id);
    const outcomes = prev?.outcomes;
    this.map.set(id, {
      status: 'ok',
      checkedAt: this.now(),
      latencyMs,
      failCount: 0,
      serverName,
      ...(outcomes ? { outcomes } : {}),
      // A changed tool list may add a usable search tool: re-learn it.
      ...(prev?.direct !== undefined && prevTools === JSON.stringify((tools || []).slice(0, 100).map((t) => t.name)) ? { direct: prev.direct } : {}),
      tools: (tools || []).slice(0, 100).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 300) })),
    });
    this._save();
  }
  recordFail(id, error) {
    const prev = this.map.get(id) || {};
    this.map.set(id, {
      ...prev,
      status: 'fail',
      checkedAt: this.now(),
      failCount: (prev.failCount || 0) + 1,
      error: String(error || '').slice(0, 300),
    });
    this._save();
  }
  /**
   * What a server's replies turned out to be: useful ('ok'), 'empty' or an
   * 'ad'. Counts are halved past 40 so recent behaviour weighs more.
   */
  /** kind: ok | empty | ad | off (answered, but about something else than the question). */
  recordOutcome(id, kind) {
    if (!['ok', 'empty', 'ad', 'off'].includes(kind)) return;
    const e = this.map.get(id) || {};
    const o = { ok: 0, empty: 0, ad: 0, off: 0, ...(e.outcomes || {}) };
    o[kind]++;
    if (o.ok + o.empty + o.ad + o.off > 40) for (const k of ['ok', 'empty', 'ad', 'off']) o[k] = Math.floor(o[k] / 2);
    this.map.set(id, { ...e, outcomes: o });
    this._save();
  }
  /** Whether a server has a tool free mode can call with just the question. */
  markDirect(id, usable) {
    const e = this.map.get(id);
    if (!e || e.direct === usable) return;
    this.map.set(id, { ...e, direct: usable });
    this._save();
  }
  /** Share of useful replies, smoothed (no history → null). */
  /**
   * What this server answered to this very question lately (a day): routing
   * stops asking it the same thing when it came back empty or off-topic.
   */
  recordAnswer(id, query, kind) {
    const key = questionKey(query);
    if (!key || !['ok', 'empty', 'ad', 'off'].includes(kind)) return;
    const e = this.map.get(id) || {};
    const recent = { ...(e.recent || {}), [key]: [kind, Date.now()] };
    const keys = Object.keys(recent);
    if (keys.length > 30) for (const k of keys.sort((a, b) => recent[a][1] - recent[b][1]).slice(0, keys.length - 30)) delete recent[k];
    this.map.set(id, { ...e, recent });
    this._save();
  }
  recentFor(id, query) {
    const r = this.map.get(id)?.recent?.[questionKey(query)];
    return r && Date.now() - r[1] < 24 * 3600_000 ? r[0] : null;
  }
  usefulness(id) {
    const o = this.map.get(id)?.outcomes;
    if (!o) return null;
    return (o.ok + 1) / (o.ok + o.empty + o.ad + (o.off || 0) + 2);
  }
  /** A tool answered "payment / API key required": treat like a failure. */
  recordPaywall(id) {
    this.recordFail(id, 'needs payment or an API key');
    const h = this.map.get(id);
    h.paywalled = true;
    h.failCount = Math.max(h.failCount, BACKOFF_MS.length); // longest back-off
  }
  /** False while a failing server is inside its back-off window. */
  isAvailable(id) {
    const h = this.map.get(id);
    if (!h || h.status !== 'fail') return true;
    const wait = BACKOFF_MS[Math.min(h.failCount - 1, BACKOFF_MS.length - 1)];
    return this.now() - h.checkedAt > wait;
  }
  /** Last known tool list, used as routing vocabulary (null if never seen). */
  knownTools(id) {
    const h = this.map.get(id);
    return h?.tools?.length ? h.tools : null;
  }
  /** True when a successful check is recent enough to trust without re-probing. */
  isFresh(id) {
    const h = this.map.get(id);
    return Boolean(h && h.status === 'ok' && this.now() - h.checkedAt < TOOL_CACHE_MS);
  }
  summary() {
    let ok = 0;
    let fail = 0;
    for (const v of this.map.values()) {
      if (v.status === 'ok') ok++;
      else if (v.status === 'fail') fail++; // entries with only outcome counts are neither
    }
    return { ok, fail };
  }
  _save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 1000);
    this._timer.unref?.();
  }
  flush() {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {
      /* non-fatal */
    }
  }
}

/** The same question however it's worded: its words, sorted ("Weather in Seattle?" = "seattle weather"). */
function questionKey(query) {
  return [...new Set(tokenize(query))].sort().join(' ').slice(0, 200);
}
