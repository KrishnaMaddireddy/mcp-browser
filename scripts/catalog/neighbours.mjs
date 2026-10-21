// For servers the keyword rules leave in "Other": embed each server's title and
// description with the same small local model routing uses (all-MiniLM-L6-v2),
// and give an "Other" server the category its closest labeled neighbours agree
// on. Optional: returns {} when the model can't load.
import { categorize } from './categories.mjs';

const DIM = 384;
const K = 12;

export async function classifyNeighbours(servers, { modelDir, log = console.log } = {}) {
  let ex;
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (modelDir) env.cacheDir = modelDir;
    ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  } catch (e) {
    log(`  neighbours: skipped (embedding model unavailable: ${e.message})`);
    return {};
  }
  const texts = servers.map((s) => [s.title || s.name.split('/').pop(), s.description].filter(Boolean).join('. ').slice(0, 400));
  const vecs = new Float32Array(servers.length * DIM);
  for (let i = 0; i < texts.length; i += 128) {
    const out = await ex(texts.slice(i, i + 128), { pooling: 'mean', normalize: true });
    vecs.set(out.data, i * DIM);
    if ((i / 128) % 80 === 0) log(`  neighbours: embedded ${i}/${texts.length}`);
  }
  const labels = servers.map((s) => categorize(s).cat);
  const labeled = [];
  const others = [];
  labels.forEach((c, i) => (c === 'other' ? others : labeled).push(i));
  const result = {};
  for (const i of others) {
    const q = vecs.subarray(i * DIM, (i + 1) * DIM);
    const best = [];
    for (const j of labeled) {
      let d = 0;
      const o = j * DIM;
      for (let k = 0; k < DIM; k++) d += q[k] * vecs[o + k];
      if (best.length < K || d > best[best.length - 1][0]) {
        best.push([d, j]);
        best.sort((a, b) => b[0] - a[0]);
        if (best.length > K) best.pop();
      }
    }
    const votes = {};
    for (const [d, j] of best) if (d > 0.42) votes[labels[j]] = (votes[labels[j]] || 0) + d;
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    const total = Object.values(votes).reduce((a, b) => a + b, 0);
    if (top && top[1] >= 1.6 && top[1] / total >= 0.5) result[servers[i].name] = top[0];
  }
  log(`  neighbours: ${Object.keys(result).length} of ${others.length} "Other" servers placed`);
  return result;
}
