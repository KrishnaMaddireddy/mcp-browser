// The catalog joins the curated list, the registry mirror, live health data
// and the user's on/off switches, and ranks servers for a query (BM25).
import { CURATED } from './curated.js';
import { loadRegistry } from './registry.js';
import { tokenize, splitIdentifier } from './util.js';
import { loadReachability, UNREACHABLE } from './reachability.js';

// A publisher with this many registry servers is a "farm": one per question, weighted down.
const FARM = 300;
/** Registry namespace before the slash: io.github.alice/x → io.github.alice. */
export const publisherOf = (s) => String(s.id || '').split('/')[0].toLowerCase();

// Time phrases say *when*, not *what*: "next week" must not route to Next.js docs.
const TIME_UNITS = 'week|weekend|month|year|quarter|day|days|weeks|months|years|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|night';
const TIME_PHRASE = new RegExp(`\\b(?:next|last|this|coming|past|previous)\\s+(?:${TIME_UNITS})\\b|\\b(?:today|tomorrow|tonight|yesterday)\\b`, 'gi');
/** Query words used for keyword routing (time phrases removed). */
// Halves of compounds that say nothing on their own: solid-STATE, cloud-BASED, real-TIME.
const FILLER_AFTER = /-(?:state|based|time|side|level|free|like|line|end|source|scale|wide|driven|first|ready)\b/gi;
const FILLER_BEFORE = /\b(?:real|high|low|end|on|off|self|well|cross|multi|non)-(?=[a-z])/gi;
const RECENCY = /\b(?:latest|newest|recent(?:ly)?|current(?:ly)?|up-to-date)\b/gi;

export function queryTerms(query) {
  // Short bare numbers ("Next.js 14", "5 miles") say nothing about which server fits;
  // years and codes (2022, 90210) still count. So do "latest" and compound fillers.
  const q = String(query || '').replace(TIME_PHRASE, ' ').replace(RECENCY, ' ').replace(FILLER_AFTER, ' ').replace(FILLER_BEFORE, ' ');
  // ("us" is also a pronoun, and matches every server that mentions the US)
  return tokenize(q).filter((w) => !/^\d{1,3}$/.test(w) && w !== 'us');
}

const K1 = 1.2;
const B = 0.75;

export class Catalog {
  constructor({ health, settings, curated = CURATED, registry, embeddings = null } = {}) {
    this.health = health;
    this.reach = loadReachability();
    this.embeddings = embeddings;
    this.settings = settings;
    this.curated = curated;
    this.registry = registry || loadRegistry();
    this._index = null;
    this._extra = [];
  }

  setSettings(s) {
    if (JSON.stringify(s?.customServers || []) !== JSON.stringify(this.settings?.customServers || [])) this._index = null;
    this.settings = s;
  }
  setRegistry(r) {
    this.registry = r;
    this._index = null;
  }
  /** Extra servers (e.g. user-added or test fixtures). */
  addServers(list) {
    this._extra.push(...list.map((s) => ({ source: 'custom', trust: 'community', tags: [], transport: 'streamable-http', ...s })));
    this._index = null;
  }
  invalidate() {
    this._index = null;
  }

  /** Every known server, deduplicated by URL (curated wins). */
  all() {
    const seen = new Set();
    const out = [];
    const custom = (this.settings?.customServers || []).map((s) => ({ source: 'custom', trust: 'community', tags: [], ...s }));
    // Package servers the user approved to run on this computer (local-servers.js).
    const local = this.local?.servers() || [];
    for (const s of [...this.curated, ...custom, ...local, ...this._extra, ...(this.registry.servers || [])]) {
      const key = s.url.replace(/\/+$/, '').toLowerCase();
      if (seen.has(key) || seen.has('id:' + s.id)) continue;
      seen.add(key);
      seen.add('id:' + s.id);
      out.push(s);
    }
    return out;
  }

  get(id) {
    return this.all().find((s) => s.id === id);
  }

  /** Enabled = curated/custom unless switched off; registry only if switched on or discovery mode. */
  isEnabled(s, discovery = this.settings?.discovery) {
    const o = this.settings?.serverOverrides?.[s.id];
    if (o === false) return false;
    if (s.needsAuth && !this.hasAuth(s)) return false;
    if (s.signIn && !this.isSignedIn(s)) return false;
    if (o === true) return true;
    if (s.needsAuth) return true; // the user added a key: they want it
    if (s.source === 'registry') return Boolean(discovery);
    return true;
  }

  /** Set by the engine (OAuth store); servers marked signIn stay off until then. */
  isSignedIn() {
    return false;
  }

  /**
   * False for registry servers the last probe found dead, sign-in-only, blocked
   * or paid, unless this app has seen them work since (then health says ok).
   */
  reachable(s) {
    if (s.source !== 'registry') return true;
    const probe = this.reach?.servers.get(s.id);
    if (!probe || !UNREACHABLE.has(probe)) return true;
    return this.health?.get(s.id)?.status === 'ok';
  }

  hasAuth(s) {
    const a = this.settings?.serverAuth?.[s.id];
    return Boolean(a && (a.value || a.url));
  }

  _build() {
    const docs = this.all();
    this._pubCount = new Map();
    for (const d of docs) if (d.source === 'registry') this._pubCount.set(publisherOf(d), (this._pubCount.get(publisherOf(d)) || 0) + 1);
    const postings = new Map();
    const lens = new Array(docs.length);
    let total = 0;
    docs.forEach((s, i) => {
      const tools = this.health?.knownTools(s.id) || [];
      const text = [
        s.title, s.title, // title counts double
        (s.tags || []).join(' '), (s.tags || []).join(' '),
        s.description,
        splitIdentifier(s.id.split('/').pop()),
        tools.map((t) => `${splitIdentifier(t.name)} ${t.description}`).join(' ').slice(0, 3000),
      ].join(' ');
      const toks = tokenize(text);
      lens[i] = toks.length;
      total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, n] of tf) {
        let p = postings.get(t);
        if (!p) postings.set(t, (p = []));
        p.push([i, n]);
      }
    });
    this._index = { docs, postings, lens, avg: total / Math.max(1, docs.length), hv: this.health?.version ?? 0, builtAt: Date.now(), byId: new Map(docs.map((d) => [d.id, d])) };
  }

  /** BM25 scores for every server that matches at least one query term. */
  score(query) {
    const stale = this._index && this.health && this._index.hv !== this.health.version && Date.now() - this._index.builtAt > 20_000;
    if (!this._index || stale) this._build();
    const { docs, postings, lens, avg } = this._index;
    const N = docs.length;
    const terms = [...new Set(queryTerms(query))];
    const scores = new Map();
    const matched = new Map();
    for (const t of terms) {
      const p = postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
      for (const [i, n] of p) {
        const s = idf * ((n * (K1 + 1)) / (n + K1 * (1 - B + (B * lens[i]) / avg)));
        scores.set(i, (scores.get(i) || 0) + s);
        if (!matched.has(i)) matched.set(i, []);
        matched.get(i).push(t);
      }
    }
    return [...scores.entries()].map(([i, score]) => ({ server: docs[i], score, terms: matched.get(i) }));
  }

  /**
   * Choose which servers to consult for a query.
   * @returns {{server, score, terms: string[], reason: string}[]}
   */
  route(query, opts = {}, semantic = null) {
    const s = { ...this.settings, ...opts };
    const max = s.maxServers ?? 4;
    const discMax = s.discoveryMax ?? 2;
    // Free mode can't use servers whose tools all need structured input: skip the
    // ones already known to be like that (an AI model can still use them).
    const freeOk = (srv) => !s.freeMode || this.health?.get(srv.id)?.direct !== false;
    const usable = (srv) => this.isEnabled(srv, s.discovery) && (this.health ? this.health.isAvailable(srv.id) : true) && this.reachable(srv) && freeOk(srv);
    const bm = this.score(query);
    const hybrid = Boolean(semantic && semantic.size);

    let cands;
    if (hybrid) {
      // Blend keyword (BM25, normalized to the best hit) and meaning (cosine) scores.
      const bmTop = Math.max(1e-9, ...bm.map((r) => r.score));
      const byId = new Map(bm.map((r) => [r.server.id, r]));
      const ids = new Set([...byId.keys(), ...semantic.keys()]);
      cands = [];
      for (const id of ids) {
        const r = byId.get(id);
        const server = r?.server || this._index.byId.get(id);
        if (!server) continue;
        const cos = semantic.get(id) ?? 0;
        const sem = Math.max(0, Math.min(1, (cos - 0.2) / 0.45));
        const kw = r ? r.score / bmTop : 0;
        // Registry descriptions are short and keyword-noisy, so meaning counts more there.
        const wSem = server.source === 'registry' ? 0.7 : 0.5;
        cands.push({ server, terms: r?.terms || [], sem, cos, score: (1 - wSem) * kw + wSem * sem });
      }
    } else cands = bm.map((r) => ({ ...r, sem: 0 }));

    const ranked = cands
      .filter((r) => usable(r.server))
      .map((r) => {
        let w = 1;
        if (r.server.source === 'curated') w *= 1.4;
        if (this.settings?.serverOverrides?.[r.server.id] === true) w *= 1.5;
        if (this.health?.get(r.server.id)?.status === 'ok') w *= 1.1;
        // MCP Rank: measured quality nudges the choice (0.7× for score 0 … 1.3× for 100).
        const rs = this.rankScores?.get(r.server.id);
        if (rs !== undefined) w *= 0.7 + (0.6 * rs) / 100;
        // What its replies turned out to be here: mostly empty → down to ~0.65×, mostly useful → up to ~1.35×.
        const u = this.health?.usefulness?.(r.server.id);
        if (u != null) w *= 0.6 + 0.8 * u;
        // Free mode: the probe found its tools all need an AI model to fill (and it hasn't
        // been seen working here): rank it well below servers that take a plain question.
        if (s.freeMode && this.reach?.servers.get(r.server.id) === 'needs-ai' && this.health?.get(r.server.id)?.direct !== true) w *= 0.3;
        // It answered this very question with nothing (or off-topic) in the last day: ask others first.
        const last = this.health?.recentFor?.(r.server.id, query);
        if (last && last !== 'ok') w *= 0.2;
        // Server farms (hundreds of near-identical servers from one publisher) count less.
        if (r.server.source === 'registry' && (this._pubCount?.get(publisherOf(r.server)) || 0) >= FARM) w *= 0.75;
        return { ...r, score: r.score * w };
      })
      .sort((a, b) => b.score - a.score);

    const top = ranked[0]?.score || 0;
    // Vetted servers (curated, or added by you) are compared with each other, so a
    // crowd of similarly named registry servers can't push a good one below the bar.
    const vetted = (srv) => srv.source === 'curated' || srv.source === 'custom';
    const topVetted = ranked.find((r) => vetted(r.server))?.score || 0;
    const qTerms = queryTerms(query);
    const nTerms = Math.max(1, new Set(qTerms).size);
    const picked = [];
    let community = 0;
    const perPub = new Map(); // publisher → servers picked, so one publisher can't fill the list
    for (const r of ranked) {
      if (picked.length >= max) break;
      // Drop weak matches: far below the best, or matching a small share of the question
      // (e.g. "state" in "solid-state batteries" hitting a geocoder's "city, state").
      // "Search wider" (s.wide) lowers these bars so the bigger net actually catches more.
      const bar = vetted(r.server) ? topVetted : top;
      if (r.score < bar * (s.wide ? 0.12 : hybrid ? 0.3 : 0.25)) continue;
      const coverage = r.terms.length / nTerms;
      if (!s.wide && r.sem < 0.35 && coverage < 0.3 && r.score < bar * 0.6) continue;
      if (r.server.source === 'registry') {
        if (community >= discMax) continue;
        const pub = publisherOf(r.server);
        const cap = (this._pubCount?.get(pub) || 0) >= FARM ? 1 : 2;
        if ((perPub.get(pub) || 0) >= cap) continue;
        if (hybrid) {
          // Strangers' servers need a clear match in meaning, not just shared words.
          if (r.sem < (s.wide ? 0.25 : 0.35) && !(r.terms.length >= 2 && r.sem >= 0.15)) continue;
        } else if (r.terms.length < Math.min(s.wide ? 1 : 2, qTerms.length) && r.score < top * 0.6) continue;
        community++;
        perPub.set(publisherOf(r.server), (perPub.get(publisherOf(r.server)) || 0) + 1);
      }
      const why = [];
      if (r.terms.length) why.push(`matched: ${r.terms.join(', ')}`);
      if (r.sem > 0.3) why.push(`similar meaning (${r.cos.toFixed(2)})`);
      picked.push({ ...r, reason: why.join('; ') || 'related' });
    }

    if (s.alwaysWebSearch !== false) {
      const generals = this.all().filter((x) => x.general && usable(x));
      const general = generals[0];
      if (general && !picked.some((p) => p.server.id === general.id)) {
        const entry = { server: general, score: 0, terms: [], sem: 0, reason: 'general web search' };
        if (picked.length >= max) picked[picked.length - 1] = entry;
        else picked.push(entry);
      }
      // At most one specialist: a second web search engine gives more (and independent) sources.
      if (picked.filter((p) => !p.server.general).length <= 1 && picked.length < max) {
        const second = generals.find((x) => !picked.some((p) => p.server.id === x.id));
        if (second) picked.push({ server: second, score: 0, terms: [], sem: 0, reason: 'second web search, for more sources' });
      }
    }
    return picked;
  }

  /** Same as route(), adding meaning-based matches when the embedding index is ready. */
  async routeAsync(query, opts = {}) {
    let semantic = null;
    if (this.embeddings?.ready && this.settings?.semanticRouting !== false) {
      const q = await this.embeddings.embedQuery(query);
      // Enough meaning-matches to fill a large "servers per question" setting.
      const want = Math.max(opts.maxServers ?? 0, this.settings?.maxServers ?? 0);
      if (q) semantic = this.embeddings.similarities(q, { top: Math.max(80, want * 3) });
    }
    if (!this._index) this._build();
    return this.route(query, opts, semantic);
  }
}
