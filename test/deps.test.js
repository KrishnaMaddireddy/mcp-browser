// Dependency check: reading manifests, versions and fixes, and merging two OSV servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseManifest, baseVersion, cmpVersion, fixVersion, runDeps, DEP_SERVERS, repoOf, fetchRepoDeps, PAGE_FETCH } = await import('../src/deps.js');

test('manifests: package.json, requirements.txt and plain lists', () => {
  const npm = parseManifest(JSON.stringify({ dependencies: { lodash: '^4.17.15', '@scope/pkg': '~1.2.3', web: 'git+https://x/y.git' }, devDependencies: { jest: '29.0.0' } }));
  assert.deepEqual(npm.map((p) => [p.name, p.version, p.ecosystem, p.dev]), [['lodash', '4.17.15', 'npm', false], ['@scope/pkg', '1.2.3', 'npm', false], ['web', null, 'npm', false], ['jest', '29.0.0', 'npm', true]]);
  const py = parseManifest('# app\nrequests==2.19.0\nDjango>=3.2,<4\nflask[async]==2.3.2  # web\n-r other.txt\n');
  // (only == pins a version: ">=3.2" installs the latest)
  assert.deepEqual(py.map((p) => [p.name, p.version, p.ecosystem]), [['requests', '2.19.0', 'pypi'], ['Django', null, 'pypi'], ['flask', '2.3.2', 'pypi']]);
  assert.deepEqual(parseManifest('urllib3!=1.24.1\nidna~=3.4').map((p) => [p.name, p.version, p.range]), [['urllib3', null, '!=1.24.1'], ['idna', '3.4', '~3.4']]);
  const cargo = parseManifest('[package]\nname = "myapp"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1.28"\n\n[tool.poetry.dependencies]\npython = "^3.9"\nrequests = "^2.19"');
  assert.deepEqual(cargo.map((p) => [p.name, p.version, p.ecosystem]), [['serde', '1.0', 'cargo'], ['tokio', '1.28', 'cargo'], ['requests', '2.19', 'pypi']]);
  assert.deepEqual(parseManifest('lodash@4.17.15\naxios@0.21.0').map((p) => [p.name, p.version, p.ecosystem]), [['lodash', '4.17.15', 'npm'], ['axios', '0.21.0', 'npm']]);
  assert.throws(() => parseManifest('{ not json'));
  assert.equal(baseVersion('latest'), null);
  assert.equal(baseVersion('>=1.2.0 <2'), '1.2.0');
});

test('versions: numeric order, and the one fix that covers every advisory', () => {
  assert.ok(cmpVersion('4.17.21', '4.17.9') > 0);
  assert.ok(cmpVersion('0.21.0', '0.21.0') === 0);
  assert.deepEqual(fixVersion('4.17.15', [{ fixedVersions: ['4.17.21'] }, { fixedVersions: ['4.18.0'] }, { fixedVersions: ['4.17.19'] }]), { version: '4.18.0', unfixed: false });
  // (the same major line is preferred: 0.21 → 0.31.1, not 1.15.2)
  assert.deepEqual(fixVersion('0.21.0', [{ fixedVersions: ['1.15.2', '0.31.1'] }]), { version: '0.31.1', unfixed: false });
  assert.equal(fixVersion('2.88.2', [{ fixedVersions: [] }]).unfixed, true);
  assert.ok(cmpVersion('2.0.0-rc.1', '2.0.0') < 0);
  assert.deepEqual(fixVersion('5.0.0', [{ fixedVersions: ['1.2.5', '2.3.4', '3.1.0', '4.0.1', '5.0.2'] }]), { version: '5.0.2', unfixed: false });
});

test('two OSV servers side by side: aliases count once, switched-off servers are skipped', async () => {
  const pkgs = parseManifest('requests==2.19.0\npyyaml==5.3');
  const calls = [];
  const callTool = async (id, tool, args) => {
    calls.push([id, tool]);
    if (id === DEP_SERVERS.osv) {
      assert.equal(args.packages.length, 1);
      const all = [
            { name: 'requests', ecosystem: 'PyPI', version: '2.19.0', vulns: [{ id: 'GHSA-x84v', aliases: ['CVE-2018-18074', 'PYSEC-2018-28'], severityLabel: 'HIGH', fixedVersions: ['2.20.0'] }, { id: 'PYSEC-2018-28', aliases: ['GHSA-x84v'], severityLabel: '', fixedVersions: ['2.20.0'] }] },
            { name: 'pyyaml', ecosystem: 'PyPI', version: '5.3', vulns: [] },
      ];
      const one = all.find((x) => x.name === args.packages[0].name);
      // (a long reply comes back paged: the first rows in "preview")
      return one.name === 'pyyaml' ? { structuredContent: { summary: { totalVulns: 0 }, preview: { rows: [{ key: '0', value: one }] } } } : { structuredContent: { results: [one] } };
    }
    if (id === DEP_SERVERS.audit) {
      assert.equal(args.ecosystem, 'pypi');
      return { structuredContent: { findings: [{ name: 'requests', vulnerability_count: 2, vulnerability_ids: ['GHSA-x84v', 'PYSEC-2018-28'] }] } };
    }
    throw new Error('switched off in Settings');
  };
  const rows = [];
  let done = null;
  const servers = [];
  await runDeps(pkgs, { callTool, emit: (t, d) => (t === 'deps_row' ? rows.push(d) : t === 'deps_done' ? (done = d) : t === 'deps_server' ? servers.push(d) : null) });
  const req = rows.find((r) => r.name === 'requests');
  assert.deepEqual([req.vulns.length, req.counts, req.agree, req.fix, req.worst], [1, { osv: 1, audit: 1, comparable: true }, true, '2.20.0', 'HIGH']);
  assert.equal(rows.find((r) => r.name === 'pyyaml').counts.audit, 0);
  assert.deepEqual([done.summary.vulnerable, done.summary.agreed, done.sources.health], [1, 2, false]);
  assert.equal(servers.find((s) => s.key === 'health').ok, false);
});

test('no server answered: nothing reads "none known"', async () => {
  const rows = [];
  let done = null;
  await runDeps(parseManifest('lodash@4.17.15'), { callTool: async () => { throw new Error('off'); }, emit: (t, d) => (t === 'deps_row' ? rows.push(d) : t === 'deps_done' ? (done = d) : null) });
  assert.equal(rows[0].checked, false);
  assert.deepEqual([done.summary.checked, done.summary.unchecked, done.summary.vulnerable], [0, 1, 0]);
});

test('lockfiles: installed versions, direct ones first, the rest marked indirect', () => {
  const npm = parseManifest(JSON.stringify({ name: 't', lockfileVersion: 3, packages: { '': { dependencies: { express: '4.17.1' }, devDependencies: { 'jest-diff': '29.0.0' } }, 'node_modules/body-parser': { version: '1.19.0' }, 'node_modules/express': { version: '4.17.1', dependencies: { 'body-parser': '1.19.0' } }, 'node_modules/jest-diff': { version: '29.0.0', dev: true }, 'node_modules/send/node_modules/ms': { version: '2.1.1' }, 'node_modules/ms': { version: '2.0.0' }, 'node_modules/local': { link: true } } }));
  assert.deepEqual(npm.map((p) => [p.name, p.version, p.indirect, p.dev]), [['express', '4.17.1', false, false], ['jest-diff', '29.0.0', false, true], ['body-parser', '1.19.0', true, false], ['ms', '2.1.1', true, false], ['ms', '2.0.0', true, false]]);
  assert.equal(npm.lockfile, true);
  assert.deepEqual(npm.find((p) => p.name === 'body-parser').via, ['express']);
  const yarn = parseManifest('# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n"@jest/schemas@^29.6.3":\n  version "29.6.3"\n  resolved "https://registry.yarnpkg.com/x.tgz"\n  dependencies:\n    "@sinclair/typebox" "^0.27.8"\n\nlodash@^4.17.15, lodash@^4.17.20:\n  version "4.18.1"\n');
  assert.deepEqual(yarn.map((p) => [p.name, p.version]), [['@jest/schemas', '29.6.3'], ['lodash', '4.18.1']]);
  const pnpm = parseManifest("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      express:\n        specifier: 4.17.1\n        version: 4.17.1\n    devDependencies:\n      jest-diff:\n        specifier: 29.0.0\n        version: 29.0.0\n\npackages:\n\n  '@jest/schemas@29.6.3':\n    resolution: {integrity: sha512-x}\n\n  express@4.17.1:\n    resolution: {integrity: sha512-y}\n\n  jest-diff@29.0.0:\n    resolution: {integrity: sha512-z}\n\nsnapshots:\n\n  '@jest/schemas@29.6.3':\n    dependencies:\n      '@sinclair/typebox': 0.27.12\n");
  assert.deepEqual(pnpm.map((p) => [p.name, p.version, p.indirect, p.dev]), [['express', '4.17.1', false, false], ['jest-diff', '29.0.0', false, true], ['@jest/schemas', '29.6.3', true, false]]);
  const uv = parseManifest('version = 1\nrevision = 3\n\n[[package]]\nname = "idna"\nversion = "2.7"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "requests"\nversion = "2.19.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "t"\nversion = "0.1.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "requests" },\n]\n');
  assert.deepEqual(uv.map((p) => [p.name, p.version, p.ecosystem, p.indirect]), [['requests', '2.19.0', 'pypi', false], ['idna', '2.7', 'pypi', true]]);
  const cargo = parseManifest('# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "libc"\nversion = "0.2.191"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "t"\nversion = "0.1.0"\ndependencies = [\n "time",\n]\n\n[[package]]\nname = "time"\nversion = "0.1.43"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n');
  assert.deepEqual(cargo.map((p) => [p.name, p.version, p.ecosystem, p.indirect]), [['time', '0.1.43', 'cargo', false], ['libc', '0.2.191', 'cargo', true]]);
  assert.deepEqual(uv.find((p) => p.name === 'idna').via, undefined); // (nothing in this excerpt says who needs idna)
  const poetry = parseManifest('# This file is automatically @generated by Poetry 2.4.3 and should not be changed by hand.\n\n[[package]]\nname = "pytest"\nversion = "8.0.0"\ngroups = ["dev"]\n\n[[package]]\nname = "requests"\nversion = "2.19.0"\ngroups = ["main"]\n');
  assert.deepEqual(poetry.map((p) => [p.name, p.version, p.ecosystem, p.dev]), [['pytest', '8.0.0', 'pypi', true], ['requests', '2.19.0', 'pypi', false]]);
  // (a package.json is still a manifest, not a lockfile)
  assert.equal(parseManifest(JSON.stringify({ dependencies: { lodash: '4.17.15' } })).lockfile, undefined);
});

test('one package at two versions: each version gets its own advisories', async () => {
  const pkgs = parseManifest(JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '1' } }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/ms': { version: '2.0.0' }, 'node_modules/a/node_modules/ms': { version: '0.7.0' } } }));
  const callTool = async (id, tool, args) => {
    if (id === DEP_SERVERS.osv) {
      const p = args.packages[0];
      return { structuredContent: { results: [{ name: p.name, ecosystem: 'npm', version: p.version, vulns: p.name === 'ms' && p.version === '0.7.0' ? [{ id: 'GHSA-ms', aliases: [], severityLabel: 'MODERATE', fixedVersions: ['0.7.1'] }] : [] }] } };
    }
    if (id === DEP_SERVERS.audit) return { structuredContent: { findings: [{ name: 'ms', version: '0.7.0', vulnerability_count: 1, vulnerability_ids: ['GHSA-ms'] }] } };
    throw new Error('off');
  };
  const rows = [];
  let start = null;
  await runDeps(pkgs, { callTool, emit: (t, d) => (t === 'deps_row' ? rows.push(d) : t === 'deps_start' ? (start = d) : null) });
  const ms = rows.filter((r) => r.name === 'ms').map((r) => [r.version, r.vulns.length, r.counts.audit, r.indirect]);
  assert.deepEqual(ms, [['2.0.0', 0, 0, true], ['0.7.0', 1, 1, true]]);
  assert.deepEqual([start.lockfile, start.total, start.indirect], [true, 3, 2]);
});

test('a GitHub repo link: its lockfile per ecosystem, a sub-folder, the workspace root', async () => {
  assert.deepEqual(repoOf('https://github.com/expressjs/express'), { owner: 'expressjs', repo: 'express', ref: 'HEAD', dir: '' });
  assert.deepEqual(repoOf('github.com/vercel/next.js/tree/canary/packages/next'), { owner: 'vercel', repo: 'next.js', ref: 'canary', dir: 'packages/next' });
  // ("..": one repo's packages would show under another's name)
  assert.equal(repoOf('https://github.com/a/b/tree/main/../../x'), null);
  assert.equal(repoOf('https://github.com/nobody-zz9/../tree/../expressjs/express/HEAD'), null);
  assert.equal(repoOf('github.com/a/b/tree/main/src/blob/web').dir, 'src/blob/web');
  assert.equal(repoOf('https://github.com/settings/profile'), null);
  assert.equal(repoOf('https://gitlab.com/a/b'), null);
  const files = {
    'https://raw.githubusercontent.com/o/r/HEAD/package-lock.json': { markdown: '{"lockfileVersion": 3, "packages": {"": {"dependencies": {"qs": "6.7.0"}}, "node_modules/qs": {"version": "6.7.0"}}}' },
    'https://raw.githubusercontent.com/o/r/HEAD/package.json': { markdown: '{"dependencies": {"qs": "^6.7.0"}}' },
    'https://raw.githubusercontent.com/o/r/HEAD/Cargo.lock': { markdown: '[[package]]\nname = "time"\nversion = "0.1.4', truncated: true },
    'https://raw.githubusercontent.com/o/r/HEAD/Cargo.toml': { markdown: '[dependencies]\ntime = "=0.1.43"' },
    'https://raw.githubusercontent.com/o/r/HEAD/pyproject.toml': { markdown: '[project]\ndependencies = ["fastapi>=0.100"]' },
    'https://raw.githubusercontent.com/o/r/HEAD/uv.lock': { markdown: '[[package]]\nname = "fastapi"\nversion = "0.115.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "star', truncated: true },
  };
  const urls = [];
  const callTool = async (id, tool, args) => {
    assert.deepEqual([id, tool], [PAGE_FETCH, 'fetch_page']);
    urls.push(args.url);
    const f = files[args.url];
    return { structuredContent: f ? { status: 'ok', ...f } : { status: 'skipped', reason: 'not_found' } };
  };
  const got = await fetchRepoDeps(repoOf('github.com/o/r'), { callTool });
  // (npm: the whole lockfile; Python: ">=" pins nothing, so the cut-off uv.lock; Rust: the whole Cargo.toml over a cut-off Cargo.lock)
  assert.deepEqual(got.files.map((f) => f.file), ['package-lock.json', 'uv.lock', 'Cargo.toml']);
  assert.deepEqual(got.pkgs.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['npm:qs@6.7.0', 'pypi:fastapi@0.115.0', 'cargo:time@0.1.43']);
  assert.ok(!urls.some((u) => u.includes('/HEAD//')));
  // a sub-folder also looks for the workspace's lockfile at the root
  urls.length = 0;
  await fetchRepoDeps(repoOf('https://github.com/o/r/tree/main/backend'), { callTool });
  assert.ok(urls.includes('https://raw.githubusercontent.com/o/r/main/backend/package.json') && urls.includes('https://raw.githubusercontent.com/o/r/main/uv.lock'));
  const none = await fetchRepoDeps(repoOf('github.com/x/y'), { callTool: async () => { throw new Error('switched off in Settings'); } });
  assert.equal(none.pkgs, null);
  assert.match(none.error, /switched off/);
});

test('review: lockfile edge cases (slow input, pnpm 7 peers, aliases, local packages, nested copies)', () => {
  // blank lines in a TOML lockfile can't make it slow
  const t0 = Date.now();
  parseManifest('[[package]]\nname = "a"\nversion = "1.0"\n' + ' \n'.repeat(80000) + 'x');
  assert.ok(Date.now() - t0 < 1000);
  // pnpm 7: "/react-dom/18.2.0_react@18.2.0" is react-dom 18.2.0
  const v5 = parseManifest("lockfileVersion: 5.4\n\nspecifiers:\n  react-dom: 18.2.0\n\ndependencies:\n  react-dom: 18.2.0_react@18.2.0\n\npackages:\n\n  /loose-envify/1.4.0:\n    resolution: {integrity: sha512-x}\n\n  /react-dom/18.2.0_react@18.2.0:\n    resolution: {integrity: sha512-y}\n    peerDependencies:\n      react: ^18.2.0\n    dependencies:\n      loose-envify: 1.4.0\n");
  assert.deepEqual(v5.map((p) => [p.name, p.version, p.indirect, (p.via || []).join()]), [['react-dom', '18.2.0', false, ''], ['loose-envify', '1.4.0', true, 'react-dom']]);
  // an alias is the real package; workspace and file packages never go to the public servers
  const berry = parseManifest('__metadata:\n  version: 8\n\n"express@npm:4.17.1":\n  version: 4.17.1\n  resolution: "express@npm:4.17.1"\n\n"lodash-old@npm:lodash@4.17.15":\n  version: 4.17.15\n  resolution: "lodash@npm:4.17.15"\n\n"local-pkg@file:./local::locator=secretapp%40workspace%3A.":\n  version: 1.0.0\n  resolution: "local-pkg@file:./local#./local::hash=e04fff"\n\n"secretapp@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "secretapp@workspace:."\n  dependencies:\n    express: "npm:4.17.1"\n    lodash-old: "npm:lodash@4.17.15"\n');
  assert.deepEqual(berry.map((p) => [p.name, p.version, p.indirect]), [['express', '4.17.1', false], ['lodash', '4.17.15', false]]);
  const v1 = parseManifest(JSON.stringify({ lockfileVersion: 1, dependencies: { 'lodash-old': { version: 'npm:lodash@4.17.15' }, mine: { version: 'file:../mine' } } }));
  assert.deepEqual(v1.map((p) => [p.name, p.version]), [['lodash', '4.17.15']]);
  assert.deepEqual(parseManifest('version = 1\n\n[[package]]\nname = "mycorp-internal"\nversion = "3.0.0"\nsource = { path = "dist/x.whl" }\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { virtual = "." }\n').length, 0);
  // a nested copy is indirect even when a direct one shares its name; a null entry doesn't crash
  const nested = parseManifest(JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { ms: '2.1.3', express: '4' } }, 'node_modules/ms': { version: '2.1.3' }, 'node_modules/express': { version: '4.17.1', dependencies: { ms: '2.0.0' } }, 'node_modules/express/node_modules/ms': { version: '2.0.0' }, 'node_modules/x': null } }));
  assert.deepEqual(nested.map((p) => [p.name, p.version, p.indirect, (p.via || []).join()]), [['ms', '2.1.3', false, ''], ['express', '4.17.1', false, ''], ['ms', '2.0.0', true, 'express']]);
  // no list of direct ones (yarn classic, npm v1): the packages nothing else needs
  const classic = parseManifest('# yarn lockfile v1\n\n\nexpress@4.17.1:\n  version "4.17.1"\n  dependencies:\n    accepts "~1.3.7"\n\naccepts@~1.3.7:\n  version "1.3.8"\n');
  assert.deepEqual(classic.map((p) => [p.name, p.indirect, (p.via || []).join()]), [['express', false, ''], ['accepts', true, 'express']]);
});

test('audit service: 100 packages per call, one retry, a failed part stays "not answered"', async () => {
  const pkgs = parseManifest(Array.from({ length: 150 }, (_, i) => `p${i}@1.0.0`).join('\n'));
  const calls = [];
  const callTool = async (id, tool, args) => {
    if (id !== DEP_SERVERS.audit) throw new Error('off');
    calls.push(args.dependencies.length);
    if (args.dependencies[0].name === 'p100') throw new Error('timeout'); // (the second part never answers)
    return { structuredContent: { findings: [], packages_not_found: [] } };
  };
  const rows = [];
  await runDeps(pkgs, { callTool, emit: (t, d) => (t === 'deps_row' ? rows.push(d) : null) });
  assert.deepEqual(calls, [100, 50, 50]);
  assert.equal(rows.find((r) => r.name === 'p5').counts.audit, 0);
  assert.equal(rows.find((r) => r.name === 'p5').checked, true);
  assert.equal(rows.find((r) => r.name === 'p120').checked, false);
});
