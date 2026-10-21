// node scripts/catalog/run-tools.mjs <registry-latest.json> <tools.json> [hours=1]
import fs from 'node:fs';
process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { probeTools, listable } = await import('./tools.mjs');
const [regFile, outFile, hours = '1'] = process.argv.slice(2);
const latest = JSON.parse(fs.readFileSync(regFile, 'utf8'));
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const save = () => fs.writeFileSync(outFile + '.tmp', JSON.stringify(out)) || fs.renameSync(outFile + '.tmp', outFile);
// Servers the reachability probe found answering go first; ones it found dead last.
let reach = {};
try { reach = JSON.parse(fs.readFileSync(new URL('../../src/data/reachability.json', import.meta.url), 'utf8')).servers; } catch {}
const rankOf = (s) => ({ ok: 0, 'needs-ai': 0, undefined: 1, auth: 2, paid: 2, blocked: 3, error: 3, dead: 4 })[reach[s.id]] ?? 1;
const todo = listable(latest).filter((s) => !['dead', 'auth', 'paid'].includes(reach[s.id])).sort((a, b) => rankOf(a) - rankOf(b));
await probeTools(todo, out, { concurrency: Number(process.env.CONCURRENCY || 64), deadline: Date.now() + Number(hours) * 3600_000, save });
const vals = Object.values(out);
console.log('done', vals.length, 'listed,', vals.filter((v) => v.tools.length).length, 'with tools');
process.exit(0);
