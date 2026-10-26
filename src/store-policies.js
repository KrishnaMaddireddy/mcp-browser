// Store policies from the store itself. Shopify stores (2.3 million of them, per webmcp.com)
// answer at https://<store>/api/mcp with a read-only tool, search_shop_policies_and_faqs: the
// return window, where it ships, how to reach it, and its written policies with their links.
// A question that names a store and asks about one of those ("allbirds return policy", "does
// gymshark ship to Canada") is asked of that store alone, and the card says it came from there.
// Nothing about you is sent: only the question (the tool's optional "context" is never filled).
// What the store says is third-party data: shown escaped, never given to a model as instructions.

const TOOL = 'search_shop_policies_and_faqs';
const TOPICS = [
  ['refund', /\b(?:returns?|refunds?|exchanges?|money[- ]back|restocking|send (?:it|them) back)\b/i],
  ['shipping', /\b(?:ship(?:s|ping)?|deliver(?:y|s|ies)?|postage|international|customs|duties)\b/i],
  ['contact', /\b(?:phone(?: number)?|contact|customer (?:service|support|care)|e-?mail(?: address)?|hours|opening times|address)\b/i],
  ['privacy', /\bprivacy\b/i],
  ['terms_of_service', /\bterms(?: of (?:service|use))?\b/i],
  ['terms_of_sale', /\bterms of sale\b/i],
  ['subscription', /\b(?:subscriptions?|cancel(?:lation)? (?:my )?(?:plan|membership|subscription))\b/i],
];
const TOPIC_WORD = String.raw`(?:return|returns|refund|refunds|exchange|exchanges|shipping|delivery|privacy|subscription|cancellation|contact|customer service|customer support|phone number|terms(?: of (?:service|sale|use))?)`;
// (a name of 1–3 words or a web address; never a pronoun or a carrier asked about its own shipping)
const STORE = String.raw`((?:[a-z0-9-]+\.)+[a-z]{2,24}|[\p{L}\p{N}][\p{L}\p{N}&'’.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}&'’.-]*){0,2}?)`;
const NOT_A_STORE = /^(?:you|your|it|they|we|i|he|she|this|that|these|those|the store|a store|stores|online stores|shopify|usps|ups|fedex|dhl|amazon|ebay|walmart|target|costco|apple|google|the|what|how|which|who|can|do|does|will)$/i;
const ASKS = [
  // "allbirds return policy", "Gymshark's shipping policy", "what is the allbirds.com refund policy"
  new RegExp(String.raw`^(?:what(?:'s|’s| is| are)\s+)?(?:the\s+)?${STORE}(?:'s|’s)?\s+${TOPIC_WORD}(?:\s+(?:policy|policies|info|information|details|window|time|times|options|rules|number|phone number|hours|email))?$`, 'iu'),
  // "does gymshark ship to Canada", "can I return allbirds shoes"? (the store first only)
  new RegExp(String.raw`^(?:does|do|will|can)\s+${STORE}\s+((?:ship|deliver|offer|accept|take|allow|do|charge|refund|have)\b.*)$`, 'iu'),
  // "return policy for allbirds", "shipping policy of kyliecosmetics.com"
  new RegExp(String.raw`^(?:what(?:'s|’s| is)\s+)?(?:the\s+)?${TOPIC_WORD}\s+(?:policy|policies|info)\s+(?:for|of|at)\s+${STORE}$`, 'iu'),
];

/** The policy kinds a question touches (for the tool's policy_types). */
export function policyTypesOf(q) {
  return TOPICS.filter(([, re]) => re.test(q)).map(([k]) => k);
}

/**
 * A store-policy question: { type: 'store', title, hosts: [first, fallback], question,
 * policyTypes } or null. A web address is used as typed; a name becomes <name>.com, and is
 * only shown if that site turns out to be a store that answers.
 */
export function detectStore(query) {
  const q = String(query || '').trim().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  if (!q || q.length > 120) return null;
  for (const [k, re] of ASKS.entries()) {
    const m = re.exec(q);
    if (!m) continue;
    const name = (m[1] || '').trim();
    if (!name || NOT_A_STORE.test(name)) continue;
    // (a "does X …" question must be about a policy: "does Nike make running shoes" isn't)
    if (k === 1 && !policyTypesOf(m[2]).length) continue;
    const isHost = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/i.test(name);
    const slug = name.toLowerCase().replace(/['’]s$/, '').replace(/[^a-z0-9-]/g, '');
    if (!isHost && (slug.length < 3 || slug.length > 40)) continue;
    const host = isHost ? name.toLowerCase().replace(/^www\./, '') : `${slug}.com`;
    // (what the store is asked: the question without its own name, which confuses its search —
    // "does gymshark ship to Canada" finds nothing, "ship to Canada" finds its answer)
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ask = q.replace(new RegExp(`(?:^|\\s)(?:the\\s+)?${esc}(?:'s|’s)?(?=\\s|$)`, 'iu'), ' ').replace(/^\s*(?:what(?:'s|’s| is| are)\s+(?:the\s+)?|does\s+|do\s+|will\s+|can\s+)/i, '').replace(/\s+(?:for|of|at)\s*$/i, '').replace(/\s+/g, ' ').trim();
    return { type: 'store', value: host, title: isHost ? host : /\p{Lu}/u.test(name) ? name : name.replace(/(^|\s)(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase()), hosts: [host, `www.${host}`], question: q, ask: ask || q, policyTypes: policyTypesOf(q) };
  }
  return null;
}

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const sameSite = (url, host) => {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.protocol === 'https:' && (h === host || h.endsWith(`.${host}`));
  } catch {
    return false;
  }
};

/** A store named directly (an MCP tool's arguments): its web address, or a name as <name>.com. */
export function storeFor(store, question) {
  const name = String(store || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').slice(0, 100);
  const isHost = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/i.test(name);
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!isHost && (slug.length < 3 || slug.length > 40)) return null;
  const host = isHost ? name.toLowerCase().replace(/^www\./, '') : `${slug}.com`;
  const q = String(question || '').trim().slice(0, 200) || 'return and shipping policy';
  return { type: 'store', value: host, title: isHost ? host : name, hosts: [host, `www.${host}`], question: q, ask: q, policyTypes: policyTypesOf(q) };
}

/** The store's reply, read: { faqs: [{ question, answer }], policies: [{ title, kind, summary, url }] }. */
export function readReply(text, host) {
  let list = [];
  try {
    list = JSON.parse(text);
  } catch {
    return { faqs: [], policies: [] };
  }
  if (!Array.isArray(list)) return { faqs: [], policies: [] };
  const faqs = [];
  const policies = [];
  for (const x of list.slice(0, 30)) {
    if (!x || typeof x !== 'object') continue;
    if (x.type === 'Policy') {
      const url = sameSite(x.url, host) ? String(x.url).slice(0, 500) : '';
      policies.push({ title: clean(x.title || x.question, 80), kind: clean(x.policy_type, 30), summary: clean(x.body_summary || x.answer, 600).replace(/\s*\n\s*/g, ' '), url });
    } else if (x.question && x.answer) {
      // (its answers come in lines: "The store accepts returns.\nWithin 31 days days of delivery.")
      faqs.push({ question: clean(x.question, 160), answer: clean(x.answer, 500).replace(/\s*\n\s*/g, ' ').replace(/\b(\w+) \1\b/g, '$1') });
    }
  }
  return { faqs: faqs.slice(0, 8), policies: policies.slice(0, 4) };
}

/** The store's MCP endpoint as a server MCP Browser can ask (hosted, HTTPS, no key). */
export const storeServer = (host) => ({ id: `shop:${host}`, title: host, description: `${host}'s own store policies`, url: `https://${host}/api/mcp`, transport: 'streamable-http', source: 'shop', trust: 'community', tags: [] });

/**
 * Ask a store about its policies. pool: MCP Browser's connection pool (its network guard and
 * time limits apply). Returns { host, faqs, policies } or null when it isn't a store that answers.
 */
export async function askStore(pool, store, { signal } = {}) {
  for (const host of store.hosts) {
    if (signal?.aborted) return null;
    const server = storeServer(host);
    try {
      const { tools } = await pool.get(server);
      if (!(tools || []).some((t) => t.name === TOOL)) continue;
      // (the question as asked; if that finds nothing, the topic alone: "shipping", "refund")
      const tries = [...new Set([store.ask || store.question, store.policyTypes.join(' ').replace(/_/g, ' ')].filter(Boolean))];
      for (const query of tries) {
        const args = { query: query.slice(0, 200), ...(store.policyTypes.length ? { policy_types: store.policyTypes } : {}) };
        const r = await pool.callTool(server, TOOL, args, { timeoutMs: 15000, signal });
        if (r?.isError) break;
        const text = (r?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        const got = readReply(text, store.value);
        if (got.faqs.length || got.policies.length) return { host, ...got };
      }
      // (a store that answered, with nothing on this: no card, but no other address to try)
      return null;
    } catch {
      /* not a store, or it didn't answer: try the next address */
    }
  }
  return null;
}

/** The card: card_start, the store's answers and its written policies, card_done; or card_none. */
export async function runStoreCard(pool, store, { emit, signal } = {}) {
  const got = await askStore(pool, store, { signal });
  if (!got) return emit('card_none', {});
  const from = [`${got.host} (the store itself)`];
  emit('card_start', { type: 'store', title: store.title, subtitle: 'Store policies', asking: `asked ${got.host} directly`, sections: [{ key: 'answers', label: 'What the store says' }, { key: 'policies', label: 'Its written policies' }] });
  emit('card_section', {
    key: 'answers',
    label: 'What the store says',
    answer: '',
    details: got.faqs.length ? [{ title: '', facts: got.faqs.map((f) => ({ label: f.question, value: f.answer })) }, { title: '', text: `These are the answers of the storefront at ${got.host}; a store's site for another country can differ.` }] : [],
    links: [],
    servers: from,
    ...(got.faqs.length ? {} : { empty: true }),
  });
  emit('card_section', {
    key: 'policies',
    label: 'Its written policies',
    answer: '',
    details: got.policies.map((p) => ({ title: p.title, text: p.summary })),
    links: got.policies.filter((p) => p.url).map((p) => ({ title: p.title, url: p.url, host: got.host })),
    servers: from,
    ...(got.policies.length ? {} : { empty: true }),
  });
  emit('card_done', {});
}
