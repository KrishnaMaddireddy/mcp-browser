// Dependency check: paste a package.json, a requirements.txt or a list of packages, and two
// independent OSV servers are asked which versions have known vulnerabilities, side by side,
// while a package registry server says what's latest and whether it's still looked after.
// Nothing is guessed: every finding names the server it came from.

export const DEP_SERVERS = {
  osv: 'io.github.cyanheads/osv-advisory-mcp-server', // OSV.dev, batch: advisories with severity and fixes
  audit: 'com.datakoot/cve-vulnerability-lookup', // OSV.dev via another publisher: counts per package
  health: 'com.datakoot/npm-pypi-crates-packages', // npm / PyPI registries and deps.dev: latest, deprecated, maintained
};
const MAX_PACKAGES = 150;
const HEALTH_LIMIT = 40;

// OSV ecosystem names, and the registry names the other servers use.
const ECO = {
  npm: { osv: 'npm', audit: 'npm', health: 'npm' },
  pypi: { osv: 'PyPI', audit: 'pypi', health: 'pypi' },
  cargo: { osv: 'crates.io', audit: 'cargo', health: 'cargo' },
};

/** The plain version a range starts from: "^4.17.15" → "4.17.15"; null for "latest", git URLs, "*". */
export function baseVersion(v) {
  const m = /^\s*(?:[\^~=v]|>=|==|~=)?\s*v?(\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)\s*(?:$|[,<\s|])/.exec(String(v || ''));
  return m ? m[1] : null;
}

/**
 * The packages in what was pasted: [{ name, version, ecosystem, range, dev }]. Understands
 * package.json, requirements.txt lines ("requests==2.19.0"), Cargo-style "name = "1.2"" and
 * plain lists ("lodash@4.17.15", "requests 2.19.0"). Unpinned entries come back with version null.
 */
export function parseManifest(text) {
  const t = String(text || '').trim();
  const out = [];
  const add = (name, range, ecosystem, dev = false) => {
    name = String(name || '').trim();
    if (!name || name.length > 214 || !/^[@\w][\w.@/-]*$/.test(name)) return;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.ecosystem === ecosystem)) return;
    out.push({ name, version: baseVersion(range), range: String(range || '').trim().slice(0, 60), ecosystem, dev });
  };
  // package.json
  if (/^\{/.test(t)) {
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      throw new Error('That looks like JSON but it doesn’t parse. Paste the whole package.json.');
    }
    for (const [key, dev] of [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false], ['peerDependencies', false]])
      for (const [n, v] of Object.entries(j?.[key] || {})) add(n, v, 'npm', dev);
    return out.slice(0, MAX_PACKAGES);
  }
  const pyHint = /==|~=|>=|^\s*-r\s|\[[\w,]+\]==/m.test(t);
  for (let line of t.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || /^[#;\[]/.test(line) || /^-/.test(line)) continue;
    let m;
    if ((m = /^([A-Za-z0-9][\w.-]*)(?:\[[\w,\s-]+\])?\s*(==|~=|>=|<=|!=|===)\s*([^\s;,]+)/.exec(line))) add(m[1], m[3], 'pypi');
    else if ((m = /^([\w-]+)\s*=\s*"([^"]+)"/.exec(line))) add(m[1], m[2], 'cargo');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)@([\^~]?\d[\w.+-]*)$/.exec(line))) add(m[1], m[2], 'npm');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)\s+v?(\d[\w.+-]*)$/.exec(line))) add(m[1], m[2], pyHint ? 'pypi' : 'npm');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)$/.exec(line))) add(m[1], '', pyHint ? 'pypi' : 'npm');
  }
  return out.slice(0, MAX_PACKAGES);
}

/** Compare dotted versions numerically ("4.17.21" > "4.17.9"). */
export function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * The version that fixes every known advisory on this line: for each advisory, the lowest fix
 * above the version in use (same major when there is one); the highest of those.
 */
export function fixVersion(version, vulns) {
  let need = null;
  const major = String(version || '').split('.')[0];
  for (const v of vulns) {
    const fixes = (v.fixedVersions || []).filter((f) => !version || cmpVersion(f, version) > 0).sort(cmpVersion);
    if (!fixes.length) return { version: need, unfixed: true };
    const sameMajor = fixes.find((f) => f.split('.')[0] === major);
    const f = sameMajor || fixes[0];
    if (!need || cmpVersion(f, need) > 0) need = f;
  }
  return { version: need, unfixed: false };
}

const SEV = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };

/**
 * Run the check. emit: deps_start { packages }, deps_server { key, title, ok, ms, error? },
 * deps_row { … } per package, deps_done { summary }. callTool(serverId, tool, args) does the
 * calling (so the caller decides which servers may run).
 */
export async function runDeps(pkgs, { callTool, titleOf = (id) => id, emit = () => {} } = {}) {
  const pinned = pkgs.filter((p) => p.version && ECO[p.ecosystem]);
  emit('deps_start', { packages: pkgs.length, pinned: pinned.length, unpinned: pkgs.filter((p) => !p.version).map((p) => p.name).slice(0, 30) });
  const timed = async (key, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      emit('deps_server', { key, id: DEP_SERVERS[key], title: titleOf(DEP_SERVERS[key]), ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      emit('deps_server', { key, id: DEP_SERVERS[key], title: titleOf(DEP_SERVERS[key]), ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) });
      return null;
    }
  };
  const sc = (r) => r?.structuredContent || (() => {
    try {
      return JSON.parse(r?.content?.find((c) => c.type === 'text')?.text || 'null');
    } catch {
      return null;
    }
  })();
  // 1. Advisories, from two publishers of OSV data at once.
  // (one package per call: a batch with many advisories comes back paged, a few rows at a time)
  const osvOne = async (p) => {
    const r = sc(await callTool(DEP_SERVERS.osv, 'osv_query_batch', { packages: [{ name: p.name, ecosystem: ECO[p.ecosystem].osv, version: p.version }] }));
    const row = r?.results?.[0] || r?.preview?.rows?.[0]?.value;
    if (row?.name) return row;
    // too long to send whole: the count without the details
    const n = r?.summary?.totalVulns;
    return Number.isFinite(n) ? { name: p.name, ecosystem: ECO[p.ecosystem].osv, version: p.version, vulnCount: n, vulns: [], partial: true } : null;
  };
  const [osv, audits] = await Promise.all([
    pinned.length
      ? timed('osv', async () => {
          const results = [];
          let i = 0;
          let fails = 0;
          const list = pinned.slice(0, 60);
          const worker = async () => {
            while (i < list.length) {
              const p = list[i++];
              try {
                const row = await osvOne(p);
                if (row) results.push(row);
              } catch {
                fails++;
              }
            }
          };
          await Promise.all(Array.from({ length: 6 }, worker));
          if (fails === list.length) throw new Error('no answers');
          return { results };
        })
      : null,
    pinned.length
      ? timed('audit', async () => {
          // (one call per ecosystem: it audits one registry at a time)
          const out = [];
          for (const eco of [...new Set(pinned.map((p) => p.ecosystem))]) {
            const r = sc(await callTool(DEP_SERVERS.audit, 'audit_dependencies', { ecosystem: ECO[eco].audit, dependencies: pinned.filter((p) => p.ecosystem === eco).map((p) => ({ name: p.name, version: p.version })) }));
            for (const f of r?.findings || []) out.push({ ...f, ecosystem: eco });
            for (const n of r?.packages_not_found || []) out.push({ name: typeof n === 'string' ? n : n?.name, ecosystem: eco, notFound: true });
          }
          return out;
        })
      : null,
  ]);
  // 2. What's latest, and whether anyone still looks after it (the first few, in parallel).
  const health = new Map();
  const healthList = pkgs.filter((p) => ECO[p.ecosystem]).slice(0, HEALTH_LIMIT);
  await timed('health', async () => {
    let i = 0;
    let fails = 0;
    const worker = async () => {
      while (i < healthList.length) {
        const p = healthList[i++];
        try {
          health.set(`${p.ecosystem}:${p.name.toLowerCase()}`, sc(await callTool(DEP_SERVERS.health, 'package_health', { ecosystem: ECO[p.ecosystem].health, name: p.name })));
        } catch {
          fails++;
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (healthList.length && fails === healthList.length) throw new Error('no answers');
  });
  const osvBy = new Map((osv?.results || []).map((r) => [`${String(r.ecosystem).toLowerCase().replace('crates.io', 'cargo')}:${String(r.name).toLowerCase()}`, r]));
  const auditBy = new Map((audits || []).map((f) => [`${f.ecosystem}:${String(f.name).toLowerCase()}`, f]));
  const summary = { packages: pkgs.length, checked: 0, vulnerable: 0, agreed: 0, disagreed: 0, deprecated: 0, high: 0 };
  for (const p of pkgs) {
    const k = `${p.ecosystem}:${p.name.toLowerCase()}`;
    const a = osvBy.get(k);
    const b = auditBy.get(k);
    const h = health.get(k);
    const vulns = (a?.vulns || []).map((v) => ({ id: v.id, all: [v.id, ...(v.aliases || [])], summary: String(v.summary || '').slice(0, 200), aliases: (v.aliases || []).filter((x) => /^CVE-/.test(x)).slice(0, 3), severity: String(v.severityLabel || '').toUpperCase(), fixedVersions: (v.fixedVersions || []).slice(0, 4) }));
    // (the same advisory under two ids — "PYSEC-…" and "GHSA-…" — counts once)
    const seen = new Map();
    const uniq = vulns.filter((v) => {
      const hit = v.all.find((x) => seen.has(x));
      if (hit != null) {
        v.all.forEach((x) => seen.set(x, seen.get(hit)));
        return false;
      }
      v.all.forEach((x) => seen.set(x, v.id));
      return true;
    });
    const countA = a && !a.error ? (a.partial ? a.vulnCount : uniq.length) : null;
    // The other server lists raw ids: the ones that are aliases of one advisory count once.
    const idsB = b && !b.notFound ? b.vulnerability_ids || [] : [];
    const groupsB = new Set(idsB.map((x) => seen.get(x) || x));
    // (its id list stops at 20: past that only its own count is known)
    const fullB = idsB.length && idsB.length >= (b?.vulnerability_count ?? 0);
    const countB = b && !b.notFound ? (fullB ? groupsB.size : b.vulnerability_count ?? idsB.length) : b?.notFound ? null : audits ? 0 : null;
    for (const v of uniq) delete v.all;
    const fix = uniq.length ? fixVersion(p.version, uniq) : { version: null, unfixed: false };
    const worst = uniq.reduce((m, v) => Math.max(m, SEV[v.severity] || 0), 0);
    const row = {
      name: p.name,
      ecosystem: p.ecosystem,
      version: p.version,
      range: p.range,
      dev: p.dev,
      vulns: uniq.sort((x, y) => (SEV[y.severity] || 0) - (SEV[x.severity] || 0)),
      // (the server had too many advisories to send them all: the count is shown, not the list)
      partial: Boolean(a?.partial),
      counts: { osv: countA, audit: countB, comparable: !a?.partial && (!b || b.notFound || fullB || !idsB.length) },
      // Two publishers of the same database: when they agree, say so; when not, show both.
      agree: countA != null && countB != null ? (countA > 0) === (countB > 0) : null,
      worst: Object.keys(SEV).find((s) => SEV[s] === worst) || null,
      fix: fix.version,
      unfixed: fix.unfixed,
      latest: h?.latest_version || null,
      deprecated: Boolean(h?.deprecated),
      maintained: h ? h.actively_maintained !== false : null,
      lastRelease: h?.last_release || null,
      license: h?.license || null,
      notFound: Boolean(b?.notFound) || Boolean(a?.error && /not found/i.test(a.error)),
    };
    if (p.version) summary.checked++;
    if (row.vulns.length || (countB || 0) > 0) summary.vulnerable++;
    if (row.agree === true) summary.agreed++;
    if (row.agree === false) summary.disagreed++;
    if (row.deprecated) summary.deprecated++;
    if (worst >= 3) summary.high++;
    emit('deps_row', row);
  }
  emit('deps_done', { summary, sources: { osv: Boolean(osv), audit: Boolean(audits), health: health.size > 0 } });
  return summary;
}
