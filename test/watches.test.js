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
  // (the first reading only sets the start: a misread can't fire it alone)
  assert.equal(store.get(w.id).met, undefined);
  store.get(w.id).nextRunAt = 0;
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

test('a dependency watch: each advisory is a source, so a new one is news', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler } = await import('../src/watches.js');
  const { DEP_SERVERS } = await import('../src/deps.js');
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-dw-')), 'w.json') });
  const w = store.add({ deps: [{ name: 'lodash', version: '4.17.15', ecosystem: 'npm' }, { name: 'bad name!', version: '1', ecosystem: 'npm' }, { name: 'x', version: '1', ecosystem: 'maven' }] });
  assert.deepEqual(w.deps.map((p) => p.name), ['lodash']);
  assert.equal(w.query, 'Dependencies: lodash');
  let ids = ['GHSA-1'];
  const callTool = async (id) => {
    if (id === DEP_SERVERS.osv) return { structuredContent: { results: [{ name: 'lodash', ecosystem: 'npm', version: '4.17.15', vulns: ids.map((x) => ({ id: x, summary: `issue ${x}`, aliases: [], severityLabel: 'HIGH', fixedVersions: ['4.17.21'] })) }] } };
    throw new Error('off');
  };
  const sch = new WatchScheduler({ store, agent: { search: async () => ({}) }, callTool });
  await sch.run(w.id);
  assert.equal(store.get(w.id).unseen, 0); // the first run is the baseline
  ids = ['GHSA-1', 'GHSA-2'];
  store.get(w.id).nextRunAt = 0;
  await sch.run(w.id);
  const after = store.get(w.id);
  assert.equal(after.unseen, 1);
  assert.equal(after.history[0].newSources[0].url, 'https://osv.dev/vulnerability/GHSA-2');
});

test('a page watch: any edited line is news, the reader’s own timestamps are not', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler, PAGE_FETCH, pageDiff } = await import('../src/watches.js');
  assert.deepEqual(pageDiff('as_of: 2026-10-23T01:00\nmarkdown:\n  Price: $10\n  Hello', 'as_of: 2026-10-24T01:00\nmarkdown:\n  Price: $12\n  Hello'), { added: ['Price: $12'], removed: ['Price: $10'] });
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-pw-')), 'w.json') });
  assert.throws(() => store.add({ page: 'file:///etc/passwd' }));
  assert.throws(() => store.add({ page: 'https://user:pw@example.com/' }));
  const w = store.add({ page: 'https://example.com/pricing' });
  let n = 0;
  const pages = ['as_of: 1\nstatus: ok\nmarkdown:\n  Plan A: $10\n  FAQ', 'as_of: 2\nstatus: ok\nmarkdown:\n  Plan A: $10\n  FAQ', 'as_of: 3\nstatus: ok\nmarkdown:\n  Plan A: $15\n  FAQ'];
  const callTool = async (id, tool, args) => {
    assert.deepEqual([id, tool, args.url], [PAGE_FETCH, 'fetch_page', 'https://example.com/pricing']);
    return { content: [{ type: 'text', text: pages[n++] }] };
  };
  const sch = new WatchScheduler({ store, agent: { search: async () => ({}) }, callTool });
  for (let i = 0; i < 3; i++) {
    store.get(w.id).nextRunAt = 0;
    await sch.run(w.id);
  }
  const after = store.get(w.id);
  assert.equal(after.unseen, 1);
  assert.deepEqual([after.history[0].added, after.history[0].removed, after.history[1].changed], [['Plan A: $15'], ['Plan A: $10'], false]);
});

test('review 2: rates both ways, times and names, a real big move, and what counts as "it happened"', async () => {
  const { figureIn, saysItHappened, saidPattern, parseTrack } = await import('../src/track.js');
  assert.ok(Math.abs(figureIn('As of 18:17 UTC, the mid-market USD to EUR rate is $1 = €0.8910.', { pair: ['EUR', 'USD'] }) - 1 / 0.891) < 1e-9);
  assert.equal(figureIn('1 US Dollar equals 152.30 Japanese Yen', { pair: ['USD', 'JPY'] }), 152.3);
  assert.equal(figureIn('Cloudy, clearing around 14:00. 12° now.'), 12);
  assert.equal(figureIn('The S&P 500 fell 1.2% to 5,812.34'), 5812.34);
  const re = saidPattern('available');
  for (const s of ['The iPhone 18 is not available now.', 'A case for the iPhone 18 was released by Spigen and is available now.']) assert.equal(saysItHappened(s, re, ['iphone', '18']), null, s);
  assert.ok(saysItHappened('The iPhone 18 is now available in stores.', re, ['iphone', '18']));
  const d = parseTrack('tell me when GTA 6 is delayed');
  assert.ok(saysItHappened('GTA 6 has been delayed to 2027.', saidPattern(d.until), d.untilAbout));
  assert.ok(saidPattern('opens') && saysItHappened('The new Apple store is now open.', saidPattern('opens'), ['apple', 'store']));
  // a real move of more than half, seen twice, is taken
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler } = await import('../src/watches.js');
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-gme-')), 'w.json') });
  const w = store.add({ query: 'GME stock price today', when: { op: 'above', value: 40 }, every: 'hourly' });
  const vals = ['20.10', '46.50', '47.00'];
  let n = 0;
  const sch = new WatchScheduler({ store, agent: { search: async () => ({ mode: 'direct', answer: '', quickAnswer: { text: `GameStop Corp. (GME): ${vals[n++]} USD` } }) } });
  for (let i = 0; i < 3; i++) {
    store.get(w.id).nextRunAt = 0;
    await sch.run(w.id);
  }
  assert.equal(store.get(w.id).met?.value, 47);
});

test('a repo watch: the lockfile is read again each run, so a bump to a vulnerable version is news', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { WatchStore, WatchScheduler } = await import('../src/watches.js');
  const { DEP_SERVERS, PAGE_FETCH } = await import('../src/deps.js');
  const store = new WatchStore({ file: pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'mcpb-rw-')), 'w.json') });
  assert.throws(() => store.add({ repo: 'https://gitlab.com/a/b' }));
  assert.throws(() => store.add({ repo: 'https://github.com/a/../b' }));
  const w = store.add({ repo: 'https://github.com/o/r/tree/main/web' });
  assert.deepEqual([w.repo, w.query], ['https://github.com/o/r/tree/main/web', 'Dependencies of o/r/web']);
  let qs = '6.16.0';
  const callTool = async (id, tool, args) => {
    if (id === PAGE_FETCH) return args.url.endsWith('/web/package-lock.json') ? { structuredContent: { status: 'ok', markdown: JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { qs: qs } }, 'node_modules/qs': { version: qs } } }) } } : { structuredContent: { status: 'skipped' } };
    if (id === DEP_SERVERS.osv) {
      const p = args.packages[0];
      return { structuredContent: { results: [{ ...p, vulns: p.version === '6.7.0' ? [{ id: 'GHSA-qs', summary: 'prototype pollution', aliases: [], severityLabel: 'HIGH', fixedVersions: ['6.7.3'] }] : [] }] } };
    }
    throw new Error('off');
  };
  const sch = new WatchScheduler({ store, agent: { search: async () => ({}) }, callTool });
  await sch.run(w.id);
  assert.equal(store.get(w.id).unseen, 0);
  qs = '6.7.0'; // (someone pinned an old version)
  store.get(w.id).nextRunAt = 0;
  await sch.run(w.id);
  assert.equal(store.get(w.id).unseen, 1);
  assert.match(store.get(w.id).history[0].newSources[0].title, /qs 6\.7\.0/);
});
