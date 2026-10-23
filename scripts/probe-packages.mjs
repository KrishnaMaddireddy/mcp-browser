#!/usr/bin/env node
// Test package MCP servers (npm, PyPI) for real, in a throwaway machine (a
// container or VM, never your own computer: this runs other people's code with
// no sandbox). Each server is started the way MCP Browser starts it (pinned
// version, the registry's startup arguments made safe, npm install scripts off,
// PyPI wheels only), its tools are listed, and one sample question is asked in
// free mode. Results go to <data dir>/catalog-build/package-probe.jsonl (one line
// per server, resumable); build-catalog.js turns them into "tested" labels.
//
//   node scripts/probe-packages.mjs [--limit 600] [--concurrency 3] [--trusted] [--only id,id] [--retest]
//
// Status per server:
//   answers      started, listed tools, and a free-mode question got a useful reply
//   starts       started and listed tools (no free-mode question fits, or the reply was empty)
//   no-tools     started but listed no tools
//   fails        didn't start, or crashed; `error` says why (install, missing runtime, crash…)
//   needs-key    needs a secret setting (API key, token): not testable without one
//   needs-args   needs startup arguments only a user can fill in
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_LOG = process.env.MCPB_LOG || 'silent';
const { dataDir } = await import('../src/config.js');
const { loadCatalog, guideLib, trustOf } = await import('../src/catalog-index.js');
const { packageInfo, findCommand, healLaunch, explainFailure } = await import('../src/local-servers.js');
const { classifyTool } = await import('../src/policy.js');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const LIMIT = Number(opt('--limit', 600));
const CONC = Number(opt('--concurrency', 3));
const ONLY = opt('--only', '') ? opt('--only').split(',') : null;
const TRUSTED = argv.includes('--trusted');
const RETEST = argv.includes('--retest');
const REFAILS = argv.includes('--refails'); // test again only what failed (e.g. after a launcher fix)
const START_MS = Number(opt('--start-ms', 150000));

const work = path.join(dataDir(), 'catalog-build');
fs.mkdirSync(work, { recursive: true });
const OUT = path.join(work, 'package-probe.jsonl');
const SCRATCH = path.join(os.tmpdir(), 'mcpb-probe');
fs.mkdirSync(path.join(SCRATCH, 'home'), { recursive: true });

// Values for settings that aren't secrets, so those servers can be tested too.
const TEST_VALUES = {
  EDGAR_IDENTITY: 'MCP Browser test mcpb-test@example.com',
  USER_AGENT: 'mcp-browser-test/1.0',
  LOG_LEVEL: 'info',
  TZ: 'UTC',
};

const done = new Map();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l.trim()) try {
  const r = JSON.parse(l);
  done.set(r.id, r);
} catch {}

const { createEngine } = await import('../src/app.js');
const engine = createEngine({ providerOverride: null, curated: [] });
engine.updateSettings({ discovery: false, freeModeBudgetMs: 30000, toolTimeoutMs: 30000 }); // testing what a server can do, not page speed
const specs = new Map(); // server id -> how to start it (the pool asks for it)
engine.pool.localLaunch = (s) => specs.get(s.id);
engine.pool.maxConnections = 64;
const c = loadCatalog();
const { F } = c;
const g = guideLib();
const rt = { npx: findCommand('npx'), uvx: findCommand('uvx') };

let rows = c.rows.filter((r) => (r[F.pkgType] === 'npm' || r[F.pkgType] === 'pypi') && !r[F.deprecated]);
if (ONLY) rows = rows.filter((r) => ONLY.includes(r[F.name]));
if (TRUSTED) rows = rows.filter((r) => trustOf(r).trusted);
// Most-used first: trusted, then popularity.
rows.sort((a, b) => trustOf(b).trusted - trustOf(a).trusted || (b._pop || 0) - (a._pop || 0));
if (REFAILS) rows = rows.filter((r) => done.get(r[F.name])?.status === 'fails');
else if (!RETEST) rows = rows.filter((r) => !done.has(r[F.name]));
rows = rows.slice(0, LIMIT);
console.log(`${rows.length} servers to test (${done.size} already tested), ${CONC} at a time → ${OUT}`);

const write = (rec) => fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
const short = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const redact = (s, secrets) => secrets.reduce((t, x) => (x && x.length >= 4 ? t.split(x).join('***') : t), String(s || ''));

function freeDisk() {
  try {
    const st = fs.statfsSync(SCRATCH);
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return 99;
  }
}
function cleanCaches() {
  for (const p of [path.join(SCRATCH, 'npm-cache'), path.join(SCRATCH, 'uv-cache'), path.join(SCRATCH, 'uv-tools')]) fs.rmSync(p, { recursive: true, force: true });
}

// What follows npx / uvx for a launch, and back (the same shape approvals keep).
const argvOf = (type, args) => (type === 'npm' ? (args[0] === '-y' ? args.slice(1) : args) : args[0] === '--no-build' ? args.slice(1) : args);

let runSeq = 0;
async function probe(r, fix = null) {
  // Each test gets its own home, temp and package caches, deleted when it ends: disk use stays
  // bounded and no test touches another's files.
  const RUN = path.join(SCRATCH, `run-${++runSeq}`);
  try {
    return await probeIn(r, fix, RUN);
  } finally {
    fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function probeIn(r, fix, RUN) {
  const id = r[F.name];
  const type = r[F.pkgType];
  const base = { id, type, pkg: r[F.pkgId], testedAt: new Date().toISOString().slice(0, 10) };
  const envs = ((F.envs != null && r[F.envs]) || []).filter(([, , , kind]) => kind !== 'h');
  const secret = envs.filter(([n, s]) => s && !TEST_VALUES[n]);
  if (secret.length) return { ...base, status: 'needs-key', error: `needs ${secret.map(([n]) => n).join(', ')}` };
  const info = await packageInfo(type, r[F.pkgId]);
  if (info.error) return { ...base, status: 'fails', error: `package lookup: ${short(info.error, 120)}`, stage: 'lookup' };
  const l = g.launchOf(r, F, { pin: { version: info.version, wheel: info.wheel !== false } });
  if (l.needsArgs) return { ...base, version: info.version, status: 'needs-args', error: short(l.needsArgs.join('; '), 200) };
  const settingEnv = {};
  for (const [n] of envs) settingEnv[n] = TEST_VALUES[n] || 'test';
  const cmd = type === 'npm' ? rt.npx : rt.uvx;
  if (!cmd) return { ...base, status: 'fails', error: `${type === 'npm' ? 'npx' : 'uvx'} not installed here`, stage: 'runtime' };
  let args = l.args.map(String);
  // A fix from healLaunch (this machine counts as isolated, like the macOS sandbox).
  if (fix) {
    const rest = fix.argv || argvOf(type, args);
    args = type === 'npm' ? ['-y', ...rest] : [...(fix.allowBuild ? [] : ['--no-build']), ...(fix.refresh ? ['--refresh-package', info.name] : []), ...rest];
  }
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(RUN, 'home'),
    TMPDIR: path.join(RUN, 'tmp'),
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'UV_NATIVE_TLS'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    npm_config_ignore_scripts: fix?.allowScripts ? 'false' : 'true',
    npm_config_cache: path.join(RUN, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_yes: 'true',
    npm_config_loglevel: 'error',
    UV_CACHE_DIR: path.join(RUN, 'uv-cache'),
    UV_TOOL_DIR: path.join(RUN, 'uv-tools'),
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
    ...settingEnv,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
  const rec = { ...base, version: info.version, cmd: `${type === 'npm' ? 'npx' : 'uvx'} ${args.join(' ')}`.slice(0, 300) };
  // The app's own path: the pool starts it as a local server and free-mode search asks it,
  // with every recipe the app uses (resolve-then-query, tickers, places…).
  // setsid: the server and everything it starts are one process group, killed together afterwards.
  const server = { id, title: r[F.title] || id.split('/').pop(), description: r[F.desc] || '', url: `local://probe/${id}`, kind: 'local', source: 'local', trust: 'community', tags: [], connectTimeoutMs: START_MS, idleMs: 600000 };
  specs.set(id, { command: '/usr/bin/setsid', args: [cmd, ...args], env, cwd: env.HOME, secrets: [] });
  const t0 = Date.now();
  const kill = () => {
    const pid = engine.pool.state(id)?.pid;
    try {
      if (pid) process.kill(-pid, 'SIGKILL');
    } catch {}
  };
  try {
    const { tools } = await engine.pool.get(server);
    rec.startMs = Date.now() - t0;
    rec.tools = tools.length;
    rec.readTools = tools.filter((t) => classifyTool(t).allowed).length;
    rec.toolNames = tools.slice(0, 20).map((t) => t.name);
    if (!tools.length) {
      rec.status = 'no-tools';
      return rec;
    }
    rec.status = 'starts';
    const prompt = ((F.prompts != null && r[F.prompts]) || [])[0]?.[0] || r[F.title] || '';
    if (!prompt) return rec;
    const ct = Date.now();
    const calls = [];
    let useful = null;
    let skipped = '';
    let quick = null;
    let lastError = '';
    await engine.agent.search(prompt, {
      servers: [id],
      adhoc: [server],
      emit: (type, d) => {
        if (type === 'tool_call') calls.push(d.tool);
        if (type === 'results' && !d.isError && (d.kind || 'ok') === 'ok' && !d.offTopic && !useful) useful = { tool: d.tool, preview: short(d.text, 160) };
        if (type === 'server' && d.status === 'skipped') skipped = d.error || 'skipped';
        if (type === 'quick_answer') quick = short(d.text, 160);
        if (type === 'tool_result' && d.ok === false && d.error) lastError = short(d.error, 160);
      },
    });
    rec.call = { prompt: short(prompt, 120), ms: Date.now() - ct, tools: calls.slice(0, 4), ...(useful ? { tool: useful.tool, preview: useful.preview } : {}), ...(quick ? { quick } : {}), ...(lastError && !useful ? { error: lastError } : {}) };
    if (useful) rec.status = 'answers';
    else if (skipped) rec.note = /AI model/.test(skipped) ? 'no tool takes a plain question (needs an AI model)' : short(skipped, 120);
    else rec.note = calls.length ? 'replied, but not with anything useful for the sample question' : 'not asked';
    return rec;
  } catch (e) {
    rec.ms = Date.now() - t0;
    if (!rec.startMs) {
      rec.status = 'fails';
      const msg = String(e.message || e) + (e.log ? `\n${e.log}` : '');
      rec.error = short(msg, 400);
      Object.defineProperty(rec, '_heal', { value: { log: msg, info, argv: argvOf(type, args), version: info.version, name: info.name }, enumerable: false });
      rec.stage = /No solution found|not found in the package registry|\b404\b|E404|ETARGET|depends on|No matching distribution|can't be built|--no-build|Failed to download|No such file or directory/i.test(msg) ? 'install' : /timed out|too slow/i.test(msg) ? 'timeout' : 'start';
    } else rec.callError = short(e.message, 200);
    return rec;
  } finally {
    rec.ms ??= Date.now() - t0;
    kill();
    await engine.pool.close(id).catch(() => {});
    kill();
    specs.delete(id);
  }
}

let i = 0;
let n = 0;
const counts = {};
async function worker() {
  while (i < rows.length) {
    const r = rows[i++];
    let rec;
    try {
      rec = await probe(r);
      // The app's self-healing start: one retry with a known fix, then a plain reason.
      if (rec.status === 'fails' && rec._heal) {
        const h = rec._heal;
        const a = { type: rec.type, name: h.name, version: h.version, argv: h.argv, isolation: 'sandbox' };
        let fixState = {};
        for (let k = 0; k < 2 && rec.status === 'fails' && rec._heal; k++) {
          const fix = healLaunch({ ...a, ...fixState, argv: fixState.argv || a.argv }, rec._heal.log, h.info);
          if (!fix) break;
          fixState = { ...fixState, ...fix };
          const again = await probe(r, fixState);
          again.healed = [rec.healed, fix.why].filter(Boolean).join('; ');
          rec = again;
        }
        if (rec.status === 'fails') {
          const why = explainFailure(rec._heal?.log || rec.error);
          if (why && (why.kind === 'needs-key' || why.kind === 'needs-args' || why.kind === 'platform')) Object.assign(rec, { status: why.kind, error: why.hint });
          else if (why) rec.reason = why.hint;
        }
      }
    } catch (e) {
      rec = { id: r[F.name], type: r[F.pkgType], status: 'fails', error: short(e.message), stage: 'harness', testedAt: new Date().toISOString().slice(0, 10) };
    }
    write(rec);
    counts[rec.status] = (counts[rec.status] || 0) + 1;
    n++;
    console.log(`${String(n).padStart(4)} ${rec.status.padEnd(10)} ${String(rec.ms ?? '').padStart(6)}ms ${rec.id}${rec.error ? '  ' + rec.error.slice(0, 110) : rec.status === 'answers' ? `  ${rec.call.tool}: ${rec.call.preview?.slice(0, 70)}` : rec.call?.error ? '  ' + rec.call.error.slice(0, 90) : rec.note ? '  ' + rec.note : ''}`);
    if (n % 20 === 0) {
      console.log('   so far:', JSON.stringify(counts), `disk free ${freeDisk().toFixed(1)} GB`);
      if (freeDisk() < 4) console.log('   low disk: stopping'), process.exit(2);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('done:', JSON.stringify(counts));
await engine.close().catch(() => {});
process.exit(0);
