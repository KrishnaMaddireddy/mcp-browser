// OAuth sign-in: a 401 server is flagged, the user signs in through the
// browser, tokens are stored privately and used, and nothing starts by itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-oauth-'));
process.env.MCPB_LOG = 'silent';
process.env.MCPB_SEMANTIC = 'off';

const { startOAuthMock } = await import('./fixtures/mock-oauth.js');
const { createEngine } = await import('../src/app.js');
const { createServer } = await import('../src/server.js');
const { HealthStore } = await import('../src/health.js');
const { safeAuthUrl } = await import('../src/oauth.js');

let mock;
let app;
let base;
const api = (p, body) =>
  fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, body: await r.json() }));
const view = async () => (await api('/api/servers?q=notes')).body.servers.find((s) => s.id === 'notes');

before(async () => {
  mock = await startOAuthMock();
  const engine = createEngine({ providerOverride: null, curated: [], extraServers: [mock.server], health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h.json') }) });
  app = createServer({ engine, port: 0 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  await mock.close();
});

test('a server that answers 401 is flagged for sign-in without registering anywhere', async () => {
  const [r] = (await api('/api/servers/probe', { ids: ['notes'] })).body.results;
  assert.equal(r.ok, false);
  assert.match(r.error, /needs sign-in/);
  assert.equal((await view()).signIn, 'needed');
  assert.equal(mock.state.registrations, 0, 'probing must not register an OAuth client');
});

test('sign in: register, consent, callback, then the tools work', async () => {
  const start = await api('/api/servers/oauth/start', { id: 'notes' });
  assert.equal(start.status, 200);
  const authUrl = new URL(start.body.url);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('redirect_uri'), `${base}/oauth/callback`);
  assert.ok(authUrl.searchParams.get('state'));
  assert.equal((await view()).signIn, 'pending');

  // The "browser": consent page redirects back to our callback.
  const consent = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const cb = await fetch(consent.headers.get('location'));
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Signed in/);
  assert.equal((await view()).signIn, 'signed-in');

  const r = await app.engine.pool.callTool(mock.server, 'search_notes', { query: 'launch' });
  assert.match(r.content[0].text, /ship on Friday/);

  const file = path.join(process.env.MCPB_DATA_DIR, 'oauth.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Tokens never appear in the API.
  const all = JSON.stringify((await api('/api/servers?q=notes')).body) + JSON.stringify((await api('/api/settings')).body);
  assert.doesNotMatch(all, /at-[0-9a-f]{12}|rt-[0-9a-f]{12}/);
});

test('the callback is single-use and rejects unknown state', async () => {
  const bad = await fetch(`${base}/oauth/callback?code=x&state=nope`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /unknown or expired/);
  const cancelled = await fetch(`${base}/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<script>x</script>')}`);
  assert.equal(cancelled.status, 400);
  const html = await cancelled.text();
  assert.doesNotMatch(html, /<script>/);
});

test('an expired access token is refreshed quietly', async () => {
  mock.expireAccess();
  await app.engine.pool.close('notes');
  const before = mock.state.tokenRequests;
  const r = await app.engine.pool.callTool(mock.server, 'search_notes', { query: 'q' });
  assert.match(r.content[0].text, /Friday/);
  assert.equal(mock.state.tokenRequests, before + 1);
});

test('revoked tokens ask the user to sign in again; sign-out forgets everything', async () => {
  mock.revokeAll();
  await app.engine.pool.close('notes');
  const regs = mock.state.registrations;
  await assert.rejects(app.engine.pool.callTool(mock.server, 'search_notes', { query: 'x' }), /sign/i);
  assert.equal(mock.state.registrations, regs, 'no new client registration in the background');
  await api('/api/servers/oauth/signout', { id: 'notes' });
  assert.equal((await view()).signIn === 'signed-in', false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.MCPB_DATA_DIR, 'oauth.json'), 'utf8'))[mock.server.url], undefined);
});

async function signIn() {
  const start = await api('/api/servers/oauth/start', { id: 'notes' });
  const consent = await fetch(start.body.url, { redirect: 'manual' });
  const cb = await fetch(consent.headers.get('location'));
  assert.equal(cb.status, 200);
  // The callback starts a background check of the server; let it finish.
  for (let i = 0; i < 50 && !(await view()).health; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
}

test('review fix: background calls never register a client or start a sign-in', async () => {
  await signIn();
  const file = path.join(process.env.MCPB_DATA_DIR, 'oauth.json');
  for (const refreshError of ['invalid_client', 'invalid_grant']) {
    // The app restarted on another port, then the access token expired and refresh fails.
    app.engine.oauth.setRedirectBase('http://127.0.0.1:1');
    mock.state.refreshError = refreshError;
    mock.expireAccess();
    await app.engine.pool.close('notes');
    const regs = mock.state.registrations;
    await assert.rejects(app.engine.pool.callTool(mock.server, 'search_notes', { query: 'x' }), /sign-in expired/);
    assert.equal(mock.state.registrations, regs, `no registration after ${refreshError}`);
    const e = JSON.parse(fs.readFileSync(file, 'utf8'))[mock.server.url];
    assert.equal(e.state, undefined);
    assert.equal(e.pendingUrl, undefined);
    assert.equal(e.tokens, undefined, 'bad tokens are dropped');
    assert.ok(e.client, 'the registered client is kept');
    assert.equal((await view()).signIn, 'needed');
    mock.state.refreshError = null;
    app.engine.oauth.setRedirectBase(base);
    await signIn();
  }
});

test('review fix: a saved key URL wins over OAuth tokens', async () => {
  const seen = [];
  const { McpPool } = await import('../src/pool.js');
  const p = new McpPool({
    allowPrivate: () => true,
    authFor: () => ({ url: `${mock.base}/mcp?key=SECRETKEY` }),
    oauthFor: () => {
      seen.push('asked');
      return { tokens: () => ({ access_token: 'x', token_type: 'Bearer' }) };
    },
  });
  await assert.rejects(p.get({ ...mock.server, id: 'k' }), /rejected the saved key|401/);
  assert.equal(seen.length, 0);
  await p.closeAll();
});

test('review fix: the callback shows server text only for our own sign-in', async () => {
  const r = await fetch(`${base}/oauth/callback?error=x&error_description=${encodeURIComponent('Call +1-555 to verify')}`);
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /555/);
});

test('only https (or local http for your own servers) sign-in pages may be opened', () => {
  assert.equal(safeAuthUrl('https://auth.example.com/authorize?x=1'), 'https://auth.example.com/authorize?x=1');
  assert.equal(safeAuthUrl('javascript:alert(1)'), null);
  assert.equal(safeAuthUrl('http://evil.example/authorize'), null);
  assert.equal(safeAuthUrl('http://127.0.0.1:9/authorize'), null);
  assert.equal(safeAuthUrl('http://127.0.0.1:9/authorize', { allowLocal: true }), 'http://127.0.0.1:9/authorize');
  assert.equal(safeAuthUrl('file:///etc/passwd', { allowLocal: true }), null);
});

test('"Your apps" servers stay off until signed in and are never ranked', async () => {
  const { CURATED } = await import('../src/curated.js');
  const { candidatesFor, SUITES } = await import('../src/rank.js');
  const apps = CURATED.filter((s) => s.signIn);
  assert.ok(apps.length >= 8);
  const eng = createEngine({ providerOverride: null, extraServers: [], health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h2.json') }), embeddings: null });
  try {
    for (const s of apps) assert.equal(eng.catalog.isEnabled(s), false, s.id);
    assert.ok(!eng.catalog.route('my linear tickets this sprint').some((r) => r.server.signIn));
    const notion = apps.find((s) => s.id === 'notion');
    eng.oauth.setRedirectBase('http://127.0.0.1:1');
    // Simulate a finished sign-in.
    const { OAuthStore } = await import('../src/oauth.js');
    new OAuthStore().patch(notion.url, { tokens: { access_token: 'x', token_type: 'Bearer' } });
    assert.equal(eng.catalog.isEnabled(notion), true);
    for (const suite of Object.values(SUITES)) assert.ok(!(await candidatesFor(eng, suite)).some((s) => (s.server || s).signIn));
  } finally {
    await eng.close();
  }
});

test('a question naming an app you have not signed in to suggests signing in', async () => {
  const { signInHints } = await import('../src/agent.js');
  const eng = createEngine({ providerOverride: null, extraServers: [], health: new HealthStore({ file: path.join(process.env.MCPB_DATA_DIR, 'h3.json') }), embeddings: null });
  try {
    assert.deepEqual(signInHints(eng.catalog, 'my open Linear bugs this cycle').map((h) => h.id), ['linear']);
    assert.deepEqual(signInHints(eng.catalog, 'Jira tickets blocking the release').map((h) => h.id), ['atlassian']);
    assert.deepEqual(signInHints(eng.catalog, 'weather in Paris tomorrow'), []);
    assert.deepEqual(signInHints(eng.catalog, 'what is a .com domain'), []);
    eng.updateSettings({ serverOverrides: { ...eng.settings.serverOverrides, linear: false } });
    assert.deepEqual(signInHints(eng.catalog, 'my Linear bugs'), [], 'not after you switched it off');
  } finally {
    eng.updateSettings({ serverOverrides: {} });
    await eng.close();
  }
});
