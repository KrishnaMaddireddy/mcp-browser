// Lazy, bounded pool of MCP client connections.
// Connections open on first use, are shared by concurrent queries, close
// after sitting idle, and the least-recently-used one is evicted when full.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { guardedFetch } from './netguard.js';
import { withTimeout, errMsg, log, cleanText } from './util.js';

const CLIENT_INFO = { name: 'mcp-browser', version: '0.1.0' };
const MAX_TOOLS_PER_SERVER = 100;

export class McpPool {
  /**
   * @param {object} o
   * @param {(server) => boolean} [o.allowPrivate] servers allowed to be on localhost/LAN
   * @param {import('./health.js').HealthStore} [o.health]
   */
  constructor({ connectTimeoutMs = 10000, idleMs = 5 * 60_000, maxConnections = 12, allowPrivate = () => false, authFor = () => null, oauthFor = () => null, health, fetchImpl, localLaunch = null } = {}) {
    this.localLaunch = localLaunch; // (server) => { command, args, env, cwd, secrets } for approved package servers
    this.authFor = authFor;
    this.oauthFor = oauthFor;
    this.connectTimeoutMs = connectTimeoutMs;
    this.idleMs = idleMs;
    this.maxConnections = maxConnections;
    this.allowPrivate = allowPrivate;
    this.health = health;
    this.fetchImpl = fetchImpl;
    this.conns = new Map(); // id -> { promise, client, tools, lastUsed, server, inflight }
    this._sweeper = setInterval(() => this._sweep(), Math.min(60_000, idleMs)).unref();
  }

  /** Connect (or reuse) and return { client, tools }. */
  async get(server) {
    let c = this.conns.get(server.id);
    const authKey = JSON.stringify(this.authFor(server) || null);
    if (c && (c.server.url !== server.url || c.authKey !== authKey)) {
      this._detach(server.id);
      c = null;
    }
    if (!c) {
      // Everything up to conns.set() is synchronous, so concurrent callers for
      // the same server always share one connection attempt.
      this._makeRoom();
      c = { server, authKey, lastUsed: Date.now(), inflight: 0 };
      c.promise = this._connect(server).then(
        (r) => {
          if (this.conns.get(server.id) !== c) {
            // Closed or replaced while connecting: don't leak the client.
            r.client.close().catch(() => {});
            throw new Error('connection was closed');
          }
          Object.assign(c, r, { since: Date.now() });
          // A connection that drops is removed, so the next call reconnects.
          r.client.onclose = () => {
            if (this.conns.get(server.id) === c) this.conns.delete(server.id);
          };
          return c;
        },
        (e) => {
          if (this.conns.get(server.id) === c) this.conns.delete(server.id);
          throw e;
        }
      );
      this.conns.set(server.id, c);
    }
    c.lastUsed = Date.now();
    try {
      await c.promise;
    } catch (e) {
      // The attempt we joined was cancelled (evicted or replaced): start a fresh one.
      if (e.message === 'connection was closed' && !this.conns.has(server.id)) return this.get(server);
      throw e;
    }
    return { client: c.client, tools: c.tools, entry: c };
  }

  /** Remove an entry now and close its client in the background. */
  _detach(id) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (c?.client) c.client.close().catch(() => {});
    return c;
  }

  /** A package server this computer starts (approved in local-servers.js), spoken to over stdio. */
  async _connectLocal(server) {
    const t0 = Date.now();
    if (!this.localLaunch) throw new Error('this server runs on this computer, which isn’t set up here');
    const spec = this.localLaunch(server);
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, stderr: 'pipe' });
    let tail = '';
    transport.stderr?.on('data', (d) => (tail = (tail + d).slice(-6000)));
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const hide = (m) => redactAll(m, spec.secrets);
    const timeout = server.connectTimeoutMs || 120000;
    try {
      await withTimeout(client.connect(transport), timeout, `start ${server.title || server.id}`);
      const tools = await withTimeout(listAllTools(client), this.connectTimeoutMs * 2, `tools/list ${server.id}`);
      this.health?.recordOk(server.id, { latencyMs: Date.now() - t0, tools, serverName: cleanText(client.getServerVersion()?.name || '').slice(0, 80) });
      const entry = { client, tools, log: () => hide(tail), pid: transport.pid };
      transport.stderr?.on('data', () => {}); // keep draining
      return entry;
    } catch (e) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      const last = hide(tail).trim().split('\n').filter(Boolean).slice(-6).join('\n');
      const msg = hide(errMsg(e)) + (last ? `\n${last}` : '');
      this.health?.recordFail(server.id, msg.slice(0, 500));
      const err = new Error(msg);
      err.log = hide(tail);
      throw err;
    }
  }

  async _connect(server) {
    if (server.kind === 'local') return this._connectLocal(server);
    const t0 = Date.now();
    const fetchFn = guardedFetch({ allowPrivate: this.allowPrivate(server), fetchImpl: this.fetchImpl });
    const attempts = server.transport === 'sse' ? ['sse'] : ['streamable-http', 'sse'];
    const auth = this.authFor(server) || {};
    if (server.needsAuth && !auth.value && !auth.url) throw new Error('this server needs a key: add one on the servers page');
    const requestInit = auth.header && auth.value ? { headers: { [auth.header]: auth.value } } : undefined;
    // OAuth tokens only when the user signed in and no key is saved for this server.
    const authProvider = (!auth.value && !auth.url && this.oauthFor(server)) || undefined;
    let lastErr;
    for (const kind of attempts) {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      const url = new URL(auth.url || server.url);
      const transport =
        kind === 'sse'
          ? new SSEClientTransport(url, {
              fetch: fetchFn,
              requestInit,
              authProvider,
              eventSourceInit: {
                // init.headers is a Headers object: copy it properly, then add the saved key.
                fetch: (u, init) => {
                  const headers = new Headers(init?.headers);
                  for (const [k, v] of Object.entries(requestInit?.headers || {})) headers.set(k, v);
                  return fetchFn(u, { ...init, headers });
                },
              },
            })
          : new StreamableHTTPClientTransport(url, { fetch: fetchFn, requestInit, authProvider });
      try {
        await withTimeout(client.connect(transport), this.connectTimeoutMs, `connect ${server.id}`);
        const tools = await withTimeout(listAllTools(client), this.connectTimeoutMs, `tools/list ${server.id}`);
        this.health?.recordOk(server.id, { latencyMs: Date.now() - t0, tools, serverName: cleanText(client.getServerVersion()?.name || '').slice(0, 80) });
        return { client, tools };
      } catch (e) {
        lastErr = e;
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        // Only fall back to SSE when the server plausibly speaks it (4xx on POST).
        const msg = errMsg(e);
        if (e instanceof UnauthorizedError || e?.signInExpired || e?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token|sign-in expired/i.test(msg)) {
          if (authProvider) this.onAuthExpired?.(server);
          lastErr = new Error(authProvider ? 'sign-in expired: sign in again on the servers page' : requestInit ? 'the server rejected the saved key (401)' : 'this server needs sign-in (401): use Sign in on the servers page');
          break;
        }
        if (!/\b(404|405|406|400)\b|Unexpected content type|SSE/i.test(msg)) break;
      }
    }
    const safe = redact(errMsg(lastErr), auth);
    this.health?.recordFail(server.id, safe);
    throw new Error(safe);
  }

  async callTool(server, name, args, { timeoutMs = 25000, signal } = {}) {
    const run = async () => {
      const { client, entry: c } = await this.get(server);
      c.inflight++;
      try {
        return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal });
      } finally {
        c.inflight--;
        c.lastUsed = Date.now();
      }
    };
    try {
      return await run();
    } catch (e) {
      if (e?.signInExpired || e instanceof UnauthorizedError) {
        this.onAuthExpired?.(server);
        throw new Error('sign-in expired: sign in again on the servers page');
      }
      // Remote servers drop sessions; reconnect once on session-shaped errors.
      // JSON-RPC errors (numeric code) come from the tool itself; never retry those.
      const transportError = typeof e?.code !== 'number' || e.code === 404;
      if (transportError && /session|404|not initialized|not connected|ECONNRESET|socket hang up|closed|terminated/i.test(errMsg(e)) && !signal?.aborted) {
        log.debug('reconnecting', server.id, errMsg(e));
        await this.close(server.id);
        return await run();
      }
      throw e;
    }
  }

  async close(id) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (c && !c.client) await c.promise?.catch(() => {}); // in-flight connect closes itself
    if (c?.client) {
      try {
        await c.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async closeAll() {
    clearInterval(this._sweeper);
    await Promise.all([...this.conns.keys()].map((id) => this.close(id)));
  }

  /** Evict least-recently-used idle connections until there is room (synchronous). */
  _makeRoom() {
    const idle = [...this.conns.entries()].filter(([, c]) => c.client && c.inflight === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.conns.size >= this.maxConnections && idle.length) this._detach(idle.shift()[0]);
  }

  _sweep() {
    const now = Date.now();
    for (const [id, c] of this.conns) {
      if (c.client && c.inflight === 0 && now - c.lastUsed > (c.server.idleMs ?? this.idleMs)) this._detach(id);
    }
  }

  stats() {
    return { open: [...this.conns.values()].filter((c) => c.client).length, max: this.maxConnections };
  }

  /** Connection state of one server: 'running' | 'starting' | null. */
  state(id) {
    const c = this.conns.get(id);
    if (!c) return null;
    return c.client ? { status: 'running', since: c.since, lastUsed: c.lastUsed, tools: c.tools?.length ?? 0, pid: c.pid ?? null } : { status: 'starting' };
  }
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(r.tools || []));
    cursor = r.nextCursor;
    if (!cursor || tools.length >= MAX_TOOLS_PER_SERVER) break;
  }
  return tools.slice(0, MAX_TOOLS_PER_SERVER);
}

/** Replace each secret in text with ***. */
export function redactAll(msg, secrets = []) {
  let m = String(msg || '');
  for (const s of [...secrets].filter((x) => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length)) m = m.split(s).join('***');
  return m;
}

/** Remove a saved key (and the query string of a saved URL) from error text. */
export function redact(msg, auth = {}) {
  let m = String(msg || '');
  const secrets = [];
  if (auth.value) {
    secrets.push(auth.value, auth.value.replace(/^bearer\s+/i, ''));
  }
  if (auth.url) {
    try {
      const u = new URL(auth.url);
      if (u.search) secrets.push(u.search.slice(1), auth.url);
      for (const v of u.searchParams.values()) if (v.length >= 4) secrets.push(v);
      if (u.username || u.password) secrets.push(u.username, u.password);
    } catch {
      secrets.push(auth.url);
    }
  }
  for (const s of secrets.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) m = m.split(s).join('***');
  return m;
}
