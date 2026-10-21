// Runs the stack setup script on this computer for MCP Browser's "Set up now",
// "Preview changes" and "Remove from my apps". Keys come in with the request,
// go to the script in its environment only, and are hidden in what comes back;
// nothing is stored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setupScript } from './stack-script.js';

const CLIENT_IDS = ['desktop', 'code', 'cursor', 'vscode'];

function childEnv(valuesByKey) {
  const home = os.homedir();
  // Apps started from the Dock get a short PATH; add the usual install places for claude, uvx, npx, docker.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.claude', 'local')];
  const env = { PATH: [process.env.PATH || '', ...extra].filter(Boolean).join(path.delimiter), HOME: process.env.HOME || home, MCPB_VALUES: JSON.stringify(valuesByKey || {}) };
  for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TMPDIR', 'LANG', 'XDG_CONFIG_HOME']) if (process.env[k]) env[k] = process.env[k];
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function run(script, args, valuesByKey, { timeoutMs = 180000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-setup-'));
  const file = path.join(dir, 'setup-mcp.mjs');
  fs.writeFileSync(file, script, { mode: 0o600 });
  return new Promise((resolve) => {
    let out = '';
    const done = (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, output: out });
    };
    const p = spawn(process.execPath, [file, '--non-interactive', ...args], { env: childEnv(valuesByKey), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => ((out += String(e.message)), done(1)));
    p.on('close', (code) => done(code));
  });
}

/** Which MCP apps are on this computer. */
export async function detectClients() {
  const r = await run(setupScript([]), ['--list-clients'], {}, { timeoutMs: 20000 });
  try {
    return JSON.parse(r.output.trim().split('\n').pop());
  } catch {
    return [];
  }
}

/** servers: scriptServers() output. secrets: server id → { NAME: value }. */
export async function applyStack(servers, { clients = [], secrets = {}, dry = true, remove = false } = {}) {
  const chosen = clients.filter((c) => CLIENT_IDS.includes(c));
  if (!chosen.length) return { ok: false, output: 'Pick at least one app to set up.' };
  const byKey = {};
  const hidden = [];
  for (const s of servers) {
    const given = secrets[s.id] && typeof secrets[s.id] === 'object' ? secrets[s.id] : {};
    const v = {};
    for (const st of s.settings) {
      const x = given[st.name];
      if (typeof x !== 'string' || !x.trim() || x.length > 4000) continue;
      v[st.name] = x.trim();
      if (st.secret) hidden.push(x.trim());
    }
    byKey[s.key] = v;
  }
  const args = [`--clients=${chosen.join(',')}`, ...(dry ? ['--dry-run'] : []), ...(remove ? ['--remove'] : [])];
  const r = await run(setupScript(servers), args, byKey);
  let output = r.output;
  for (const h of hidden) if (h.length >= 4) output = output.split(h).join('***');
  return { ok: r.code === 0, output: output.trim() };
}
