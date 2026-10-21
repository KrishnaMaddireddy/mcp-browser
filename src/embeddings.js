// Semantic routing: a small local embedding model (all-MiniLM-L6-v2, ~23 MB,
// runs on CPU) turns every server description into a vector, so "will it rain
// in Paris" finds weather servers even with no shared keyword.
// Optional: if @huggingface/transformers isn't installed or the model can't be
// downloaded, routing silently stays keyword-only (BM25).
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { errMsg, log, splitIdentifier } from './util.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const BATCH = 128;

/** Text that describes a server for embedding. */
export function serverText(s, tools) {
  const t = (tools || []).slice(0, 12).map((x) => splitIdentifier(x.name)).join(', ');
  // Tags are keyword bait for BM25; they blur the meaning vector, so leave them out.
  return [s.title, s.description || (s.tags || []).join(' '), t].filter(Boolean).join('. ').slice(0, 1000);
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export class EmbeddingIndex {
  /** @param {{embedder?: (texts: string[]) => Promise<Float32Array[]>, dir?: string}} o  embedder is injectable for tests */
  constructor({ embedder, dir = dataDir() } = {}) {
    this.dir = dir;
    this.customEmbedder = embedder;
    this.ids = [];
    this.hashes = [];
    this.vecs = new Int8Array(0); // int8-quantized, normalized vectors
    this.pos = new Map();
    this.state = { status: 'idle', done: 0, total: 0, error: null };
    this._pipe = null;
    this._building = null;
    this._load();
  }

  get ready() {
    return this.ids.length > 0;
  }

  async _embedder() {
    if (this.customEmbedder) return this.customEmbedder;
    if (!this._pipe) {
      this._pipe = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = path.join(this.dir, 'models');
        const ex = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        return async (texts) => {
          const out = await ex(texts, { pooling: 'mean', normalize: true });
          return texts.map((_, i) => out.data.subarray(i * DIM, (i + 1) * DIM));
        };
      })();
      this._pipe.catch(() => (this._pipe = null));
    }
    return this._pipe;
  }

  /** Embed one query (normalized Float32Array), or null if unavailable. */
  async embedQuery(text) {
    try {
      const fn = await this._embedder();
      return (await fn([String(text).slice(0, 1000)]))[0];
    } catch (e) {
      if (this.state.status !== 'unavailable') log.info('semantic routing unavailable:', errMsg(e));
      this.state = { ...this.state, status: 'unavailable', error: errMsg(e) };
      return null;
    }
  }

  /** Cosine similarity of q with every indexed server: Map id → score. */
  similarities(q, { min = 0.25, top = 80 } = {}) {
    const out = [];
    const n = this.ids.length;
    const v = this.vecs;
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const o = i * DIM;
      for (let k = 0; k < DIM; k++) dot += q[k] * v[o + k];
      dot /= 127;
      if (dot >= min) out.push([this.ids[i], dot]);
    }
    out.sort((a, b) => b[1] - a[1]);
    return new Map(out.slice(0, top));
  }

  /**
   * (Re)build vectors for these servers, reusing cached ones whose text is
   * unchanged. Safe to call repeatedly; concurrent calls share one build.
   */
  build(servers, toolsFor = () => null) {
    if (this._building) {
      // A newer server list arrived mid-build: run once more with it afterwards.
      this._next = { servers, toolsFor };
      return this._building.then(() => this._building || this.state);
    }
    this._building = this._build(servers, toolsFor).finally(() => {
      this._building = null;
      const next = this._next;
      this._next = null;
      if (next) this.build(next.servers, next.toolsFor);
    });
    return this._building;
  }

  async _build(servers, toolsFor) {
    const items = servers.map((s) => {
      const text = serverText(s, toolsFor(s.id));
      return { id: s.id, text, h: hash(text) };
    });
    const old = new Map(this.ids.map((id, i) => [id, i]));
    const todo = items.filter((it) => {
      const i = old.get(it.id);
      return i === undefined || this.hashes[i] !== it.h;
    });
    this.state = { status: 'building', done: items.length - todo.length, total: items.length, error: null };
    let fn;
    try {
      fn = await this._embedder();
    } catch (e) {
      this.state = { ...this.state, status: 'unavailable', error: errMsg(e) };
      return this.state;
    }
    const fresh = new Map();
    try {
      for (let b = 0; b < todo.length; b += BATCH) {
        const chunk = todo.slice(b, b + BATCH);
        const vecs = await fn(chunk.map((c) => c.text));
        chunk.forEach((c, i) => fresh.set(c.id, quantize(vecs[i])));
        this.state.done += chunk.length;
        await new Promise((r) => setImmediate(r)); // keep the server responsive
      }
    } catch (e) {
      // Keep whatever index we had; routing falls back to keywords for new servers.
      this.state = { ...this.state, status: this.ready ? 'ready' : 'unavailable', error: errMsg(e) };
      return this.state;
    }
    const vecs = new Int8Array(items.length * DIM);
    items.forEach((it, i) => {
      const f = fresh.get(it.id);
      if (f) vecs.set(f, i * DIM);
      else {
        const j = old.get(it.id);
        vecs.set(this.vecs.subarray(j * DIM, (j + 1) * DIM), i * DIM);
      }
    });
    this.ids = items.map((i) => i.id);
    this.hashes = items.map((i) => i.h);
    this.vecs = vecs;
    this._save();
    this.state = { status: 'ready', done: items.length, total: items.length, error: null };
    return this.state;
  }

  _files() {
    return { meta: path.join(this.dir, 'embeddings.json'), bin: path.join(this.dir, 'embeddings.bin') };
  }

  _save() {
    const f = this._files();
    try {
      fs.writeFileSync(f.bin + '.tmp', Buffer.from(this.vecs.buffer, this.vecs.byteOffset, this.vecs.byteLength));
      fs.writeFileSync(f.meta + '.tmp', JSON.stringify({ model: MODEL, dim: DIM, ids: this.ids, hashes: this.hashes }));
      fs.renameSync(f.bin + '.tmp', f.bin);
      fs.renameSync(f.meta + '.tmp', f.meta);
    } catch (e) {
      log.warn('could not save embeddings:', errMsg(e));
    }
  }

  _load() {
    const f = this._files();
    try {
      const meta = JSON.parse(fs.readFileSync(f.meta, 'utf8'));
      const buf = fs.readFileSync(f.bin);
      if (meta.model !== MODEL || meta.dim !== DIM || buf.length !== meta.ids.length * DIM) return;
      this.ids = meta.ids;
      this.hashes = meta.hashes;
      this.vecs = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
      this.state = { status: 'ready', done: this.ids.length, total: this.ids.length, error: null };
    } catch {
      /* none yet */
    }
  }
}

function quantize(v) {
  const q = new Int8Array(DIM);
  for (let k = 0; k < DIM; k++) q[k] = Math.max(-127, Math.min(127, Math.round(v[k] * 127)));
  return q;
}
