// The checks as reports: Markdown for the MCP tools, the command line and the GitHub Action.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { depsMarkdown, failsOn, md, mdUrl, paragraphMarkdown } = await import('../src/reports.js');
const { readDependencyFile } = await import('../src/mcp-server.js');

const row = (o) => ({ name: 'x', ecosystem: 'npm', version: '1.0.0', range: '1.0.0', vulns: [], counts: { osv: 0, audit: 0 }, checked: true, ...o });

test('dependency report: worst first, escaped, the direct dependency that brings problems in', () => {
  const rows = [
    row({ name: 'lodash', version: '4.18.1' }),
    row({ name: 'qs', version: '6.7.0', indirect: true, via: ['express'], worst: 'HIGH', fix: '6.7.3', vulns: [{ id: 'GHSA-1', summary: 'Prototype <img src=x> pollution', severity: 'HIGH', aliases: ['CVE-2022-24999'], fixedVersions: ['6.7.3'] }] }),
    row({ name: 'express', version: '4.17.1', worst: 'MODERATE', vulns: [{ id: 'GHSA-2', summary: 'open redirect', severity: 'MODERATE', aliases: [], fixedVersions: ['4.20.0'] }] }),
  ];
  const out = depsMarkdown({ rows, summary: { checked: 3, vulnerable: 2, high: 1, deprecated: 0 }, servers: { osv: { ok: true, title: 'OSV | evil', key: 'osv' } } }, { date: '2026-10-23' });
  assert.match(out, /^## Dependency check: 2 of 3 packages have known vulnerabilities, 1 with high or critical ones/);
  assert.ok(out.indexOf('| qs (npm)') < out.indexOf('| express (npm)') && out.indexOf('| express (npm)') < out.indexOf('| lodash (npm)'));
  assert.match(out, /All 2 packages with known vulnerabilities come in through express/);
  assert.ok(!/[^\\]<img/.test(out) && out.includes('\\<img'));
  assert.ok(out.includes('OSV \\| evil'));
  // nothing answered: never a clean result
  assert.match(depsMarkdown({ rows: [row({ checked: false })], summary: { checked: 0, vulnerable: 0 } }), /Nothing was checked/);
});

test('--fail-on: a severity line, "any", and unlabelled advisories', () => {
  const rows = [row({ worst: 'MODERATE', vulns: [{ id: 'a' }] }), row({ vulns: [{ id: 'b' }] })];
  assert.deepEqual(['any', 'low', 'moderate', 'high', 'critical', 'never'].map((l) => failsOn(rows, l)), [true, true, true, false, false, false]);
  assert.equal(failsOn([row({})], 'any'), false);
  assert.throws(() => failsOn(rows, 'severe'));
});

test('MCP check_dependencies reads dependency files only', () => {
  assert.throws(() => readDependencyFile('/etc/passwd'), /only dependency files/);
  assert.throws(() => readDependencyFile('/home/me/.ssh/id_rsa'), /only dependency files/);
  assert.match(readDependencyFile(new URL('../package.json', import.meta.url).pathname), /"name"/);
});

test('escaping: markup and link targets', () => {
  assert.equal(md('a | b *c* [d](e) <x>'), 'a \\| b \\*c\\* \\[d\\](e) \\<x\\>');
  assert.equal(mdUrl('javascript:alert(1)'), '');
  assert.equal(mdUrl('https://a.example/x (y)'), 'https://a.example/x%20%28y%29');
  const p = paragraphMarkdown({ claims: [{ claim: 'A [b](c) is 3 m', result: { verdict: 'contradicted', label: '2 sources say something different', evidence: [{ stance: 'differs', sentence: 'It is 4 m', source: 's', url: 'https://s.example' }] } }, { claim: '', sentence: 'You should go.', skip: 'an opinion' }] });
  assert.match(p, /A \\\[b\\\]\(c\) is 3 m/);
  assert.match(p, /Not checked: “You should go\.”/);
});

test('dependency report, compact (pull request comment): problems open, clean rest folded, under GitHub size limit', () => {
  const rows = [row({ name: 'ok-a' }), row({ name: 'bad', worst: 'HIGH', vulns: [{ id: 'GHSA-9', summary: 's', severity: 'HIGH', aliases: [], fixedVersions: [] }] }), row({ name: 'old', deprecated: true })];
  const out = depsMarkdown({ rows, summary: { checked: 3, vulnerable: 1, high: 1, deprecated: 1 }, servers: {} }, { compact: true });
  const [open, folded] = out.split('<details>');
  assert.match(open, /\| bad \(npm\)/);
  assert.match(open, /\| old \(npm\)/);
  assert.doesNotMatch(open, /ok-a/);
  assert.match(folded, /The other 1 package: no known vulnerabilities/);
  assert.match(folded, /ok-a/);
  const many = Array.from({ length: 1000 }, (_, i) => row({ name: `package-number-${i}`, indirect: true, via: ['some-direct-dependency'] }));
  const big = depsMarkdown({ rows: many, summary: { checked: 1000, vulnerable: 0 }, servers: {} }, { compact: true, limit: 1000 });
  assert.ok(big.length < 60000, `comment is ${big.length} characters`);
  assert.match(big, /… and \d+ more\./);
});

test('package cap: a lockfile keeps direct dependencies first, up to max', async () => {
  const { parseManifest } = await import('../src/deps.js');
  const packages = { '': { dependencies: { d0: '1.0.0' } }, 'node_modules/d0': { version: '1.0.0' } };
  for (let i = 0; i < 400; i++) packages[`node_modules/i${i}`] = { version: '1.0.0' };
  const lock = JSON.stringify({ lockfileVersion: 3, packages });
  assert.equal(parseManifest(lock).length, 150);
  const all = parseManifest(lock, { max: 1000 });
  assert.equal(all.length, 401);
  assert.equal(all[0].name, 'd0');
  assert.equal(all.total, 401);
});
