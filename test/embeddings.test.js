// Meaning-based routing with a fake embedder (no model download in tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-emb-'));
process.env.MCPB_LOG = 'silent';

const { EmbeddingIndex } = await import('../src/embeddings.js');
const { Catalog } = await import('../src/catalog.js');
const { loadSettings } = await import('../src/config.js');

// Words → concept dimensions; synonyms share a dimension, like a real model would.
const CONCEPTS = [['weather', 'forecast', 'rain', 'wet', 'umbrella', 'temperature'], ['flight', 'airline', 'fly', 'plane', 'airfare'], ['library', 'docs', 'documentation', 'api', 'react']];
let calls = 0;
const fake = async (texts) => {
  calls += texts.length;
  return texts.map((t) => {
    const v = new Float32Array(384);
    const words = t.toLowerCase().split(/[^a-z]+/);
    CONCEPTS.forEach((syn, d) => (v[d] = words.filter((w) => syn.includes(w)).length));
    v[383] = 0.3; // shared background
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
};

const curated = [
  { id: 'web', title: 'Web Search', description: 'search the web', url: 'https://w.example/mcp', tags: ['web'], source: 'curated', trust: 'trusted', general: true },
  { id: 'meteo', title: 'Meteo', description: 'forecast and temperature for any city', url: 'https://m.example/mcp', tags: [], source: 'curated', trust: 'trusted' },
  { id: 'air', title: 'Air', description: 'airline fares', url: 'https://a.example/mcp', tags: [], source: 'curated', trust: 'trusted' },
];

test('meaning finds servers that share no keyword with the question', async () => {
  const idx = new EmbeddingIndex({ embedder: fake, dir: process.env.MCPB_DATA_DIR });
  const cat = new Catalog({ curated, registry: { servers: [] }, settings: { ...loadSettings(), serverOverrides: {} }, embeddings: idx });
  // Before the index exists: keyword routing only → just web search.
  assert.deepEqual((await cat.routeAsync('should I bring an umbrella in Paris')).map((r) => r.server.id), ['web']);
  await idx.build(cat.all());
  const r = await cat.routeAsync('should I bring an umbrella in Paris');
  assert.equal(r[0].server.id, 'meteo');
  assert.match(r[0].reason, /similar meaning/);
  assert.ok(!r.some((x) => x.server.id === 'air'));
  assert.equal((await cat.routeAsync('cheap plane tickets'))[0].server.id, 'air');
});

test('vectors are cached on disk and only changed servers are re-embedded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-emb2-'));
  calls = 0;
  const a = new EmbeddingIndex({ embedder: fake, dir });
  await a.build(curated);
  assert.equal(calls, 3);
  const b = new EmbeddingIndex({ embedder: fake, dir }); // reloads from disk
  assert.equal(b.ready, true);
  calls = 0;
  await b.build([...curated.slice(0, 2), { ...curated[2], description: 'cheap airline tickets' }]);
  assert.equal(calls, 1, 'only the changed server is re-embedded');
  const q = (await fake(['rain tomorrow']))[0];
  assert.equal([...b.similarities(q).keys()][0], 'meteo');
});

test('a missing model leaves routing on keywords', async () => {
  const idx = new EmbeddingIndex({
    embedder: async () => {
      throw new Error('no model');
    },
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-emb3-')),
  });
  const st = await idx.build(curated);
  assert.equal(st.status, 'unavailable');
  const cat = new Catalog({ curated, registry: { servers: [] }, settings: { ...loadSettings(), serverOverrides: {} }, embeddings: idx });
  assert.equal((await cat.routeAsync('airline fares')).at(0).server.id, 'air');
});
