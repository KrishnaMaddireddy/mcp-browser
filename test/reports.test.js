// The checks as reports: Markdown for the MCP tools, the command line and the GitHub Action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const rows = [row({ worst: 'MODERATE', vulns: [{ id: 'a' }] })];
  assert.deepEqual(['any', 'low', 'moderate', 'high', 'critical', 'never'].map((l) => failsOn(rows, l)), [true, true, true, false, false, false]);
  // (an advisory with no severity label fails at every level: unknown isn't "low")
  assert.deepEqual(['low', 'high', 'critical'].map((l) => failsOn([row({ vulns: [{ id: 'b' }] })], l)), [true, true, true]);
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

test('review fixes: a count-only package is vulnerable, unknown severity fails closed, unchecked never reads clean', () => {
  return import('../src/reports.js').then(({ vulnCount, ghSafe }) => {
    const lodash = row({ name: 'lodash', version: '4.17.4', partial: true, counts: { osv: 57, audit: 0 } });
    const off = row({ name: 'left-pad', version: '1.0.0', checked: false });
    const clean = row({ name: 'ok', version: '1.0.0' });
    assert.equal(vulnCount(lodash), 57);
    assert.equal(failsOn([lodash], 'critical'), true); // (no severity label: fails at every level)
    assert.throws(() => failsOn([clean], 'critcal'));
    const out = depsMarkdown({ rows: [clean, off, lodash], summary: { checked: 2, vulnerable: 1, high: 0, deprecated: 0 }, servers: {} }, { compact: true });
    const [open] = out.split('<details>');
    assert.match(open, /\| lodash \(npm\) \| 4\.17\.4 \| 57/);
    assert.match(out, /; 1 not checked/);
    assert.match(out, /<summary>1 package not checked/);
    assert.doesNotMatch(out.split('not checked (no pinned')[1].split('</details>')[0], /\| ok \(npm\)/);
    // the cut says what it cut
    const many = [lodash, ...Array.from({ length: 5 }, (_, i) => row({ name: `u${i}`, checked: false }))];
    assert.match(depsMarkdown({ rows: many, summary: { checked: 1, vulnerable: 1 }, servers: {} }, { limit: 2 }), /… and 4 more: 4 not checked\./);
    // GitHub: third-party text can't mention or link; our own links stay links
    assert.equal(ghSafe('ping @octocat at https://evil.example'), 'ping @⁠octocat at https:⁠//evil.example');
    const linky = depsMarkdown({ rows: [row({ name: 'x', vulns: [{ id: 'GHSA-1', summary: 'cc @admins see https://evil.example', severity: 'HIGH', aliases: [], fixedVersions: [] }], worst: 'HIGH' })], summary: { checked: 1, vulnerable: 1 }, servers: {} }, { compact: true });
    assert.match(linky, /\(https:\/\/github\.com\/KrishnaMaddireddy\/mcp-browser\)/);
    assert.match(linky, /\(https:\/\/osv\.dev\/vulnerability\/GHSA-1\)/);
    assert.doesNotMatch(linky, /@admins|https:\/\/evil/);
    // control and direction characters never reach a terminal or a reader
    assert.equal(md('a\u001b[2Jb‮c'), 'a[2Jbc'.replace('[', '\\['));
  });
});

test('review fixes: the whole compact comment stays under GitHub\'s limit, problems included', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row({ name: `pkg-${i}`, worst: 'HIGH', vulns: [{ id: `GHSA-${i}-a`, summary: 'x'.repeat(150), severity: 'HIGH', aliases: ['CVE-2026-0001'], fixedVersions: ['9.9.9'] }, { id: `GHSA-${i}-b`, summary: 'y'.repeat(150), severity: 'HIGH', aliases: [], fixedVersions: [] }] }));
  const out = depsMarkdown({ rows, summary: { checked: 1000, vulnerable: 1000, high: 1000 }, servers: {} }, { compact: true, limit: 1000 });
  assert.ok(out.length < 60000, `${out.length} characters`);
  assert.match(out, /… and \d+ more: \d+ with known vulnerabilities\./);
  assert.match(out, /… and \d+ more advisories/);
  const off = Array.from({ length: 1000 }, (_, i) => row({ name: `pkg-${i}`, checked: false }));
  assert.ok(depsMarkdown({ rows: off, summary: { checked: 0 }, servers: {} }, { compact: true, limit: 1000 }).length < 60000);
});

test('review fixes: a link is never read as a dependency file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-link-'));
  fs.writeFileSync(path.join(dir, 'token'), 'SECRET=1');
  fs.symlinkSync(path.join(dir, 'token'), path.join(dir, 'requirements.txt'));
  assert.throws(() => readDependencyFile(path.join(dir, 'requirements.txt')), /link/);
  fs.mkdirSync(path.join(dir, 'requirements'));
  fs.writeFileSync(path.join(dir, 'requirements', 'base.txt'), 'flask==2.0.0\n');
  assert.equal(readDependencyFile(path.join(dir, 'requirements', 'base.txt')), 'flask==2.0.0\n');
});
