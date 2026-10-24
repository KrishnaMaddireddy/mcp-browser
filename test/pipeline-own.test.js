// Your own pipelines and your own servers: a pipeline you saved yourself may use servers you added
// or gave a key or sign-in; the same pipeline changed and not saved, a library pipeline, or one
// someone else wrote may not. Real HTTP to the app's own API, mock MCP servers on localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-own-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';
const { startMockServers } = await import('./fixtures/mock-servers.js');
const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');

let mock;
let app;
let base;
let engine;
before(async () => {
  mock = await startMockServers();
  engine = createEngine({ providerOverride: null, curated: [], extraServers: [mock.servers.locked, mock.servers.docs] });
  engine.updateSettings({ alwaysWebSearch: false, serverAuth: { locked: { header: 'X-Api-Key', value: 'good-key' } } });
  app = createServer({ engine, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  await mock.close();
});

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body) });
async function run(pipeline, input = 'passwords') {
  const text = await (await post('/api/pipelines/run', { pipeline, input })).text();
  return text
    .split('\n\n')
    .map((b) => /^event: (\S+)\ndata: (.*)$/s.exec(b.trim()))
    .filter(Boolean)
    .map(([, t, d]) => [t, JSON.parse(d)]);
}
const VAULT = {
  title: 'Vault check',
  input: { label: 'What', example: 'passwords' },
  steps: [{ kind: 'call', ask: 'Search my vault', call: { server: 'locked', tool: 'search_vault', args: [{ query: '{input}' }] } }],
};
// (any call to your keyed server by a pipeline that isn't yours fails the test outright)
const vaultCalls = () => mock.calls.filter((c) => c.server === 'locked' && c.tool === 'search_vault');

test('a pipeline you saved can call your keyed server, once you saw what it sends and allowed it', async () => {
  // (first save: asked, with the step's tool and arguments shown; nothing saved yet)
  const ask = await post('/api/pipelines/save', { pipeline: VAULT });
  assert.equal(ask.status, 409);
  const q = await ask.json();
  assert.deepEqual(q.uses, [{ step: 1, id: 'locked', title: 'Vault', ask: 'Search my vault', tool: 'search_vault', args: [{ query: '{input}' }] }]);
  assert.equal((await (await fetch(`${base}/api/pipelines`)).json()).mine.length, 0);
  const r = await (await post('/api/pipelines/save', { pipeline: VAULT, allowOwn: true })).json();
  assert.deepEqual(r.ownOnly.map((x) => x.id), ['locked']);
  const listed = await (await fetch(`${base}/api/pipelines`)).json();
  assert.deepEqual(listed.mine.find((p) => p.id === r.pipeline.id).ownOnly, ['Vault']);
  const before = vaultCalls().length;
  const ev = await run(listed.mine.find((p) => p.id === r.pipeline.id));
  assert.deepEqual(ev.find(([t]) => t === 'pipe_trust')[1], { own: true });
  assert.equal(vaultCalls().length, before + 1);
  assert.ok(ev.some(([t, d]) => t === 'pipe_result' && d.servers?.includes('locked') && !d.note), JSON.stringify(ev));
});

test('the same pipeline changed and not saved, or never saved, can\'t reach it', async () => {
  const saved = (await (await fetch(`${base}/api/pipelines`)).json()).mine.find((p) => p.title === 'Vault check');
  const before = vaultCalls().length;
  // (changed: a step's arguments differ from the saved copy)
  const changed = { ...saved, steps: [{ ...saved.steps[0], call: { ...saved.steps[0].call, args: [{ query: 'everything' }] } }] };
  const ev = await run(changed);
  assert.deepEqual(ev.find(([t]) => t === 'pipe_trust')[1], { own: false });
  assert.ok(ev.some(([t, d]) => t === 'pipe_result' && /can't be called from this pipeline/.test(d.note || '')), JSON.stringify(ev));
  // (never saved: no id of yours)
  const ev2 = await run({ ...VAULT, id: 'someone-elses' });
  assert.ok(ev2.some(([t, d]) => t === 'pipe_result' && /can't be called from this pipeline/.test(d.note || '')));
  // (a step that names no servers: MCP Browser's own pick leaves out your servers too)
  await run({ id: 'someone-elses', title: 'y', steps: [{ ask: 'search the private vault for {input}' }] });
  // (saving it again after a change, with the same servers as before, isn't asked again)
  const again = await post('/api/pipelines/save', { pipeline: { ...saved, title: 'Vault check' } });
  assert.equal(again.status, 200);
  // (a servers list in a plain step is held to the same rule)
  const ev3 = await run({ title: 'x', steps: [{ ask: 'vault {input}', servers: ['locked'] }] });
  assert.ok(ev3.some(([t, d]) => t === 'pipe_result' && /Not asked: locked can't be used from this pipeline/.test(d.note || '')), JSON.stringify(ev3));
  assert.equal(vaultCalls().length, before);
});

test('your own pipeline still skips a server you switched off', async () => {
  const saved = (await (await fetch(`${base}/api/pipelines`)).json()).mine.find((p) => p.title === 'Vault check');
  engine.updateSettings({ serverOverrides: { locked: false } });
  const before = vaultCalls().length;
  const ev = await run(saved);
  assert.ok(ev.some(([t, d]) => t === 'pipe_result' && /switched off/.test(d.note || '')), JSON.stringify(ev));
  assert.equal(vaultCalls().length, before);
  engine.updateSettings({ serverOverrides: { locked: true } });
  // (the read-only rule still applies: a tool that changes things is refused in your own pipeline too)
  const { classifyTool } = await import('../src/policy.js');
  assert.equal(classifyTool({ name: 'delete_entry', description: 'Delete a vault entry.' }, { trust: 'community' }).allowed, false);
});

test('a schedule made from your saved copy keeps its trust; one from a changed copy doesn\'t', async () => {
  const saved = (await (await fetch(`${base}/api/pipelines`)).json()).mine.find((p) => p.title === 'Vault check');
  const a = await (await post('/api/pipelines/watch', { pipeline: saved, input: 'passwords', every: 'daily' })).json();
  const b = await (await post('/api/pipelines/watch', { pipeline: { ...saved, title: 'Vault check (copy)' }, input: 'passwords', every: 'daily' })).json();
  assert.equal(engine.watches.get(a.watch.id).ownPipeline, true);
  assert.equal(engine.watches.get(b.watch.id).ownPipeline, undefined);
  // (a request can't claim it)
  const c = await (await post('/api/pipelines/watch', { pipeline: { ...VAULT, id: 'x' }, input: 'p', every: 'daily', ownPipeline: true })).json();
  assert.equal(engine.watches.get(c.watch.id).ownPipeline, undefined);
  // (it runs with your server while the saved copy is unchanged…)
  let n = vaultCalls().length;
  await engine.scheduler.run(a.watch.id);
  assert.equal(vaultCalls().length, n + 1);
  // (…and not once the saved copy is deleted)
  await post('/api/pipelines/delete', { id: saved.id });
  n = vaultCalls().length;
  await engine.scheduler.run(a.watch.id);
  assert.equal(vaultCalls().length, n);
});

test('a library pipeline\'s id stays the library\'s: a copy saved with it gets its own', async () => {
  const r = await (await post('/api/pipelines/save', { pipeline: { id: 'stock-snapshot', title: 'Mine', steps: [{ ask: '{input} price' }] } })).json();
  assert.notEqual(r.pipeline.id, 'stock-snapshot');
});

test('in your own pipeline, a server id MCP Browser doesn\'t know is said so', async () => {
  const r = await (await post('/api/pipelines/save', { pipeline: { title: 'Typo', steps: [{ ask: 'vault {input}', servers: ['lockd'] }] } })).json();
  const ev = await run(r.pipeline);
  assert.ok(ev.some(([t, d]) => t === 'pipe_result' && /isn't a server MCP Browser knows/.test(d.note || '')), JSON.stringify(ev));
});
