// Package download counts for catalog servers. Every source is public and needs
// no key: npm (last 30 days), PyPI via pypistats.org (last 30 days), crates.io
// (last 90 days) and Docker Hub (all-time pulls). Results accumulate in `out`
// so an interrupted run can resume.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'mcp-browser-catalog (https://github.com/modelcontextprotocol/registry consumer)' };

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return { notFound: true };
      if (r.status === 429 || r.status >= 500) {
        await sleep(2000 * 2 ** i);
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await sleep(1500);
    }
  }
  return null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export const dockerKey = (id) => {
  const m = String(id || '').replace(/^docker\.io\//, '').replace(/:.*$/, '').toLowerCase();
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(m) ? m : '';
};

/** servers: compact registry records. out: { npm, pypi, cargo, docker } (filled in place). */
export async function fetchDownloads(servers, out, { save = () => {}, log = console.log } = {}) {
  for (const k of ['npm', 'pypi', 'cargo', 'docker']) out[k] ||= {};
  const ids = { npm: new Set(), pypi: new Set(), cargo: new Set(), docker: new Set() };
  for (const s of servers) {
    for (const p of s.packages || []) {
      if (!p.id) continue;
      if (p.type === 'npm') ids.npm.add(p.id);
      else if (p.type === 'pypi') ids.pypi.add(p.id.toLowerCase());
      else if (p.type === 'cargo') ids.cargo.add(p.id);
      else if (p.type === 'oci' && dockerKey(p.id)) ids.docker.add(dockerKey(p.id));
    }
  }
  log(`  packages: ${ids.npm.size} npm, ${ids.pypi.size} PyPI, ${ids.cargo.size} crates, ${ids.docker.size} Docker`);

  // npm: unscoped names in bulk (128 per call), scoped ones singly.
  const npmTodo = [...ids.npm].filter((p) => !(p in out.npm));
  const bulk = npmTodo.filter((p) => !p.startsWith('@'));
  const chunks = [];
  for (let i = 0; i < bulk.length; i += 128) chunks.push(bulk.slice(i, i + 128));
  await pool(chunks, 3, async (c) => {
    const j = await getJson(`https://api.npmjs.org/downloads/point/last-month/${c.map(encodeURIComponent).join(',')}`);
    if (j) for (const p of c) out.npm[p] = j[p]?.downloads ?? 0;
  });
  save();
  let k = 0;
  const scoped = npmTodo.filter((p) => p.startsWith('@'));
  await pool(scoped, 6, async (p) => {
    const j = await getJson(`https://api.npmjs.org/downloads/point/last-month/${p.replace('/', '%2F')}`);
    if (j) out.npm[p] = j.downloads ?? 0;
    if (++k % 500 === 0) (save(), log(`  npm: ${k}/${scoped.length} scoped packages`));
  });
  save();

  k = 0;
  const py = [...ids.pypi].filter((p) => !(p in out.pypi));
  await pool(py, 4, async (p) => {
    const j = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(p)}/recent`, 6);
    if (j) out.pypi[p] = j.data?.last_month ?? 0;
    if (++k % 250 === 0) (save(), log(`  PyPI: ${k}/${py.length}`));
  });
  save();

  for (const p of [...ids.cargo].filter((x) => !(x in out.cargo))) {
    const j = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(p)}`, 3);
    if (j) out.cargo[p] = j.crate?.recent_downloads ?? 0;
    await sleep(1100); // crates.io asks for at most one request a second
  }
  save();

  await pool([...ids.docker].filter((x) => !(x in out.docker)), 3, async (p) => {
    const j = await getJson(`https://hub.docker.com/v2/repositories/${p}/`, 2);
    if (j) out.docker[p] = j.pull_count ?? 0;
  });
  out.fetchedAt = new Date().toISOString();
  save();
  return out;
}
