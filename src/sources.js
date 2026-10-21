// Pull citable links out of tool results so the answer can show sources.

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

function tidyUrl(u) {
  // Trailing punctuation is almost never part of the URL.
  return u.replace(/[.,;:!?*]+$/, '');
}

function safeHttpUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    if (x.username || x.password) return null;
    return x.href;
  } catch {
    return null;
  }
}

/** @returns {{url: string, title: string}[]} in order of first appearance */
// Images, fonts, scripts and styles inside results (logos, icons) are not sources.
const ASSET_RE = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp|css|js|mjs|woff2?|ttf|otf|map)$/i;
function isAsset(href) {
  try {
    return ASSET_RE.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

export function extractSources(text, max = 25) {
  const s = String(text || '');
  const found = new Map();
  const add = (url, title) => {
    const href = safeHttpUrl(tidyUrl(url));
    if (!href || found.size >= max || isAsset(href)) return;
    const prev = found.get(href);
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!prev) found.set(href, { url: href, title: t });
    else if (!prev.title && t) prev.title = t;
  };

  // "Title: …\nURL: …" (Exa and many search servers)
  for (const m of s.matchAll(/Title:\s*(.+)\n\s*(?:URL|Url|Link|Source):\s*(https?:\/\/\S+)/g)) add(m[2], m[1]);
  // Markdown links [title](url)
  for (const m of s.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2], m[1]);
  // JSON-ish "title": "...", ... "url": "..."
  for (const m of s.matchAll(/"title"\s*:\s*"([^"\n]{1,200})"[^{}]{0,400}?"(?:url|link|href)"\s*:\s*"(https?:[^"\s]+)"/g)) add(m[2], m[1]);
  for (const m of s.matchAll(/"(?:url|link|href)"\s*:\s*"(https?:[^"\s]+)"[^{}]{0,400}?"title"\s*:\s*"([^"\n]{1,200})"/g)) add(m[1], m[2]);
  // Anything else
  for (const m of s.matchAll(URL_RE)) add(m[0], '');
  return [...found.values()];
}

/** Keeps one numbered list of sources across a whole search session. */
export class SourceBook {
  constructor() {
    this.list = [];
    this.byUrl = new Map();
  }
  /** Add sources; returns their numbers. */
  addAll(items, origin) {
    const nums = [];
    for (const it of items) {
      let n = this.byUrl.get(it.url);
      if (!n) {
        if (this.list.length >= 60) break;
        n = this.list.length + 1;
        this.list.push({ n, url: it.url, title: it.title || hostOf(it.url), origin });
        this.byUrl.set(it.url, n);
      }
      nums.push(n);
    }
    return nums;
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
