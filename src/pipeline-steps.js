// The parts of a pipeline that are plain code, with no AI and no server: what a request asks for
// (the brief), whether a result is about the subject, checks on generated copy, reading a site's
// own robots.txt, and the result that ends every pipeline. Everything here is deterministic, so
// it works in free mode and can be tested without the network.

const STOP = new Set('a an the and or of for to in on at by with from about into over under as is are was were be been it its this that these those my our your their me us we you i do does did how what which who whom why when where can could should would will may might must not no yes than then so if but via per vs versus'.split(' '));

/** Words that carry meaning (for matching a result to a subject). */
export function keyWords(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).map((w) => w.replace(/['’]s$/, '').replace(/[.'’-]+$/, '')).filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d{1,2}$/.test(w)))];
}

// ---------- the brief: what a request asks for ----------

// Ad channels and their headline limits (characters). Google Search ads: 30 per headline;
// Meta (Facebook, Instagram) headline: 40; LinkedIn headline: 70; TikTok ad text: 100.
export const CHANNELS = {
  google: { name: 'Google Search', limit: 30, platform: 'Google' },
  meta: { name: 'Meta (Facebook and Instagram)', limit: 40, platform: 'Facebook' },
  facebook: { name: 'Facebook', limit: 40, platform: 'Facebook' },
  instagram: { name: 'Instagram', limit: 40, platform: 'Instagram' },
  linkedin: { name: 'LinkedIn', limit: 70, platform: null },
  tiktok: { name: 'TikTok', limit: 100, platform: 'TikTok' },
};
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
// "Write 10 Google ad headlines for a …", "give me some ad copy about …", "10 headlines for …".
// It needs a verb ("write", "give me") or a count before the nouns, and whole words only, so
// "Adobe", "Linear algebra" and "Lines of code" are never cut.
const VERB = String.raw`(?:write|create|generate|make|draft|give\s+me|come\s+up\s+with|suggest|brainstorm|produce|i\s+need|we\s+need)\s+(?:me\s+|us\s+)?(?:an?\s+)?`;
const COUNT = String.raw`(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|a\s+few|some|several|more)\s+`;
const NOUNS = String.raw`(?:(?:google|meta|facebook|instagram|linkedin|tiktok|search|social|display)\s+)*(?:(?:ad|ads|advert|advertising|marketing|campaign|catchy|short|punchy|new)\s+)*(?:headlines?|ad\s+copy|copy|titles?|slogans?|taglines?|ads|ad|captions?|posts?|ideas?)(?![\w-])`;
// (with no verb or count, only a phrase that is plainly about ads: "Facebook ad copy: …",
// "Google search ads for …", "Ad headlines for …" — never "Ad blockers" or "Titles of …")
const AD_LEAD = String.raw`(?=(?:(?:google|meta|facebook|instagram|linkedin|tiktok|search|social|display)\s+)*(?:ad|ads|advert|advertising)\s+(?:headlines?|copy|titles?|slogans?|taglines?|captions?|posts?|ideas?)(?![\w-])|(?:google|meta|facebook|instagram|linkedin|tiktok)\s+(?:search\s+)?(?:headlines?|ad\s+copy|ads?|captions?)(?![\w-]))`;
const INSTRUCTION = new RegExp(String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:${VERB}(?:${COUNT})?|${COUNT}|${AD_LEAD})${NOUNS}(?:\s*[:,–—-]\s*|\s+(?:for|about|on|promoting|to\s+promote|to\s+sell)\s+|\s*$)(?:(?:an?|the|my|our)\s+)?`, 'i');
// (a channel named in the instruction itself: "Write 5 LinkedIn ad headlines for …", "Facebook ad
// copy: …"; not one inside the product, "headlines for a LinkedIn ads course")
const CHANNEL_ASK = new RegExp(String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:${VERB})?(?:${COUNT})?(?:(?:ad|catchy|short|new)\s+)*(google|meta|facebook|instagram|linkedin|tiktok)\s+(?:search\s+)?(?:(?:ad|ads|advert|advertising)\s+)?(?:ads?|headlines?|copy|campaigns?|posts?|captions?|titles?|taglines?)(?=\s+(?:for|about|on|promoting|to)\b|\s*[:,–—-]|\s*$)`, 'i');
// (words a request uses to ask, not what it's about: with only these left, there's no subject)
const ASKING = new Set('write create generate make draft give me us come up with suggest brainstorm produce need please some few several more new catchy short punchy ad ads advert advertising marketing campaign headline headlines copy title titles slogan slogans tagline taglines caption captions post posts idea ideas google meta facebook instagram linkedin tiktok search social display i we can could would you'.split(' '));

/** The request with its instruction words taken off: what a tool should be asked about. */
export function stripInstruction(text) {
  const t = String(text || '').trim();
  const rest = t.replace(INSTRUCTION, '').trim();
  return rest.length >= 2 ? rest : t;
}
/** Is anything left that a request is about (not only "write me 10 ad headlines")? */
const namesSomething = (t) => keyWords(t).some((w) => !ASKING.has(w) && !/^\d+$/.test(w));

const DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/i;
const FILE_EXT = new Set(['js', 'ts', 'md', 'py', 'json', 'txt', 'html', 'css', 'xml', 'yml', 'yaml', 'csv', 'pdf', 'png', 'jpg']);

/**
 * What a request asks for, read in code: { subject, product, benefit, audience, count, channel,
 * limit, platform, channelGiven, domain, raw }. "Write 10 ad headlines for a us government
 * contracts" → subject "US government contracts", count 10, channel Google Search (by default).
 * "SpendQuery, a free federal contract search for small businesses" → product SpendQuery,
 * benefit "free federal contract search", audience "small businesses".
 */
export function briefOf(input) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  // (what ends the request doesn't change it: "… on Instagram.", "… for Facebook, please")
  const low = raw.toLowerCase().replace(/(?:[,;]?\s*please)?[\s.!?,;]*$/, '');
  const countM = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+(?:(?:google|meta|facebook|instagram|linkedin|tiktok|search|ad|ads|catchy|short)\s+)*(?:headlines?|ads?|titles?|slogans?|taglines?|lines?|ideas?)\b/i.exec(raw);
  const count = countM ? Math.min(20, Number(countM[1]) || NUMBER_WORDS[countM[1].toLowerCase()] || 10) : null;
  // (a channel only where the request says where the ads run: "LinkedIn ad headlines", "for Meta",
  // "on Google" — not "Meta Quest accessories" or "Linked In Learning courses")
  const atEnd = /\b(?:on|for|in)\s+(google|meta|facebook|instagram|linkedin|tiktok)(?:\s+(?:search|ads?))*$/i.exec(low);
  const asked = CHANNEL_ASK.exec(low);
  const chKey = asked ? asked[1].toLowerCase() : atEnd ? atEnd[1].toLowerCase() : /^\s*(?:\S+\s+){0,4}search\s+ads?\b/i.test(low) && INSTRUCTION.test(low) ? 'google' : null;
  const ch = CHANNELS[chKey || 'google'];
  let rest = stripInstruction(raw.replace(/(?:[,;]?\s*please)?[\s.!?,;]*$/i, ''))
    .replace(/\b(?:on|for|in)\s+(?:google(?:\s+search)?|meta|facebook|instagram|linkedin|tiktok)(?:\s+ads?)?\s*$/gi, ' ')
    .replace(/^[\s:,;-]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  // "SpendQuery, a free federal contract search for small businesses"
  let product = '';
  let benefit = '';
  let audience = '';
  const apos = /^([^,]{2,60}?),\s+(?:an?|the)\s+(.{3,120})$/i.exec(rest);
  if (apos) {
    product = apos[1].trim();
    benefit = apos[2].trim();
  }
  const forAud = /^(.{3,120}?)\s+(?:for|aimed at|targeting)\s+((?:small|busy|new|local|young|first-time|online|independent|federal|government|enterprise)?\s*[\p{L}][\p{L} -]{2,50}?)$/iu.exec(benefit || rest);
  if (forAud && !/\b(?:sale|free|less|more|you|your)\b/i.test(forAud[2]) && /(?:ers|ors|people|owners|teams|students|parents|businesses|companies|agencies|firms|buyers|shoppers|users|developers|contractors|startups|families|seniors|nurses|doctors|lawyers|employees|homeowners|retirees|travelers|travellers|gamers|investors|patients|clinics|schools|nonprofits|freelancers|creators|veterans|members|professionals|kids|children|moms|dads|women|men|couples|renters|landlords|athletes|pet owners|retailers|restaurants|smbs)$/i.test(forAud[2].trim())) {
    if (benefit) benefit = forAud[1].trim();
    else rest = forAud[1].trim();
    audience = forAud[2].trim();
  }
  let subject = product || rest;
  // "us government contracts": "us" is the country here
  subject = subject.replace(/^us\b(?=\s+(?:government|federal|army|navy|military|market|companies|stocks?|economy))/i, 'US').trim();
  // (the first name that is a website, not a file: "the robots.txt of theguardian.com")
  const domain = ([...raw.matchAll(new RegExp(DOMAIN.source, 'gi'))].map((m) => m[1]).find((d) => (d.split('.').length > 2 || !FILE_EXT.has(d.split('.').pop().toLowerCase())) && !/^(?:robots|llms|sitemap|security|humans|ads)\.txt$/i.test(d)) || '').toLowerCase().replace(/^www\./, '');
  // (nothing but asking words left — "Write 10 ad headlines", "Write me some ads": no subject)
  if (!namesSomething(subject)) subject = '';
  const words = keyWords(subject);
  return {
    raw,
    subject: words.length ? subject : '',
    product,
    benefit,
    audience,
    count,
    channel: ch.name,
    channelGiven: Boolean(chKey),
    limit: ch.limit,
    platform: ch.platform || '',
    domain,
  };
}

// ---------- is a result about the subject? ----------

/**
 * Keep the results that mention the subject (in their title, address or snippet). A subject
 * that is a ticker or a code ("NVDA", "CVE-2021-44228") is left alone: pages name the company.
 */
export function aboutSubject(results, subject) {
  // (accents, case and hyphens don't count: "Türkiye" matches "Turkiye", "CVE-2021-44228" matches
  // "cve 2021 44228" in an address)
  const flat = (t) => String(t || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[-_/–—]+/g, ' ');
  const words = keyWords(subject).map((w) => flat(w).trim()).filter((w) => w.length >= 3);
  if (!words.length || /^[A-Z0-9.-]{1,6}$/.test(String(subject).trim())) return { kept: results, dropped: [] };
  const stem = (w) => (w.length > 5 && !/\d/.test(w) ? w.slice(0, w.length - 2) : w);
  const kept = [];
  const dropped = [];
  for (const r of results) {
    let url = String(r.url || '');
    try { url = decodeURIComponent(url.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { /* keep it as it is */ }
    const hay = flat(`${r.title || ''} ${url} ${r.text || ''}`);
    (words.some((w) => hay.includes(stem(w))) ? kept : dropped).push(r);
  }
  return { kept, dropped };
}

// ---------- checks on generated ad copy ----------

// (risky wording, by why it's risky)
const AD_FLAGS = [
  // ("Endorsed by Small Businesses" is a testimonial; "Official Nike Store" is a brand's own shop)
  ['looks like a government site', /\b(?:official(?!\s+(?:[\w&'’-]+\s+){0,2}(?:store|shop|merch|partner|reseller|site of)\b)|(?:federally|government|govt|gov['’]?t|state)[- ](?:approved|endorsed|certified|backed|sanctioned)|(?:endorsed|approved|certified|backed|sanctioned)\s+by\s+(?:the\s+)?(?:government|federal|state|u\.?s\.?\b|gsa|sba|irs|fema|usda|dod|department|dept|agency|pentagon|white house)|on behalf of (?:the )?(?:government|agency))\b|\.gov\b|\bsam\.gov\b/i],
  // (an agency's or a federal system's name, in capitals, as if it were the advertiser: "Search SAM
  // Faster", "Free IRS Tax Help"; "GSA Schedule", "SBA loans", "VA Home Loans", "USPS Shipping"
  // are what's being sold, so they pass)
  ['looks like a government site', /\b(?:SAM|GSA|SBA|IRS|DoD|FEMA|USDA|VA|SSA|USPS)\b(?!\s+(?:[Ss]chedules?|[Cc]ontracts?|[Ss]et-[Aa]sides?|[Bb]ids?|[Dd]ata|[Rr]ules|[Gg]uidelines|[Ll]oans?|[Hh]ome\s+[Ll]oans?|[Mm]ortgages?|[Ff]orms?|[Ss]hipping|[Bb]oxes|[Ss]upplies|[Bb]enefits?\s+[Hh]elp))/],
  ['promises a result', /\bguarantee[ds]?\b|\b(?:win|land)\s+every\b|\bnever\s+lose\s+(?:a|another|any)\s+(?:bid|case|deal|sale|customer|client|contract)\b|\b100\s?%\s+(?:success|results?|approval|approved|win|wins|guaranteed|accurate|safe|effective|money back)\b|\b(?:make|earn)\s+(?:\$\s?\d[\d,.]*\s*[km]?|\d[\d,.]*\s*(?:k|grand|dollars)\b)|\b(?:double|triple)\s+your\s+(?:income|money|revenue|sales|profits?|savings)\b|\blose\s+\d+\s*(?:lbs?|pounds?|kg|kilos?)\b|\b(?:cures?|treats?|reverses?|heals?)\s+(?:your\s+)?(?:diabetes|cancer|covid|depression|anxiety|arthritis|obesity|disease|back pain|pain|alzheimer['’]?s|insomnia)\b/i],
  ['clickbait', /\b(?:secrets?(?!\s+santa)|hidden(?!\s+gems?)|shocking|you\s+won['’]?t\s+believe|(?:one\s+)?(?:weird\s+)?trick\b|nobody\s+tells\s+you|unlock\s+the|\w+\s+hate\s+(?:this|him|her)\b)/i],
  // (a number of approvals or users, or "the best", is a claim the advertiser has to be able to prove)
  ['a claim to back up', /\b(?:approved|trusted|used|loved|chosen|rated)\s+by\s+(?:over\s+|more than\s+)?\d[\d,.]*\s*[km+]?\b|(?:^|\s)#\s?1\b|\bnumber one\b|\bbest\s+(?:[\w-]+\s+){0,3}in\s+(?:the\s+)?(?:us|usa|america|world|country|nation)\b/i],
];
// (characters as a person counts them: "👍🏽" is one)
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
export const charCount = (t) => (SEG ? [...SEG.segment(String(t))].length : [...String(t)].length);
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
function similar(a, b) {
  const A = new Set(keyWords(a));
  const B = new Set(keyWords(b));
  if (!A.size || !B.size) return norm(a) === norm(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.75;
}

/** Headlines out of a generator's text: "1. Find Federal Contracts Fast  [Benefit-Driven]". */
export function headlinesIn(text) {
  const out = [];
  for (const line of String(text || '').split(/\n/)) {
    // (numbered lines only: a generator's "• Free, no signup: https://…" lines are its own ads)
    const m = /^\s*\d{1,2}[.)]\s+(.+?)\s*(?:\[([^\]]{2,30})\]|\(([^)]{2,30})\))?\s*$/.exec(line.replace(/\*\*(\[[^\]]*\])\*\*/g, '$1'));
    if (!m || /https?:\/\/|www\./i.test(line)) continue;
    const t = m[1].replace(/\*\*|__|`/g, '').replace(/^["“]|["”]$/g, '').trim();
    if (t.length >= 4 && t.length <= 160 && !/^https?:/i.test(t)) out.push({ text: t, angle: (m[2] || m[3] || '').trim() });
  }
  return out;
}

const TAIL = /\s+(?:today|now|fast|instantly|online|here|easily|for free)$/i;
const ENDS_BADLY = /\b(?:a|an|the|to|and|or|of|for|with|your|our|in|on|at|by|from|that|is|are|just|not|only|but|than|as|so|if|no|more|less|very)$/i;
/**
 * A headline over the limit, shortened in code when that keeps its meaning: the part before a
 * dash, colon or comma, or without a trailing "for …"/"with …" phrase or "Today". Kept only if it
 * still names the subject (a word from `must`), has three words or more and doesn't end on "the".
 * "Find Free Federal Contracts for Growth" → "Find Free Federal Contracts". Null when none fits.
 */
export function shortenHeadline(text, limit, must = []) {
  const t = String(text).replace(/[.!]+$/, '').trim();
  const stems = must.map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w).toLowerCase()).filter((w) => w.length >= 3);
  const cands = [];
  const cut = /\s[–—-]\s|:\s|,\s|;\s/.exec(t);
  if (cut) cands.push(t.slice(0, cut.index));
  for (let x = t, k = 0; k < 3; k++) {
    const y = x.replace(TAIL, '').replace(/\s+(?:for|with|in|from|by|across|to help|so)\s+[^,]{2,40}$/i, '').trim();
    if (y === x) break;
    cands.push((x = y));
  }
  for (const c0 of cands) {
    const c = c0.replace(/[\s,;:–—-]+$/, '').trim();
    const len = charCount(c);
    if (len > limit || len < 12 || c.split(/\s+/).length < 3 || ENDS_BADLY.test(c)) continue;
    if (stems.length && !stems.some((w) => c.toLowerCase().includes(w))) continue;
    return c;
  }
  return null;
}

/**
 * Check ad headlines in code: the channel's character limit, near-duplicates, and risky wording.
 * { kept: [{ text, chars, angle }], dropped: [{ text, chars, reason }] }; keeps at most `keep`.
 */
export function checkAdHeadlines(list, { limit = 30, keep = 10, must = null } = {}) {
  const kept = [];
  const dropped = [];
  for (const h of list) {
    let text = String(h.text || h).replace(/\s+/g, ' ').trim();
    const original = text;
    // (too long: shortened in code when a shorter form keeps the subject; `must` = its words)
    if (charCount(text) > limit && must) text = shortenHeadline(text, limit, must) || text;
    const chars = charCount(text);
    const flag = AD_FLAGS.find(([, re]) => re.test(original));
    const from = text !== original ? { from: original } : {};
    // (risky wording first: it matters even when the headline is also too long)
    const mine = h.mine ? { mine: true } : {};
    if (flag) dropped.push({ text: original, chars: charCount(original), reason: flag[0], ...mine });
    else if (chars > limit) dropped.push({ text, chars, reason: `${chars - limit} over the ${limit}-character limit`, ...mine });
    else if (kept.some((k) => similar(k.text, text))) dropped.push({ text, chars, reason: 'too like another headline', ...from, ...mine });
    else kept.push({ text, chars, angle: h.angle || '', ...from, ...(h.mine ? { mine: true } : {}) });
  }
  // (the best few: one per angle first, then the rest, in the generator's order; headlines put
  // together from the request's own words only after the written ones)
  const seen = new Set();
  const theirs = kept.filter((k) => !k.mine);
  const first = theirs.filter((k) => !seen.has(k.angle) && seen.add(k.angle));
  const ordered = [...first, ...theirs.filter((k) => !first.includes(k)), ...kept.filter((k) => k.mine)];
  const best = ordered.slice(0, keep);
  for (const k of ordered.slice(keep)) dropped.push({ text: k.text, chars: k.chars, reason: 'more than needed', ...(k.mine ? { mine: true } : {}) });
  return { kept: best, dropped };
}

// ---------- a site's own robots.txt (RFC 9309) ----------

/** robots.txt as groups: [{ agents: ['gptbot'], rules: [{ allow, path }] }]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  // (CR, LF or CRLF; only an Allow or Disallow line ends a group's list of agents, so a Sitemap or
  // Crawl-delay line between two User-agent lines doesn't split them)
  for (const line0 of String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = line0.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      // ("GPTBot/1.0" names GPTBot: the token is what comes before a slash or a space)
      cur.agents.push(val.split(/[\/\s*,;]/)[0].toLowerCase() || (val.trim().startsWith('*') ? '*' : ''));
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      if (val || key === 'allow') cur.rules.push({ allow: key === 'allow', path: normPath(val) });
      lastWasAgent = false;
    }
  }
  return groups;
}
// (percent-encoding compared the same way on both sides: "%7e" = "%7E" = "~")
function normPath(p) {
  return String(p).replace(/[^\x00-\x7f]+/g, (t) => encodeURIComponent(t)).replace(/%([0-9a-f]{2})/gi, (all, h) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${h.toUpperCase()}`;
  });
}
function pathMatches(pattern, path) {
  if (!pattern) return false;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
  return re.test(normPath(path));
}
/**
 * May this user-agent token fetch this path? The group naming the token (else its owner's stated
 * fallback, else "*"), the longest matching rule wins, Allow wins a tie.
 * { allowed, group: 'own' | 'fallback' | 'all' | 'none', rule }.
 */
export function robotsAllows(groups, token, path = '/', { fallback = null } = {}) {
  const t = String(token).toLowerCase();
  // (Applebot follows Googlebot's group when it has none of its own)
  let own = groups.filter((g) => g.agents.includes(t));
  let kind = own.length ? 'own' : '';
  if (!own.length && fallback) {
    own = groups.filter((g) => g.agents.includes(String(fallback).toLowerCase()));
    if (own.length) kind = 'fallback';
  }
  const use = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  if (!kind) kind = use.length ? 'all' : 'none';
  const rules = use.flatMap((g) => g.rules).filter((r) => pathMatches(r.path, path));
  if (!rules.length) return { allowed: true, group: kind, rule: null };
  const best = rules.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
  return { allowed: best.allow, group: kind, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` };
}

// ---------- the result that ends a pipeline ----------

/**
 * A plain result from the steps before: per step, its question, what it found, and its best
 * links, each cited as [step.n]. { text, citations: [{ n, step, title, url }] }.
 */
export function summaryResult(steps) {
  const citations = [];
  const lines = [];
  steps.forEach((s, i) => {
    const runs = s.runs || [];
    if (!runs.length && s.note) return lines.push(`Step ${i + 1}: ${s.note}`);
    for (const r of runs.slice(0, 3)) {
      const said = r.answer || r.details?.[0]?.text || r.details?.[0]?.title || '';
      const cites = (r.sources || []).slice(0, 2).map((x) => {
        const n = citations.length + 1;
        citations.push({ n, step: i + 1, title: x.title, url: x.url, host: x.host });
        return `[${n}]`;
      });
      if (said || cites.length) lines.push(`Step ${i + 1} (${r.q || s.label || ''}): ${said ? `${String(said).replace(/\s+/g, ' ').slice(0, 240)} ` : ''}${cites.join(' ')}`.trim());
      else lines.push(`Step ${i + 1} (${r.q || ''}): nothing relevant found.`);
    }
  });
  return { text: lines.join('\n'), citations };
}
