import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-stack-'));
process.env.MCPB_LOG = 'silent';
const { createServer } = await import('../src/server.js');
const { createEngine } = await import('../src/app.js');

let app;
let base;
before(async () => {
  app = createServer({ engine: createEngine({ providerOverride: null, curated: [], extraServers: [], embeddings: null }), port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(() => app.close());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(b) }).then((r) => r.json());

const IDS = ['io.github.upstash/context7', 'io.github.getsentry/sentry-mcp', 'io.github.dgunning/edgartools'];

test('stack: add, keep non-secret values only, order, remove', async () => {
  for (const id of IDS) await post('/api/stack/add', { id });
  const bad = await post('/api/stack/add', { id: 'nope/nope' });
  assert.match(bad.error, /not in the catalog/);
  await post('/api/stack/values', { id: 'io.github.dgunning/edgartools', values: { EDGAR_IDENTITY: 'Jane Doe jane@example.com' } });
  const kept = await post('/api/stack/values', { id: 'io.github.getsentry/sentry-mcp', values: { SENTRY_ACCESS_TOKEN: 'sntrys_secret_value' } });
  assert.deepEqual(kept.values, {}, 'secret values are never stored');
  const s = await fetch(base + '/api/stack').then((r) => r.json());
  assert.deepEqual(s.items.map((x) => x.id), IDS);
  assert.equal(s.items[2].values.EDGAR_IDENTITY, 'Jane Doe jane@example.com');
  assert.ok(s.items[0].server.sample_prompts.length);
  assert.ok(!fs.readFileSync(path.join(process.env.MCPB_DATA_DIR, 'stack.json'), 'utf8').includes('sntrys'));
});

test('the setup script configures Claude Desktop, Cursor and VS Code without prompting when values are in the environment', async () => {
  const script = await fetch(base + '/api/stack/script').then((r) => r.text());
  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.ok(!script.includes('sntrys'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-script-'));
  const file = path.join(dir, 'setup-mcp.mjs');
  fs.writeFileSync(file, script);
  const home = path.join(dir, 'home');
  const support = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  fs.mkdirSync(path.join(support, 'Claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(support, 'Code', 'User'), { recursive: true });
  // An existing Claude Desktop config: other servers must survive, and it is backed up.
  fs.writeFileSync(path.join(support, 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SENTRY_ACCESS_TOKEN: 'sntrys_from_env_123456' };
  const dry = spawnSync(process.execPath, [file, '--dry-run', '--clients=desktop,cursor,vscode'], { env, encoding: 'utf8', input: '' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(support, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers.context7, undefined, 'dry run changes nothing');
  const r = spawnSync(process.execPath, [file, '--clients=desktop,cursor,vscode'], { env, encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const desk = JSON.parse(fs.readFileSync(path.join(support, 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.equal(desk.other, 1);
  assert.deepEqual(desk.mcpServers.mine, { command: 'x' });
  assert.deepEqual(desk.mcpServers['edgartools'], { command: 'uvx', args: ['edgartools'], env: { EDGAR_IDENTITY: 'Jane Doe jane@example.com' } });
  assert.equal(desk.mcpServers['sentry-mcp'].env.SENTRY_ACCESS_TOKEN, 'sntrys_from_env_123456');
  assert.equal(desk.mcpServers.context7.command, 'npx'); // published as an npm package
  assert.ok(fs.readdirSync(path.join(support, 'Claude')).some((f) => f.includes('.backup-')));
  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.context7 && cursor.mcpServers['sentry-mcp'].env.SENTRY_ACCESS_TOKEN);
  const vs = JSON.parse(fs.readFileSync(path.join(support, 'Code', 'User', 'mcp.json'), 'utf8'));
  assert.match(vs.servers['sentry-mcp'].env.SENTRY_ACCESS_TOKEN, /^\$\{input:/, 'VS Code gets a prompt, not the key');
  assert.ok(vs.inputs.some((i) => i.password));
  assert.ok(!JSON.stringify(vs).includes('sntrys'));
  const ts = await fetch(base + '/api/stack/script?format=ts').then((r) => r.text());
  assert.match(ts, /@ts-nocheck/);
});

test('MCP Browser sets up, previews and removes the stack in the apps itself, and never echoes keys', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-apply-'));
  const support = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  fs.mkdirSync(path.join(support, 'Claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const cl = await fetch(base + '/api/stack/clients').then((r) => r.json());
    assert.ok(cl.clients.find((c) => c.id === 'desktop').present);
    assert.ok(!cl.clients.find((c) => c.id === 'vscode').present);
    const secrets = { 'io.github.getsentry/sentry-mcp': { SENTRY_ACCESS_TOKEN: 'sntrys_typed_in_browser_999' } };
    const none = await post('/api/stack/apply', { clients: [], secrets });
    assert.equal(none.ok, false);
    const dry = await post('/api/stack/apply', { clients: ['desktop', 'cursor'], secrets, dry: true });
    assert.ok(dry.ok, dry.output);
    assert.match(dry.output, /dry run/);
    assert.ok(!dry.output.includes('sntrys_typed'), 'keys are hidden in the preview');
    assert.ok(!fs.existsSync(path.join(support, 'Claude', 'claude_desktop_config.json')));
    const go = await post('/api/stack/apply', { clients: ['desktop', 'cursor'], secrets, dry: false });
    assert.ok(go.ok, go.output);
    assert.ok(!go.output.includes('sntrys_typed'));
    const desk = JSON.parse(fs.readFileSync(path.join(support, 'Claude', 'claude_desktop_config.json'), 'utf8'));
    assert.equal(desk.mcpServers['sentry-mcp'].env.SENTRY_ACCESS_TOKEN, 'sntrys_typed_in_browser_999');
    assert.ok(desk.mcpServers.edgartools && desk.mcpServers.context7);
    assert.ok(!fs.readFileSync(path.join(process.env.MCPB_DATA_DIR, 'stack.json'), 'utf8').includes('sntrys_typed'));
    // Without the key, that server is skipped rather than written with a placeholder.
    fs.rmSync(path.join(home, '.cursor', 'mcp.json'));
    const skip = await post('/api/stack/apply', { clients: ['cursor'], dry: false });
    assert.match(skip.output, /Skipped/i);
    const cur = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cur.mcpServers['sentry-mcp'], undefined);
    assert.ok(cur.mcpServers.context7);
    const rm = await post('/api/stack/apply', { clients: ['desktop', 'cursor'], remove: true, dry: false });
    assert.ok(rm.ok, rm.output);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(support, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers, {});
  } finally {
    process.env.HOME = old;
  }
});
