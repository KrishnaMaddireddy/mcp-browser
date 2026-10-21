// Where the MCP server catalog lives: a fresh build in the data dir wins over
// the snapshot that ships with the app (src/data/catalog.json.gz).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'catalog.json.gz');

export function catalogFile() {
  for (const [p, gzip] of [[path.join(dataDir(), 'catalog.json.gz'), true], [path.join(dataDir(), 'catalog.json'), false], [BUNDLED, true]]) {
    try {
      if (fs.statSync(p).size > 0) return { path: p, gzip };
    } catch {
      /* not there */
    }
  }
  return null;
}
