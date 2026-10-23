import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-pipes-'));
process.env.MCPB_LOG = 'silent';
const { runPipeline, cleanPipeline, fill, STARTERS, pipelineText } = await import('../src/pipelines.js');
const { WatchStore, WatchScheduler } = await import('../src/watches.js');

// A fake search: lists items for the first question, finds a repo for each title.
function fakeAgent(log) {
  return {
    async search(q, { emit, servers }) {
      log.push([q, servers]);
      if (/^papers about/.test(q)) {
        emit('results', { kind: 'ok', serverTitle: 'Papers', score: 2, view: { kind: 'items', items: [{ title: 'Paper A', url: 'https://arxiv.org/a' }, { title: 'Paper A', url: 'https://mirror.example/a' }, { title: 'Paper B', url: 'https://arxiv.org/b' }] } });
        return { mode: 'direct', answer: '', sources: [{ n: 1, url: 'https://orcid.org/x', title: 'orcid.org' }] };
      }
      emit('results', { kind: 'ok', serverTitle: 'Web', score: 1, view: { kind: 'items', items: [{ title: `${q} repo`, url: `https://github.com/x/${encodeURIComponent(q)}` }] } });
      emit('quick_answer', { text: `answer for ${q}` });
      return { mode: 'direct', answer: '', quickAnswer: { text: `answer for ${q}` }, sources: [] };
    },
  };
}

test('a pipeline passes results on: for each result, {title}, {answer}, {input}', async () => {
  const log = [];
  const events = [];
  const p = cleanPipeline({ title: 'T', steps: [{ ask: 'papers about {input}', servers: ['papers'], max: 3 }, { ask: '{title} code', each: true, servers: ['web'] }, { ask: 'summary of {answer}' }] });
  const r = await runPipeline(fakeAgent(log), p, { input: 'RAG', emit: (t, d) => events.push([t, d]) });
  assert.deepEqual(log.map(([q]) => q), ['papers about RAG', 'Paper A code', 'Paper B code', 'summary of answer for Paper B code']);
  assert.deepEqual(log[0][1], ['papers']);
  assert.equal(r.steps[1].runs.length, 2, 'the same paper from two places runs once; author links are not items');
  assert.ok(events.some(([t]) => t === 'pipe_done'));
  assert.match(pipelineText(r), /Paper A code repo/);
});

test('pipelines from outside are checked', () => {
  assert.throws(() => cleanPipeline({ steps: [] }), /at least one step/);
  assert.throws(() => cleanPipeline({ steps: [{ ask: '' }] }), /no question/);
  const c = cleanPipeline({ id: '../../x', steps: Array.from({ length: 9 }, () => ({ ask: 'q', each: true, max: 99, servers: ['a', 'b', 'c', 'd'] })) });
  assert.equal(c.steps.length, 5);
  assert.equal(c.steps[0].each, undefined, 'the first step has nothing to go through');
  assert.equal(c.steps[1].max, 5);
  assert.equal(c.steps[1].servers.length, 3);
  assert.doesNotMatch(c.id, /[./]/);
  assert.equal(fill('a {title} {nope} {input}', { title: 'x\n y', input: 'z' }), 'a x y {nope} z');
  for (const s of STARTERS) assert.doesNotThrow(() => cleanPipeline(s), s.id);
});

test('a scheduled pipeline stops once its result says what you were waiting for', async () => {
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w.json') });
  const p = cleanPipeline({ title: 'Watch', steps: [{ ask: 'news about {input}' }] });
  const w = store.add({ query: 'Watch: rates', every: 'hourly', pipeline: p, input: 'rates', until: 'ANSWER FOR' });
  const sched = new WatchScheduler({ store, agent: fakeAgent([]) });
  await sched.run(w.id);
  const after = store.get(w.id);
  assert.ok(after.met, 'condition met');
  assert.match(after.met.snippet, /answer for news about rates/i);
  assert.ok(after.nextRunAt > Date.now() + 365 * 864e5, 'no more runs');
  assert.ok(after.lastRun && !after.lastRun.error);
});

test('the pipeline library: starters are featured, entries are checked, unknown topics go to everyday', async () => {
  const { loadLibrary, STARTERS } = await import('../src/pipelines.js');
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const f = pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-lib-')), 'lib.json');
  fsm.writeFileSync(f, JSON.stringify([
    { id: 'a', title: 'A', category: 'finance', input: { label: 'x', example: 'y' }, steps: [{ ask: '{input}', servers: ['marketcrew'] }], tested: { on: '2026-10-22', ms: 1200 } },
    { id: 'b', title: 'B', category: 'nonsense', steps: [{ ask: 'q' }] },
    { id: 'bad', title: 'no steps', steps: [] },
    { id: STARTERS[0].id, title: 'duplicate', steps: [{ ask: 'q' }] },
  ]));
  const lib = loadLibrary(f);
  assert.equal(lib.length, STARTERS.length + 2);
  assert.ok(lib.slice(0, STARTERS.length).every((p) => p.category === 'featured'));
  const a = lib.find((p) => p.id === 'a');
  assert.equal(a.category, 'finance');
  assert.deepEqual(a.tested, { on: '2026-10-22', ms: 1200 });
  assert.equal(lib.find((p) => p.id === 'b').category, 'everyday');
});
