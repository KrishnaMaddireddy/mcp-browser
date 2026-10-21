import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-audit-'));
const { auditInstalled, configPaths } = await import('../src/audit.js');

test('audit reads client configs, matches the registry and never returns secret values', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-home-'));
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      context7: { url: 'https://mcp.context7.com/mcp' },
      gh: { command: 'npx', args: ['-y', 'some-unknown-github-mcp'], env: { GITHUB_TOKEN: secret, LOG_LEVEL: 'debug' } },
      plain: { url: 'http://example.com/mcp' },
    },
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/repo': { mcpServers: { sentry: { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: '${SENTRY_TOKEN}' } } } } } }));
  const r = auditInstalled({ paths: configPaths(home, 'darwin', {}) });
  const out = JSON.stringify(r);
  assert.ok(!out.includes(secret), 'secret value leaked');
  const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
  assert.equal(by.context7.catalog?.server_id, 'io.github.upstash/context7');
  assert.match(by.gh.checks.map((c) => c.text).join(' '), /GITHUB_TOKEN is stored in plain text/);
  assert.ok(!by.gh.checks.some((c) => /LOG_LEVEL/.test(c.text)));
  assert.match(by.gh.checks.map((c) => c.text).join(' '), /latest version/);
  assert.equal(by.plain.level, 'bad');
  assert.equal(by.sentry.scope, '/repo');
  assert.ok(!by.sentry.checks.some((c) => /plain text/.test(c.text)), 'env reference is not a plain secret');
  assert.ok(!by.sentry.checks.some((c) => /latest version/.test(c.text)), 'pinned version');
  assert.equal(r.files.find((f) => f.client === 'Claude Desktop').found, false);
});
