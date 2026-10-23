// Dependency check: paste a package.json, a requirements.txt or a list of packages, and two
// independent OSV servers are asked which versions have known vulnerabilities, side by side,
// while a package registry server says what's latest and whether it's still looked after.
// Nothing is guessed: every finding names the server it came from.

export const DEP_SERVERS = {
  osv: 'io.github.cyanheads/osv-advisory-mcp-server', // OSV.dev, batch: advisories with severity and fixes
  audit: 'com.datakoot/cve-vulnerability-lookup', // OSV.dev via another publisher: counts per package
  health: 'com.datakoot/npm-pypi-crates-packages', // npm / PyPI registries and deps.dev: latest, deprecated, maintained
};
// (names to show when the registry isn't on this computer, as in CI)
export const DEP_TITLES = { [DEP_SERVERS.osv]: 'OSV Advisory MCP Server', [DEP_SERVERS.audit]: 'Security Intel MCP', [DEP_SERVERS.health]: 'Package Intel MCP' };
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
  // (npm ">=1.2.0 <2" starts at 1.2.0; but a bare ">=" or "!=" pins nothing)
  if (/^\s*(?:!=|<=?|>=?)\s*[\d.]+\s*$/.test(String(v || ''))) return null;
  const m = /^\s*(?:[\^~=v]|>=|==|~=)?\s*v?(\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)\s*(?:$|[,<\s|])/.exec(String(v || ''));
  return m ? m[1] : null;
}

/**
 * The packages in what was pasted: [{ name, version, ecosystem, range, dev }]. Understands
 * package.json, requirements.txt lines ("requests==2.19.0"), Cargo-style "name = "1.2"" and
 * plain lists ("lodash@4.17.15", "requests 2.19.0"). Unpinned entries come back with version null.
 */
/**
 * A lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, uv.lock, Cargo.lock):
 * the versions actually installed. Direct dependencies first, then the ones they pull in
 * (marked indirect). Returns null when the text isn't a lockfile.
 */
export function parseLockfile(text, { max = MAX_PACKAGES } = {}) {
  const t = String(text || '').trim();
  const out = [];
  const seen = new Set();
  let total = 0;
  // Who pulls in whom, to say which direct dependency brings an indirect one in. Keys are
  // names, except in package-lock v2/v3, where each copy has its own path ("node_modules/
  // express/node_modules/ms" is not the "ms" at the top).
  const parents = new Map();
  const edge = (from, to) => {
    if (!from || !to || from === to) return;
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to).add(from);
  };
  const add = (name, version, ecosystem, extra = {}) => {
    name = String(name || '').trim();
    version = String(version || '').trim();
    if (!name || name.length > 214 || !/^[@\w][\w.@/-]*$/.test(name) || !/^\d[\w.+-]*$/.test(version)) return;
    const dupe = `${ecosystem}:${name.toLowerCase()}@${version}`;
    total++;
    if (seen.has(dupe)) {
      // (the same version in two places: one row, direct if either copy is)
      if (extra.key) out.find((p) => `${p.ecosystem}:${p.name.toLowerCase()}@${p.version}` === dupe)?.keys.push(extra.key);
      total--;
      return;
    }
    seen.add(dupe);
    out.push({ name, version, range: version, ecosystem, dev: Boolean(extra.dev), indirect: false, lock: true, keys: [extra.key || name] });
  };
  // (no list of direct ones: the packages nothing else needs are the ones you asked for)
  const roots = () => {
    if (!parents.size) return null;
    const r = new Set(out.filter((p) => !p.keys.some((k) => parents.has(k))).flatMap((p) => p.keys));
    return r.size && r.size < out.length ? r : null;
  };
  const order = (direct) => {
    const isDirect = (p) => p.keys.some((k) => direct.has(k));
    if (direct) for (const p of out) p.indirect = !isDirect(p);
    // (direct ones first, so a long lockfile still checks what you asked for)
    const kept = out.sort((a, b) => Number(a.indirect) - Number(b.indirect)).slice(0, max);
    // "qs (via express)": the nearest direct dependencies up the tree (only for the ones kept)
    let budget = 200000;
    if (direct && parents.size)
      for (const p of kept.filter((x) => x.indirect)) {
        const via = new Set();
        const seenUp = new Set(p.keys);
        let level = [...p.keys];
        for (let depth = 0; depth < 12 && level.length && !via.size && budget > 0; depth++) {
          const next = [];
          for (const n of level)
            for (const up of parents.get(n) || []) {
              if (--budget <= 0 || seenUp.has(up)) continue;
              seenUp.add(up);
              if (direct.has(up)) via.add(up.replace(/^.*node_modules\//, ''));
              else next.push(up);
            }
          level = next;
        }
        if (via.size) p.via = [...via].sort();
      }
    for (const p of kept) delete p.keys;
    return Object.assign(kept, { total, lockfile: true, directKnown: Boolean(direct) });
  };
  // "lodash-old": "npm:lodash@4.17.15" is lodash: [real name, version]
  const alias = (v) => /^npm:(@?[^@\s]+)@(.+)$/.exec(String(v || ''));
  // package-lock.json / npm-shrinkwrap.json
  if (/^\{/.test(t) && /"lockfileVersion"\s*:/.test(t.slice(0, 2000))) {
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      throw new Error('That looks like a package-lock.json but it doesn’t parse. Paste the whole file.');
    }
    const pk = j?.packages && typeof j.packages === 'object' ? j.packages : null;
    const root = (pk?.[''] && typeof pk[''] === 'object' ? pk[''] : null) || {};
    const rootDeps = { ...(root.dependencies || {}), ...(root.devDependencies || {}), ...(root.optionalDependencies || {}) };
    if (pk) {
      const has = (path) => pk[path] && typeof pk[path] === 'object';
      // the copy a package at `from` gets: its own node_modules, then each folder up
      const resolve = (from, name) => {
        let base = from;
        for (;;) {
          const cand = `${base ? `${base}/` : ''}node_modules/${name}`;
          if (has(cand)) return cand;
          if (!base) return null;
          // node_modules/a/node_modules/b → node_modules/a → (the top); packages/web → (the top)
          const cut = base.lastIndexOf('/node_modules/');
          base = cut >= 0 ? base.slice(0, cut) : '';
        }
      };
      const direct = new Set(Object.keys(rootDeps).map((n) => resolve('', n)).filter(Boolean));
      for (const [path, info] of Object.entries(pk)) {
        if (!path || !info || typeof info !== 'object' || info.link || !path.includes('node_modules/')) continue;
        // (a git, file or tarball dependency isn't the registry package of that name)
        if (info.resolved && !/^https?:\/\/[^/]*(?:registry|npmjs|yarnpkg)[^/]*\//.test(info.resolved)) continue;
        if (info.resolved && /^https?:\/\//.test(info.resolved) && !/\.tgz(?:[?#].*)?$/.test(info.resolved)) continue;
        const name = info.name || path.slice(path.lastIndexOf('node_modules/') + 13);
        add(name, info.version, 'npm', { dev: info.dev, key: path });
        // (peers are the other way round: whoever installs this provides them)
        for (const k of ['dependencies', 'optionalDependencies']) for (const d of Object.keys(info[k] || {})) edge(path, resolve(path, d));
      }
      return order(direct.size ? direct : null);
    }
    // (lockfile v1: a tree of "dependencies"; an alias's version is "npm:lodash@4.17.15")
    const direct = new Set();
    const walk = (deps, depth) => {
      for (const [n, info] of Object.entries(deps || {})) {
        if (!info || typeof info !== 'object') continue;
        const al = alias(info.version);
        const name = al ? al[1] : n;
        add(name, al ? al[2] : info.version, 'npm', { dev: info.dev });
        for (const d of Object.keys(info.requires || {})) edge(name, d);
        if (depth < 6) walk(info.dependencies, depth + 1);
      }
    };
    walk(j.dependencies, 0);
    for (const [n, v] of Object.entries(rootDeps)) direct.add(alias(v)?.[1] || n);
    return order(direct.size ? direct : roots());
  }
  // yarn.lock (classic and berry): `"lodash@^4.17.15", lodash@^4.17.20:` then `version "4.17.21"`
  if (/^# (?:THIS IS AN AUTOGENERATED FILE|This file is generated by running "yarn)|^__metadata:/m.test(t.slice(0, 600)) || /^"?@?[\w.-]+(?:\/[\w.-]+)?@[^\n]*:\n[ \t]+version:? "?\d/m.test(t)) {
    let name = null;
    let local = false;
    let version = null;
    let deps = [];
    let inDeps = false;
    const wsDirect = new Set();
    const flush = () => {
      if (name && version && !local) {
        add(name, version, 'npm');
        for (const d of deps) edge(name, d);
      }
      // (berry: the project's own entry, "app@workspace:.", lists the direct ones)
      if (name && local && /^0\.0\.0-use\.local$/.test(version || '')) for (const d of deps) wsDirect.add(d);
      name = null;
      version = null;
      local = false;
      deps = [];
      inDeps = false;
    };
    for (const line of t.split(/\r?\n/)) {
      if (!/^\s/.test(line) && line.trim()) {
        flush();
        if (/^__metadata|^#/.test(line)) continue;
        const first = line.replace(/^"/, '').split(/",?\s*"?|,\s*/)[0];
        const head = /^(@?[^@\s"]+)@(.*)$/.exec(first);
        if (!head) continue;
        // ("x@npm:lodash@4.17.15" is lodash; workspace:, file:, link:, portal:, git and URLs aren't registry packages)
        const al = /^npm:(@?[^@\s"]+)@/.exec(head[2]);
        name = al ? al[1] : head[1];
        local = /^(?:workspace|file|link|portal|git|github|https?|patch):|^(?:\.\.?\/|\/)/.test(head[2].replace(/^npm:@?[^@]+@/, ''));
        continue;
      }
      if (/^ {2}\w/.test(line)) inDeps = /^ {2}(?:dependencies|optionalDependencies):/.test(line);
      else if (inDeps) {
        // classic `    "@scope/x" "^1.0.0"` / berry `    x: "npm:^1.0.0"` (an alias's value names the real one)
        const d = /^ {4}"?((?:@[\w.-]+\/)?[\w.-]+)"?:?[ \t]+"?(?:npm:((?:@[\w.-]+\/)?[\w.-]+)@)?/.exec(line);
        if (d) deps.push(d[2] || d[1]);
      }
      const v = /^[ \t]+version:?[ \t]+"?([^"\s]+)"?/.exec(line);
      if (v && name && !version) version = v[1];
      // berry: `resolution: "lodash@npm:4.17.15"` names the real package
      const res = /^[ \t]+resolution:[ \t]+"?(@?[^@\s"]+)@([a-z]+):/.exec(line);
      if (res && name) {
        name = res[1];
        if (res[2] !== 'npm') local = true;
      }
    }
    flush();
    return order(wsDirect.size ? wsDirect : roots());
  }
  // pnpm-lock.yaml: v9 "  lodash@4.17.21:", v6 "  /lodash@4.17.21:", v5 "  /lodash/4.17.21:" under
  // packages: (and snapshots:), with "_peer@1" or "(peer@1)" suffixes; direct ones under importers.
  if (/^lockfileVersion:\s*['"]?\d/m.test(t.slice(0, 200))) {
    let section = '';
    let sub = '';
    let owner = null;
    let importer = null;
    const direct = new Set();
    const devs = new Set();
    for (const line of t.split(/\r?\n/)) {
      const top = /^(\w[\w-]*):/.exec(line);
      if (top) {
        section = top[1];
        owner = null;
        continue;
      }
      if (section === 'packages' || section === 'snapshots') {
        if (/^ {2}\S/.test(line)) {
          // (a new entry: whatever it is, the last one's dependencies end here)
          owner = null;
          const k = line.trim().replace(/^['"]|['"]?:\s*(?:\{\})?\s*$/g, '');
          const m = /^\/?((?:@[^/@\s]+\/)?[^/@\s(]+)@(\d[^:(_\s]*)/.exec(k) || /^\/((?:@[^/\s]+\/)?[^/\s]+)\/(\d[^:(_\s/]*)/.exec(k);
          if (m) {
            add(m[1], m[2], 'npm');
            owner = m[1];
          }
          continue;
        }
        const s4 = /^ {4}(\w+):/.exec(line);
        if (s4) sub = s4[1];
        const dep = owner && (sub === 'dependencies' || sub === 'optionalDependencies') && /^ {6}['"]?((?:@[\w.-]+\/)?[\w.-]+)['"]?:\s*\S/.exec(line);
        if (dep) edge(owner, dep[1]);
      } else if (section === 'importers' || section === 'dependencies' || section === 'devDependencies' || section === 'optionalDependencies') {
        // v9/v6: importers: / ".": / dependencies: / name: / version: x (or "lodash@4.17.15" for an alias)
        // v5 single project: dependencies: / name: 1.2.3
        const ind = /^( *)/.exec(line)[1].length;
        const kv = /^ *['"]?((?:@[\w.-]+\/)?[\w.-]+)['"]?:\s*['"]?([^'"\s]*)/.exec(line);
        if (!kv) continue;
        const depth = section === 'importers' ? 6 : 2;
        const groupKey = section === 'importers' ? (ind === 4 ? kv[1] : null) : section;
        if (groupKey) sub = groupKey;
        if (ind === depth && kv[1] !== '.') {
          importer = kv[1];
          if (/^(?:dependencies|devDependencies|optionalDependencies)$/.test(sub)) {
            direct.add(importer);
            if (sub === 'devDependencies') devs.add(importer);
          }
          if (kv[2] && section !== 'importers') {
            const al = /^(@?[^@\s]+)@(\d.*)$/.exec(kv[2]);
            if (al) direct.add(al[1]);
          }
        } else if (section === 'importers' && ind === depth + 2 && kv[1] === 'version' && importer) {
          // ("version: lodash@4.17.15": an alias, so the real package is the direct one)
          const al = /^(@?[^@\s]+)@(\d.*)$/.exec(kv[2]);
          if (al) direct.add(al[1]);
        }
      }
    }
    for (const p of out) if (devs.has(p.name)) p.dev = true;
    return order(direct.size ? direct : roots());
  }
  // poetry.lock, uv.lock, Cargo.lock: [[package]] name = "…" version = "…"
  if (/^\[\[package\]\]/m.test(t)) {
    const cargo = /@generated by Cargo|registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|^checksum = /m.test(t);
    const eco = cargo ? 'cargo' : 'pypi';
    let direct = null;
    // (one line at a time: "[ \t]*", never "\s*", so blank lines can't make it slow)
    const listed = (block) => [...block.matchAll(/^[ \t]*"([\w.-]+)(?: [^"\n]*)?",?[ \t]*$/gm), ...block.matchAll(/\{[ \t]*name[ \t]*=[ \t]*"([\w.-]+)"/g)].map((m) => m[1]);
    for (const block of t.split(/^\[\[package\]\][ \t]*$/m).slice(1)) {
      const name = /^name[ \t]*=[ \t]*"([^"\n]+)"/m.exec(block)?.[1];
      const version = /^version[ \t]*=[ \t]*"([^"\n]+)"/m.exec(block)?.[1];
      const source = /^source[ \t]*=[ \t]*(.*)$/m.exec(block)?.[1] || '';
      // The project itself (uv: virtual or editable; Cargo: no source): its list is the direct ones.
      if (/^\{[ \t]*(?:editable|virtual)[ \t]*=/.test(source) || (cargo && !source)) {
        direct = new Set([...(direct || []), ...listed(block)]);
        continue;
      }
      // (a local folder, a path or a git checkout isn't the registry package of that name)
      if (/^\{[ \t]*(?:directory|path|git|url)[ \t]*=|^"(?:git|path)\+/.test(source)) continue;
      for (const d of listed(block)) edge(name, d);
      // (poetry: a [package.dependencies] table, "attrs = \">=17.4.0\"")
      const table = /^\[package\.dependencies\][ \t]*$([^[]*)/m.exec(block);
      if (table) for (const m of table[1].matchAll(/^([\w.-]+)[ \t]*=/gm)) edge(name, m[1]);
      add(name, version, eco, { dev: /^category[ \t]*=[ \t]*"dev"|^groups[ \t]*=[ \t]*\["dev"\]/m.test(block) });
    }
    return order(direct?.size ? direct : roots());
  }
  return null;
}

export function parseManifest(text, { max = MAX_PACKAGES } = {}) {
  const t = String(text || '').trim();
  const lock = parseLockfile(t, { max });
  if (lock) return lock;
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
    return out.slice(0, max);
  }
  const pyHint = /==|~=|>=|^\s*-r\s|\[[\w,]+\]==/m.test(t);
  // Only == (and ===) pins a version; ">=2.19" installs the latest, "!=1.24.1" excludes one.
  const py = (name, op, ver) => add(name, op === '==' || op === '===' ? ver : op === '~=' ? `~${ver}` : `${op}${ver}`, 'pypi');
  let section = null; // a TOML file: [dependencies], [tool.poetry.dependencies]…
  for (let line of t.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    const head = /^\[([\w.-]+)\]$/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      continue;
    }
    if (!line || /^[#;]/.test(line) || /^-/.test(line)) continue;
    let m;
    if (section !== null) {
      // TOML: only dependency tables count ("name", "version", "edition" under [package] aren't packages)
      if (!/(?:^|\.)(?:dev-|build-)?dependencies$|^workspace\.dependencies$|^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[\w-]+\.dependencies$/.test(section)) {
        // [project] dependencies = ["requests>=2.19", …]
        for (const q of line.matchAll(/"([A-Za-z0-9][\w.-]*)(?:\[[\w,\s-]+\])?\s*(==|~=|>=|<=|!=|===)\s*([^"\s;,]+)[^"]*"/g)) py(q[1], q[2], q[3]);
        continue;
      }
      const eco = section.startsWith('tool.poetry') ? 'pypi' : 'cargo';
      if ((m = /^([\w.-]+)\s*=\s*"([^"]+)"/.exec(line)) || (m = /^([\w.-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"([^"]+)"/.exec(line))) {
        if (m[1].toLowerCase() !== 'python') add(m[1], m[2], eco);
      } else if ((m = /^([\w.-]+)\s*=\s*\{/.exec(line))) add(m[1], '', eco);
      continue;
    }
    if ((m = /^([A-Za-z0-9][\w.-]*)(?:\[[\w,\s-]+\])?\s*(==|~=|>=|<=|!=|===)\s*([^\s;,]+)/.exec(line))) py(m[1], m[2], m[3]);
    else if ((m = /^([\w-]+)\s*=\s*"([^"]+)"/.exec(line))) add(m[1], m[2], 'cargo');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)@([\^~]?\d[\w.+-]*)$/.exec(line))) add(m[1], m[2], 'npm');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)\s+v?(\d[\w.+-]*)$/.exec(line))) add(m[1], m[2], pyHint ? 'pypi' : 'npm');
    else if ((m = /^(@?[\w.-]+(?:\/[\w.-]+)?)$/.exec(line))) add(m[1], '', pyHint ? 'pypi' : 'npm');
  }
  return out.slice(0, max);
}

/** Compare dotted versions numerically ("4.17.21" > "4.17.9"). */
export function cmpVersion(a, b) {
  // (a pre-release comes before its release: 2.0.0-rc.1 < 2.0.0)
  const [ba, pra] = String(a).split(/-(.*)/s);
  const [bb, prb] = String(b).split(/-(.*)/s);
  if (ba !== bb && cmpVersion0(ba, bb) !== 0) return cmpVersion0(ba, bb);
  if (pra && !prb) return -1;
  if (!pra && prb) return 1;
  return cmpVersion0(String(a), String(b));
}
function cmpVersion0(a, b) {
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
  emit('deps_start', { packages: pkgs.length, pinned: pinned.length, unpinned: pkgs.filter((p) => !p.version).map((p) => p.name).slice(0, 30), lockfile: Boolean(pkgs.lockfile), directKnown: Boolean(pkgs.directKnown), total: pkgs.total ?? pkgs.length, indirect: pkgs.filter((p) => p.indirect).length });
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
  const auditEcos = new Set();
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
          const list = pinned;
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
            if (r) auditEcos.add(eco);
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
  // (a lockfile can hold one package at two versions: "ms@2.0.0" and "ms@2.1.1" are looked up apart)
  const osvBy = new Map();
  for (const r of osv?.results || []) {
    const k = `${String(r.ecosystem).toLowerCase().replace('crates.io', 'cargo')}:${String(r.name).toLowerCase()}`;
    if (r.version) osvBy.set(`${k}@${r.version}`, r);
    if (!osvBy.has(k)) osvBy.set(k, r);
  }
  const auditBy = new Map();
  for (const f of audits || []) {
    const k = `${f.ecosystem}:${String(f.name).toLowerCase()}`;
    if (f.version) auditBy.set(`${k}@${f.version}`, f);
    if (!auditBy.has(k)) auditBy.set(k, f);
  }
  const twoVersions = new Set(pkgs.filter((p, i) => pkgs.findIndex((q) => q.ecosystem === p.ecosystem && q.name.toLowerCase() === p.name.toLowerCase()) !== i).map((p) => `${p.ecosystem}:${p.name.toLowerCase()}`));
  const summary = { packages: pkgs.length, checked: 0, unchecked: 0, vulnerable: 0, agreed: 0, disagreed: 0, deprecated: 0, high: 0 };
  for (const p of pkgs) {
    const k = `${p.ecosystem}:${p.name.toLowerCase()}`;
    // (by version first; by name only when the package appears once)
    const a = osvBy.get(`${k}@${p.version}`) || (twoVersions.has(k) ? null : osvBy.get(k));
    const b = auditBy.get(`${k}@${p.version}`) || (twoVersions.has(k) && auditBy.get(k)?.version ? null : auditBy.get(k));
    const h = health.get(k);
    const vulns = (a?.vulns || []).map((v) => ({ id: v.id, all: [v.id, ...(v.aliases || [])], summary: String(v.summary || '').slice(0, 200), aliases: (v.aliases || []).filter((x) => /^CVE-/.test(x)).slice(0, 3), severity: String(v.severityLabel || '').toUpperCase(), fixedVersions: (v.fixedVersions || []).slice(0, 40) }));
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
    // Did any server actually answer for this package? Without one, it's "not checked", never "none known".
    const answeredB = Boolean(audits) && auditEcos.has(p.ecosystem);
    // The other server lists raw ids: the ones that are aliases of one advisory count once.
    const idsB = b && !b.notFound ? b.vulnerability_ids || [] : [];
    const groupsB = new Set(idsB.map((x) => seen.get(x) || x));
    // (its id list stops at 20: past that only its own count is known)
    const fullB = idsB.length && idsB.length >= (b?.vulnerability_count ?? 0);
    const countB = b && !b.notFound ? (fullB ? groupsB.size : b.vulnerability_count ?? idsB.length) : b?.notFound ? null : audits ? 0 : null;
    for (const v of uniq) delete v.all;
    const fixAll = uniq.length ? fixVersion(p.version, uniq) : { version: null, unfixed: false };
    for (const v of uniq) v.fixedVersions = v.fixedVersions.slice(0, 4); // (shown; the fix above used them all)
    const fix = fixAll;
    const worst = uniq.reduce((m, v) => Math.max(m, SEV[v.severity] || 0), 0);
    const row = {
      name: p.name,
      ecosystem: p.ecosystem,
      version: p.version,
      range: p.range,
      dev: p.dev,
      indirect: Boolean(p.indirect),
      via: p.via || null,
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
      checked: Boolean(p.version) && (countA != null || answeredB),
    };
    if (row.checked) summary.checked++;
    else if (p.version) summary.unchecked++;
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

// ---------- a public GitHub repo ----------
// "Is this repo's dependency tree safe?" before you adopt it: its lockfile (or manifest) is
// read through a page-reading server, then checked like a pasted one.
export const PAGE_FETCH = 'app.openkrill/page-fetch';
// (a lockfile first: installed versions; a manifest when there is none or it was cut off)
const REPO_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml'];

/** github.com/owner/repo[/tree/ref/dir] → { owner, repo, ref, dir } (null if not a repo link). */
export function repoOf(input) {
  const s = String(input || '').trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?(?:\/(tree|blob)\/([\w.\/-]{1,200}))?\/?(?:[?#].*)?$/i.exec(s);
  if (!m || /^(?:settings|orgs|topics|marketplace|explore|features|about|login|sponsors|search|notifications|pulls|issues)$/i.test(m[1])) return null;
  // (".." or a leading dot never names a repo, a branch or a folder: the page would name one repo and read another)
  if (/^\./.test(m[2])) return null;
  let ref = 'HEAD';
  let dir = '';
  if (m[4]) {
    // ("tree/main/packages/web": the branch is the first part; a blob link points at a file, so its folder)
    const parts = m[4].split('/').filter(Boolean);
    ref = parts.shift();
    if (!ref || ref.startsWith('.') || ref.includes('..') || ref.endsWith('.')) return null;
    if (m[3].toLowerCase() === 'blob') parts.pop();
    if (parts.some((p) => p.startsWith('.'))) return null;
    dir = parts.join('/');
  }
  return { owner: m[1], repo: m[2], ref, dir };
}

/** Read the repo's dependency file through the page server: { text, file, url, truncated, tried }. */
export async function fetchRepoDeps(repo, { callTool, emit = () => {}, max = MAX_PACKAGES } = {}) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const base = `https://raw.githubusercontent.com/${enc(repo.owner)}/${enc(repo.repo)}/${enc(repo.ref)}/${repo.dir ? `${enc(repo.dir)}/` : ''}`;
  const rootBase = `https://raw.githubusercontent.com/${enc(repo.owner)}/${enc(repo.repo)}/${enc(repo.ref)}/`;
  const read = async (file) => {
    // ("/uv.lock": a workspace's lockfile at the repo root, for a package in a sub-folder)
    const atRoot = file.startsWith('/');
    const url = atRoot ? rootBase + file.slice(1) : base + file;
    try {
      const r = await callTool(PAGE_FETCH, 'fetch_page', { url, max_chars: 100000 });
      const sc = r?.structuredContent;
      if (!sc || sc.status !== 'ok' || !sc.markdown || /^\s*404: Not Found\s*$/.test(sc.markdown)) return null;
      // (the page server indents raw text two spaces under "markdown:" in its text form; structured is as-is)
      return { file, url, text: String(sc.markdown), truncated: Boolean(sc.truncated) };
    } catch (e) {
      lastError = String(e?.message || e);
      return null;
    }
  };
  let lastError = null;
  const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'Cargo.lock'];
  const found = (await Promise.all([...REPO_FILES, ...(repo.dir ? LOCKS.map((f) => `/${f}`) : [])].map(read))).filter(Boolean);
  const tried = REPO_FILES.length;
  const parsed = found
    .map((f) => {
      try {
        return { ...f, pkgs: parseManifest(f.text, { max }) };
      } catch {
        return null; // (a lockfile cut off mid-JSON doesn't parse)
      }
    })
    .filter((f) => f?.pkgs?.length);
  // For each ecosystem the repo uses: a whole lockfile, else a whole manifest, else the first
  // part of a long lockfile ("uv" has Cargo.lock and uv.lock: both, side by side).
  const GROUPS = [['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '/package-lock.json', '/pnpm-lock.yaml', '/yarn.lock', 'package.json'], ['uv.lock', 'poetry.lock', '/uv.lock', '/poetry.lock', 'requirements.txt', 'pyproject.toml'], ['Cargo.lock', '/Cargo.lock', 'Cargo.toml']];
  const picks = GROUPS.map((g) => {
    const mine = g.map((file) => parsed.find((f) => f.file === file)).filter(Boolean);
    const whole = mine.find((f) => !f.truncated);
    // (a manifest of ">=" ranges pins nothing: the first part of a long lockfile tells more)
    const cut = mine.find((f) => f.truncated && f.pkgs.lockfile);
    if (whole && cut && !whole.pkgs.lockfile && whole.pkgs.filter((p) => p.version).length < whole.pkgs.length / 2) return cut;
    return whole || mine[0];
  }).filter(Boolean);
  if (picks.length) {
    const pkgs = [];
    const share = Math.floor(max / picks.length);
    for (const f of picks) pkgs.push(...f.pkgs.slice(0, picks.length > 1 ? share : max));
    const lockfile = picks.some((f) => f.pkgs.lockfile);
    Object.assign(pkgs, { lockfile, directKnown: picks.some((f) => f.pkgs.directKnown), total: picks.reduce((n, f) => n + (f.pkgs.total ?? f.pkgs.length), 0) });
    const files = picks.map((f) => ({ file: f.file, url: f.url, truncated: f.truncated, lockfile: Boolean(f.pkgs.lockfile), packages: f.pkgs.total ?? f.pkgs.length }));
    emit('deps_source', { repo: `${repo.owner}/${repo.repo}`, dir: repo.dir, ref: repo.ref, files, found: found.map((g) => g.file) });
    return { pkgs, files, tried };
  }
  return { pkgs: null, tried, found: found.map((g) => g.file), error: found.length ? null : lastError };
}
