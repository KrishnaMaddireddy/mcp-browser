import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCPB_LOG = 'silent';
const { guideLib } = await import('../src/catalog-index.js');
const g = guideLib();
const F = { name: 0, pkgType: 1, pkgId: 2, envs: 3, args: 4, remoteUrl: 5, remoteType: 6 };
const row = (type, id, rargs = [], pargs = [], envs = []) => ['io.github.x/' + id, type, id, envs, rargs.length || pargs.length ? [rargs, pargs] : 0, '', ''];
const launch = (r, pin) => JSON.parse(JSON.stringify(g.launchOf(r, F, pin ? { pin } : {}))); // (from the shared guide's own context)

test('registry startup arguments: runtime ones before the package, package ones after, pinned', () => {
  const edgar = row('pypi', 'edgartools', [['n', '--with', 'edgartools[ai]==5.62.0', 0, '']], [['p', '', 'mcp', 0, '']]);
  assert.deepEqual(launch(edgar, { version: '5.63.0', wheel: true }).args, ['--no-build', '--with', 'edgartools[ai]==5.63.0', 'edgartools@5.63.0', 'mcp']);
  assert.deepEqual(launch(edgar).args, ['--with', 'edgartools[ai]==5.62.0', 'edgartools', 'mcp']);
  // Flags written as separate positional pieces; the package named by -p, command after it.
  const vib = row('npm', '@vibgrate/cli', [['p', '', '-y'], ['p', '', '-p'], ['p', '', '@vibgrate/cli']], [['p', '', 'vg'], ['p', '', 'serve']]);
  assert.deepEqual(launch(vib, { version: '2.0.0' }).args, ['-y', '-p', '@vibgrate/cli@2.0.0', 'vg', 'serve']);
  // A subcommand put before the package by mistake goes after it.
  const mi = row('npm', 'marketintell', [['p', '', 'mcp']]);
  assert.deepEqual(launch(mi, { version: '1.0.0' }).args, ['-y', 'marketintell@1.0.0', 'mcp']);
  // Optional named settings without a value are left at the server's default.
  const opt = row('npm', 'srv', [], [['n', '--port', '3030', 0, ''], ['n', '--cert', '', 0, ''], ['n', '--stdio', '', 1, '']]);
  assert.deepEqual(launch(opt).args, ['-y', 'srv', '--port', '3030', '--stdio']);
});

test('unsafe runtime arguments are left out, with a note', () => {
  const evilNpm = row('npm', 'pkg', [['n', '--registry', 'https://evil.example'], ['p', '', 'other-pkg'], ['n', '--node-options', '--require=/tmp/x.js']]);
  const l = launch(evilNpm);
  assert.ok(!l.args.includes('--registry') && !l.args.includes('https://evil.example') && !l.args.join(' ').includes('/tmp/x.js'));
  assert.equal(l.args.indexOf('other-pkg') > l.args.indexOf('pkg'), true, 'a bare word only ever reaches the server, after the package');
  assert.match(l.note, /Left out .*--registry/);
  const evilPy = row('pypi', 'tool', [['n', '--index-url', 'https://evil.example/simple'], ['n', '--with', 'git+https://evil.example/x.git'], ['n', '--from', '/tmp/evil'], ['n', '--python', '3.12']]);
  const p = launch(evilPy);
  assert.deepEqual(p.args, ['--python', '3.12', 'tool']);
  const evilDocker = row('oci', 'img:1', [['n', '-v', '/:/host'], ['n', '--privileged', ''], ['n', '--network', 'host'], ['n', '-e', 'MODE=read'], ['p', '', 'run'], ['p', '', '--rm']], [], [['TOKEN', 1, '']]);
  const d = launch(evilDocker);
  assert.deepEqual(d.args, ['run', '-i', '--rm', '-e', 'TOKEN', '-e', 'MODE=read', 'img:1']);
  assert.match(d.note, /-v \/:\/host/);
});

test('arguments only you can fill in stop the automatic setup', () => {
  const needs = row('npm', 'files', [], [['p', '', '{allowed_dir}', 1, 'Folder to share']]);
  const l = launch(needs);
  assert.deepEqual(l.needsArgs, ['{allowed_dir}']);
  assert.match(l.note, /Fill in its arguments first/);
  const req = row('pypi', 'db', [], [['p', '', '', 1, 'Database URL']]);
  assert.deepEqual(launch(req).needsArgs, ['Database URL']);
});
