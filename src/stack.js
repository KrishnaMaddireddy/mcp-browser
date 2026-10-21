// "My MCP stack": the catalog servers a user picked, kept in the data dir.
// Only server ids, the order, and non-secret setting values are stored;
// secret values are never written here.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

const MAX = 60;

export class StackStore {
  constructor({ file = path.join(dataDir(), 'stack.json') } = {}) {
    this.file = file;
    this.items = [];
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.items)) this.items = d.items.filter((x) => x && typeof x.id === 'string').slice(0, MAX);
    } catch {
      /* none yet */
    }
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ items: this.items }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  has(id) {
    return this.items.some((x) => x.id === id);
  }

  add(id) {
    id = String(id || '').slice(0, 200);
    if (!id) throw new Error('id required');
    if (this.has(id)) return this.items;
    if (this.items.length >= MAX) throw new Error(`your stack can hold up to ${MAX} servers`);
    this.items.push({ id, addedAt: Date.now(), values: {} });
    this.save();
    return this.items;
  }

  remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return this.items;
  }

  /** Keep non-secret setting values (e.g. EDGAR_IDENTITY, a region). `secretNames` are refused. */
  setValues(id, values, secretNames = []) {
    const it = this.items.find((x) => x.id === id);
    if (!it) throw new Error('not in your stack');
    const clean = {};
    for (const [k, v] of Object.entries(values && typeof values === 'object' ? values : {})) {
      if (secretNames.includes(k) || typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
      if (v.length > 500) continue;
      clean[k] = v;
    }
    it.values = clean;
    this.save();
    return it;
  }

  move(id, delta) {
    const i = this.items.findIndex((x) => x.id === id);
    const j = i + Number(delta);
    if (i < 0 || j < 0 || j >= this.items.length) return this.items;
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    this.save();
    return this.items;
  }
}
