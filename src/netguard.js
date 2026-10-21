// Keeps registry-supplied URLs from reaching the user's own machine or LAN.
// A registry entry is written by a stranger, so an entry pointing at
// http://192.168.1.1/ or a hostname that resolves to 127.0.0.1 must not be
// connected to. Every redirect hop is checked too.
import dns from 'node:dns/promises';
import dnsCb from 'node:dns';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import net from 'node:net';

export class BlockedUrlError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BlockedUrlError';
  }
}

function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // hex-form v4-mapped
    if (/^f[cd]/.test(s)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
    if (/^ff/.test(s)) return true; // multicast
    if (/^64:ff9b:/.test(s)) return true; // NAT64 can map to private v4
    if (/^2001:db8:/.test(s)) return true; // documentation
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

/**
 * Throw unless url is https:// and every address its host resolves to is public.
 * `allowPrivate` exists for tests and for servers the user adds by hand.
 */
export async function assertPublicUrl(url, { allowPrivate = false, lookup = dns.lookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${String(url).slice(0, 100)}`);
  }
  if (allowPrivate) {
    if (!/^https?:$/.test(u.protocol)) throw new BlockedUrlError(`unsupported protocol ${u.protocol}`);
    return u;
  }
  if (u.protocol !== 'https:') throw new BlockedUrlError(`only https is allowed (${u.protocol})`);
  if (u.username || u.password) throw new BlockedUrlError('credentials in URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new BlockedUrlError(`blocked host ${host}`);
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try {
      addrs = await lookup(host, { all: true, verbatim: true });
    } catch (e) {
      throw new BlockedUrlError(`DNS lookup failed for ${host}: ${e.code || e.message}`);
    }
  }
  if (!addrs.length) throw new BlockedUrlError(`no addresses for ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new BlockedUrlError(`${host} resolves to a private address`);
  }
  return u;
}

/**
 * DNS lookup used at connect time: the address actually dialed is checked,
 * which closes the DNS-rebinding gap between the pre-check and the request.
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dnsCb.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad) return callback(new BlockedUrlError(`${hostname} resolves to a private address`));
    if (options.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

/** True when `host` is listed in a NO_PROXY-style value. */
export function inNoProxy(host, noProxy = process.env.NO_PROXY || process.env.no_proxy || '') {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  for (let e of noProxy.split(/[\s,]+/)) {
    e = e.trim().toLowerCase().replace(/:\d+$/, '');
    if (!e) continue;
    if (e === '*') return true;
    if (e.startsWith('*.')) e = e.slice(1);
    if (e.startsWith('.') ? h.endsWith(e) || h === e.slice(1) : h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

let directAgent = null;
const proxyAgents = new Map();
/**
 * Pick how to dial a URL. Direct connections always go through guardedLookup,
 * so the address actually connected to is checked (no DNS rebinding). If the
 * environment names an HTTPS proxy and the host isn't in NO_PROXY, the request
 * is tunneled through that proxy; the proxy resolves the name, so only the
 * pre-flight check applies there.
 */
export function dispatcherFor(url, env = process.env) {
  const u = new URL(url);
  const proxy = u.protocol === 'https:' ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy;
  if (proxy && !inNoProxy(u.hostname, env.NO_PROXY || env.no_proxy || '')) {
    if (!proxyAgents.has(proxy)) proxyAgents.set(proxy, new ProxyAgent(proxy));
    return { kind: 'proxy', dispatcher: proxyAgents.get(proxy) };
  }
  directAgent ??= new Agent({ connect: { lookup: guardedLookup } });
  return { kind: 'direct', dispatcher: directAgent };
}

function defaultFetch(allowPrivate) {
  if (allowPrivate) return fetch; // user-added local servers
  return (url, init) => undiciFetch(url, { ...init, dispatcher: dispatcherFor(String(url)).dispatcher });
}

/**
 * fetch() replacement for MCP transports: validates the target before each
 * request and follows up to 3 same-origin redirects by hand. A redirect to
 * another origin is refused, so saved keys and request bodies never leave the
 * server the user approved.
 */
export function guardedFetch({ allowPrivate = false, fetchImpl, lookup } = {}) {
  const doFetch = fetchImpl || defaultFetch(allowPrivate);
  return async function guarded(input, init = {}) {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(url).origin;
    let opts = { ...init, redirect: 'manual' };
    for (let hop = 0; hop <= 3; hop++) {
      await assertPublicUrl(url, { allowPrivate, lookup });
      const res = await doFetch(url, opts);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url);
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        if (next.origin !== origin) throw new BlockedUrlError(`redirect to another site (${next.host}) was blocked`);
        // Only same-method redirects (307/308) keep the body; 301-303 become GET.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method === 'POST')) {
          opts = { ...opts, method: 'GET', body: undefined };
        }
        url = next.href;
        continue;
      }
      return res;
    }
    throw new BlockedUrlError('too many redirects');
  };
}
