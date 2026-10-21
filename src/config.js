// Settings and data-directory handling. Everything lives in one folder
// (default ~/.mcp-browser) so the app never writes elsewhere on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { isPrivateIp } from './netguard.js';

export function dataDir() {
  const dir = process.env.MCPB_DATA_DIR || path.join(os.homedir(), '.mcp-browser');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEFAULTS = Object.freeze({
  // 'anthropic' | 'openai' (any OpenAI-compatible API: OpenAI, Groq, OpenRouter, Ollama…) | 'none'
  provider: 'auto',
  model: '',
  apiKey: '',
  baseUrl: '',
  maxServers: 4, // servers consulted per query
  maxSteps: 6, // LLM ↔ tool round trips
  maxToolsPerQuery: 40,
  toolTimeoutMs: 25000,
  connectTimeoutMs: 10000,
  discovery: false, // also route to community servers found in the registry
  discoveryMax: 2, // how many community servers may join one query
  alwaysWebSearch: true, // keep a general web search server in the mix
  semanticRouting: true, // local embedding model for meaning-based routing (if installed)
  serverOverrides: {}, // { [serverId]: true | false } user enable/disable
  serverAuth: {}, // { [serverId]: { url?, header?, value? } } keys for servers that need one
  customServers: [], // servers the user added by URL: [{ id, title, url, description }]
  freeModeBudgetMs: 9000, // free mode: results that arrive later than this are skipped (keeps pages fast)
  githubToken: '', // optional: refresh GitHub stars straight from GitHub (read-only, no scopes needed)
});

const PROVIDER_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4o-mini',
};

function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    /* first run */
  }
  return {
    ...DEFAULTS,
    ...saved,
    serverOverrides: { ...(saved.serverOverrides || {}) },
    serverAuth: { ...(saved.serverAuth || {}) },
    customServers: Array.isArray(saved.customServers) ? saved.customServers.map(cleanCustomServer).filter(Boolean) : [],
  };
}

/** localhost, *.localhost, *.local, *.internal, or a private/loopback IP literal. */
export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  return net.isIP(h) ? isPrivateIp(h) : false;
}

/** Validate one user-added server; returns null when unusable. */
export function cleanCustomServer(x) {
  if (!x || typeof x !== 'object') return null;
  let u;
  try {
    u = new URL(String(x.url || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  // Plain http only for servers on this computer or the local network (keys would travel in the clear).
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) return null;
  const strip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const id = /^custom\/[a-z0-9-]{1,80}$/.test(String(x.id)) ? x.id : null;
  if (!id) return null;
  return {
    id,
    title: strip(x.title, 120) || u.hostname,
    url: u.href,
    description: strip(x.description, 400),
    transport: x.transport === 'sse' ? 'sse' : 'streamable-http',
  };
}

const NUMERIC = {
  maxServers: [1, 100],
  maxSteps: [1, 50],
  maxToolsPerQuery: [4, 512],
  toolTimeoutMs: [2000, 600000],
  connectTimeoutMs: [2000, 120000],
  discoveryMax: [0, 100],
  freeModeBudgetMs: [3000, 120000],
};

/** Merge a partial update, validating every field. Returns the saved settings. */
export function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (k in NUMERIC) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = NUMERIC[k];
      next[k] = Math.min(hi, Math.max(lo, Math.round(n)));
    } else if (k === 'provider') {
      if (['auto', 'anthropic', 'openai', 'none'].includes(v)) next[k] = v;
    } else if (k === 'discovery' || k === 'alwaysWebSearch' || k === 'semanticRouting') {
      next[k] = Boolean(v);
    } else if (k === 'serverOverrides') {
      if (v && typeof v === 'object') {
        const o = { ...cur.serverOverrides };
        for (const [id, val] of Object.entries(v)) {
          if (val === null) delete o[id];
          else o[String(id).slice(0, 200)] = Boolean(val);
        }
        next.serverOverrides = o;
      }
    } else if (k === 'customServers') {
      if (Array.isArray(v)) next.customServers = v.slice(0, 50).map(cleanCustomServer).filter(Boolean);
    } else if (k === 'serverAuth') {
      if (v && typeof v === 'object') {
        const o = { ...cur.serverAuth };
        for (const [id, val] of Object.entries(v)) {
          const key = String(id).slice(0, 200);
          if (!val) {
            delete o[key];
            continue;
          }
          const a = {};
          if (typeof val.url === 'string' && /^https:\/\/\S+$/i.test(val.url.trim())) a.url = val.url.trim().slice(0, 1000);
          if (typeof val.header === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(val.header) && typeof val.value === 'string' && val.value.trim()) {
            if (/[\x00-\x08\x0a-\x1f\x7f]/.test(val.value)) continue; // no header injection or invalid bytes
            a.header = val.header;
            a.value = val.value.trim().slice(0, 2000);
          }
          if (a.url || a.header) o[key] = a;
        }
        next.serverAuth = o;
      }
    } else if (k === 'githubToken') {
      const t = String(v ?? '').trim();
      if (t === '' || /^[A-Za-z0-9_]{20,255}$/.test(t)) next[k] = t;
    } else if (k === 'baseUrl') {
      const s = String(v || '').trim();
      if (s === '' || /^https?:\/\//i.test(s)) next[k] = s.slice(0, 500);
    } else {
      next[k] = String(v ?? '').trim().slice(0, 500);
    }
  }
  const file = settingsPath();
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return next;
}

/** Work out which LLM provider is actually usable right now. */
export function resolveProvider(settings) {
  const s = settings;
  const envAnthropic = process.env.ANTHROPIC_API_KEY || '';
  const envOpenAI = process.env.OPENAI_API_KEY || '';
  let provider = s.provider;
  if (provider === 'auto') {
    // A custom base URL always means an OpenAI-compatible endpoint (Groq, Ollama…).
    if (s.baseUrl) provider = 'openai';
    else if (s.apiKey || envAnthropic) provider = 'anthropic';
    else if (envOpenAI) provider = 'openai';
    else provider = 'none';
  }
  if (provider === 'none') return { provider: 'none' };
  // Environment keys only go to their own vendor's default endpoint, never to a
  // base URL the user typed (that would hand an Anthropic key to another host).
  let officialHost = false;
  try {
    const u = new URL(s.baseUrl);
    officialHost = provider === 'anthropic' && u.protocol === 'https:' && u.hostname === 'api.anthropic.com' && !u.username && !u.password;
  } catch {
    /* no or bad base URL */
  }
  const customHost = Boolean(s.baseUrl) && !officialHost;
  const envKey = customHost ? '' : provider === 'anthropic' ? envAnthropic : envOpenAI;
  const apiKey = s.apiKey || envKey;
  const model = s.model || PROVIDER_MODELS[provider];
  // Local OpenAI-compatible servers (Ollama, LM Studio) need no key.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s.baseUrl || '');
  if (!apiKey && !local) return { provider: 'none', reason: `no API key for ${provider}` };
  return { provider, apiKey, model, baseUrl: s.baseUrl || undefined };
}

/** Settings safe to send to the UI (API key masked). */
export function publicSettings(s) {
  const masked = s.apiKey ? `••••${s.apiKey.slice(-4)}` : '';
  const serverAuth = {};
  for (const [id, a] of Object.entries(s.serverAuth || {})) serverAuth[id] = { header: a.header, hasValue: Boolean(a.value), hasUrl: Boolean(a.url) };
  return { ...s, apiKey: masked, hasApiKey: Boolean(s.apiKey), serverAuth, githubToken: s.githubToken ? `••••${s.githubToken.slice(-4)}` : '', hasGithubToken: Boolean(s.githubToken) };
}
