import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-catalog-'));
process.env.MCPB_LOG = 'silent';
const { createServer } = await import('../src/server.js');
const { createEngine } = await import('../src/app.js');
const { catalogFile } = await import('../src/catalog-data.js');
const { categorize } = await import('../scripts/catalog/categories.mjs');

let app;
let base;
before(async () => {
  const engine = createEngine({ providerOverride: null, curated: [], extraServers: [], embeddings: null });
  app = createServer({ engine, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(() => app.close());

test('the bundled catalog ships and is served, gzipped or plain', async () => {
  assert.match(catalogFile().path, /src[\\/]data[\\/]catalog\.json\.gz$/);
  const r = await fetch(`${base}/api/catalog`);
  assert.equal(r.status, 200);
  const d = await r.json(); // fetch decodes content-encoding: gzip
  assert.ok(d.rows.length > 1000);
  for (const f of ['name', 'cat', 'stars', 'downloads', 'added', 'repo', 'website']) assert.ok(d.fields.includes(f), f);
  assert.equal(d.rows[0].length, d.fields.length);
});

test('a fresh build in the data dir wins over the bundled snapshot', async () => {
  const mine = { generatedAt: '2026-10-21T00:00:00Z', cats: [['other', 'Other']], fields: ['name'], rows: [['x/y']] };
  fs.writeFileSync(path.join(process.env.MCPB_DATA_DIR, 'catalog.json.gz'), zlib.gzipSync(JSON.stringify(mine)));
  const d = await fetch(`${base}/api/catalog`).then((r) => r.json());
  assert.deepEqual(d.rows, [['x/y']]);
  fs.rmSync(path.join(process.env.MCPB_DATA_DIR, 'catalog.json.gz'));
});

test('category rules read what a server does, not who it is for', () => {
  assert.equal(categorize({ name: 'io.github.someone/pg', title: 'Postgres MCP', description: 'Read-only SQL queries against PostgreSQL for AI agents' }).cat, 'data');
  assert.equal(categorize({ name: 'io.github.someone/wx', title: 'Weather', description: 'Forecasts for any city, for Claude and Cursor' }).cat, 'places');
  assert.equal(categorize({ name: 'io.github.someone/x', title: 'Thing', description: 'Does stuff' }).cat, 'other');
});
