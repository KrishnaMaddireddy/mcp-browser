// Watches: saved searches that re-run and report what changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-watch-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { WatchStore, WatchScheduler, similarity, EVERY } = await import('../src/watches.js');

function fakeAgent(script) {
  let n = 0;
  return {
    calls: [],
    async search(q, opts) {
      this.calls.push({ q, discovery: opts.discovery });
      const r = script(n++);
      if (r instanceof Error) throw r;
      for (const x of r.results || []) opts.emit('results', x);
      return { mode: r.mode || 'direct', answer: r.answer || '', sources: r.sources || [] };
    },
  };
}

test('similarity is 1 for the same words and low for different ones', () => {
  assert.equal(similarity('rain in Paris tomorrow', 'Tomorrow: rain in Paris'), 1);
  assert.ok(similarity('rain in Paris', 'sunny in Tokyo next week') < 0.3);
});

test('first run sets a baseline; later runs report new sources and reworded answers', async () => {
  let t = 1_000_000;
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w1.json'), now: () => t });
  const w = store.add({ query: 'solid-state battery news', every: 'daily', discovery: true });
  const agent = fakeAgent((i) =>
    [
      { mode: 'llm', answer: 'Toyota leads solid-state battery pilots.', sources: [{ url: 'https://a.com/1', title: 'A' }] },
      { mode: 'llm', answer: 'Toyota leads solid-state battery pilots.', sources: [{ url: 'https://a.com/1', title: 'A' }] },
      { mode: 'llm', answer: 'Samsung announced a new sulfide electrolyte factory in Korea.', sources: [{ url: 'https://a.com/1' }, { url: 'https://b.com/2', title: 'B' }] },
    ][i]
  );
  const sched = new WatchScheduler({ store, agent });
  const first = await sched.run(w.id);
  assert.equal(first.first, true);
  assert.equal(first.changed, false);
  assert.equal(store.get(w.id).nextRunAt, t + EVERY.daily);
  assert.equal(agent.calls[0].discovery, true);

  t += EVERY.daily;
  const same = await sched.run(w.id);
  assert.equal(same.changed, false);
  assert.equal(store.get(w.id).unseen, 0);

  t += EVERY.daily;
  const changed = await sched.run(w.id);
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.newSources.map((s) => s.url), ['https://b.com/2']);
  assert.equal(store.get(w.id).unseen, 1);
  store.update(w.id, { seen: true });
  assert.equal(store.get(w.id).unseen, 0);
  assert.equal(store.get(w.id).history.length, 3);
});

test('free-mode watches compare raw server results', async () => {
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w2.json') });
  const w = store.add({ query: 'weather Seattle', every: 'hourly' });
  const agent = fakeAgent((i) => ({ results: [{ serverTitle: 'US Weather', text: i === 0 ? 'Rain, 52F, wind 10 mph' : 'Sunny skies, 71F, calm winds all afternoon' }] }));
  const sched = new WatchScheduler({ store, agent });
  await sched.run(w.id);
  const second = await sched.run(w.id);
  assert.equal(second.changed, true);
});

test('failures are recorded and rescheduled; the scheduler only runs due watches', async () => {
  let t = 5_000_000;
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w3.json'), now: () => t });
  const a = store.add({ query: 'q1', every: 'hourly' });
  store.add({ query: 'q2', every: 'weekly' });
  store.list[1].nextRunAt = t + 10_000; // not due yet
  const agent = fakeAgent(() => new Error('all servers down'));
  const sched = new WatchScheduler({ store, agent });
  await sched.tick();
  assert.equal(agent.calls.length, 1);
  assert.match(store.get(a.id).history[0].error, /all servers down/);
  assert.equal(store.get(a.id).nextRunAt, t + EVERY.hourly);
  assert.equal(store.get(a.id).running, false);
});

test('validation, persistence and the public view', () => {
  const file = path.join(process.env.MCPB_DATA_DIR, 'w4.json');
  const store = new WatchStore({ file });
  assert.throws(() => store.add({ query: '  ' }), /query required/);
  assert.throws(() => store.add({ query: 'x', every: 'minutely' }), /hourly, daily or weekly/);
  const w = store.add({ query: 'x' });
  assert.equal(new WatchStore({ file }).get(w.id).query, 'x');
  assert.equal(store.view(w).seenUrls, undefined);
  store.remove(w.id);
  assert.throws(() => store.remove(w.id), /unknown watch/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('review fix: a failed first run does not become the baseline', async () => {
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w5.json') });
  const w = store.add({ query: 'q' });
  const agent = fakeAgent((i) => (i === 0 ? new Error('down') : { mode: 'llm', answer: 'hello world', sources: [{ url: 'https://a.com' }] }));
  const sched = new WatchScheduler({ store, agent });
  await sched.run(w.id);
  const second = await sched.run(w.id);
  assert.equal(second.first, true);
  assert.equal(second.changed, false);
  assert.equal(store.get(w.id).unseen, 0);
});

test('review fix: a hung search times out and later watches still run, one at a time', async () => {
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w6.json') });
  const a = store.add({ query: 'hangs' });
  const b = store.add({ query: 'fine' });
  let concurrent = 0;
  let maxConcurrent = 0;
  const agent = {
    async search(q, opts) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (q === 'hangs') await new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
        return { mode: 'llm', answer: 'ok', sources: [] };
      } finally {
        concurrent--;
      }
    },
  };
  const sched = new WatchScheduler({ store, agent, runTimeoutMs: 100 });
  await Promise.all([sched.tick(), sched.run(b.id)]);
  assert.match(store.get(a.id).history[0].error, /longer than/);
  assert.ok(store.get(b.id).lastRun.at);
  assert.equal(maxConcurrent, 1);
  assert.equal(store.get(a.id).running, false);
});

test('review fix: a save failure never throws out of the scheduler', async () => {
  const store = new WatchStore({ file: path.join(process.env.MCPB_DATA_DIR, 'w7.json') });
  const w = store.add({ query: 'q' });
  store.file = path.join(process.env.MCPB_DATA_DIR, 'missing-dir', 'x.json');
  const sched = new WatchScheduler({ store, agent: fakeAgent(() => ({ mode: 'llm', answer: 'a', sources: [] })) });
  await assert.doesNotReject(sched.tick());
  assert.ok(store.get(w.id).lastRun);
});
