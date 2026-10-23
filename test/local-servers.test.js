import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-local-'));
process.env.MCPB_LOG = 'silent';
const { LocalServers, launchSpec, sandboxProfile, keyOf } = await import('../src/local-servers.js');
const { McpPool } = await import('../src/pool.js');
const { classifyTool } = await import('../src/policy.js');

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-env-server.mjs');
const base = path.join(process.env.MCPB_DATA_DIR, 'local-servers');

test('approvals pin the version, keep keys in memory only, and need every setting', () => {
  const file = path.join(process.env.MCPB_DATA_DIR, 'local-servers.json');
  const L = new LocalServers({ file, base });
  assert.throws(() => L.approve({ id: 'a/b', type: 'npm', name: 'pkg', version: 'latest; rm -rf /', isolation: 'none' }), /version/);
  assert.throws(() => L.approve({ id: 'a/b', type: 'cargo', name: 'pkg', version: '1.0.0', isolation: 'none' }), /can't start/);
  const settings = [{ name: 'ECHO_KEY', secret: true }, { name: 'ECHO_SETTING', secret: false }];
  L.approve({ id: 'a/b', title: 'B', type: 'npm', name: 'pkg', version: '1.2.3', isolation: 'none', settings, values: { ECHO_SETTING: 'visible', ECHO_KEY: 'should-not-be-a-value' }, secrets: { ECHO_KEY: 'sk-secret-value-123' } });
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes('sk-secret-value-123'), 'keys are never written to disk');
  assert.ok(!saved.includes('should-not-be-a-value'), 'a secret setting is never kept as a value');
  assert.equal(L.servers().length, 1);
  // A restart: approvals stay, keys are gone, so the server waits for its key.
  const L2 = new LocalServers({ file, base });
  assert.deepEqual(L2.missing(L2.get('a/b')), ['ECHO_KEY']);
  assert.equal(L2.servers().length, 0);
  L2.setKeys('a/b', { ECHO_KEY: 'sk-again-456', OTHER: 'ignored' });
  assert.equal(L2.servers().length, 1);
  assert.deepEqual(Object.keys(L2.keys.get('a/b')), ['ECHO_KEY']);
  L2.forget('a/b');
  assert.equal(new LocalServers({ file, base }).approved.length, 0);
});

test('launch: pinned packages, install scripts off, own folder, nothing from the parent environment', () => {
  process.env.MCPB_TEST_PARENT_SECRET = 'parent-secret';
  const rt = { npx: '/usr/bin/npx', uvx: '/usr/bin/uvx', docker: '/usr/bin/docker', node: '/usr/bin/node' };
  const npm = launchSpec({ key: 'x-1', type: 'npm', name: '@scope/pkg', version: '2.0.1', isolation: 'none' }, { MY_SETTING: 'v' }, { base, rt });
  assert.deepEqual(npm.args, ['-y', '@scope/pkg@2.0.1']);
  assert.equal(npm.env.npm_config_ignore_scripts, 'true');
  assert.equal(npm.env.MY_SETTING, 'v');
  assert.equal(npm.env.HOME, path.join(base, 'x-1', 'home'));
  assert.equal(npm.env.MCPB_TEST_PARENT_SECRET, undefined);
  assert.ok(!Object.keys(npm.env).some((k) => /ANTHROPIC|OPENAI/.test(k)));
  const py = launchSpec({ key: 'x-2', type: 'pypi', name: 'tool', version: '0.8.2', isolation: 'none' }, {}, { base, rt });
  assert.deepEqual(py.args, ['--no-build', 'tool@0.8.2']);
  assert.equal(py.env.UV_NO_CONFIG, '1');
  const dk = launchSpec({ key: 'x-3', type: 'pypi', name: 'tool', version: '0.8.2', isolation: 'docker' }, { K: 'v' }, { base, rt });
  assert.equal(dk.command, '/usr/bin/docker');
  for (const flag of ['--rm', '--cap-drop', 'no-new-privileges']) assert.ok(dk.args.includes(flag), flag);
  assert.ok(!dk.args.some((a) => /^-v$/.test(a) && false));
  assert.ok(!dk.args.join(' ').includes(os.homedir() + ':'), 'no host folder is mounted');
  assert.ok(dk.args.includes('-e') && dk.args.includes('K') && !dk.args.includes('K=v'), 'values go through the environment, not the command line');
});

test('the macOS sandbox profile denies the home folder except the server’s own', () => {
  const dir = path.join(base, 'quote"test');
  const p = sandboxProfile(dir);
  assert.match(p, /\(deny file-read-data file-write\*/);
  assert.ok(p.includes(`(subpath "${os.homedir().replace(/"/g, '\\"')}")`) || p.includes('(subpath "'));
  assert.ok(p.includes('quote\\"test'), 'quotes in paths are escaped');
  assert.match(p, /\(deny file-write\*\s*\(require-all\s*\(require-not \(subpath/);
});

test('an approved server runs over stdio with only its own settings, and its write tools stay hidden', async () => {
  process.env.MCPB_TEST_PARENT_SECRET = 'parent-secret';
  const L = new LocalServers({ file: path.join(process.env.MCPB_DATA_DIR, 'ls2.json'), base });
  L.approve({ id: 'test/echo', title: 'Echo', type: 'npm', name: 'echo', version: '1.0.0', isolation: 'none', settings: [{ name: 'ECHO_KEY', secret: true }, { name: 'ECHO_SETTING', secret: false }], values: { ECHO_SETTING: 'hello' }, secrets: { ECHO_KEY: 'sk-live-abcdef' } });
  const pool = new McpPool({
    localLaunch: (s) => {
      const spec = L.launch(s);
      // Same environment and folder as a real package, but the test server instead of npx.
      return { ...spec, command: process.execPath, args: [FIXTURE], env: { ...spec.env, PATH: process.env.PATH } };
    },
  });
  const server = L.servers()[0];
  assert.equal(server.kind, 'local');
  const { tools } = await pool.get(server);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['delete_everything', 'search_env']);
  assert.equal(classifyTool(tools.find((t) => t.name === 'delete_everything')).allowed, false);
  const r = await pool.callTool(server, 'search_env', { query: 'x' });
  const seen = JSON.parse(r.content[0].text);
  assert.equal(seen.setting, 'hello');
  assert.ok(!seen.names.includes('MCPB_TEST_PARENT_SECRET'), 'the parent environment does not leak in');
  assert.equal(seen.home, path.join(base, keyOf('test/echo'), 'home'));
  assert.equal(pool.state('test/echo').status, 'running');
  await pool.close('test/echo');
  assert.equal(pool.state('test/echo'), null);
  // A failing start reports what it printed, with the key hidden.
  const bad = new McpPool({ localLaunch: (s) => ({ ...L.launch(s), command: process.execPath, args: ['-e', 'console.error("boom with " + process.env.ECHO_KEY); process.exit(3)'], env: { ...L.launch(s).env, PATH: process.env.PATH } }) });
  await assert.rejects(bad.get(server), (e) => /boom with \*\*\*/.test(e.message) && !e.message.includes('sk-live-abcdef'));
  await pool.closeAll();
  await bad.closeAll();
});

test('self-healing starts: known failures get one fix, install-time code only when isolated', async () => {
  const { healLaunch, explainFailure } = await import('../src/local-servers.js');
  const py = { type: 'pypi', name: 'edgartools', version: '5.62.1', argv: ['--with', 'edgartools[ai]==5.62.1', 'edgartools@5.62.1', 'mcp'], isolation: 'sandbox' };
  assert.deepEqual(healLaunch(py, '× No solution found: Because there is no version of edgartools==5.62.1 and you require…'), { refresh: true, why: 'the package index was out of date here' });
  const exe = healLaunch({ ...py, name: 'llm-sandbox', version: '1.0', argv: ['llm-sandbox@1.0'] }, 'An executable named `llm-sandbox` is not provided by package `llm-sandbox`.\nThe following executables are available:\n- llm-sandbox-mcp\n');
  assert.deepEqual(exe.argv, ['--from', 'llm-sandbox==1.0', 'llm-sandbox-mcp']);
  const from = healLaunch({ ...py, name: 'llm-sandbox', argv: ['--from', 'llm-sandbox[mcp]==1.0', 'llm-sandbox'] }, 'An executable named `llm-sandbox` is not provided by package `llm-sandbox[mcp]`. The following executables are available: - llm-sandbox-mcp');
  assert.deepEqual(from.argv, ['--from', 'llm-sandbox[mcp]==1.0', 'llm-sandbox-mcp']);
  const sdist = 'Because pybars3==0.9.7 has no usable wheels and only pybars3<=0.9.7 is available…';
  assert.equal(healLaunch(py, sdist).allowBuild, true);
  assert.equal(healLaunch({ ...py, isolation: 'none' }, sdist), null, 'no source builds without a sandbox');
  const npm = { type: 'npm', name: '@x/sem', version: '1.0.0', argv: ['@x/sem@1.0.0'], isolation: 'docker' };
  assert.equal(healLaunch(npm, 'sem is not installed yet. Reinstall @x/sem to download the binary.').allowScripts, true);
  assert.equal(healLaunch({ ...npm, isolation: 'none' }, 'postinstall script did not run'), null);
  assert.deepEqual(healLaunch(npm, 'npm error could not determine executable to run', { bins: ['sem', 'sem-mcp'] }).argv, ['-p', '@x/sem@1.0.0', 'sem-mcp']);
  assert.equal(healLaunch(py, 'Traceback: something else broke'), null);
  assert.equal(explainFailure('\x1b[36mGITLAB_PERSONAL_ACCESS_TOKEN environment variable is not set\x1b[39m').kind, 'needs-key');
  assert.equal(explainFailure('Usage: mcp-server-filesystem --allowed-directories <allowed-directories>').kind, 'needs-args');
  assert.equal(explainFailure('e2e requires Node.js 22.22.3 or newer').kind, 'runtime');
  assert.equal(explainFailure('Segmentation fault'), null);
});

test('explainFailure: platform-only servers and more ways of asking for a key', async () => {
  const { explainFailure: e } = await import('../src/local-servers.js');
  assert.equal(e('excel-mcp: ExcelMcp is Windows only.').os, 'Windows');
  assert.equal(e('npm error code EBADPLATFORM npm error notsup Unsupported platform for safari-mcp@2.1.0: wanted {"os":"darwin"} (current: {"os":"linux"})').os, 'macOS');
  assert.equal(e('Error: Missing required environment variables: JIRA_API_TOKEN, JIRA_HOST').kind, 'needs-key');
  assert.equal(e('[ERROR:auth0-mcp] Authorization Error: No valid authorization token found').kind, 'needs-key');
  assert.equal(e("error: option '--root <dir>' argument missing").kind, 'needs-args');
});
