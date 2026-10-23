// Turns a server's raw reply into something a person can read: a list of items
// (title, link, site, date, summary, a few key facts), a small fact table for
// single records, or plain paragraphs. The raw text is always kept alongside.
import { cleanText, parseJsonLenient } from './util.js';

const TITLE_KEYS = ['title', 'name', 'headline', 'label', 'display_name', 'displayName', 'full_name', 'fullName', 'company', 'symbol', 'ticker', 'question', 'term', 'subject'];
const URL_KEYS = ['url', 'link', 'href', 'source_url', 'sourceUrl', 'html_url', 'htmlUrl', 'web_url', 'permalink', 'pdf_url', 'website', 'homepage'];
const TEXT_KEYS = ['snippet', 'summary', 'description', 'short_description', 'abstract', 'text', 'content', 'excerpt', 'body', 'answer', 'highlights', 'overview', 'details', 'extract', 'detailed', 'detailedForecast', 'detailed_forecast', 'forecast', 'shortForecast', 'short_forecast', 'short', 'conditions', 'condition'];
const DATE_KEYS = ['date', 'published', 'publishedAt', 'published_at', 'publishedDate', 'pubDate', 'time', 'timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'start', 'startTime', 'start_time', 'starts_at', 'datetime', 'year'];
// Ad and tracking fields, slugs, raw markdown and the echoed query never help a reader.
const NOISE_FACT = /^sponsored?$|^sponsored_|(?:^|_)imp(?:ression)?_?url|logo|slug|markdown|(?:^|_)query$|utm|^tracking_(?:id|url|pixel)$|analytics|^ad_|_ad$|beacon|pixel/i;
const SKIP_FACT = /^(?:id|_id|uuid|image|image_url|thumbnail|icon|logo|score_debug|embedding|raw|html|metadata|schema|\$schema)$|^[a-z]+_id$|^[a-z]+Id$/i;
// Bookkeeping fields that rarely help a reader: status, type, codes, flags.
const LOW_VALUE = /(?:^|_)(?:status|type|kind|code|lang|language|locale|version|source|license|is_[a-z_]+|has_[a-z_]+)$|^(?:is|has)[A-Z]/i;

const MAX_ITEMS = 25;

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '' && (typeof v === 'string' || typeof v === 'number')) return { key: k, value: String(v) };
  }
  // Case-insensitive fallback.
  const lower = Object.fromEntries(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower[k.toLowerCase()];
    const v = real && obj[real];
    if (v != null && v !== '' && (typeof v === 'string' || typeof v === 'number')) return { key: real, value: String(v) };
  }
  return null;
}

const isHttp = (u) => /^https?:\/\/[^\s]+$/i.test(u);
export function siteOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** "publishedAt" → "Published at", "market_cap" → "Market cap". */
export function humanKey(k) {
  // Short keys are usually acronyms: pe → PE, vix → VIX, hq → HQ.
  if (/^[a-z]{2,3}$/i.test(String(k))) return String(k).toUpperCase();
  const PERIOD = { '1d': '1 day', '5d': '5 days', '1w': '1 week', '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year', '5y': '5 years', ytd: 'year to date', mtd: 'month to date' };
  const s = String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((w) => PERIOD[w] || (w === 'pct' || w === 'percent' ? '%' : w))
    .join(' ')
    // Unit suffixes: "temperature c" → "temperature (°C)", "wind kmh" → "wind (km/h)".
    .replace(/ (c|f)$/, (m, u) => ` (°${u.toUpperCase()})`)
    .replace(/ (kmh|kph|mph|mm|cm|km|kg|ms)$/, (m, u) => ` (${{ kmh: 'km/h', kph: 'km/h' }[u] || u})`);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortDate(v) {
  const s = String(v);
  if (/^\d{4}$/.test(s)) return s;
  // The calendar day as written ("…T18:00:00-07:00" is still the 21st locally).
  const ymd = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(s.trim());
  if (ymd) return ymd[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t < Date.parse('1900-01-01')) return s.slice(0, 40);
  return new Date(t).toISOString().slice(0, 10);
}

/** Markdown and markup to plain words: [text](url) → text, no **, #, `, images or tags. */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
/** Decode the HTML entities scraped snippets carry (&#x27; &amp; &nbsp; …). */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plain(s) {
  return cleanText(decodeEntities(String(s)))
    .replace(/!\[[^\]\n]{0,200}\]\([^)\s]{0,500}\)/g, ' ')
    .replace(/\[([^\]]{1,200})\]\([^)\s]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]{0,200}>/gi, ' ')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/[*_`~]{1,3}([^*_`~\n]+)[*_`~]{1,3}/g, '$1')
    .replace(/\|(?:[ \t]*:?-{3,}:?[ \t]*\|)+/g, ' ') // markdown table rules |:----|---|
    .replace(/(^|\s)[>|]\s*/g, '$1');
}

function clip(s, n) {
  const t = plain(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
}

// Keys whose numbers are identifiers or times, shown as written.
const PLAIN_NUMBER_KEY = /(?:^|_)(?:dt|ts|time|timestamp|date|epoch|sunrise|sunset|isbn\d*|phone|id|number|no|code|zip|year)$|(?:Id|Time|At)$/;
let plainNumber = false;

function factValue(v, key = '') {
  plainNumber = PLAIN_NUMBER_KEY.test(String(key));
  if (plainNumber && typeof v === 'number') return String(v);
  // No thousands separator below 10,000 (years, small counts read better plain).
  // Billions and up read as 5.23T / 142.7B (not for timestamps, IDs, ISBNs: see plainKey); below that, separators from 10,000.
  if (typeof v === 'number' && Math.abs(v) >= 1e9 && !plainNumber) return v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) >= 10000 ? v.toLocaleString('en-US') : String(v)) : String(Math.round(v * 1e4) / 1e4);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  // ISO timestamps read as "2026-10-21 18:00" (the time as the server wrote it).
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(String(v).trim());
  if (iso) return iso[2] === '00:00' ? iso[1] : `${iso[1]} ${iso[2]}`;
  return clip(v, 80);
}

/** Small scalar fields that aren't the title/link/summary/date: shown as key facts. */
function factsOf(obj, used, max = 3) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= max) break;
    if (used.has(k) || SKIP_FACT.test(k) || LOW_VALUE.test(k)) continue;
    if (v == null || v === '' || typeof v === 'object') continue;
    if (typeof v === 'string' && (v.length > 80 || isHttp(v))) continue;
    out.push({ label: humanKey(k), value: factValue(v, k) });
  }
  return out;
}

function itemFromObject(o) {
  const used = new Set();
  const take = (keys) => {
    const p = pick(o, keys);
    if (p) used.add(p.key);
    return p?.value ?? '';
  };
  let title = take(TITLE_KEYS);
  let url = take(URL_KEYS);
  if (url && !isHttp(url)) url = '';
  // No link, but a well-known identifier makes one (PubMed, DOI, arXiv, PubMed Central).
  if (!url) {
    const id = (k) => {
      const key = Object.keys(o).find((x) => x.toLowerCase() === k);
      const v = key != null && (typeof o[key] === 'string' || typeof o[key] === 'number') ? String(o[key]).trim() : '';
      if (v) used.add(key);
      return v;
    };
    const pmid = id('pmid');
    const doi = !pmid && id('doi').replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '');
    const pmcid = !pmid && !doi && id('pmcid');
    const arxiv = !pmid && !doi && !pmcid && (id('arxiv_id') || id('arxivid') || id('arxiv'));
    if (/^\d{1,9}$/.test(pmid)) url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    else if (/^10\.\d{4,9}\/\S+$/.test(doi || '')) url = `https://doi.org/${doi}`;
    else if (/^PMC\d+$/i.test(pmcid || '')) url = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/`;
    else if (/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.test(arxiv || '')) url = `https://arxiv.org/abs/${arxiv}`;
  }
  let text = '';
  const tp = pick(o, TEXT_KEYS);
  if (tp) {
    used.add(tp.key);
    text = tp.value;
  } else {
    // Arrays of strings (e.g. highlights) also make a fine summary.
    for (const k of TEXT_KEYS) {
      if (Array.isArray(o[k]) && o[k].every((x) => typeof x === 'string')) {
        text = o[k].join(' ');
        used.add(k);
        break;
      }
    }
  }
  const date = take(DATE_KEYS);
  if (!title) {
    // No usual title field: the first short text value names the item.
    const k = Object.keys(o).find((k) => !used.has(k) && !SKIP_FACT.test(k) && typeof o[k] === 'string' && o[k].length <= 100 && !isHttp(o[k]));
    if (k) {
      title = o[k];
      used.add(k);
    }
  }
  if (!title && text) {
    title = clip(text, 90);
    text = '';
  }
  if (!title && url) title = siteOf(url);
  // Facts that only repeat the summary ("Short: Clear" under "Clear. Low around 46…") go.
  const said = plain(`${title} ${text}`).toLowerCase();
  // (Words only, as whole words: numbers like a temperature always stay.)
  const repeats = (v) => {
    const t = String(v).toLowerCase();
    if (t.length < 3 || /\d/.test(t)) return false;
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(said);
  };
  // A search hit's rank and its own domain (already shown as the site) aren't facts about it.
  const site = url ? siteOf(url) : '';
  const facts = factsOf(o, used)
    .filter((f) => !repeats(f.value))
    .filter((f) => !(url && /^(?:position|rank|ranking|index|result (?:rank|position)|domain|host|hostname|display link|displayed link|score|relevance(?: score)?)$/i.test(f.label)))
    .filter((f) => !(site && String(f.value).replace(/^www\./, '') === site.replace(/^www\./, '')));
  return { title: clip(title, 160), url, site: url ? siteOf(url) : '', date: date ? shortDate(date) : '', text: text ? cutMark(clip(text, 320)) : '', facts };
}

/**
 * The main list of things in a JSON reply: arrays of objects, preferring shallow
 * ones whose entries have a title or a link (a paper list over each paper's tags).
 */
function mainList(v) {
  let best = null;
  let bestScore = 0;
  const queue = [[v, 0]];
  while (queue.length) {
    const [x, depth] = queue.shift();
    if (depth > 5 || x == null || typeof x !== 'object') continue;
    if (Array.isArray(x)) {
      const objs = x.filter((y) => y && typeof y === 'object' && !Array.isArray(y));
      if (objs.length >= 1 && objs.length >= x.length * 0.6) {
        const sample = objs.slice(0, 10);
        const titled = sample.filter((o) => pick(o, TITLE_KEYS) || pick(o, URL_KEYS)).length / sample.length;
        // Titled lists first, then the shallowest, then the longest.
        const score = (titled >= 0.5 ? 1e6 : 0) + (10 - depth) * 1e3 + Math.min(objs.length, 999);
        if (score > bestScore) {
          best = objs;
          bestScore = score;
        }
      }
      x.slice(0, 50).forEach((y) => queue.push([y, depth + 1]));
    } else Object.values(x).forEach((y) => queue.push([y, depth + 1]));
  }
  return best;
}

/** Flatten a single record into facts (one level of nesting). */
function recordFacts(o, max = 24) {
  const out = [];
  const add = (label, v, key = '') => {
    if (out.length >= max || v == null || v === '') return;
    if (typeof v === 'object') return;
    // Links read as their site; data blobs and tokens (base64 images, JWTs) aren't facts.
    if (typeof v === 'string' && isHttp(v)) v = siteOf(v);
    else if (typeof v === 'string' && (/^data:/i.test(v) || /[A-Za-z0-9_-]{60,}/.test(v))) return;
    if (typeof v === 'string' && v.length > 300) v = clip(v, 300);
    // "Price changes: 1 day %" with -0.2856 reads as "Price changes: 1 day" -0.29%.
    if (/ %$/.test(label) && typeof v === 'number') {
      out.push({ label: label.replace(/ %$/, ''), value: `${Math.round(v * 100) / 100}%` });
      return;
    }
    out.push({ label, value: typeof v === 'string' && v.length > 80 ? cleanText(v) : factValue(v, key) });
  };
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_FACT.test(k) || NOISE_FACT.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (!NOISE_FACT.test(k2) && !NOISE_FACT.test(k)) add(`${humanKey(k)}: ${humanKey(k2).toLowerCase()}`, v2, k2);
    } else if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x !== 'object')) add(humanKey(k), v.slice(0, 8).join(', '), k);
    } else add(humanKey(k), v, k);
  }
  return out;
}

/**
 * Rows of plain numbers and short labels (rates, standings, sector P/E) read
 * best as a table. Only when no row has a link or long text.
 */
function asTable(list) {
  const rows = list.slice(0, 50);
  const cols = [];
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) {
      if (SKIP_FACT.test(k) || (v != null && typeof v === 'object')) continue;
      if (!cols.includes(k)) cols.push(k);
    }
  if (cols.length < 2 || cols.length > 7) return null;
  const tooLong = rows.some((r) => cols.some((c) => typeof r[c] === 'string' && (r[c].length > 60 || isHttp(r[c]))));
  if (tooLong) return null;
  return {
    columns: cols.map(humanKey),
    rows: rows.map((r) => cols.map((c) => (r[c] == null ? '' : factValue(r[c], c)))),
    more: Math.max(0, list.length - rows.length),
  };
}

/** "Title: …\nURL: …\nPublished: …\nHighlights: …" blocks (Exa, Keenable and many others). */
function labeledBlocks(text, { full = false } = {}) {
  if (!/^[ \t]*Title:\s*\S/m.test(text) || !/^[ \t]*(?:URL|Url|Link):\s*https?:\/\//m.test(text)) return null;
  const chunks = text.split(/\n(?=[ \t]*Title:[ \t])/);
  const items = [];
  for (const c of chunks) {
    const title = /^[ \t]*Title:\s*(.+)$/m.exec(c)?.[1];
    // A URL that ends a sentence keeps no trailing punctuation.
    const url = /^[ \t]*(?:URL|Url|Link):\s*(https?:\/\/\S+)/m.exec(c)?.[1]?.replace(/[.,;:!?)\]'"]+$/, '');
    if (!title || !url) continue;
    const date = /^[ \t]*(?:Published(?: ?Date)?|Date):\s*(.+)$/im.exec(c)?.[1];
    const author = /^[ \t]*Author:\s*(.+)$/im.exec(c)?.[1];
    // Everything after the header lines is the body.
    const body = decodeEntities(c)
      .split('\n')
      .filter((l) => !/^[ \t]*(?:Title|URL|Url|Link|Published(?: ?Date)?|Date|Author|Highlights|Text|Summary):\s*/i.test(l) && !/^[ \t]*-{3,}\s*$/.test(l))
      .join(' ')
      // Search engines' own labels ("Acquired: 2026-10-17 Snippets:") aren't content.
      .replace(/\b(?:Acquired|Retrieved|Crawled|Fetched):\s*\S+\s*/gi, ' ')
      .replace(/\b(?:Snippets?|Highlights|Excerpt):\s*/gi, ' ')
      .replace(/[#*_`>]+/g, ' ');
    // (entities are decoded first so "&#x27;" isn't split by the "#" cleanup)
    items.push({
      title: clip(title, 160),
      url,
      site: siteOf(url),
      date: date && !/n\/a/i.test(date) ? shortDate(date.trim()) : '',
      text: dropLeadingTitle(full ? plain(body).replace(/\s+/g, ' ').trim() : clip(body, 320), title),
      facts: author && !/n\/a/i.test(author) ? [{ label: 'Author', value: clip(author, 60) }] : [],
    });
  }
  return items.length ? items : null;
}

/** Markdown-ish lists of links: "- [Title](url) — summary" or "1. **Title** … url". */
function linkList(text) {
  const items = [];
  for (const m of text.matchAll(/^[ \t]*(?:[-*•]|\d+[.)])\s+\[([^\]\n]{2,200})\]\((https?:\/\/[^)\s]+)\)[ \t]*[-–—:]?[ \t]*(.*)$/gm)) {
    items.push({ title: clip(m[1], 160), url: m[2], site: siteOf(m[2]), date: '', text: clip(m[3] || '', 320), facts: [] });
  }
  return items.length >= 2 ? items : null;
}

/**
 * @returns {{ kind: 'items', items: object[], more: number }
 *         | { kind: 'record', title: string, facts: {label, value}[] }
 *         | { kind: 'text', text: string }}
 */
/** Search-result blocks with their whole body text (for picking a quick answer). */
export function resultBlocks(raw) {
  return labeledBlocks(String(raw || ''), { full: true }) || [];
}

export function formatResult(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'text', text: '' };
  if (/^[[{]/.test(text)) {
    // Replies may be cut off at the size cap: repair before giving up on structure.
    const v = parseJsonLenient(text) ?? null;
    // A reply that leads with its own plain-language answer shows that, not its attribution list.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.answer === 'string' && v.answer.length >= 40) {
      return { kind: 'text', text: plainKeepLines(v.answer) };
    }
    if (v != null) {
      const list = mainList(v);
      const table = list && list.length >= 2 ? asTable(list) : null;
      if (table) return { kind: 'table', ...table, facts: Array.isArray(v) ? [] : recordFacts(v, 8) };
      if (list && list.length >= 2) {
        const items = list.slice(0, MAX_ITEMS).map(itemFromObject).filter((x) => x.title || x.text);
        if (items.length) return { kind: 'items', items, more: Math.max(0, list.length - MAX_ITEMS) };
      }
      const obj = list?.length === 1 ? list[0] : Array.isArray(v) ? null : v;
      if (obj && typeof obj === 'object') {
        const it = itemFromObject(obj);
        const facts = recordFacts(obj);
        if (it.url && it.title) return { kind: 'items', items: [it], more: 0 };
        if (facts.length) return { kind: 'record', title: it.title || '', url: it.url || '', facts };
      }
    }
  }
  const blocks = labeledBlocks(text);
  if (blocks) return { kind: 'items', items: blocks.slice(0, MAX_ITEMS), more: Math.max(0, blocks.length - MAX_ITEMS) };
  const links = linkList(text);
  if (links) return { kind: 'items', items: links.slice(0, MAX_ITEMS), more: Math.max(0, links.length - MAX_ITEMS) };
  // Markdown emphasis and headings read as plain words ("**USD rates**" → "USD rates"); line breaks stay.
  return { kind: 'text', text: plainKeepLines(text) };
}

/** A long snippet the server cut mid-sentence ("…solid-state alternati") gets an ellipsis. */
function cutMark(t) {
  return t.length >= 100 && /[\p{L}\p{N},;:]$/u.test(t) ? `${t}…` : t;
}

/** A snippet that starts by repeating its title ("Top Picks … Top Picks for Week …") loses the copy. */
function dropLeadingTitle(text, title) {
  const t = plain(String(title || '')).replace(/\s+/g, ' ').trim();
  if (t.length < 12) return text;
  const s = String(text || '');
  return s.toLowerCase().startsWith(t.toLowerCase()) && s.length > t.length + 20 ? s.slice(t.length).replace(/^[\s:.\-–—|]+/, '') : s;
}

function plainKeepLines(text) {
  return cleanText(decodeEntities(String(text)))
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/(\*\*|__)([^*_\n]+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,;:!?]|$)/g, '$1$2').replace(/`([^`\n]+)`/g, '$1'))
    .join('\n');
}
