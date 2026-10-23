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

test('"tell me when": thresholds, things happening, anything new', async () => {
  const { parseTrack, figureIn, thresholdMet, saysItHappened, saidPattern } = await import('../src/track.js');
  const t = parseTrack('tell me when NVDA drops below 200');
  assert.deepEqual([t.kind, t.query, t.when], ['threshold', 'NVDA stock price today', { op: 'below', value: 200 }]);
  assert.equal(parseTrack('notify me if bitcoin goes above 100k').when.value, 100000);
  assert.equal(parseTrack('tell me when USD to JPY is above 160').query, 'USD to JPY exchange rate');
  const ev = parseTrack('tell me when GTA 6 is out');
  assert.equal(ev.kind, 'until');
  const re = saidPattern(ev.until);
  assert.equal(ev.untilRe, undefined); // (the pattern is the server's, never sent to or from the page)
  assert.equal(saysItHappened('GTA 6 is expected to be released in 2026.', re, ev.untilAbout), null);
  assert.equal(saysItHappened('GTA 5 was released in 2013.', re, ev.untilAbout), null);
  assert.ok(saysItHappened('Big news. GTA 6 was released on May 26 to huge sales.', re, ev.untilAbout));
  for (const s of ['GTA 6 trailer 3 is out now.', 'GTA 6 is now available for pre-order.', 'GTA 6 fans: GTA 5 was released on PS5 and is out now.']) assert.equal(saysItHappened(s, re, ev.untilAbout), null, s);
  // the review's misparses
  assert.equal(parseTrack('tell me about the french revolution'), null);
  assert.equal(parseTrack('tell me if I need a visa for Japan'), null);
  assert.ok(parseTrack('tell me when 🚀 is out').error);
  assert.equal(parseTrack('tell me when the temperature in London is below 0').query, 'weather in London');
  assert.deepEqual(parseTrack('tell me when mortgage rates go above 7%').when, { op: 'above', value: 7, unit: '%' });
  assert.equal(parseTrack('tell me when mortgage rates go above 7%').query, 'mortgage rates today');
  assert.equal(parseTrack('tell me when apple stock hits 300').when.op, 'reach');
  assert.ok(parseTrack('tell me when Bitcoin drops 10%').note);
  for (const [t, v] of [['As of Oct 23, NVIDIA trades at 212.21 USD', 212.21], ['1 USD = 152.3 JPY', 152.3], ['Top 10 stocks: NVDA at 212', 212], ['As of October 23, 2026 the price is 212.21', 212.21]]) assert.equal(figureIn(t), v, t);
  assert.equal(figureIn('The 30-year fixed mortgage rate averaged 6.2%'), null);
  assert.equal(figureIn('The 30-year fixed mortgage rate averaged 6.2%', { unit: '%' }), 6.2);
  assert.equal(parseTrack('tell me about new recalls for Kia Sorento').kind, 'new');
  assert.equal(parseTrack('what is the weather'), null);
  assert.equal(figureIn('NVIDIA Corporation (NVDA): 212.21 USD (1-day change -4.4%)'), 212.21);
  assert.ok(thresholdMet({ op: 'below', value: 220 }, 212.21));
  assert.ok(!thresholdMet({ op: 'above', value: 220 }, 212.21));
});

test('a threshold watch stops once the figure crosses its line', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler } = await import('../src/watches.js');
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-tw-')), 'w.json') });
  const w = store.add({ query: 'NVDA stock price today', when: { op: 'below', value: 220 }, every: 'hourly' });
  const agent = { search: async () => ({ mode: 'direct', answer: '', quickAnswer: { text: 'NVIDIA Corporation (NVDA): 212.21 USD (1-day change -4.4%)' } }) };
  const sch = new WatchScheduler({ store, agent });
  await sch.run(w.id);
  const after = store.get(w.id);
  assert.equal(after.met.value, 212.21);
  assert.equal(after.nextRunAt, Number.MAX_SAFE_INTEGER);
  assert.equal(after.lastValue.value, 212.21);
});

test('a price watch only has news when it crosses; a wild reading is ignored; no client regex runs', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler } = await import('../src/watches.js');
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-tw-')), 'w.json') });
  const w = store.add({ query: 'NVDA stock price today', when: { op: 'below', value: 200 }, every: 'hourly', untilRe: '^(a+)+$' });
  assert.equal(w.untilRe, undefined);
  let n = 0;
  const answers = ['NVIDIA Corporation (NVDA): 212.21 USD', 'NVIDIA Corporation (NVDA): 211.80 USD', 'As of Oct 23, the page says 23', 'NVIDIA Corporation (NVDA): 52.00 USD'];
  const agent = { search: async () => ({ mode: 'direct', answer: '', sources: [{ url: `https://news.example/${n}`, title: 'story' }], quickAnswer: { text: answers[n++] } }) };
  const sch = new WatchScheduler({ store, agent });
  for (let i = 0; i < 4; i++) {
    store.get(w.id).nextRunAt = 0;
    await sch.run(w.id);
  }
  const after = store.get(w.id);
  assert.equal(after.unseen, 0); // new sources every run, but no crossing: no news
  assert.ok(!after.met); // 52 is too far from 211.80 to believe
  assert.equal(after.lastValue.value, 211.8);
  assert.equal(after.lastMiss.value, 52);
});
