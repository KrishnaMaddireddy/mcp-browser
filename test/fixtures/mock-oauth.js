// A tiny MCP server protected by OAuth 2.1 the way the MCP spec describes:
// protected-resource metadata, authorization-server metadata, dynamic client
// registration, PKCE (S256), refresh tokens. /authorize "consents" at once.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function startOAuthMock({ authorizeBase } = {}) {
  const state = { clients: new Map(), codes: new Map(), tokens: new Set(), refresh: new Set(), registrations: 0, tokenRequests: 0 };
  let base;
  const send = (res, code, obj, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
  const body = async (req) => {
    let b = '';
    for await (const c of req) b += c;
    return b;
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === '/.well-known/oauth-authorization-server')
      return send(res, 200, {
        issuer: base,
        authorization_endpoint: `${authorizeBase || base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (u.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(await body(req));
      const client_id = `client-${++state.registrations}`;
      state.clients.set(client_id, meta);
      return send(res, 201, { ...meta, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (u.pathname === '/authorize') {
      const p = u.searchParams;
      const client = state.clients.get(p.get('client_id'));
      if (!client || !client.redirect_uris.includes(p.get('redirect_uri')) || p.get('code_challenge_method') !== 'S256') return send(res, 400, { error: 'invalid_request' });
      const code = randomBytes(8).toString('hex');
      state.codes.set(code, { challenge: p.get('code_challenge'), client: p.get('client_id'), redirect: p.get('redirect_uri') });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      if (p.get('state')) back.searchParams.set('state', p.get('state'));
      return res.writeHead(302, { location: back.href }).end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      state.tokenRequests++;
      const p = new URLSearchParams(await body(req));
      const issue = () => {
        const access_token = `at-${randomBytes(6).toString('hex')}`;
        const refresh_token = `rt-${randomBytes(6).toString('hex')}`;
        state.tokens.add(access_token);
        state.refresh.add(refresh_token);
        return send(res, 200, { access_token, token_type: 'Bearer', expires_in: 3600, refresh_token });
      };
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code'));
        state.codes.delete(p.get('code'));
        const ok = c && c.client === p.get('client_id') && createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') === c.challenge;
        return ok ? issue() : send(res, 400, { error: 'invalid_grant' });
      }
      if (p.get('grant_type') === 'refresh_token' && state.refreshError) return send(res, 400, { error: state.refreshError });
      if (p.get('grant_type') === 'refresh_token') return state.refresh.delete(p.get('refresh_token')) ? issue() : send(res, 400, { error: 'invalid_grant' });
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/mcp') {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!state.tokens.has(tok)) return send(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      if (req.method !== 'POST') return res.writeHead(405).end();
      const json = JSON.parse(await body(req));
      const mcp = new McpServer({ name: 'mock-notes', version: '1.0.0' });
      mcp.registerTool('search_notes', { description: 'Search your private notes.', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, async ({ query }) => ({
        content: [{ type: 'text', text: `Note: the secret plan for "${query}" is to ship on Friday.` }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      return transport.handleRequest(req, res, json);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    server: { id: 'notes', title: 'Private Notes', description: 'Search your private notes', url: `${base}/mcp`, source: 'custom', trust: 'community', tags: ['notes', 'plan'] },
    expireAccess: () => state.tokens.clear(),
    revokeAll: () => {
      state.tokens.clear();
      state.refresh.clear();
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}
