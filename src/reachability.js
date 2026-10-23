// Which registry servers answered an anonymous connect when last probed
// (scripts/probe-registry.js). Ships as a snapshot; a newer copy in the data dir
// wins. Routing skips servers found dead, sign-in-only, blocked or paid, unless
// this app has since seen them work (live health always overrides).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'reachability.json');
export const UNREACHABLE = new Set(['dead', 'auth', 'blocked', 'paid']);

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'answer-tests.json');
/**
 * Which servers answered a real sample question when tested (scripts/probe-hosted.mjs,
 * scripts/probe-packages.mjs): id → a (answered) | s (connected, nothing useful) |
 * i (its tools need an AI model) | f (failed). A newer copy in the data dir wins.
 */
export function loadAnswerTests(files = [TESTS, path.join(dataDir(), 'answer-tests.json')]) {
  const servers = new Map();
  let checkedAt = null;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [id, v] of Object.entries(j.servers || {})) servers.set(id, v);
      if (j.checkedAt && (!checkedAt || j.checkedAt > checkedAt)) checkedAt = j.checkedAt;
    } catch {
      /* none yet */
    }
  }
  return { servers, checkedAt };
}

export function loadReachability(files = [SNAPSHOT, path.join(dataDir(), 'reachability.json')]) {
  const servers = new Map();
  let checkedAt = null;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [id, v] of Object.entries(j.servers || {})) servers.set(id, v);
      if (j.checkedAt && (!checkedAt || j.checkedAt > checkedAt)) checkedAt = j.checkedAt;
    } catch {
      /* none yet */
    }
  }
  return { servers, checkedAt };
}
