// Package MCP servers (npm, PyPI, Docker images) that MCP Browser starts on this
// computer itself, after the user approves each one.
//
// Safeguards, in order:
//  1. Nothing runs until the user approves it, seeing the exact command, version,
//     publisher and adoption. The version is pinned at approval: an update needs a
//     new approval.
//  2. Install-time code is blocked: npm runs with ignore-scripts, PyPI only from
//     prebuilt wheels (uv --no-build). Source builds are only allowed in Docker.
//  3. Each server gets its own folder (home, temp, package cache) and an
//     environment with only its own settings: none of MCP Browser's keys or the
//     user's shell variables.
//  4. Isolation: on macOS a sandbox (sandbox-exec) denies reading or writing the
//     user's home folder outside the server's own folder; it is self-checked on
//     this computer before it is offered. Or Docker (no host folders mounted). Or,
//     only with explicit consent, no isolation.
//  5. Keys are kept in memory only, for as long as MCP Browser runs.
//  Tools that change things are never offered to the model (policy.js), for these
//  servers as for every other one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir } from './config.js';
import { guardedFetch } from './netguard.js';
import { errMsg } from './util.js';

export const IDLE_MS = 10 * 60_000;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const NODE_IMAGE = 'node:22-slim';
const UV_IMAGE = 'ghcr.io/astral-sh/uv:python3.12-bookworm-slim';

const home = () => os.homedir();
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** PATH used to find npx, uvx and docker: the app's PATH plus the usual install places. */
export function searchPath() {
  const h = home();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(h, '.local', 'bin'), path.join(h, '.npm-global', 'bin'), path.join(h, '.volta', 'bin'), path.join(h, '.cargo', 'bin'), '/usr/bin', '/bin'];
  return [...new Set([...(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean))];
}

/** Absolute path of a command, or null. */
export function findCommand(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of searchPath()) {
    for (const e of exts) {
      const p = path.join(dir, cmd + e);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** What this computer can run with: npx, uvx, docker. */
export function runtimes() {
  return { npx: findCommand('npx'), uvx: findCommand('uvx'), docker: findCommand('docker'), node: findCommand('node') };
}

export const keyOf = (id) => {
  const base = String(id).split('/').pop().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'server';
  return `${base}-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8)}`;
};

// ---------- package facts (version, install scripts, wheels) ----------

const infoCache = new Map(); // `${type}:${id}` -> { at, info }
const strip = (id, type) => (type === 'npm' ? String(id).replace(/(?<=.)@[^/@]*$/, '') : type === 'pypi' ? String(id).replace(/[=<>!~@].*$/, '') : String(id));

/**
 * Latest version and install-time behaviour of a package, from its registry.
 * @returns {{ type, name, version, installScripts?: string[], wheel?: boolean, deprecated?: string, homepage?: string, error?: string }}
 */
export async function packageInfo(type, id, { fetchImpl } = {}) {
  const name = strip(id, type);
  const k = `${type}:${name}`;
  const hit = infoCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.info;
  const get = guardedFetch({ fetchImpl });
  let info;
  try {
    if (type === 'npm') {
      const r = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`npm says ${r.status}`);
      const j = await r.json();
      const scripts = Object.keys(j.scripts || {}).filter((s) => /^(pre|post)?install$|^prepare$/.test(s));
      const bins = typeof j.bin === 'string' ? [name.split('/').pop()] : Object.keys(j.bin || {}).slice(0, 10);
      info = { type, name, version: String(j.version || ''), installScripts: scripts, bins, deprecated: typeof j.deprecated === 'string' ? j.deprecated.slice(0, 200) : '', homepage: j.homepage || '' };
    } else if (type === 'pypi') {
      const r = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`PyPI says ${r.status}`);
      const j = await r.json();
      const files = Array.isArray(j.urls) ? j.urls : [];
      info = { type, name, version: String(j.info?.version || ''), wheel: files.some((f) => f.packagetype === 'bdist_wheel'), deprecated: j.info?.yanked ? 'this version was yanked' : '', homepage: j.info?.home_page || j.info?.project_url || '' };
    } else if (type === 'oci') {
      const tag = /:[^/:@]+$/.exec(name)?.[0]?.slice(1) || 'latest';
      info = { type, name, version: tag };
    } else throw new Error(`MCP Browser can't start ${type} packages`);
    if (!VERSION_RE.test(info.version)) throw new Error('no usable version found');
  } catch (e) {
    return { type, name, version: '', error: errMsg(e) };
  }
  infoCache.set(k, { at: Date.now(), info });
  return info;
}

// ---------- macOS sandbox ----------

const sb = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Folders inside the home folder that the server's runtime itself needs to read (nvm's node, uv). */
function runtimeReadDirs() {
  const h = real(home());
  const out = new Set();
  for (const c of ['node', 'npx', 'uvx', 'uv']) {
    const p = findCommand(c);
    if (!p) continue;
    const r = real(p);
    if (!inside(r, h)) continue;
    // ~/.nvm/versions/node/v22/bin/node → ~/.nvm/versions/node/v22 (its lib/node_modules has npm)
    out.add(c === 'node' || c === 'npx' ? path.dirname(path.dirname(real(findCommand('node') || r))) : r);
    if (p !== r) out.add(p);
  }
  return [...out];
}

/**
 * Sandbox profile: everything allowed except reading or writing the home folder
 * (outside the server's own folder and its runtime), external volumes, and
 * writing anywhere but the server's folder, temp and /dev.
 */
export function sandboxProfile(serverDir) {
  const h = real(home());
  const dir = real(serverDir);
  const readOk = runtimeReadDirs();
  return `(version 1)
(allow default)
(deny file-read-data file-write*
  (require-all
    (subpath ${sb(h)})
    (require-not (subpath ${sb(dir)}))
${readOk.map((d) => `    (require-not (subpath ${sb(d)}))`).join('\n')}))
(deny file-write* (require-all (subpath ${sb(h)}) (require-not (subpath ${sb(dir)}))))
(deny file-read-data file-write* (subpath "/Volumes"))
(deny file-write*
  (require-all
    (require-not (subpath ${sb(dir)}))
    (require-not (subpath "/private/tmp"))
    (require-not (subpath "/private/var/folders"))
    (require-not (subpath "/dev"))))
`;
}

function runQuiet(cmd, args, { env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: errMsg(e) });
    }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => ((out += errMsg(e)), clearTimeout(t), resolve({ code: -1, out })));
    p.on('close', (code) => (clearTimeout(t), resolve({ code, out })));
  });
}

let sandboxState = null;
/**
 * Whether the macOS sandbox works on this computer, checked for real: under the
 * profile, a file in the home folder must be unreadable and unwritable while the
 * server's own folder works and node starts.
 */
export function sandboxStatus({ base = path.join(dataDir(), 'local-servers'), force = false } = {}) {
  if (sandboxState && !force) return sandboxState;
  sandboxState = (async () => {
    if (process.platform !== 'darwin') return { available: false, reason: 'The built-in sandbox needs macOS. Use Docker for isolation here.' };
    if (!fs.existsSync('/usr/bin/sandbox-exec')) return { available: false, reason: 'sandbox-exec is missing on this Mac.' };
    const h = real(home());
    if (!inside(real(base), h)) return { available: false, reason: 'MCP Browser’s data folder is outside your home folder, so the check can’t run.' };
    fs.mkdirSync(base, { recursive: true });
    const canary = path.join(base, '.sandbox-canary');
    fs.writeFileSync(canary, 'secret');
    const probeDir = path.join(base, '.sandbox-probe');
    fs.mkdirSync(path.join(probeDir, 'tmp'), { recursive: true });
    const outside = path.join(h, `.mcpb-sandbox-probe-${process.pid}`);
    const prof = sandboxProfile(probeDir);
    const env = { PATH: searchPath().join(':'), HOME: path.join(probeDir) };
    const run = (cmd, args) => runQuiet('/usr/bin/sandbox-exec', ['-p', prof, cmd, ...args], { env });
    const fails = [];
    const r1 = await run('/bin/cat', [canary]);
    if (r1.code === 0 || r1.out.includes('secret')) fails.push('could read a file in your home folder');
    const r2 = await run('/bin/ls', [h]);
    if (r2.code === 0) fails.push('could list your home folder');
    await run('/usr/bin/touch', [outside]);
    if (fs.existsSync(outside)) (fails.push('could write to your home folder'), fs.rmSync(outside, { force: true }));
    const r4 = await run('/bin/sh', ['-c', `echo ok > ${JSON.stringify(path.join(probeDir, 'tmp', 'p'))} && cat ${JSON.stringify(path.join(probeDir, 'tmp', 'p'))}`]);
    if (r4.code !== 0 || !r4.out.includes('ok')) fails.push(`the server's own folder didn't work (${r4.out.trim().slice(0, 120)})`);
    const node = findCommand('node');
    if (node) {
      const r5 = await run(node, ['-e', 'process.stdout.write("node-ok")']);
      if (!r5.out.includes('node-ok')) fails.push(`node didn't start inside it (${r5.out.trim().slice(0, 160)})`);
    }
    fs.rmSync(canary, { force: true });
    if (fails.length) return { available: false, reason: `The sandbox check failed on this Mac: ${fails.join('; ')}.` };
    return { available: true, checkedAt: new Date().toISOString() };
  })().catch((e) => ({ available: false, reason: `The sandbox check failed: ${errMsg(e)}` }));
  return sandboxState;
}

// ---------- launch ----------

/** Proxy and certificate settings, so servers work on networks that need a proxy. */
function netEnv() {
  const out = {};
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) if (process.env[k]) out[k] = process.env[k];
  return out;
}

/**
 * How to start an approved server: { command, args, env, cwd }.
 * a: approval record; values: { NAME: value } for its settings.
 */
export function launchSpec(a, values, { base = path.join(dataDir(), 'local-servers'), rt = runtimes() } = {}) {
  const dir = path.join(base, a.key);
  for (const d of ['home', 'tmp', 'cache', 'work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const npmrc = path.join(dir, 'npmrc');
  if (!fs.existsSync(npmrc)) fs.writeFileSync(npmrc, '');
  const settingEnv = Object.fromEntries(Object.entries(values || {}).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string'));
  const h = real(home());
  // PATH without folders in the home folder (except the runtime's own), so nothing there is run or read.
  const runtimeDirs = new Set([rt.node, rt.npx, rt.uvx].filter(Boolean).flatMap((c) => [path.dirname(c), path.dirname(real(c))]));
  const PATH = searchPath()
    .filter((p) => !inside(real(p), h) || runtimeDirs.has(p) || runtimeDirs.has(real(p)))
    .join(path.delimiter);
  const env = {
    PATH,
    HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'),
    TMP: path.join(dir, 'tmp'),
    TEMP: path.join(dir, 'tmp'),
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    ...netEnv(),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, APPDATA: path.join(dir, 'home'), LOCALAPPDATA: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home') } : {}),
  };
  // Install-time code (npm scripts, PyPI source builds) only runs when the server is isolated.
  const isolated = a.isolation === 'sandbox' || a.isolation === 'docker';
  const npmEnv = { npm_config_ignore_scripts: a.allowScripts && isolated ? 'false' : 'true', npm_config_cache: path.join(dir, 'cache'), npm_config_userconfig: npmrc, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_yes: 'true', npm_config_loglevel: 'error' };
  const uvEnv = { UV_CACHE_DIR: path.join(dir, 'cache', 'uv'), UV_TOOL_DIR: path.join(dir, 'cache', 'uv-tools'), UV_PYTHON_INSTALL_DIR: path.join(dir, 'cache', 'uv-python'), UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1' };
  const pkg = a.type === 'npm' ? `${a.name}@${a.version}` : a.type === 'pypi' ? `${a.name}@${a.version}` : a.name;
  // The approved command after npx / uvx / docker run (startup arguments included, pinned);
  // approvals from before startup arguments were known run just the package.
  const argv = Array.isArray(a.argv) && a.argv.length ? a.argv : [pkg];

  if (a.isolation === 'docker' || a.type === 'oci') {
    if (!rt.docker) throw new Error('Docker isn’t installed or isn’t running');
    // The docker command itself needs the real home folder (its settings and socket); the server doesn't see it.
    const dEnv = { PATH: searchPath().join(path.delimiter), HOME: process.env.HOME || home(), ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}), ...settingEnv };
    const common = ['run', '-i', '--rm', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--pids-limit', '512', '--label', 'mcp-browser=1', ...Object.keys(settingEnv).flatMap((k) => ['-e', k])];
    if (a.type === 'oci') return { command: rt.docker, args: [...common, ...(Array.isArray(a.argv) && a.argv.length ? a.argv : [a.name])], env: dEnv, cwd: path.join(dir, 'work'), isolation: 'docker' };
    if (a.type === 'npm') return { command: rt.docker, args: [...common, '-e', 'npm_config_ignore_scripts=true', '-e', 'npm_config_update_notifier=false', '-v', `mcpb-${a.key}-npm:/root/.npm`, NODE_IMAGE, 'npx', '-y', ...argv], env: dEnv, cwd: path.join(dir, 'work'), isolation: 'docker' };
    // In Docker, PyPI packages may build from source: that happens inside the container.
    return { command: rt.docker, args: [...common, '-v', `mcpb-${a.key}-uv:/root/.cache/uv`, UV_IMAGE, 'uvx', ...argv], env: dEnv, cwd: path.join(dir, 'work'), isolation: 'docker' };
  }

  let command;
  let args;
  if (a.type === 'npm') {
    if (!rt.npx) throw new Error('Node.js (npx) isn’t installed: get it from nodejs.org');
    command = rt.npx;
    args = ['-y', ...argv];
    Object.assign(env, npmEnv);
  } else if (a.type === 'pypi') {
    if (!rt.uvx) throw new Error('uv isn’t installed: brew install uv');
    command = rt.uvx;
    args = [...(a.allowBuild && isolated ? [] : ['--no-build']), ...(a.refresh ? ['--refresh-package', a.name] : []), ...argv];
    Object.assign(env, uvEnv);
  } else throw new Error(`MCP Browser can't start ${a.type} packages`);
  Object.assign(env, settingEnv);
  if (a.isolation === 'sandbox') {
    if (process.platform !== 'darwin') throw new Error('The built-in sandbox needs macOS');
    // A Python in the home folder (conda, pyenv) can't be read in the sandbox: uv uses its own, in the server's folder.
    if (a.type === 'pypi') env.UV_PYTHON_PREFERENCE = 'only-managed';
    return { command: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile(dir), command, ...args], env, cwd: path.join(dir, 'work'), isolation: 'sandbox' };
  }
  return { command, args, env, cwd: path.join(dir, 'work'), isolation: 'none' };
}

// ---------- when a start fails ----------

/**
 * A known fix for a failed start, from what it printed, or null.
 * { argv?, refresh?, allowBuild?, allowScripts?, why } — builds and install scripts only
 * when the server is isolated (sandbox or Docker).
 */
export function healLaunch(a, log, info = {}) {
  const t = String(log || '').replace(/\x1b\[[0-9;]*m/g, '');
  const argv = Array.isArray(a.argv) && a.argv.length ? a.argv : null;
  const isolated = a.isolation === 'sandbox' || a.isolation === 'docker';
  if (a.type === 'pypi' && !a.refresh && /no version of [\w.\[\]-]+==|no versions? of [\w.-]+ (?:that|matching)/i.test(t)) return { refresh: true, why: 'the package index was out of date here' };
  // uv: "An executable named `x` is not provided by package `p`. The following executables are available: - y"
  const exe = /executable named `([^`]+)` is not provided by package `([^`]+)`[\s\S]*?available:\s*-\s*([\w.-]+)/i.exec(t);
  if (a.type === 'pypi' && exe && argv) {
    // "--from pkg[extra]==v wrong-name": just the command changes.
    const f = argv.indexOf('--from');
    if (f >= 0 && argv[f + 2] === exe[1]) {
      const next = [...argv];
      next[f + 2] = exe[3];
      return { argv: next, why: `its command is ${exe[3]}` };
    }
    const i = argv.findIndex((x) => x === `${a.name}@${a.version}` || x.startsWith(`${a.name}@`));
    if (i >= 0) {
      const next = [...argv];
      next.splice(i, 1, '--from', `${a.name}==${a.version}`, exe[3]);
      // a stray word that was the wrong command name goes too
      if (next[i + 3] === exe[1]) next.splice(i + 3, 1);
      return { argv: next, why: `its command is ${exe[3]}` };
    }
  }
  // npx: "could not determine executable to run": name the package's command.
  if (a.type === 'npm' && /could not determine executable to run/i.test(t) && argv && info.bins?.length) {
    const bin = info.bins.find((b) => /mcp/i.test(b)) || info.bins[0];
    const i = argv.findIndex((x) => x === `${a.name}@${a.version}`);
    if (i >= 0 && /^[\w@./-]{1,80}$/.test(bin)) {
      const next = [...argv];
      next.splice(i, 1, '-p', `${a.name}@${a.version}`, bin);
      return { argv: next, why: `its command is ${bin}` };
    }
  }
  if (a.type === 'pypi' && !a.allowBuild && /no usable wheels|--no-build|can't be built|not allowed to build|building source distributions is disabled/i.test(t)) {
    return isolated ? { allowBuild: true, why: 'a dependency has to be built from source (allowed in the sandbox)' } : null;
  }
  if (a.type === 'npm' && !a.allowScripts && /postinstall|install script|not installed yet\. reinstall|run the install script|binary.*(?:not found|missing)/i.test(t)) {
    return isolated ? { allowScripts: true, why: 'it needs its install script (allowed in the sandbox)' } : null;
  }
  return null;
}

/** Why a server didn't start, in words, when it's a setting rather than a bug: { kind, hint } or null. */
export function explainFailure(log) {
  const t = String(log || '').replace(/\x1b\[[0-9;]*m/g, '');
  const env = /\b([A-Z][A-Z0-9_]{2,60})\b[^\n]{0,40}(?:environment variable )?(?:is )?(?:not set|missing|required|must be set)/.exec(t) || /(?:set|missing|requires?) (?:the )?([A-Z][A-Z0-9_]{2,60}) (?:environment variable|env var)/.exec(t);
  if (env && /KEY|TOKEN|SECRET|PASSWORD|URL|HOST|DSN|ID\b/.test(env[1])) return { kind: 'needs-key', hint: `it needs ${env[1]}, which the registry doesn’t list` };
  if (/\b(?:api key|access token|personal access token|credentials?) (?:is |are )?(?:not set|missing|required|not configured)|no api key configured/i.test(t)) return { kind: 'needs-key', hint: 'it needs an API key or token the registry doesn’t list' };
  const usage = /\bUsage:\s*([^\n]{0,120})/i.exec(t);
  if (usage && /<[^>]+>|--[\w-]+ \S|required/i.test(usage[1] + t.slice(usage.index, usage.index + 400))) return { kind: 'needs-args', hint: `it needs startup arguments the registry doesn’t list: ${usage[1].trim()}` };
  const node = /requires Node\.?js ([\d.]+)/i.exec(t);
  if (node) return { kind: 'runtime', hint: `it needs Node.js ${node[1]} or newer` };
  return null;
}

// ---------- approvals ----------

export class LocalServers {
  /** rowFor(id) → { title, description, type, pkgId, settings: [{ name, secret, header, description }] } | null */
  constructor({ file = path.join(dataDir(), 'local-servers.json'), base = path.join(dataDir(), 'local-servers'), onChange = () => {} } = {}) {
    this.file = file;
    this.base = base;
    this.onChange = onChange;
    this.approved = [];
    this.keys = new Map(); // id -> { NAME: secret }  (memory only)
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.approved)) this.approved = d.approved.filter((a) => a && typeof a.id === 'string' && VERSION_RE.test(a.version || '') && ['npm', 'pypi', 'oci'].includes(a.type));
    } catch {
      /* none yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ approved: this.approved }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
    this.onChange();
  }

  get(id) {
    return this.approved.find((a) => a.id === id) || null;
  }

  /** Settings still missing (secrets are lost when MCP Browser quits). */
  missing(a) {
    const k = this.keys.get(a.id) || {};
    return (a.settings || []).filter((s) => !(s.secret ? k[s.name] : a.values?.[s.name])).map((s) => s.name);
  }

  valuesFor(a) {
    const k = this.keys.get(a.id) || {};
    return Object.fromEntries((a.settings || []).map((s) => [s.name, s.secret ? k[s.name] : a.values?.[s.name]]).filter(([, v]) => v));
  }

  /** Server entries for the search catalog: approved and with every setting filled in. */
  servers() {
    return this.approved
      .filter((a) => !this.missing(a).length)
      .map((a) => ({ id: a.id, title: a.title, description: a.description, url: `local://${a.key}`, kind: 'local', source: 'local', trust: 'community', tags: [], transport: 'stdio', idleMs: IDLE_MS, connectTimeoutMs: 300000 }));
  }

  approve({ id, title, description, type, name, version, isolation, settings = [], values = {}, secrets = {}, trusted = false, argv }) {
    if (!['npm', 'pypi', 'oci'].includes(type)) throw new Error(`MCP Browser can't start ${type} packages`);
    if (!VERSION_RE.test(String(version || ''))) throw new Error('no version to pin');
    if (!['sandbox', 'docker', 'none'].includes(isolation)) throw new Error('choose how to run it');
    const secretNames = new Set(settings.filter((s) => s.secret).map((s) => s.name));
    const clean = (o, keep) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => keep(k) && typeof v === 'string' && v.trim() && v.length <= 4000).map(([k, v]) => [k, v.trim()]));
    const rec = {
      id,
      key: keyOf(id),
      title: String(title || id).slice(0, 120),
      description: String(description || '').slice(0, 400),
      type,
      name: String(name).slice(0, 214),
      version,
      isolation,
      trusted: Boolean(trusted),
      settings: settings.map((s) => ({ name: s.name, secret: Boolean(s.secret), header: Boolean(s.header), description: String(s.description || '').slice(0, 200) })),
      values: clean(values, (k) => settings.some((s) => s.name === k) && !secretNames.has(k)),
      approvedAt: new Date().toISOString(),
      ...(Array.isArray(argv) && argv.length && argv.length <= 40 && argv.every((x) => typeof x === 'string' && x.length <= 300 && !/[\u0000-\u001f]/.test(x)) ? { argv } : {}),
    };
    this.approved = [...this.approved.filter((a) => a.id !== id), rec];
    this.keys.set(id, clean(secrets, (k) => secretNames.has(k)));
    this.save();
    return rec;
  }

  /** Apply a fix from healLaunch to an approval (same version). */
  patch(id, fix) {
    const a = this.get(id);
    if (!a) return null;
    if (Array.isArray(fix.argv) && fix.argv.length <= 40 && fix.argv.every((x) => typeof x === 'string' && x.length <= 300 && !/[\u0000-\u001f]/.test(x))) a.argv = fix.argv;
    for (const k of ['refresh', 'allowBuild', 'allowScripts']) if (fix[k]) a[k] = true;
    this.save();
    return a;
  }

  setKeys(id, secrets = {}) {
    const a = this.get(id);
    if (!a) throw new Error('not approved');
    const names = new Set(a.settings.filter((s) => s.secret).map((s) => s.name));
    const cur = this.keys.get(id) || {};
    for (const [k, v] of Object.entries(secrets || {})) if (names.has(k) && typeof v === 'string' && v.trim() && v.length <= 4000) cur[k] = v.trim();
    this.keys.set(id, cur);
    this.onChange();
  }

  forget(id) {
    const a = this.get(id);
    this.approved = this.approved.filter((x) => x.id !== id);
    this.keys.delete(id);
    this.save();
    if (a) fs.rmSync(path.join(this.base, a.key), { recursive: true, force: true });
  }

  launch(server) {
    const a = this.get(server.id);
    if (!a) throw new Error('this server is not approved to run here');
    if (this.missing(a).length) throw new Error(`fill in ${this.missing(a).join(', ')} first`);
    return { ...launchSpec(a, this.valuesFor(a), { base: this.base }), secrets: Object.values(this.keys.get(a.id) || {}) };
  }
}
