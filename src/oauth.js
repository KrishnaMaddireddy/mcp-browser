// OAuth sign-in for MCP servers that require it (the MCP authorization spec:
// protected-resource metadata, dynamic client registration, PKCE). The SDK does
// the protocol; this file stores clients and tokens and drives the browser step.
//
// Nothing here runs on its own: a server is only registered with or redirected
// to when the user presses "Sign in" for it. Routing and MCP Rank never start a
// sign-in. Tokens live in <data dir>/oauth.json (mode 0600) and never leave the
// local API.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { dataDir } from './config.js';
import { guardedFetch } from './netguard.js';
import { errMsg } from './util.js';

const PENDING_MS = 10 * 60_000;

export class OAuthStore {
  constructor({ file = path.join(dataDir(), 'oauth.json') } = {}) {
    this.file = file;
    this.mtime = 0;
    this.data = {};
    this._reload();
  }
  /** Pick up sign-ins made by another process (the app vs. MCP server mode share the file). */
  _reload() {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m === this.mtime) return;
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.mtime = m;
    } catch {
      /* missing or unreadable: keep what we have */
    }
  }
  get(key) {
    this._reload();
    return this.data[key];
  }
  patch(key, obj) {
    this._reload();
    this.data[key] = { ...(this.data[key] || {}), ...obj };
    this.save();
    return this.data[key];
  }
  remove(key) {
    this._reload();
    delete this.data[key];
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write then rename, so the other process never reads half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* a failed save only costs a re-sign-in */
    }
  }
}

/** Tokens are bound to the server's URL (the OAuth "resource"), not its id. */
export const oauthKey = (s) => s.url;

/** Only https authorization pages (http for a local server you added) may be opened. */
export function safeAuthUrl(href, { allowLocal = false } = {}) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return u.href;
  if (allowLocal && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return u.href;
  return null;
}

export function createOAuth({ store = new OAuthStore(), catalog, pool, allowPrivate = () => false, fetchImpl } = {}) {
  let redirectBase = null; // set by the HTTP server once it knows its port

  function provider(s) {
    const key = oauthKey(s);
    const redirectUrl = () => (redirectBase ? `${redirectBase}/oauth/callback` : store.get(key)?.redirectUrl || 'http://127.0.0.1/oauth/callback');
    return {
      get redirectUrl() {
        return redirectUrl();
      },
      get clientMetadata() {
        return {
          client_name: 'MCP Browser',
          redirect_uris: [redirectUrl()],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      state() {
        const state = randomBytes(16).toString('hex');
        store.patch(key, { state, stateAt: Date.now() });
        return state;
      },
      clientInformation() {
        const e = store.get(key);
        // A client registered for another callback port can't be reused for a new sign-in.
        if (!e?.client || (redirectBase && e.redirectUrl !== redirectUrl())) return undefined;
        return e.client;
      },
      saveClientInformation(client) {
        store.patch(key, { client, redirectUrl: redirectUrl() });
      },
      tokens() {
        return store.get(key)?.tokens;
      },
      saveTokens(tokens) {
        store.patch(key, { tokens, signedInAt: Date.now() });
      },
      redirectToAuthorization(url) {
        // Never opened from here: the user opens it from the servers page.
        store.patch(key, { pendingUrl: url.href });
      },
      saveCodeVerifier(verifier) {
        store.patch(key, { verifier });
      },
      codeVerifier() {
        const v = store.get(key)?.verifier;
        if (!v) throw new Error('no sign-in in progress');
        return v;
      },
      invalidateCredentials(scope) {
        const drop = { all: ['client', 'tokens', 'verifier'], client: ['client'], tokens: ['tokens'], verifier: ['verifier'], discovery: [] }[scope] || [];
        if (drop.length) store.patch(key, Object.fromEntries(drop.map((k) => [k, undefined])));
      },
    };
  }

  /**
   * What the pool attaches to live connections: it may use and refresh tokens,
   * but can never register a client or begin a sign-in (that needs the user's
   * click). Anything that would start one fails with "sign-in expired" instead.
   */
  function refreshOnly(s) {
    const key = oauthKey(s);
    const full = provider(s);
    const expired = () => {
      throw Object.assign(new Error('sign-in expired: sign in again on the servers page'), { signInExpired: true });
    };
    return {
      get redirectUrl() {
        return store.get(key)?.redirectUrl || full.redirectUrl;
      },
      get clientMetadata() {
        return full.clientMetadata;
      },
      clientInformation: () => store.get(key)?.client,
      tokens: () => store.get(key)?.tokens,
      saveTokens: (t) => full.saveTokens(t),
      state: expired,
      saveCodeVerifier: expired,
      redirectToAuthorization: expired,
      codeVerifier: expired,
      // Bad tokens are dropped (so the app shows "Needs sign-in"); the client is kept.
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'tokens') store.patch(key, { tokens: undefined });
      },
    };
  }

  const fetchFor = (s) => guardedFetch({ allowPrivate: allowPrivate(s), fetchImpl });
  const find = (id) => {
    const s = catalog.get(id);
    if (!s) throw Object.assign(new Error('unknown server'), { status: 404 });
    return s;
  };

  return {
    setRedirectBase(base) {
      redirectBase = base;
    },
    /** The provider the pool attaches to a connection, only once the user has signed in. */
    providerFor(s) {
      return store.get(oauthKey(s))?.tokens ? refreshOnly(s) : null;
    },
    /** The pool saw a 401 even after refreshing: the sign-in is gone. */
    expire(s) {
      if (store.get(oauthKey(s))?.tokens) store.patch(oauthKey(s), { tokens: undefined });
    },
    /** The sign-in page sent the user back with an error: only for a sign-in we started. */
    cancel(state) {
      store._reload();
      const key = state && Object.keys(store.data).find((k) => store.data[k].state === state);
      if (!key) return false;
      store.patch(key, { state: undefined, verifier: undefined, pendingUrl: undefined });
      return true;
    },
    status(s) {
      const e = store.get(oauthKey(s));
      if (e?.tokens) return 'signed-in';
      if (e?.pendingUrl && Date.now() - (e.stateAt || 0) < PENDING_MS) return 'pending';
      return null;
    },
    /** Start a sign-in: returns { url } to open, or { signedIn: true } if tokens still work. */
    async start(id) {
      if (!redirectBase) throw new Error('sign-in needs the browser app running');
      const s = find(id);
      const key = oauthKey(s);
      store.patch(key, { pendingUrl: undefined, verifier: undefined, state: undefined });
      let r;
      try {
        r = await auth(provider(s), { serverUrl: s.url, fetchFn: fetchFor(s) });
      } catch (e) {
        throw Object.assign(new Error(`sign-in failed: ${errMsg(e)}`), { status: 502 });
      }
      if (r === 'AUTHORIZED') {
        await pool.close(s.id);
        return { signedIn: true };
      }
      const url = safeAuthUrl(store.get(key)?.pendingUrl, { allowLocal: allowPrivate(s) });
      if (!url) throw Object.assign(new Error('the server sent an unsafe sign-in address'), { status: 502 });
      return { url };
    },
    /** The browser came back to /oauth/callback: exchange the code for tokens. */
    async finish({ code, state }) {
      if (!code || !state) throw Object.assign(new Error('missing code or state'), { status: 400 });
      store._reload();
      const key = Object.keys(store.data).find((k) => store.data[k].state && store.data[k].state === state);
      const e = key && store.get(key);
      if (!e || Date.now() - (e.stateAt || 0) > PENDING_MS) throw Object.assign(new Error('this sign-in link is unknown or expired: start again'), { status: 400 });
      const s = catalog.all().find((x) => oauthKey(x) === key);
      if (!s) throw Object.assign(new Error('unknown server'), { status: 404 });
      store.patch(key, { state: undefined }); // one use only
      try {
        await auth(provider(s), { serverUrl: s.url, authorizationCode: String(code), fetchFn: fetchFor(s) });
      } catch (err) {
        throw Object.assign(new Error(`sign-in failed: ${errMsg(err)}`), { status: 502 });
      } finally {
        store.patch(key, { verifier: undefined, pendingUrl: undefined });
      }
      await pool.close(s.id);
      return s;
    },
    async signOut(id) {
      const s = find(id);
      store.remove(oauthKey(s));
      await pool.close(s.id);
    },
  };
}
