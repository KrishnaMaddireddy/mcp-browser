// Real-network checks (opt in: MCPB_LIVE=1 npm run test:live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const live = process.env.MCPB_LIVE === '1';
process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-live-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { createEngine } = await import('../src/app.js');
const { CURATED } = await import('../src/curated.js');

test('every curated server answers without credentials', { skip: !live, timeout: 120000 }, async () => {
  const e = createEngine({ providerOverride: null });
  const res = await e.probe(CURATED.map((s) => s.id));
  await e.close();
  const failed = res.filter((r) => !r.ok);
  for (const r of res) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.ok ? `${r.tools} tools` : r.error}`);
  assert.ok(failed.length <= 2, `too many curated servers down: ${failed.map((f) => f.id).join(', ')}`);
});

test('free-mode web search returns sources', { skip: !live, timeout: 60000 }, async () => {
  const e = createEngine({ providerOverride: null });
  const r = await e.agent.search('model context protocol specification', { servers: ['exa'] });
  await e.close();
  assert.equal(r.mode, 'direct');
  assert.ok(r.sources.length > 0);
});
