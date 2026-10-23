// Dependency check: reading manifests, versions and fixes, and merging two OSV servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseManifest, baseVersion, cmpVersion, fixVersion, runDeps, DEP_SERVERS } = await import('../src/deps.js');

test('manifests: package.json, requirements.txt and plain lists', () => {
  const npm = parseManifest(JSON.stringify({ dependencies: { lodash: '^4.17.15', '@scope/pkg': '~1.2.3', web: 'git+https://x/y.git' }, devDependencies: { jest: '29.0.0' } }));
  assert.deepEqual(npm.map((p) => [p.name, p.version, p.ecosystem, p.dev]), [['lodash', '4.17.15', 'npm', false], ['@scope/pkg', '1.2.3', 'npm', false], ['web', null, 'npm', false], ['jest', '29.0.0', 'npm', true]]);
  const py = parseManifest('# app\nrequests==2.19.0\nDjango>=3.2,<4\nflask[async]==2.3.2  # web\n-r other.txt\n');
  assert.deepEqual(py.map((p) => [p.name, p.version, p.ecosystem]), [['requests', '2.19.0', 'pypi'], ['Django', '3.2', 'pypi'], ['flask', '2.3.2', 'pypi']]);
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
