// "Check my installed servers": read the MCP configs of the clients on this
// computer (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf), match each
// server to the registry catalog, and flag risks. Read-only. Secret values never
// leave this module: only their names, and whether they sit in plain text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, guideLib, searchCatalog, runnable, describe } from './catalog-index.js';

/** Config files to look at, per client and platform. */
export function configPaths(home = os.homedir(), platform = process.platform, env = process.env) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const support = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? appData : path.join(home, '.config');
  return [
    { client: 'Claude Desktop', file: path.join(support, 'Claude', 'claude_desktop_config.json'), shape: 'mcpServers' },
    { client: 'Claude Code', file: path.join(home, '.claude.json'), shape: 'claudeCode' },
    { client: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), shape: 'mcpServers' },
    { client: 'VS Code', file: path.join(support, 'Code', 'User', 'mcp.json'), shape: 'servers' },
    { client: 'VS Code', file: path.join(support, 'Code', 'User', 'settings.json'), shape: 'vscodeSettings' },
    { client: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), shape: 'mcpServers' },
  ];
}

/** Lenient JSON: VS Code settings allow comments and trailing commas. */
function parseJsonc(text) {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(stripped);
  }
}

function serversIn(json, shape) {
  const out = [];
  const add = (obj, scope) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, cfg] of Object.entries(obj)) if (cfg && typeof cfg === 'object') out.push({ name, cfg, scope });
  };
  if (shape === 'mcpServers') add(json.mcpServers, 'user');
  else if (shape === 'servers') add(json.servers, 'user');
  else if (shape === 'vscodeSettings') add(json.mcp?.servers, 'user');
  else if (shape === 'claudeCode') {
    add(json.mcpServers, 'user');
    for (const [dir, p] of Object.entries(json.projects || {})) add(p?.mcpServers, dir);
  }
  return out;
}

const SECRET_KEY = /key|token|secret|passw|pwd|auth|bearer|credential|cookie|session|private/i;
const isReference = (v) => /^\$\{[^}]+\}$|^\$[A-Z_][A-Z0-9_]*$|^\$\{input:[^}]+\}$|^<[^>]+>$|^env:/i.test(String(v).trim());
/** A value that is probably a real secret sitting in plain text. */
function plainSecret(key, value) {
  const v = String(value ?? '').trim();
  if (!v || isReference(v) || v.length < 8) return false;
  if (SECRET_KEY.test(key)) return true;
  return /^(sk|pk|ghp|gho|github_pat|xox[abp]|glpat|AKIA|AIza|ya29)[-_A-Za-z0-9]{8,}/.test(v) || (/^[A-Za-z0-9_\-]{32,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v));
}

/** How the client launches it: package id, docker image, or URL. */
export function launchInfo(cfg) {
  const command = String(cfg.command || '').split(/[\\/]/).pop().toLowerCase();
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  let url = typeof cfg.url === 'string' ? cfg.url : typeof cfg.serverUrl === 'string' ? cfg.serverUrl : '';
  let pkg = null;
  const firstPlain = (list) => list.find((a) => !a.startsWith('-'));
  if (['npx', 'pnpx', 'bunx'].includes(command) || (command === 'pnpm' && args[0] === 'dlx')) {
    const rest = command === 'pnpm' ? args.slice(1) : args;
    const id = firstPlain(rest.filter((a, i) => !(rest[i - 1] === '-p' || rest[i - 1] === '--package')));
    if (id === 'mcp-remote' || id?.startsWith('mcp-remote@')) url ||= rest.find((a) => /^https?:\/\//.test(a)) || '';
    else if (id) pkg = { type: 'npm', id: id.replace(/(?<=.)@[^/@]+$/, ''), pinned: /(?<=.)@\d[^/@]*$/.test(id) };
  } else if (command === 'uvx' || (command === 'uv' && args[0] === 'tool' && args[1] === 'run')) {
    const rest = command === 'uv' ? args.slice(2) : args;
    const id = firstPlain(rest.filter((a, i) => !['--from', '--with', '--python'].includes(rest[i - 1])));
    if (id) pkg = { type: 'pypi', id: id.replace(/[=<>~!].*$/, '').replace(/\[.*\]$/, ''), pinned: /==/.test(id) };
  } else if (command === 'docker' || command === 'podman') {
    const i = args.indexOf('run');
    if (i >= 0) {
      const rest = args.slice(i + 1);
      const flagsWithValue = new Set(['-e', '--env', '-v', '--volume', '--name', '-p', '--network', '--env-file', '-w', '--entrypoint', '-u', '--user', '--platform']);
      let image = '';
      for (let k = 0; k < rest.length; k++) {
        if (rest[k].startsWith('-')) {
          if (flagsWithValue.has(rest[k])) k++;
          continue;
        }
        image = rest[k];
        break;
      }
      if (image) pkg = { type: 'oci', id: image, pinned: /[:@]/.test(image.split('/').pop()) && !/:latest$/.test(image) };
    }
  }
  const type = url ? 'remote' : pkg ? 'package' : cfg.command ? 'local command' : 'unknown';
  return { type, command: cfg.command ? String(cfg.command) : '', pkg, url };
}

function matchCatalog(info, name) {
  const c = loadCatalog();
  if (!c) return null;
  const { F, rows } = c;
  if (info.pkg) {
    const id = info.pkg.id.toLowerCase();
    const strip = (x) => String(x || '').toLowerCase().replace(/^docker\.io\//, '').replace(/^(.+?)(:[^/]*)?$/, '$1');
    const hit = rows.filter((r) => r[F.pkgId] && (r[F.pkgId].toLowerCase() === id || (info.pkg.type === 'oci' && strip(r[F.pkgId]) === strip(id))));
    if (hit.length) return hit.sort((a, b) => b._pop - a._pop)[0];
  }
  if (info.url) {
    let host = '';
    try {
      host = new URL(info.url).host.toLowerCase();
    } catch {}
    const exact = rows.find((r) => r[F.remoteUrl] && r[F.remoteUrl].replace(/\/+$/, '') === info.url.replace(/\/+$/, ''));
    if (exact) return exact;
    const sameHost = rows.filter((r) => r[F.remoteUrl] && r[F.remoteUrl].toLowerCase().includes(`//${host}`));
    if (host && sameHost.length) return sameHost.sort((a, b) => b._pop - a._pop)[0];
  }
  return null;
}

/** Better-maintained or more-used servers for the same job. */
function alternatives(row) {
  const c = loadCatalog();
  const { F, D } = c;
  const words = `${row[F.title]} ${String(row[F.desc] || '').split(/[.:;—–-]/)[0]}`;
  return searchCatalog(words, { limit: 12 })
    .filter((r) => r !== row && r[F.cat] === row[F.cat] && !r[F.archived] && r._pop > row._pop + 0.5)
    .slice(0, 2)
    .map((r) => ({ server_id: r[F.name], title: r[F.title] || r[F.name].split('/').pop(), stars: r[F.stars] >= 0 ? r[F.stars] : null, runs_in_mcp_browser: runnable(r, F), category: D.cats[r[F.cat]]?.[1] }));
}

/** Audit every config found. Returns no secret values. */
export function auditInstalled({ paths = configPaths() } = {}) {
  const c = loadCatalog();
  const g = c ? guideLib() : null;
  const files = [];
  const servers = [];
  for (const p of paths) {
    let text;
    try {
      text = fs.readFileSync(p.file, 'utf8');
    } catch {
      files.push({ client: p.client, file: p.file, found: false });
      continue;
    }
    let json;
    try {
      json = parseJsonc(text);
    } catch (e) {
      files.push({ client: p.client, file: p.file, found: true, error: 'could not read it as JSON' });
      continue;
    }
    const list = serversIn(json, p.shape);
    files.push({ client: p.client, file: p.file, found: true, servers: list.length });
    for (const { name, cfg, scope } of list) {
      const info = launchInfo(cfg);
      const row = matchCatalog(info, name);
      const checks = [];
      // Secrets written straight into the config file.
      const envs = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
      const headers = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
      const plain = [...Object.entries(envs), ...Object.entries(headers)].filter(([k, v]) => plainSecret(k, v)).map(([k]) => k);
      const argSecret = (Array.isArray(cfg.args) ? cfg.args : []).some((a) => /(?:key|token|secret)=\S{8,}/i.test(String(a)) || /^Bearer\s+\S{12,}/.test(String(a)));
      if (plain.length) checks.push(['warn', `${plain.join(', ')} ${plain.length > 1 ? 'are' : 'is'} stored in plain text in this file. Anyone or anything that can read it gets the key; prefer your OS keychain or an env var reference.`]);
      if (argSecret) checks.push(['warn', 'A key appears in the launch arguments (visible in process lists and logs).']);
      if (info.pkg && !info.pkg.pinned) checks.push(['info', `Runs the latest ${info.pkg.type === 'oci' ? 'image' : 'version'} every time it starts, so an update you haven’t reviewed can run. Pin a version if this server has access to anything sensitive.`]);
      if (info.url && /^http:\/\//i.test(info.url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(info.url)) checks.push(['bad', 'Connects over plain HTTP: traffic and keys can be read on the network.']);
      if (!row && (info.pkg || info.url)) checks.push(['info', 'Not found in the official MCP Registry: check where it comes from before trusting it.']);
      if (!row && !info.pkg && !info.url && info.command) checks.push(['info', 'Runs a local program; nothing to compare with the registry.']);
      if (row && g) for (const ch of g.gotchas(row, c.F)) if (!/^Needs (a setting|\d+ settings)/.test(ch[1])) checks.push(ch);
      const level = checks.some(([l]) => l === 'bad') ? 'bad' : checks.some(([l]) => l === 'warn') ? 'warn' : 'ok';
      servers.push({
        client: p.client,
        file: p.file,
        scope,
        name,
        how: info.type === 'remote' ? info.url : info.pkg ? `${info.pkg.type} ${info.pkg.id}` : info.command || 'unknown',
        env_names: Object.keys(envs),
        catalog: row ? describe(row) : null,
        checks: checks.map(([l, t]) => ({ level: l, text: t })),
        level,
        alternatives: row && level !== 'ok' ? alternatives(row) : [],
      });
    }
  }
  const counts = { servers: servers.length, bad: servers.filter((s) => s.level === 'bad').length, warn: servers.filter((s) => s.level === 'warn').length };
  return { checkedAt: new Date().toISOString(), catalog: Boolean(c), files, servers, counts };
}
