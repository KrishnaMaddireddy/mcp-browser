// Sample prompts for a catalog server, without a language model.
// From its tools when we could list them: the tool's verb and object, with
// example values for its required inputs ("Get the stock quote for NVDA").
// Otherwise from its own description ("Ask Weather Worldwide about forecasts
// for any city"), so a suggestion never claims more than the server says.
import { splitIdentifier } from '../../src/util.js';

// Example input per category, for free-text inputs (query, topic, text…).
const TOPIC = {
  search: 'the latest MCP spec changes', browser: 'https://modelcontextprotocol.io', dev: 'React server components', cloud: 'AWS Lambda timeout limits',
  observe: 'errors in the last hour', data: 'monthly revenue by region', ai: 'open-weight models for coding', memory: 'last week’s project notes',
  productivity: 'tasks due this week', comms: 'messages from my team today', social: 'MCP servers', finance: 'Nvidia', crypto: 'Ethereum',
  commerce: 'wireless earbuds under $100', media: 'a sunset over the mountains', files: 'the quarterly report', places: 'Seattle',
  science: 'CRISPR gene editing', security: 'CVE-2024-3094', gov: 'small business grants', util: 'Hello, world', iot: 'the living room lights', other: 'model context protocol',
};

const VERBS = {
  get: 'Get', fetch: 'Get', retrieve: 'Get', read: 'Read', search: 'Search', find: 'Find', lookup: 'Look up', look: 'Look up', query: 'Look up',
  list: 'List', show: 'Show', check: 'Check', compare: 'Compare', convert: 'Convert', calculate: 'Calculate', calc: 'Calculate', compute: 'Calculate',
  analyze: 'Analyze', analyse: 'Analyze', summarize: 'Summarize', explain: 'Explain', translate: 'Translate', validate: 'Validate', verify: 'Verify',
  resolve: 'Resolve', describe: 'Describe', track: 'Track', estimate: 'Estimate', recommend: 'Recommend', suggest: 'Suggest', generate: 'Generate',
  create: 'Create', send: 'Send', scrape: 'Scrape', crawl: 'Crawl', extract: 'Extract', parse: 'Parse', format: 'Format', count: 'Count',
  forecast: 'Forecast', predict: 'Predict', rank: 'Rank', score: 'Score', research: 'Research', discover: 'Discover', browse: 'Browse', explore: 'Explore',
  detect: 'Detect', classify: 'Classify', audit: 'Audit', scan: 'Scan', diff: 'Compare', review: 'Review', plan: 'Plan', book: 'Book', ask: 'Ask', answer: 'Answer',
};
const NOT_OBJECT = new Set(['mcp', 'tool', 'tools', 'v1', 'v2', 'by', 'for', 'the', 'a', 'an', 'of', 'all']);
const QUESTION_WORDS = new Set(['what', 'who', 'how', 'when', 'where', 'which', 'why', 'is', 'are', 'can', 'does', 'do', 'start', 'connect', 'register', 'login', 'auth', 'ping', 'health', 'echo', 'test', 'debug', 'version', 'help', 'about', 'status']);
const ACRONYMS = new Set(['llm', 'llms', 'api', 'apis', 'ip', 'url', 'urls', 'sql', 'pdf', 'ai', 'mcp', 'sec', 'cve', 'dns', 'seo', 'ssl', 'tls', 'http', 'json', 'csv', 'xml', 'html', 'id', 'ids', 'uuid', 'eth', 'btc', 'nft', 'nfts', 'usd', 'gdp', 'cpi', 'etf', 'etfs', 'ipo', 'kpi', 'ui', 'ux', 'aws', 'gcp', 'k8s', 'npm', 'pypi', 'vat', 'iban', 'swift', 'isbn', 'doi', 'fda', 'nasa', 'noaa', 'nws']);
const word = (w) => (ACRONYMS.has(w) ? w.toUpperCase() : w);

/** Example value for one required input, or null when we can't guess one honestly. */
function example(p, cat) {
  if (p.e) return { v: p.e, prep: 'for' };
  if (p.x) return { v: p.x, prep: 'for' };
  const k = String(p.k || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const has = (...w) => w.some((x) => k === x || k.startsWith(x + '_') || k.endsWith('_' + x));
  if (p.t === 'boolean') return { v: '', prep: '' };
  if (has('city', 'location', 'place', 'address', 'destination', 'origin', 'area', 'region')) return { v: cat === 'places' || cat === 'other' ? 'Seattle' : 'Seattle', prep: 'in' };
  if (has('country')) return { v: 'Japan', prep: 'in' };
  if (has('lat', 'latitude')) return { v: 'Seattle', prep: 'in', merge: 'loc' };
  if (has('lon', 'lng', 'longitude')) return { v: 'Seattle', prep: 'in', merge: 'loc' };
  if (has('zip', 'zipcode', 'postal', 'postcode')) return { v: '98101', prep: 'for' };
  if (has('ticker', 'symbol', 'symbols', 'tickers', 'stock')) return { v: cat === 'crypto' ? 'BTC' : 'NVDA', prep: 'for' };
  if (has('coin', 'token', 'asset')) return { v: 'ETH', prep: 'for' };
  if (has('currency', 'from_currency', 'base', 'from')) return { v: 'USD', prep: 'from' };
  if (has('to_currency', 'target', 'to', 'quote')) return { v: 'EUR', prep: 'to' };
  if (has('amount', 'value', 'quantity')) return { v: '100', prep: 'for' };
  if (has('url', 'link', 'uri', 'page', 'website', 'site')) return { v: 'https://modelcontextprotocol.io', prep: 'for' };
  if (has('domain', 'hostname', 'host')) return { v: 'modelcontextprotocol.io', prep: 'for' };
  if (has('ip', 'ip_address', 'ipaddress')) return { v: '8.8.8.8', prep: 'for' };
  if (has('repo', 'repository', 'repo_name')) return { v: 'facebook/react', prep: 'for' };
  if (has('owner', 'org', 'organization', 'username', 'user', 'handle', 'author')) return { v: cat === 'social' ? '@anthropic' : 'facebook', prep: 'for' };
  if (has('package', 'library', 'lib', 'module', 'framework', 'dependency')) return { v: cat === 'dev' ? 'react' : 'react', prep: 'for' };
  if (has('company', 'brand', 'business', 'organisation')) return { v: 'Nvidia', prep: 'for' };
  if (has('date', 'day', 'start_date', 'from_date', 'checkin', 'departure_date')) return { v: 'next Friday', prep: 'for' };
  if (has('end_date', 'to_date', 'checkout', 'return_date')) return { v: 'next Sunday', prep: 'until' };
  if (has('year')) return { v: '2025', prep: 'for' };
  if (has('language', 'lang')) return { v: cat === 'dev' ? 'Python' : 'Spanish', prep: 'in' };
  if (has('word', 'term')) return { v: 'serendipity', prep: 'for' };
  if (has('drug', 'medication', 'medicine')) return { v: 'ibuprofen', prep: 'for' };
  if (has('gene')) return { v: 'BRCA1', prep: 'for' };
  if (has('cve')) return { v: 'CVE-2024-3094', prep: 'for' };
  if (has('airport', 'iata')) return { v: 'SEA', prep: 'for' };
  if (has('limit', 'count', 'n', 'num', 'top', 'max_results', 'page_size', 'size', 'days', 'hours')) return { v: '', prep: '' };
  if (has('query', 'q', 'search', 'keyword', 'keywords', 'topic', 'text', 'prompt', 'question', 'input', 'term', 'subject', 'title', 'name', 'description', 'content', 'message', 'expression', 'code')) {
    return { v: TOPIC[cat] || TOPIC.other, prep: cat === 'places' ? 'in' : 'about' };
  }
  return null; // ids, tokens, file paths…: nothing we can make up
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One prompt from one tool, or null. */
export function promptFromTool(tool, cat) {
  const words = splitIdentifier(tool.n || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (QUESTION_WORDS.has(words[0])) return null;
  let verb = VERBS[words[0]];
  let rest = words.slice(verb ? 1 : 0);
  if (words[0] === 'look' && words[1] === 'up') rest = words.slice(2);
  rest = rest.filter((w) => !NOT_OBJECT.has(w));
  // A noun-only name ("llm_models", "planting_calendar"): list plurals, get singulars.
  if (!verb) verb = /s$/.test(rest[rest.length - 1] || '') ? 'List' : 'Get';
  if (!rest.length) {
    // "search" alone: take the object from the description ("Search arXiv papers").
    const d = (tool.d || '').toLowerCase().match(/^(?:search|find|get|look up|list)\s+(?:for\s+)?([a-z0-9 \-]{3,40}?)(?:\s+(?:by|for|with|from|in|using|across|on)\b|[.,;:]|$)/);
    rest = d ? d[1].split(/\s+/) : [];
  }
  const object = rest.map(word).join(' ').trim();
  const vals = [];
  let loc = false;
  for (const p of tool.p || []) {
    const ex = example(p, cat);
    if (!ex) return null;
    if (ex.merge === 'loc') {
      if (loc) continue;
      loc = true;
    }
    if (ex.v) vals.push(ex);
  }
  let text = object ? `${verb} ${object}` : verb;
  // "Search papers about X" reads better as "Search papers for X".
  if (['Search', 'Find', 'Look up', 'Browse', 'Discover', 'Explore'].includes(verb)) for (const v of vals) if (v.prep === 'about') v.prep = 'for';
  if (/\b(docs|documentation|guides?|knowledge|faq|help)\b/i.test(object)) for (const v of vals) if (v.prep === 'for' || v.prep === 'about') if (v.v === (TOPIC[cat] || TOPIC.other)) v.v = 'getting started';
  const from = vals.find((v) => v.prep === 'from');
  const to = vals.find((v) => v.prep === 'to');
  const others = vals.filter((v) => v !== from && v !== to);
  if (others.length) text += ' ' + others.map((v) => `${v.prep} ${v.v}`.trim()).join(' and ');
  if (from) text += ` from ${from.v}`;
  if (to) text += ` to ${to.v}`;
  if (text.split(' ').length < 2) return null;
  return cap(text.replace(/\s+/g, ' ').trim()).slice(0, 140);
}

function fromDescription(s) {
  const title = (s.title || s.name.split('/').pop() || '').trim();
  const desc = String(s.description || '').replace(/\s+/g, ' ').trim();
  if (!desc || !title) return [];
  let clause = desc.split(/(?<=[a-z0-9)]{2}[.!?])\s|\s[—–-]\s|;\s/)[0].replace(/[.!?]+$/, '').trim();
  // Drop a leading restatement of the name ("Acme MCP — …", "MCP server for …").
  clause = clause.replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:mcp)?\\s*(?:server)?\\s*[:—–-]?\\s*`, 'i'), '');
  clause = clause.replace(/^(?:an?\s+|the\s+)?(?:remote\s+|hosted\s+|official\s+)?mcp\s+server\s+(?:for|that|to|which)\s+/i, '');
  if (clause.length < 8) return [];
  clause = clause.replace(/^(?:mcp\s+server|server)\s+(?:for|to|that)\s+/i, '').replace(/^(?:with|using)\s+\d+\s+tools?,?\s*/i, '');
  if (clause.length > 110) clause = clause.slice(0, 110).replace(/[\s,:;]+\S*$/, '') + '…';
  if (clause.length < 8) return [];
  const first = clause.split(' ')[0].toLowerCase().replace(/,$/, '');
  const verb3 = first.replace(/(ies)$/, 'y').replace(/(ches|shes|xes|sses)$/, (m) => m.slice(0, -2)).replace(/s$/, '');
  if (VERBS[first] || VERBS[verb3]) {
    const v = VERBS[first] ? first : verb3;
    return [`Use ${title} to ${v}${clause.slice(clause.split(' ')[0].length)}`];
  }
  const lower = /^[A-Z][a-z]/.test(clause) ? clause.charAt(0).toLowerCase() + clause.slice(1) : clause;
  return [`Use ${title} for ${lower}`];
}

/**
 * Up to `max` prompts as [text, toolName] ('' when from the description).
 * Read-only tools and tools whose inputs we can fill come first; one per tool
 * verb+object so the suggestions differ.
 */
export function samplePrompts(s, cat, tools, max = 3) {
  const out = [];
  const seen = new Set();
  const ordered = (tools || []).filter((t) => !t.w).concat((tools || []).filter((t) => t.w));
  for (const t of ordered) {
    const p = promptFromTool(t, cat);
    if (!p) continue;
    const key = p.toLowerCase().replace(/\b(for|in|about|the)\b.*$/, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([p, t.n]);
    if (out.length >= max) break;
  }
  if (out.length < 2) for (const p of fromDescription(s)) if (out.length < max) out.push([p, '']);
  return out;
}
