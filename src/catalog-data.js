// Where the MCP server catalog lives: a build in the data dir or the snapshot that
// ships with the app (src/data/catalog.json.gz), whichever is newer, so an app
// update's snapshot replaces an older local build. Same for the per-server tool
// lists (catalog-tools.json.gz).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

function find(base) {
  let best = null;
  for (const [p, gzip] of [[path.join(dataDir(), base + '.gz'), true], [path.join(dataDir(), base), false], [path.join(BUNDLED, base + '.gz'), true]]) {
    try {
      const st = fs.statSync(p);
      if (st.size > 0 && (!best || st.mtimeMs > best.mtime)) best = { path: p, gzip, mtime: st.mtimeMs };
    } catch {
      /* not there */
    }
  }
  return best && { path: best.path, gzip: best.gzip };
}

export const catalogFile = () => find('catalog.json');

let toolsCache = null; // { path, mtime, data }
/** Tool list of one catalog server, or null. */
export function catalogTools(id) {
  const f = find('catalog-tools.json');
  if (!f) return null;
  const mtime = fs.statSync(f.path).mtimeMs;
  if (!toolsCache || toolsCache.path !== f.path || toolsCache.mtime !== mtime) {
    const buf = fs.readFileSync(f.path);
    toolsCache = { path: f.path, mtime, data: JSON.parse((f.gzip ? zlib.gunzipSync(buf) : buf).toString('utf8')) };
  }
  return Object.hasOwn(toolsCache.data, id) ? toolsCache.data[id] : null;
}
