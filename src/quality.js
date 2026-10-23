// What a server's reply is worth to the person asking: useful content, an
// empty answer ("no results", or just the question echoed back), or a sales
// pitch (a price list with checkout, sign-up or pay-per-query instructions).
// Used to order results, keep junk out of the sources list, and tell the AI
// model what it is looking at.
import { tokenize, parseJsonLenient } from './util.js';
import { resultBlocks } from './format.js';

// Replies that only report a failure (checked on short replies only).
// A reply that is the server describing itself, or an empty search dressed as JSON,
// rather than an answer ("Here are the available commands and their input schema…",
// {"total_matches": 0, …}). Checked on the first ~200 characters.
export const HELP_REPLY = /available commands and their input schema|run again with the "learn=true"|^\W{0,3}"?error"?\s*:\s*"|"(?:total_matches|returned|total_results|totalResults|result_count|num_results)"\s*:\s*0\s*[,}]/i;
// Tools that list or route to a server's own other tools: what they return is a menu, not an answer.
// (search_tools is left out: on directory servers the tools it finds are the answer.)
export const META_TOOL = /^(?:menu|learn|help|get_help|route|list_tools|get_tools|list_methods|list_commands|describe_tools)$/i;

export const ERROR_REPLY = /^\W{0,4}(?:error|exception|traceback)\b|^\W{0,4}(?:failed|failure)(?: to\b|:)|\b(?:failed to (?:connect|resolve|fetch|load|reach|authenticate|open)|connection (?:refused|reset|timed out)|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|not connected|no active session|unable to connect|could not connect|is not running|is not reachable|errno \d+|internal server error|service unavailable|bad gateway)\b/i;

const NO_RESULT = [
  /\bno (?:results?|matches|matching|listed|items?|records?|data|stocks?|companies|entries|hits|articles|papers|documents)\b/i,
  /\bno (?:[\w/-]+ ){0,3}(?:were |was )?(?:found|match|matches|matched|available)\b/i, // "No stored diagrams match …"
  /\bno [\w-]+ (?:named|called) ["“']|\bno match(?:es)?\b|\b(?:not[_ ]found|nothing found|did not match|could not (?:resolve|find)|couldn'?t find|unable to find|0 results|zero results)\b/i,
  /일치하는 .{0,12}없습니다|결과가 없습니다|찾을 수 없습니다/,
  /見つかりませんでした|該当(?:する)?.{0,6}ありません|結果はありません/,
  /\bno se (?:encontr|hall)aron\b|\bsin resultados\b|\baucun résultat\b|\bkeine (?:ergebnisse|treffer)\b/i,
];

// Signs of a pitch rather than an answer. Fields in the server's own JSON
// (checkout, billing, how_to_buy) and a few unmistakable phrases; ordinary words
// like "subscribe" appear in quoted web pages and don't count.
const PITCH_KEY = /"(?:checkout\w*|billing|how_to_buy|unit_price\w*|pricing|plans|subscription\w*|signup\w*|sign_up\w*|license_key|upgrade_url|buy_url|payment_url|purchase\w*)"\s*:/gi;
const PITCH = [
  /\bfull results are paid\b|\bpaid (?:tier|plan) required\b/i,
  /\btestnet usdc\b|\bfund (?:a |your )?(?:wallet|session)\b/i,
  /\blicen[cs]e key from (?:your )?receipt\b/i,
  /\bplace_\w*order\b|\bbuy[_ ]credits\b|\bcheckout_handoff\b/i,
  /\/signup\b|\bsign up (?:now|today|for (?:a |your )?(?:free|paid|pro))\b/i,
  /\bupgrade (?:to|your) (?:pro|premium|a paid plan)\b/i,
];
// Weak signs: prices. Only a pitch when the question isn't about buying.
const PRICE = [/"price"\s*:\s*\d/i, /"currency"\s*:\s*"[A-Z]{3}"/, /\$\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year)\b/i];
const SHOPPING = /\b(?:buy|price|prices|cheap|cheapest|deal|deals|cost|costs|best|vs|compare|review|reviews)\b/i;

/** Every string value and whether every array is empty, for JSON replies. */
function jsonShape(text, query = '') {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  const v = parseJsonLenient(t);
  if (v === undefined) return null;
  let arrays = 0;
  let filled = 0;
  let facts = 0; // meaningful scalar fields outside lists (a record's own data)
  let textFacts = 0; // …of which text, other than the question echoed back
  const q = String(query).trim().toLowerCase();
  const strings = [];
  const BOOKKEEPING = /^(?:count|total|totalcount|total_count|query|q|search|status|page|limit|offset|took|ms|elapsed|source|sources|license|notice|disclaimer|note|as_of|asof|generatedat|generated_at|data_generated|generated|updated_at|fetched_at|data_as_of|shown|returned|matched|total_matches|num_results|server_version|version|sortkey|cursor|next|has_more|ok|success|error|message|preview|label)$/i;
  const walk = (x, depth, key) => {
    if (depth > 8) return;
    if (Array.isArray(x)) {
      arrays++;
      if (x.length) filled++;
      x.forEach((y) => walk(y, depth + 1));
    } else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, depth + 1, k);
    else if (x != null && x !== '') {
      if (typeof x === 'string') strings.push(x);
      if (key && !BOOKKEEPING.test(key)) {
        facts++;
        if (typeof x === 'string' && x.trim().toLowerCase() !== q && x.trim().length >= 2) textFacts++;
      }
    }
  };
  walk(v, 0);
  return { arrays, filled, facts, textFacts, strings, top: v && typeof v === 'object' && !Array.isArray(v) ? v : null };
}

/** Words that carry content once JSON keys, the question itself and boilerplate are removed. */
function contentWords(text, query) {
  let t = text.replace(/"[\w$-]{1,40}"\s*:/g, ' '); // JSON keys
  const q = query.trim();
  if (q.length >= 3) t = t.split(q).join(' ').split(q.toLowerCase()).join(' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  const qset = new Set(tokenize(query));
  return tokenize(t).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !qset.has(w) && !['true', 'false', 'null'].includes(w));
}

/**
 * @returns {{kind: 'ok'|'empty'|'ad', reason: string}}
 */
export function classifyResult(text, query = '', { general = false } = {}) {
  const s = String(text || '').trim();
  if (s.length < 25) return { kind: 'empty', reason: 'empty reply' };

  // Web search engines return other people's pages: never a pitch of their own.
  if (!general) {
    const pitch = (s.match(PITCH_KEY) || []).length + PITCH.filter((re) => re.test(s)).length;
    const price = PRICE.filter((re) => re.test(s)).length;
    if (pitch >= 2 || (pitch >= 1 && price >= 1 && !SHOPPING.test(query))) return { kind: 'ad', reason: 'sales pitch' };
  }

  const json = jsonShape(s, query);
  // Empty lists and nothing else ({"results": []}, {"count": 0, "items": []}); a
  // record with real fields and an empty "alerts" list is still a record.
  if (json && json.arrays > 0 && json.filled === 0 && json.facts <= 1) return { kind: 'empty', reason: 'no results' };

  const words = contentWords(s, query);
  // "No results" said up front, or in a reply with little else in it. A record
  // with several real fields isn't judged by one "no data" field among them.
  // An explicit status saying nothing was found settles it, however many fields come with it.
  // (top-level only: a list of items each with its own status is a real result)
  const NOT_FOUND = /^(?:not[_ -]?found|no[_ -]?(?:results?|match(?:es)?|data)|unknown[_ -]?(?:ticker|symbol|entity)|invalid[_ -]?(?:query|symbol|ticker))$/i;
  if (json?.top && ['status', 'result', 'outcome', 'state'].some((k) => typeof json.top[k] === 'string' && NOT_FOUND.test(json.top[k].trim()))) return { kind: 'empty', reason: 'no results' };
  // A reply that says so in its own fields: no_match: true, found: false, or only an error.
  const top = json?.top;
  if (top) {
    const flag = (k) => Object.keys(top).find((x) => new RegExp(`^${k}$`, 'i').test(x));
    // (only when the reply carries no list data: {"ok": false, "data": [...]} is still a result)
    const bare = !json.filled;
    const nm = bare && flag('no_?match(?:es)?');
    if (nm && (top[nm] === true || top[nm] === 'yes')) return { kind: 'empty', reason: 'no results' };
    const fd = bare && flag('(?:found|matched|success|ok)');
    if (fd && top[fd] === false) return { kind: 'empty', reason: 'no results' };
    const er = flag('errors?');
    const others = Object.keys(top).filter((k) => !/^(?:errors?|message|code|status|query|q|request_id|requestid|details?|hint|docs?|help|remedy|fix|suggestions?|next_?steps?)$/i.test(k));
    if (er && top[er] && others.length === 0) return { kind: 'empty', reason: 'error reply' };
    const w = flag('warnings?');
    if (bare && w && /unknown (?:ticker|symbol|token|entity|company|place|location)|not in (?:canonical )?registry/i.test(JSON.stringify(top[w])) && json.facts <= 3) return { kind: 'empty', reason: 'no results' };
  }
  if (HELP_REPLY.test(s.slice(0, 200)) && !(json && json.filled)) return { kind: 'empty', reason: /schema|learn=/.test(s.slice(0, 200)) ? 'help text, not an answer' : 'no results' };
  const record = json && json.facts >= 3 && json.textFacts >= 1;
  // A short reply that is only a failure: the server couldn't reach what it fronts, or needs
  // a session or device first ("Failed to connect to MikroTik device", "No active session").
  if (!record && words.length < 60 && ERROR_REPLY.test(s.slice(0, 200))) return { kind: 'empty', reason: 'error reply' };
  if (!record && NO_RESULT.some((re) => re.test(s.slice(0, 150))) && words.length < 60) return { kind: 'empty', reason: 'no results' };
  if (!record && words.length < 20 && NO_RESULT.some((re) => re.test(s))) return { kind: 'empty', reason: 'no results' };
  if (!record && words.length < 3) return { kind: 'empty', reason: 'only repeated the question' };

  return { kind: 'ok', reason: '' };
}

/**
 * Order results: useful before empty or pitches; within useful, trusted and
 * well-ranked servers, more sources and replies that talk about the question.
 */
export function resultScore({ kind, text, query = '', sources = 0, server = {}, rank = null, view = null }) {
  let score = kind === 'ok' ? 10 : kind === 'ad' ? -10 : -20;
  // A specialist answering in structured data (a forecast, a quote, a table)
  // is usually the direct answer; web pages about it come after.
  const structured = view && (view.kind === 'table' || view.kind === 'record' || (view.kind === 'items' && view.items.filter((it) => it.facts?.length).length >= Math.min(3, view.items.length)));
  if (kind === 'ok' && structured && !server.general) score += 5;
  if (server.source === 'curated') score += server.trust === 'trusted' ? 4 : 3;
  else if (server.source === 'custom') score += 3;
  if (rank != null) score += rank / 25;
  score += Math.min(4, sources * 0.4);
  const len = String(text || '').length;
  if (len > 200) score += Math.min(4, Math.log2(len / 200));
  // Relevance carries the most weight: how much of the question the reply talks about.
  const cover = relevance(text, query);
  if (cover != null) {
    score += 8 * cover;
    if (cover < 0.5) score -= 4; // talks about a different thing that shares a word
  }
  return Math.round(score * 10) / 10;
}

/** When, not what: a forecast for "this weekend" says Saturday and Sunday. */
const WHEN = new Set(
  'today tomorrow tonight yesterday weekend weekends week weeks month months year years now next last morning evening afternoon night upcoming soon daily weekly monthly'
    .split(' ')
    .map((w) => tokenize(w)[0] || w)
);

/**
 * Words that appear in many questions and say little about the topic
 * ("latest research on solid-state batteries": the topic is the batteries).
 */
const GENERIC = new Set(
  ('research study studies paper news article guide tutorial review reviews best top new latest recent current info information data ' +
    'overview explained explain example examples list price prices cost compare comparison versus use using used way ways tip tips ' +
    'idea ideas thing things people good great free online official update updates report reports analysis question answer help ' +
    'learn work works make get buy near around world global')
    .split(' ')
    .map((w) => tokenize(w)[0] || w)
);

/**
 * How much of the question a reply talks about, 0..1 (null when the question
 * has no usable words). Topical words count three times as much as generic
 * ones, and a reply that matches none of the topical words is off-topic.
 */
export function relevance(text, query) {
  // Hyphenated terms ("solid-state", "COVID-19") match only as a whole phrase,
  // so "state" alone ("market-state") doesn't count as the topic.
  const compounds = [...new Set((String(query).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu) || []).map((c) => c.toLowerCase()))];
  const parts = new Set(compounds.flatMap((c) => tokenize(c.replace(/-/g, ' '))));
  const q = [...new Set(tokenize(query))].filter((w) => w.length >= 3 && !parts.has(w) && !WHEN.has(w));
  if (!q.length && !compounds.length) return null;
  // One long run with no spaces (Thai, a URL-ish string) can't be matched word by word.
  if (q.length === 1 && !compounds.length && q[0].length > 15) return null;
  // Replies often echo the question back ("query": "…"); that isn't content.
  const raw = String(text || '').slice(0, 20000);
  const qs = String(query).trim();
  // Only the echo: the question as a whole quoted value, or after a query-like key.
  const esc = qs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // (a one-word question — "Nvidia" — is the topic itself, not an echo)
  const body = qs.length >= 3 && /\s/.test(qs) ? raw.replace(new RegExp(`(["'\u201c])${esc}["'\u201d]|\\b(?:query|q|search|keywords?|term|input|question)\\s*[:=]\\s*${esc}`, 'gi'), ' ') : raw;
  const t = new Set(tokenize(body));
  let have = 0;
  let total = 0;
  let topical = 0;
  let topicalHit = 0;
  for (const w of q) {
    const weight = GENERIC.has(w) ? 1 : 3;
    total += weight;
    if (weight === 3) topical++;
    if (t.has(w)) {
      have += weight;
      if (weight === 3) topicalHit++;
    }
  }
  for (const c of compounds) {
    total += 3;
    topical++;
    const re = new RegExp(c.split('-').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-‐–]?'), 'i');
    if (re.test(body)) {
      have += 3;
      topicalHit++;
    }
  }
  const cover = have / total;
  // Only generic words ("top news today"): nothing to judge the topic by.
  if (!topical) return null;
  return !topicalHit ? Math.min(cover, 0.2) : cover;
}

const STOP = new Set(
  'a an the of in on at for to from by with about into over and or is are was were be been do does did can could should would will what which who whom whose when where why how i me my we our you your it its this that these those there here please tell show find give list get me some any much many latest current today tomorrow tonight yesterday now week weekend month year next last'.split(' ')
);

/**
 * Simpler ways to ask the same thing, for servers that want keywords or a name
 * rather than a sentence: "weather in Seattle this weekend" → keywords
 * "weather Seattle", entity "Seattle". Returns only forms that differ.
 */
export function simplerQueries(query) {
  const q = String(query || '').trim();
  if (!/[a-z]/i.test(q)) return []; // keep non-Latin questions as they are
  const words = q.replace(/[?!.,;:"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  const keywords = words.filter((w) => !STOP.has(w.toLowerCase())).join(' ');
  const entity = entityOf(q);
  const out = [];
  if (keywords && keywords.toLowerCase() !== q.toLowerCase()) out.push(keywords);
  if (entity && !out.some((x) => x.toLowerCase() === entity.toLowerCase()) && entity.toLowerCase() !== q.toLowerCase()) out.push(entity);
  return out;
}

/** Capitalised words after the first one name the thing asked about ("Seattle"). */
// Sentence-initial words that are capitalised only because they start the question.
const OPENERS = new Set(
  ('weather forecast best top latest news price prices cheap cheapest flights flight things easy population capital convert compare side clinical papers paper research recent new current upcoming hotels restaurants tickets stocks stock reviews review history guide tips ' +
    'define explain translate summarize summarise describe calculate recommend suggest average list show find give tell compute estimate write plan analyze analyse check track')
    .split(' ')
);

export function entityOf(query) {
  const words = String(query || '').replace(/[?!.,;:"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  const name = (w) => /^[A-Z][\p{L}\p{N}.&'-]*$/u.test(w) && !STOP.has(w.toLowerCase());
  // The first word counts when it's a name ("Nvidia stock price"), not an opener ("Weather in Seattle").
  const first = words[0] && name(words[0]) && !OPENERS.has(words[0].toLowerCase()) && words.length > 1 ? [words[0]] : [];
  return [...first, ...words.slice(1).filter(name)].join(' ');
}

/**
 * Free mode has no model to read the conversation, so a short follow-up ("and AMD?",
 * "what about Porto?") is rewritten from the question before it: the new name takes
 * the old one's place ("Nvidia stock price today" → "AMD stock price today"). Anything
 * else is returned as it is.
 */
export function followUpQuery(query, history = []) {
  const q = String(query || '').trim();
  const last = String(history.at(-1)?.q || '').trim();
  if (!last) return q;
  const m = /^(?:and|what about|how about|same for|same with|now|or|also|versus|vs\.?|compared to|compared with)\s+(?:for\s+|in\s+|the\s+)?(.{1,60}?)\s*[?.!]*$/i.exec(q);
  if (!m) return q;
  const next = m[1].trim();
  if (!next || next.split(/\s+/).length > 5) return q;
  // "and why?", "what about it?" are questions about the last answer, not a new name.
  if (/^(?:why|how|what|when|where|who|which|whose|is|are|was|were|does|do|did|can|could|should|will|would|it|its|that|this|these|those|them|they|he|she|more|else|then|so|ok|okay|yes|no)\b/i.test(next)) return q;
  const old = entityOf(last) || tickersOf(last)[0] || '';
  if (!old || !last.includes(old)) return q;
  return last.replace(old, next);
}

/** Ticker symbols written in the question: "NVDA", "$AAPL", "BRK.B". */
export function tickersOf(query) {
  const out = [];
  for (const m of String(query || '').matchAll(/(?:^|[\s,(])\$?([A-Z]{1,5}(?:\.[A-Z])?)(?=$|[\s,.?!)])/g)) {
    if (!/^(?:I|A|AI|US|USA|UK|EU|CEO|IPO|ETF|GDP|CPI|FX|OK|PM|AM|TV|API|SEO|CRM|NBA|NFL|EV|VS)$/.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Free mode's quick answer: the one sentence across the useful results that
 * best answers the question, quoted as written with its source. Extractive
 * only (no generation), so it can't invent anything. Null when nothing fits.
 * @param {{text: string, score: number, serverTitle: string, view?: object}[]} results
 */
/** True when some 16-character stretch of the text appears again later in it. */
function repeatsItself(s) {
  for (let i = 0; i + 32 <= s.length; i += 4) if (s.indexOf(s.slice(i, i + 16), i + 16) !== -1) return true;
  return false;
}

// Years and calendar dates ("1950 - 2026", "July 1", "1 July") aren't the value asked for.
// (a bare year only when it reads as one: not "2048 characters" or "1900 km")
const DATE_BITS = /\b(?:1[89]|20)\d\d\b(?!\s*(?:%|°|(?:km|kg|mb|gb|tb|mi|ft|m|characters?|chars?|words?|people|residents|inhabitants|units?|items?|meters?|metres?|miles?|feet|calories|tokens?|employees|users)\b))|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function quickAnswer(results, query) {
  // (CJK words are two-character pieces: keep them.)
  const q = [...new Set(tokenize(query))].filter((w) => w.length >= 3 || CJK.test(w));
  if (!q.length) return null;
  const qNorm = String(query).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const wantsNumber =
    /\b(?:how (?:many|much|long|old|far|big|tall|fast)|max(?:imum)?|min(?:imum)?|limit|population|price|cost|rate|exchange|convert|when|what year|age|size|timeout|temperature)\b/i.test(query) ||
    // Other languages: population, price, how much / how many
    /人口|価格|値段|いくら|何人|인구|가격|얼마|몇|población|poblacion|população|precio|preço|cuánto|cuántos|quanto|bevölkerung|einwohner|preis|wie viele?|combien|prix|habitants/i.test(query);
  // Only questions with one factual answer get a quick answer; broad topics
  // ("top stocks", "things to do in Kyoto") are better served by the digest.
  const factual =
    wantsNumber ||
    /^(?:what|who|whom|when|where|which|why|is|are|was|were|does|do|did|can|could|should|how (?:do|does|did|to|can|is|are))\b/i.test(String(query).trim()) ||
    /\b(?:capital of|meaning of|definition of|difference between|vs\.?|versus)\b/i.test(query) ||
    /首都|とは|誰|いつ|どこ|수도|누구|언제|어디|무엇|^(?:qué|que|quién|quien|cuándo|cuando|dónde|donde|cuál|cual|qui|quand|où|quel|quelle|wer|wann|wo|was|welche[rs]?)\b|capital de|hauptstadt/i.test(String(query).trim());
  // Opinions, roundups and explainers are better read as results than as one quote.
  if (!factual || /\b(?:people (?:are )?saying|opinions?|thoughts on|reviews?|explained|ideas|tips|recommend\w*|best\b|top\b)/i.test(query)) return null;
  // News roundups ("what happened in tech news yesterday") are a list of headlines, not one quote.
  if (/\b(?:news|headlines?|what happened)\b/i.test(query)) return null;
  // 1. Candidate sentences, each with its page and heading (context).
  const cands = [];
  for (const r of results) {
    // The whole body of each search result (not the shortened snippet), else item text.
    const full = resultBlocks(r.text);
    const blocks = full.length
      ? full.map((it) => ({ text: it.text, url: it.url, site: it.site, title: it.title }))
      : r.view?.kind === 'items'
        ? r.view.items.map((it) => ({ text: it.text, url: it.url, site: it.site, title: it.title }))
        : [{ text: r.text, url: null, site: '', title: '' }];
    for (const b of blocks.slice(0, 8)) {
      const titleWords = new Set(tokenize(b.title || ''));
      // A title that is itself a full statement ("Nvidia (NVDA) traded at $219.49 on Oct 21") counts too.
      const titleLine = wantsNumber && /\d/.test(b.title || '') && String(b.title).length >= 40 && String(b.title).length <= 220 ? [String(b.title)] : [];
      // Sentence ends: ". " before a capital, a digit or non-Latin text; or 。！？ (no space in CJK).
      for (let raw of [...titleLine, ...String(b.text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"“(¿¡]|[^\p{Script=Latin}\s\p{P}])|(?<=[。！？])/u)]) {
        // Headings glued to the sentence: "Where is Canberra Canberra is …" → "Canberra is …".
        // Pronunciation asides ("( / ˈkænbrə / ⓘ KAN-brə )") go.
        // Site navigation glued to the front ("Students Britannica Kids Homework Help The capital of …").
        raw = raw.replace(/^(?:[\p{Lu}][\p{L}'’&-]*\s+){4,}(?=(?:The|A|An|It|In|This|There|Its)\s+\p{Ll})/u, '');
        const s = raw.replace(/\s*\([^()]{0,120}(?:ⓘ|ˈ|ˌ|\/[^/()]{1,40}\/)[^()]{0,120}\)/g, '').trim().replace(/^[#>*\-\s]+/, '').replace(/^(?:where|what|who|when|how|why)\s+(?:is|are|was|were|did|does)\s+([\p{Lu}][\p{L}'’-]+)\s+(?=\1\b)/iu, '');
        const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
        if (s.length < (cjk ? 12 : 30) || s.length > 260) continue;
        // The same phrase twice in one "sentence" is a page header, not prose.
        if (repeatsItself(s)) continue;
        if (/[{}[\]<>|]|https?:\/\//.test(s)) continue; // markup, tables, links
        if (/\?\s*$/.test(s) || /^\(/.test(s)) continue; // a question, or an aside
        if (/\?\s+[-–|]\s+\S/.test(s)) continue; // a question's page title ("… per invocation? - Stack Overflow")
        if (/\)\s*$/.test(s) && !/[.!]/.test(s)) continue; // a label, not a sentence ("US football team season (won Super Bowl)")
        if (/\s(?:\.\.\.|…)\s/.test(s)) continue; // snippets stitched together with "…"
        // A list whose line breaks were lost ("are: Alternate-day fasting Eat a normal diet …").
        if (/:\s/.test(s) && /\b[a-z]{3,}\s+(?:Eat|Do|Use|Try|Make|Take|Avoid|Get|Keep|Stop|Start|Add|Choose|Limit|Drink|Go|Have|Set|Skip|Plan)\s+[a-z]/.test(s)) continue;
        // A population question in Japanese, Chinese or Korean needs a head count (…万人, …명).
        if (/人口|인구/.test(query) && !/\d[\d,.]*\s*(?:万|億|千|만|억|천)?\s*(?:人|명)/.test(s)) continue;
        // A crypto "tokenized" copy of a stock, or a market cap / volume, is not the price asked for.
        if (/tokeni[sz]ed|\bxstocks?\b/i.test(s) && !/token|crypto|chain/i.test(query)) continue;
        if (NO_RESULT.some((re) => re.test(s))) continue; // "no results for …"
        if ((s.match(/\b[\w ]{1,24}:\s/g) || []).length >= 2) continue; // key: value metadata
        if (/\b\d{1,2}\.$/.test(s) || /^[A-Z][\w ]{0,30}:\s/.test(s)) continue; // list fragments, labels
        if (/^(?:find|enter|click|sign up|subscribe|discover|explore|book|compare|search|browse|get|check out|shop|verify|ensure|make sure|learn|see|read|follow|try|use|note|example \d+)\b/i.test(s)) continue; // calls to action, instructions
        // An article's warm-up, not an answer ("When you are working with …, you might encounter …",
        // "In this article we'll look at …", "Let's dive in").
        if (/\byou (?:might|may|will|could|often) (?:encounter|come across|run into|find yourself|need to|want to)\b|\bin this (?:article|post|tutorial|guide|blog|video)\b|\blet'?s (?:take a look|explore|dive|look at|see how)\b|\b(?:we|I)(?:'ll| will) (?:show|explore|look at|walk you|cover|discuss)\b|^(?:have you ever|ever wondered|are you looking)\b/i.test(s)) continue;
        // "Who won the last Super Bowl": the sentence has to be about a recent one (a recent
        // year, or "reigning"/"defending"), not a general fact ("20 franchises have won").
        if (/^who\b/i.test(query) && /\b(?:last|latest|most recent|current|reigning|this year'?s?)\b/i.test(query)) {
          const y = new Date().getFullYear();
          const years = (s.match(/\b(?:19|20)\d\d\b/g) || []).map(Number);
          if (!years.some((n) => n >= y - 1) && !/\b(?:reigning|defending|current) (?:champion|title|winner)/i.test(s)) continue;
        }
        // An age question needs an age or a birth date, not any number in a biography.
        if (/\bhow old\b|\bage\b/i.test(query) && !/\bborn\b|\(age \d|\baged? \d|\d+[- ]years?[- ]old|\bage(?: of|:)? \d|\bturn(?:s|ed)? \d/i.test(s)) continue;
        // A number question needs a value, not just years ("1950 - 2026") or dates.
        if (wantsNumber && !/\d/.test(s.replace(DATE_BITS, ''))) continue;
        // A price question needs an amount of money, not a percentage.
        if (/\b(?:price|cost|fare|fee)s?\b/i.test(query) && !/[$€£¥₹]\s?\d|\d[\d,.]*\s?(?:USD|EUR|GBP|JPY|INR|dollars?|euros?|pounds?|yen)\b/i.test(s)) continue;
        const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (norm === qNorm || norm.length < qNorm.length + 12) continue; // the question itself
        cands.push({ s, own: new Set(tokenize(s)), titleWords, b, r });
      }
    }
  }
  if (!cands.length) return null;
  const entity = entityOf(query).toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const isPrice = /\b(?:price|prices|cost|quote|trading at|share price|stock price|exchange rate|rate|worth|value of)\b/i.test(query) || /\b(?:USD|EUR|GBP|JPY|INR|CNY|CAD|AUD|CHF|HKD|SGD|KRW|BRL|MXN|SEK|NOK|DKK|NZD|ZAR|RUB|TRY|THB|IDR|PHP|PLN|AED|SAR|BTC|ETH)\b.*\b(?:to|in)\s+(?:USD|EUR|GBP|JPY|INR|CNY|CAD|AUD|CHF|HKD|SGD|KRW|BRL|MXN|SEK|NOK|DKK|NZD|ZAR|RUB|TRY|THB|IDR|PHP|PLN|AED|SAR|BTC|ETH)\b/.test(query);
  // 2. Rarer question words count more ("maximum" over "lambda" when every result says Lambda).
  const weight = Object.fromEntries(q.map((t) => [t, Math.log(1 + cands.length / (1 + cands.filter((c) => c.own.has(t)).length))]));
  const total = q.reduce((a, t) => a + weight[t], 0) || 1;
  const cover = (has) => q.filter(has).reduce((a, t) => a + weight[t], 0) / total;
  // 3. Score: the sentence and its heading cover the question; the sentence itself states it.
  const scored = [];
  for (const c of cands) {
    const ctx = q.filter((t) => c.own.has(t) || c.titleWords.has(t)).length / q.length;
    if (ctx < 0.6) continue;
    const own = cover((t) => c.own.has(t));
    if (own <= 0) continue;
    const fact = /\d/.test(c.s) || /\b[A-Z][a-z]{2,}/.test(c.s.slice(1)) ? 1 : 0;
    const number = /\d/.test(c.s) ? 1 : 0;
    const len = c.s.length;
    const lengthCost = len < 50 ? (50 - len) / 100 : len > 180 ? (len - 180) / 80 : 0;
    // Names what was asked about ("Nvidia"), states a value ("is $219", "traded at"),
    // and doesn't juggle several amounts at once.
    const named = entity.length && entity.every((w) => c.s.toLowerCase().includes(w)) ? 2.5 : 0;
    const states = wantsNumber && /\b(?:is|was|are|were|traded at|trading at|trades at|stands? at|stood at|at|equals?|=)\s*(?:about|around|approximately|roughly|nearly|over|under)?\s*[$€£¥₹]?\s?\d/i.test(c.s) ? 2 : 0;
    const amounts = (c.s.match(/[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*\s?%/g) || []).length;
    const juggling = amounts >= 3 ? 2 : 0;
    // A crypto "tokenized" copy of a stock is not the stock.
    // Asked for the price now: highs, ranges, targets and forecasts are other numbers.
    if (isPrice && /\b(?:all-time|ath|record high|52-week|range|target|forecast|predict\w*|could (?:reach|hit)|by 20\d\d|unlock|market cap\w*|volume)\b/i.test(c.s)) continue;
    const notNow = 0;
    // "He went on to…" quoted alone loses who "he" is.
    const pronoun = /^(?:[^,]{0,25},\s*)?(?:he|she|it|they|this|that|these|those|his|her|its|their|you|you['’](?:ll|re|ve)|we|we['’](?:re|ve|ll)|our|i)\b/i.test(c.s) ? 3 : 0;
    const tokenized = /tokeni[sz]ed|\bxstock|\bon-?chain\b/i.test(c.s) && !/token|crypto|chain/i.test(query) ? 4 : 0;
    const score = ctx * 3 + own * 5 + fact * 2 + (wantsNumber && number ? 3 : 0) + named + states - juggling - tokenized - notNow - pronoun + (c.r.score || 0) / 10 - lengthCost;
    scored.push({ score, c });
  }
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  if (!best || best.score < 5) return null;
  // 4. Numbers need a second opinion: when several sources state an amount, the
  // quoted one must agree (within 15%) with at least one other source, else none.
  if (isPrice) {
    // The amount a sentence states: the first money/currency amount that isn't the "1" of "1 USD = …".
    const valueOf = (x) => {
      const amounts = (re) => [...x.c.s.matchAll(re)].map((m) => Number(String(m[1]).replace(/,/g, ''))).filter((v) => Number.isFinite(v) && v > 0 && v !== 1);
      // Amounts with a currency symbol first, then ones followed by a currency code or name.
      // ("$1.46T", "$142M" are sizes, not prices)
      const nums = [...amounts(/[$€£¥₹]\s?(\d[\d,]*(?:\.\d+)?)(?!\s?(?:[TBMK]\b|trillion|billion|million|thousand))/g), ...amounts(/(\d[\d,]*(?:\.\d+)?)\s?(?:(?:USD|EUR|GBP|JPY|INR|CNY|CAD|AUD|CHF|HKD|SGD|KRW|BRL|MXN|SEK|NOK|DKK|NZD|ZAR|RUB|TRY|THB|IDR|PHP|PLN|AED|SAR|BTC|ETH)\b|dollars?|euros?|yen|pounds?|rupees?)/g)];
      if (nums.length) return nums[0];
      const m = /(\d[\d,]*(?:\.\d+)?)/.exec(x.c.s);
      const v = m && Number(m[1].replace(/,/g, ''));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const siteOf = (c) => c.b.site || c.b.url || c.r.serverTitle;
    const top = scored.filter((x) => x.score >= 5).slice(0, 8).map((x) => ({ ...x, v: valueOf(x), site: siteOf(x.c) }));
    // Second opinions: any sentence on the topic that states an amount, however it's worded.
    const pool = cands
      .filter((c) => q.some((t) => c.own.has(t)) && !/\b(?:all-time|ath|record high|52-week|range|target|forecast|market cap\w*|volume)\b/i.test(c.s))
      .map((c) => ({ c, v: valueOf({ c }), site: siteOf(c) }))
      .filter((x) => x.v != null);
    const agrees = (x) => x.v != null && pool.some((y) => y.site !== x.site && Math.abs(y.v - x.v) / Math.max(y.v, x.v) <= 0.15);
    // Prices go stale and pages disagree: quote one only when another site agrees on it.
    const ok = top.filter(agrees);
    if (!ok.length) return null;
    best = ok[0];
  }
  const { c } = best;
  return { text: c.s, url: c.b.url || null, site: c.b.site || '', title: c.b.title || '', server: c.r.serverTitle };
}

const WANTS_NEW = /\b(?:latest|newest|recent(?:ly)?|new|today|this (?:week|month|year)|upcoming|current)\b/i;

/**
 * Order a list reply for reading: items about the question first (their
 * original order kept), off-topic ones after; newest first when the question
 * asks for the latest and most items carry a date. Returns a new view.
 */
// ---------- official sources ----------

// Governments, intergovernmental bodies, standards bodies and primary registries.
const OFFICIAL = /(?:^|\.)(?:gov|mil|gouv\.fr|gc\.ca|canada\.ca|gov\.uk|gov\.au|govt\.nz|gov\.in|gov\.sg|go\.jp|go\.kr|gob\.mx|gov\.br|bund\.de|admin\.ch|europa\.eu|who\.int|un\.org|unesco\.org|worldbank\.org|imf\.org|oecd\.org|wto\.org|ietf\.org|w3\.org|iso\.org|cve\.org|nist\.gov|ecb\.europa\.eu|federalreserve\.gov|bankofengland\.co\.uk|nhs\.uk|parliament\.uk|legislation\.gov\.uk|congress\.gov|supremecourt\.gov|courts\.gov)$/;
// Registries of record for papers and code.
const PRIMARY = /(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|clinicaltrials\.gov|doi\.org|arxiv\.org|nature\.com|science\.org|thelancet\.com|nejm\.org|bmj\.com|cochranelibrary\.com|sec\.gov|npmjs\.com|pypi\.org|crates\.io)$/;

/**
 * What kind of source a link is: 'official' (a government or international body),
 * 'primary' (a registry of record: PubMed, SEC filings, DOI, arXiv, npm), 'own' (the
 * company's own site, when the question names a company), or null.
 */
export function sourceKind(url, query = '') {
  let h;
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (PRIMARY.test(h)) return 'primary';
  if (OFFICIAL.test(h)) return 'official';
  // "Nvidia …" → nvidia.com is the company's own site.
  const low = String(query).toLowerCase();
  const sld = h.split('.').slice(-2, -1)[0] || '';
  if (sld.length >= 3 && /\.(?:com|co|io|ai|net|org|dev|app)$/.test(h)) {
    for (const name of Object.keys(COMPANY_TICKERS)) if (name.replace(/[^a-z]/g, '') === sld && new RegExp(`\\b${name}\\b`).test(low)) return 'own';
  }
  return null;
}

export function orderItems(view, query) {
  if (view?.kind !== 'items' || view.items.length < 2) {
    if (view?.kind === 'items') for (const it of view.items) if (it.url && sourceKind(it.url, query)) it.kind = sourceKind(it.url, query);
    return view;
  }
  // The same page twice (same link, or same site saying the same thing) shows once.
  const seen = new Set();
  const items = view.items.filter((it) => {
    const keys = [it.url && it.url.replace(/#.*$/, '').replace(/([?&])(?:utm_[a-z]+|ref|fbclid|gclid)=[^&]*/gi, '$1').replace(/[?&]+$/, '').replace(/\/$/, ''), it.site && it.text ? `${it.site}|${it.text.slice(0, 80)}` : null].filter(Boolean);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
  view = { ...view, items };
  const scored = view.items.map((it, i) => {
    const r = relevance(`${it.title} ${it.text} ${(it.facts || []).map((f) => f.value).join(' ')}`, query);
    return { it, i, on: r == null || r > 0.2 };
  });
  const dated = view.items.filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.date || '')).length;
  const when = timeFocus(query);
  for (const x of scored) x.when = when ? Number(when(x.it)) : 0;
  // Pages in the question's own language and script first: an English question gets
  // English pages before a Chinese or Turkish one (they stay, lower down).
  const lang = langOf(String(query));
  for (const x of scored) x.lang = !lang || langOf(`${x.it.title} ${x.it.text || ''}`.slice(0, 300)) === lang ? 1 : 0;
  // Official and primary sources first among the on-topic ones (shown with a label).
  for (const x of scored) {
    const k = x.it.url ? sourceKind(x.it.url, query) : null;
    if (k) x.it.kind = k;
    x.off = k ? 1 : 0;
  }
  const byDate = WANTS_NEW.test(String(query)) && dated >= view.items.length / 2;
  scored.sort((a, b) => (b.on - a.on) || (b.lang - a.lang) || (b.when - a.when) || (byDate ? 0 : b.off - a.off) || (byDate ? String(b.it.date || '').localeCompare(String(a.it.date || '')) : 0) || a.i - b.i);
  return { ...view, items: scored.map((x) => x.it), offTopicItems: scored.filter((x) => !x.on).length };
}

const SCRIPTS = [
  ['han', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['hangul', /\p{Script=Hangul}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['devanagari', /\p{Script=Devanagari}/gu],
  ['greek', /\p{Script=Greek}/gu],
  ['hebrew', /\p{Script=Hebrew}/gu],
  ['thai', /\p{Script=Thai}/gu],
];
/**
 * A rough language key for ordering: the main non-Latin script, 'en' for plain
 * ASCII Latin text, 'latin+' for Latin text with many accented letters (Turkish,
 * Vietnamese…). Null when there's too little text to tell.
 */
// (no "in", "an", "on", "a": other languages use them too)
const EN_SMALL = new Set('the and of to is for with are was by at from that its it this be or has have will new how what why who your you can more about after over into than not'.split(' '));
// Small words of German, Spanish, French, Portuguese, Italian and Dutch that English doesn't use.
const FOREIGN_SMALL = new Set('der die das und mit auf bei ist sind von zu im den des dem nicht ein eine einen auch nach wie el la los las del y que por para con una les et est du au le pour dans sur sont pas os em com uma nao não il di che per della dei degli het een van voor niet ook zijn'.split(' '));
export function langOf(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 4) return null;
  for (const [name, re] of SCRIPTS) if ((text.match(re) || []).length / letters > 0.2) return name;
  const accented = (text.match(/[\p{Script=Latin}]/gu) || []).filter((c) => c.charCodeAt(0) > 127).length;
  if (accented / letters > 0.04) return 'latin+';
  // Latin text with none of English's small words is another language ("Nvidia despliega miles de millones en Europa").
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const en = words.filter((w) => EN_SMALL.has(w)).length;
  const foreign = words.filter((w) => FOREIGN_SMALL.has(w)).length;
  if (words.length >= 6 && en < (words.length >= 14 ? 2 : 1) && foreign >= 1 && foreign > en) return 'latin+';
  return 'en';
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * For questions about a time ("this weekend", "tomorrow", "tonight", "on
 * Friday"): a test for list items about that time, by their title or date.
 * Null when the question names no time.
 */
export function timeFocus(query, now = new Date()) {
  const q = String(query).toLowerCase();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + n));
    return { iso: iso(d), day: DAYS[d.getUTCDay()] };
  };
  let days = null;
  let words = [];
  if (/\bweekend\b/.test(q)) {
    const toSat = (6 - now.getDay() + 7) % 7;
    days = [plus(toSat), plus(toSat + 1)];
    words = ['saturday', 'sunday', 'weekend'];
  } else if (/\btomorrow\b/.test(q)) {
    days = [plus(1)];
    words = [days[0].day];
  } else if (/\btonight\b/.test(q)) {
    days = [plus(0)];
    words = ['tonight'];
  } else {
    const d = DAYS.find((x) => new RegExp(`\\b${x}\\b`).test(q));
    if (!d) return null;
    words = [d];
  }
  const isos = new Set((days || []).map((d) => d.iso));
  return (it) => {
    const title = String(it.title || '').toLowerCase();
    if (words.some((w) => title.includes(w))) return true;
    if (!isos.has(it.date)) return false;
    // Dated on an asked day: counts unless its title names a different day.
    const named = DAYS.find((d) => title.includes(d));
    return !named || words.includes(named);
  };
}

const WEATHER_Q = /\b(?:weather|forecast(?! for (?:sales|revenue|demand))|rain(?:ing|y)?|snow(?:ing)?|temperature|sunny|cloudy|wind(?:y)?|umbrella|cold|hot|warm|tiempo|clima|pronóstico|météo|wetter|meteo|previsão)\b|天気|天気予報|날씨|일기예보|天气/i;
const TEMP_FACT = /^(?:temp(?:erature)?|high|low|max(?:imum)?|min(?:imum)?)(?:\s|$)/i;

/**
 * Weather questions: the first one or two forecast periods (already ordered
 * to the asked days) from a specialist, quoted as written. Null otherwise.
 */
export function forecastAnswer(results, query) {
  if (!WEATHER_Q.test(String(query))) return null;
  const best = results
    .filter((r) => !r.general && r.view?.kind === 'items' && !wrongPlace(query, r.text))
    .filter((r) => r.view.items.slice(0, 3).every((it) => it.title && it.text && it.facts?.some((f) => TEMP_FACT.test(f.label))))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (!best) return plainWeatherAnswer(results, query);
  const items = best.view.items;
  // The asked days ("this weekend" → Saturday and Sunday), else the next day or so.
  const when = timeFocus(query);
  let picked = when ? items.filter(when) : [];
  if (!picked.length) picked = items.slice(0, 2).filter((it) => it.date === items[0].date);
  // Daytime periods carry the summary; nights only when nothing else was asked.
  const days = picked.filter((it) => !/\bnight\b/i.test(it.title));
  if (days.length && picked.length > 2) picked = days;
  // "high near 55" → "high near 55°F", using the period's own temperature fact.
  const withUnit = (it) => {
    const t = (it.facts || []).find((f) => TEMP_FACT.test(f.label));
    const m = t && /^(-?\d+)\s*°\s*([FC])$/i.exec(String(t.value).trim());
    return m ? it.text.replace(new RegExp(`\\b${m[1]}\\b(?!\\s*°)`), `${m[1]}°${m[2].toUpperCase()}`) : it.text;
  };
  const text = picked
    .slice(0, 3)
    .map((it) => `${it.title}: ${withUnit(it)}`)
    .join(' ');
  // Name the place the forecast is for ("Paris, TX"), so a wrong-city match is visible.
  const place = forecastPlace(best.text);
  return { text: place ? `${place}: ${text}` : text, url: null, site: '', title: '', server: best.serverTitle };
}

/**
 * "sunrise in Paris tomorrow", "when is sunset in Tokyo": the times from a forecast
 * reply's own sunrise/sunset fields, in the place's local time. Null otherwise.
 */
export function sunAnswer(results, query) {
  const q = String(query || '');
  const want = /\bsunrise\b/i.test(q) ? (/\bsunset\b/i.test(q) ? 'both' : 'sunrise') : /\bsunset\b/i.test(q) ? 'sunset' : null;
  if (!want) return null;
  for (const r of results) {
    if (r.general || wrongPlace(query, r.text)) continue;
    const raw = String(r.text || '');
    // The first day the reply lists ("daily": [{ "date", "sunrise", "sunset" }]), else any pair.
    const rise = /"sunrise"\s*:\s*"(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
    const set = /"sunset"\s*:\s*"(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
    if (!rise && !set) continue;
    const clock = (m) => {
      const h = Number(m[2]);
      return `${((h + 11) % 12) + 1}:${m[3]} ${h < 12 ? 'AM' : 'PM'}`;
    };
    const day = (m) => new Date(`${m[1]}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const parts = [];
    if ((want === 'sunrise' || want === 'both') && rise) parts.push(`sunrise ${clock(rise)}`);
    if ((want === 'sunset' || want === 'both') && set) parts.push(`sunset ${clock(set)}`);
    if (!parts.length) continue;
    const place = forecastPlace(raw) || (/^Using ([^(.]+?)\s*(?:\(|\.)/.exec((/"answer"\s*:\s*"([^"]{0,300})/.exec(raw) || [])[1] || '') || [])[1];
    const text = `${place ? `${place.trim()}, ` : ''}${day(rise || set)}: ${parts.join(', ')} (local time)`;
    return { text: text.charAt(0).toUpperCase() + text.slice(1), url: null, site: '', title: '', server: r.serverTitle };
  }
  return null;
}

/** The place a forecast reply says it covers ("location": "Seattle, WA"). */
function forecastPlace(text) {
  const m = /"(?:location|place|city|area)"\s*:\s*"([^"]{2,60})"/.exec(String(text || '').slice(0, 2000));
  return m ? m[1] : null;
}

// ---------- calculated answers ----------

// Linear units by kind, in a base unit; temperature handled separately.
const UNITS = {
  length: { m: 1, meter: 1, metre: 1, km: 1000, kilometer: 1000, kilometre: 1000, cm: 0.01, centimeter: 0.01, mm: 0.001, millimeter: 0.001, mi: 1609.344, mile: 1609.344, yd: 0.9144, yard: 0.9144, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, nmi: 1852, 'nautical mile': 1852 },
  mass: { kg: 1, kilogram: 1, g: 0.001, gram: 0.001, mg: 1e-6, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, stone: 6.35029318, st: 6.35029318, ton: 907.18474, tonne: 1000 },
  volume: { l: 1, liter: 1, litre: 1, ml: 0.001, milliliter: 0.001, gal: 3.785411784, gallon: 3.785411784, qt: 0.946352946, quart: 0.946352946, pt: 0.473176473, pint: 0.473176473, cup: 0.2365882365, 'fl oz': 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375 },
  speed: { 'km/h': 1, kph: 1, kmh: 1, mph: 1.609344, 'm/s': 3.6, knot: 1.852, knots: 1.852 },
  area: { 'sq m': 1, m2: 1, 'square meter': 1, 'sq ft': 0.09290304, 'square foot': 0.09290304, 'square feet': 0.09290304, acre: 4046.8564224, hectare: 10000, ha: 10000, 'sq km': 1e6, 'sq mi': 2589988.110336 },
};
const TEMP = { c: 'C', celsius: 'C', '°c': 'C', f: 'F', fahrenheit: 'F', '°f': 'F', k: 'K', kelvin: 'K' };

export function unitOf(word) {
  const w = String(word).toLowerCase().replace(/\.$/, '');
  const singular = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
  for (const [kind, table] of Object.entries(UNITS)) {
    if (table[w] != null) return { kind, factor: table[w], name: w };
    if (table[singular] != null) return { kind, factor: table[singular], name: singular };
  }
  if (TEMP[w]) return { kind: 'temp', scale: TEMP[w], name: w };
  return null;
}

function round(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 3 : 4;
  return Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * "convert 5 miles to km", "72 F in C", "how many cups in 2 liters": computed
 * here, exactly, instead of quoted from a page. Null for anything else.
 */
export function convertAnswer(query) {
  const q = String(query || '').toLowerCase().replace(/,/g, '').trim().replace(/\b(?:in|to) (?:a|an|one) /, (m) => m.replace(/(?:a|an|one) $/, '1 '));
  const u = '([a-z°/ ]{1,14}?)';
  // Anchored: one amount, one unit ("5 ft 11 in to cm" and "3-5 km" are left to the results).
  let m = new RegExp(`^(?:(?:what is|what's|convert)\\s+)?(-?\\d+(?:\\.\\d+)?)\\s*${u}\\s+(?:to|in|into|=|as)\\s+${u}\\??$`).exec(q);
  let value, from, to;
  if (m) [value, from, to] = [Number(m[1]), m[2].trim(), m[3].trim()];
  else {
    m = new RegExp(`^how many\\s+${u}\\s+(?:are\\s+)?(?:in|is)\\s+(-?\\d+(?:\\.\\d+)?)\\s*${u}\\??$`).exec(q);
    if (!m) return null;
    [to, value, from] = [m[1].trim(), Number(m[2]), m[3].trim()];
  }
  let a = unitOf(from);
  let b = unitOf(to);
  // "ounces in a cup": ounces next to a volume are fluid ounces.
  const fluid = (x, other) => (x?.kind === 'mass' && /^(?:oz|ounces?)$/.test(x.name) && other?.kind === 'volume' ? { kind: 'volume', factor: UNITS.volume['fl oz'], name: x.name } : x);
  [a, b] = [fluid(a, b), fluid(b, a)];
  if (!a || !b || a.kind !== b.kind || !Number.isFinite(value)) return null;
  let out;
  if (a.kind === 'temp') {
    const c = a.scale === 'C' ? value : a.scale === 'F' ? ((value - 32) * 5) / 9 : value - 273.15;
    out = b.scale === 'C' ? c : b.scale === 'F' ? (c * 9) / 5 + 32 : c + 273.15;
  } else out = (value * a.factor) / b.factor;
  // Units as the question wrote them ("5 miles = 8.047 km"); temperatures as °F / °C / K.
  const label = (x, typed) => (x.kind === 'temp' ? (x.scale === 'K' ? 'K' : `°${x.scale}`) : typed);
  return { text: `${round(value)} ${label(a, from)} = ${round(out)} ${label(b, to)}`, url: null, site: '', title: '', server: 'MCP Browser (calculated)' };
}

// ---------- other sources that say the same ----------

/**
 * Other sources among the results that state the quick answer's figures too
 * ("212.21", "8,849 m"): distinct sites for web results, servers otherwise. Only
 * answers with a figure in them are checked; words are too loose to count as agreement.
 */
export function agreeingSources(answer, results) {
  const strip = (t) => String(t || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  let nums = (strip(answer?.text).match(/\d+(?:\.\d+)?/g) || []).filter((n) => n.replace('.', '').length >= 2);
  const notYears = nums.filter((n) => !/^(?:19|20)\d\d$/.test(n));
  if (notYears.length) nums = notYears;
  if (!nums.length) return [];
  // A distinctive figure (3+ digits, like 212.21 or 8849) is enough on its own; small
  // ones ("13° to 21°") only count when every one of them is there.
  const strong = nums.filter((n) => n.replace('.', '').length >= 3);
  const found = (x, n) => new RegExp(`(?:^|[^\\d.])${n.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(x);
  const has = (t) => {
    const x = strip(t);
    return strong.length ? strong.some((n) => found(x, n)) : nums.every((n) => found(x, n));
  };
  const quotedSite = answer.url ? siteOfUrl(answer.url) : '';
  const out = new Map();
  for (const r of results) {
    const items = r.view?.kind === 'items' ? r.view.items : null;
    if (items?.length) {
      for (const it of items) {
        const site = it.site || (it.url ? siteOfUrl(it.url) : '');
        if (!site || site === quotedSite || out.has(site)) continue;
        if (has(`${it.title} ${it.text || ''} ${(it.facts || []).map((f) => f.value).join(' ')}`)) out.set(site, { name: site, url: it.url || null });
      }
    } else if (r.serverTitle !== answer.server && !out.has(r.serverTitle) && has(r.text)) out.set(r.serverTitle, { name: r.serverTitle, url: null });
  }
  return [...out.values()].slice(0, 6);
}
const siteOfUrl = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// ---------- arithmetic and percentages ----------

/** A small arithmetic evaluator (+ − × ÷ ^ and brackets): no eval, numbers only. */
function evalMath(expr) {
  const src = expr.replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  const num = () => {
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new Error('number expected');
    i += m[0].length;
    return Number(m[0]);
  };
  const atom = () => {
    if (peek() === '(') {
      i++;
      const v = sum();
      if (peek() !== ')') throw new Error(') expected');
      i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return -atom();
    }
    return num();
  };
  const pow = () => {
    const b = atom();
    if (peek() === '^') {
      i++;
      return b ** pow();
    }
    return b;
  };
  const prod = () => {
    let v = pow();
    while (peek() === '*' || peek() === '/') v = src[i++] === '*' ? v * pow() : v / pow();
    return v;
  };
  const sum = () => {
    let v = prod();
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + prod() : v - prod();
    return v;
  };
  const v = sum();
  if (i !== src.length) throw new Error('unexpected input');
  return v;
}

/** "what is 18% of 250", "15 percent of 80", "12*7+3", "what's 2^10": worked out exactly. */
export function mathAnswer(query) {
  let q = String(query || '').toLowerCase().trim().replace(/[?=]+\s*$/, '').replace(/^(?:what(?:'s| is)|calculate|compute|how much is|solve)\s+/, '').replace(/,(?=\d{3}\b)/g, '').trim();
  const show = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : Number(v.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 8 }));
  const done = (text) => ({ text, url: null, site: '', title: '', server: 'MCP Browser (calculated)' });
  let m = /^(-?\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s+of\s+(-?\d+(?:\.\d+)?)$/.exec(q);
  if (m) return done(`${m[1]}% of ${show(Number(m[2]))} = ${show((Number(m[1]) * Number(m[2])) / 100)}`);
  m = /^(-?\d+(?:\.\d+)?)\s+(?:is\s+)?what\s+(?:%|percent(?:age)?)\s+of\s+(-?\d+(?:\.\d+)?)$/.exec(q);
  if (m && Number(m[2]) !== 0) return done(`${show(Number(m[1]))} is ${show((Number(m[1]) / Number(m[2])) * 100)}% of ${show(Number(m[2]))}`);
  // Plain arithmetic: at least one operator between numbers, nothing but maths in it.
  q = q.replace(/[×x](?=\s*[\d(.])/g, '*').replace(/÷/g, '/').replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-').replace(/\btimes\b|\bmultiplied by\b/g, '*').replace(/\bdivided by\b/g, '/').replace(/\bto the power of\b/g, '^');
  if (!/^[\d\s.+\-*/^()]+$/.test(q) || !/\d\s*[+\-*/^]\s*[\d(.-]/.test(q)) return null;
  // Phone numbers, dates and ranges look like sums but aren't (1-800-555-0100, 10/22/2026, 2024-2025).
  if (/^\d+(?:[-/.]\d+){2,}$/.test(q) || /^(?:1[89]|20)\d\d-(?:1[89]|20)?\d\d$/.test(q)) return null;
  try {
    const v = evalMath(q);
    if (!Number.isFinite(v)) return null;
    return done(`${q.replace(/\s+/g, ' ').replace(/\s*([+\-*/^])\s*/g, ' $1 ').replace(/\*/g, '×').replace(/\//g, '÷').trim()} = ${show(v)}`);
  } catch {
    return null;
  }
}

// ---------- the time in a place ----------

// Cities whose time zone isn't named after them (the rest come from the time zone list itself).
const CITY_ZONES = {
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', washington: 'America/New_York', 'washington dc': 'America/New_York', miami: 'America/New_York', atlanta: 'America/New_York', philadelphia: 'America/New_York', toronto: 'America/Toronto', montreal: 'America/Toronto',
  'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', seattle: 'America/Los_Angeles', 'san diego': 'America/Los_Angeles', 'san jose': 'America/Los_Angeles', portland: 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles', vancouver: 'America/Vancouver', california: 'America/Los_Angeles',
  chicago: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', austin: 'America/Chicago', texas: 'America/Chicago', denver: 'America/Denver', phoenix: 'America/Phoenix',
  london: 'Europe/London', uk: 'Europe/London', england: 'Europe/London', paris: 'Europe/Paris', france: 'Europe/Paris', berlin: 'Europe/Berlin', germany: 'Europe/Berlin', munich: 'Europe/Berlin', madrid: 'Europe/Madrid', spain: 'Europe/Madrid', barcelona: 'Europe/Madrid', rome: 'Europe/Rome', italy: 'Europe/Rome', milan: 'Europe/Rome', amsterdam: 'Europe/Amsterdam', zurich: 'Europe/Zurich', geneva: 'Europe/Zurich', lisbon: 'Europe/Lisbon', dublin: 'Europe/Dublin', moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul', athens: 'Europe/Athens', stockholm: 'Europe/Stockholm',
  dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', india: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', mumbai: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', chennai: 'Asia/Kolkata', pune: 'Asia/Kolkata', kolkata: 'Asia/Kolkata',
  tokyo: 'Asia/Tokyo', japan: 'Asia/Tokyo', osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo', seoul: 'Asia/Seoul', korea: 'Asia/Seoul', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', china: 'Asia/Shanghai', shenzhen: 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', taipei: 'Asia/Taipei', singapore: 'Asia/Singapore', bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta', manila: 'Asia/Manila',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane', perth: 'Australia/Perth', auckland: 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland', honolulu: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu',
  'sao paulo': 'America/Sao_Paulo', 'são paulo': 'America/Sao_Paulo', brazil: 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo', 'mexico city': 'America/Mexico_City', mexico: 'America/Mexico_City', 'buenos aires': 'America/Argentina/Buenos_Aires', cairo: 'Africa/Cairo', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi', johannesburg: 'Africa/Johannesburg',
  utc: 'UTC', gmt: 'UTC',
};
let zoneNames = null;
export function zoneFor(place) {
  const p = place.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  if (CITY_ZONES[p]) return CITY_ZONES[p];
  if (!zoneNames) {
    zoneNames = new Map();
    try {
      for (const z of Intl.supportedValuesOf('timeZone')) zoneNames.set(z.split('/').pop().replace(/_/g, ' ').toLowerCase(), z);
    } catch {}
  }
  return zoneNames.get(p) || null;
}

/** "time in Tokyo", "what time is it in London": the clock there, now. */
export function timeAnswer(query, now = new Date()) {
  const q = String(query || '').toLowerCase().trim().replace(/[?.!]+$/, '');
  const m = /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:current\s+|local\s+)?time\s+(?:is\s+it\s+)?(?:now\s+)?(?:in|at)\s+(.{2,40})$/.exec(q) || /^what\s+time\s+is\s+it\s+(?:now\s+)?in\s+(.{2,40})$/.exec(q) || /^(.{2,40}?)\s+(?:local\s+)?time(?:\s+now)?$/.exec(q);
  if (!m) return null;
  const place = m[1].replace(/\s+(?:right\s+)?now$/, '').trim();
  const zone = zoneFor(place);
  if (!zone) return null;
  const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...o }).format(now);
  const time = fmt({ hour: 'numeric', minute: '2-digit' });
  const day = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
  const tz = fmt({ timeZoneName: 'short' }).split(' ').pop();
  const name = place.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()).replace(/^(Uk|Utc|Gmt|Nyc|Sf|La)$/i, (x) => x.toUpperCase());
  return { text: `${time} in ${name}, ${day} (${tz})`, url: null, site: '', title: '', server: 'MCP Browser (clock)' };
}

// ---------- days until a date ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const nthWeekday = (y, m, wd, n) => {
  const d = new Date(Date.UTC(y, m, 1));
  const shift = (wd - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m, 1 + shift + 7 * (n - 1)));
};
const lastWeekday = (y, m, wd) => {
  const d = new Date(Date.UTC(y, m + 1, 0));
  return new Date(Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)));
};
// Fixed-date and rule-based US holidays: (year) → date (UTC midnight).
const HOLIDAYS = {
  christmas: (y) => new Date(Date.UTC(y, 11, 25)),
  'christmas day': (y) => new Date(Date.UTC(y, 11, 25)),
  'christmas eve': (y) => new Date(Date.UTC(y, 11, 24)),
  'new year': (y) => new Date(Date.UTC(y + 1, 0, 1)),
  "new year's": (y) => new Date(Date.UTC(y + 1, 0, 1)),
  "new year's day": (y) => new Date(Date.UTC(y + 1, 0, 1)),
  "new year's eve": (y) => new Date(Date.UTC(y, 11, 31)),
  halloween: (y) => new Date(Date.UTC(y, 9, 31)),
  "valentine's day": (y) => new Date(Date.UTC(y, 1, 14)),
  valentines: (y) => new Date(Date.UTC(y, 1, 14)),
  'valentines day': (y) => new Date(Date.UTC(y, 1, 14)),
  'independence day': (y) => new Date(Date.UTC(y, 6, 4)),
  'july 4th': (y) => new Date(Date.UTC(y, 6, 4)),
  'the 4th of july': (y) => new Date(Date.UTC(y, 6, 4)),
  '4th of july': (y) => new Date(Date.UTC(y, 6, 4)),
  thanksgiving: (y) => nthWeekday(y, 10, 4, 4),
  'mother’s day': (y) => nthWeekday(y, 4, 0, 2),
  "mother's day": (y) => nthWeekday(y, 4, 0, 2),
  "father's day": (y) => nthWeekday(y, 5, 0, 3),
  'labor day': (y) => nthWeekday(y, 8, 1, 1),
  'memorial day': (y) => lastWeekday(y, 4, 1),
};
function parseDay(text, today) {
  const t = text.toLowerCase().replace(/[?.!]+$/, '').replace(/^the\s+/, '').trim();
  const y0 = today.getUTCFullYear();
  if (HOLIDAYS[t]) {
    let d = HOLIDAYS[t](y0);
    if (d < today && !/new year/.test(t)) d = HOLIDAYS[t](y0 + 1);
    return { date: d, name: t.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()).replace(/'S\b/g, "'s") };
  }
  // "december 25", "dec 25 2026", "25 december", "2027-03-01"
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), name: null };
  const mi = (w) => MONTHS.findIndex((x) => x.startsWith(w) && w.length >= 3);
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(t) || null;
  let month, day, year;
  if (m && mi(m[1]) >= 0) [month, day, year] = [mi(m[1]), +m[2], m[3] ? +m[3] : null];
  else {
    m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})(?:,?\s+(\d{4}))?$/.exec(t);
    if (m && mi(m[2]) >= 0) [month, day, year] = [mi(m[2]), +m[1], m[3] ? +m[3] : null];
    else return null;
  }
  if (day < 1 || day > 31) return null;
  let d = new Date(Date.UTC(year ?? y0, month, day));
  if (year == null && d < today) d = new Date(Date.UTC(y0 + 1, month, day));
  return { date: d, name: null };
}
/** "how many days until Christmas", "days until march 1", "what day is december 25": counted here. */
export function dateAnswer(query, now = new Date()) {
  const q = String(query || '').toLowerCase().trim().replace(/[?.!]+$/, '');
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const fmt = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const done = (text) => ({ text, url: null, site: '', title: '', server: 'MCP Browser (calendar)' });
  let m = /^(?:how many\s+)?(days|weeks|months)\s+(?:left\s+)?(?:until|till|til|to|before)\s+(.{3,40})$/.exec(q) || /^how long (?:until|till|before)\s+(.{3,40})$/.exec(q);
  if (m) {
    const unit = m.length === 3 ? m[1] : 'days';
    const p = parseDay(m.length === 3 ? m[2] : m[1], today);
    if (!p) return null;
    const days = Math.round((p.date - today) / 864e5);
    if (days < 0) return null;
    const label = p.name ? `${p.name} (${fmt(p.date)})` : fmt(p.date);
    if (days === 0) return done(`${label} is today`);
    const amount = unit === 'weeks' ? `${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? '' : 's'}${days % 7 ? ` and ${days % 7} day${days % 7 === 1 ? '' : 's'}` : ''}` : `${days.toLocaleString('en-US')} day${days === 1 ? '' : 's'}`;
    return done(`${amount} until ${label}`);
  }
  m = /^what day (?:of the week )?(?:is|was|will be)\s+(.{3,40})$/.exec(q);
  if (m) {
    const p = parseDay(m[1], today);
    if (!p) return null;
    return done(`${p.name ? `${p.name} is ` : ''}${fmt(p.date)}`);
  }
  return null;
}

/** Questions answered here without asking any server: conversions, sums, the time somewhere, days until a date. */
export function instantAnswer(query) {
  return convertAnswer(query) || mathAnswer(query) || timeAnswer(query) || dateAnswer(query);
}

// ---------- stock quotes ----------

// Well-known names → tickers, so "Nvidia stock price" can ask a quote tool for NVDA.
export const COMPANY_TICKERS = {
  nvidia: 'NVDA', apple: 'AAPL', microsoft: 'MSFT', amazon: 'AMZN', alphabet: 'GOOGL', google: 'GOOGL', meta: 'META', facebook: 'META',
  tesla: 'TSLA', netflix: 'NFLX', amd: 'AMD', intel: 'INTC', broadcom: 'AVGO', oracle: 'ORCL', salesforce: 'CRM', adobe: 'ADBE',
  ibm: 'IBM', qualcomm: 'QCOM', cisco: 'CSCO', palantir: 'PLTR', coinbase: 'COIN', paypal: 'PYPL', uber: 'UBER', airbnb: 'ABNB',
  shopify: 'SHOP', spotify: 'SPOT', disney: 'DIS', walmart: 'WMT', costco: 'COST', berkshire: 'BRK-B', jpmorgan: 'JPM',
  visa: 'V', mastercard: 'MA', 'coca-cola': 'KO', pepsico: 'PEP', mcdonalds: 'MCD', nike: 'NKE', boeing: 'BA', pfizer: 'PFE',
  'eli lilly': 'LLY', lilly: 'LLY', 'novo nordisk': 'NVO', tsmc: 'TSM', asml: 'ASML', samsung: '005930.KS', toyota: 'TM', micron: 'MU',
};
const PRICE_Q = /\b(?:price|quote|trading at|share price|stock price|how much is|worth)\b/i;

/** The ticker a stock-price question is about ("NVDA", or "Nvidia" → NVDA); null if none. */
export function tickerFor(query) {
  const q = String(query || '');
  if (!PRICE_Q.test(q) || !/\b(?:stock|share|shares|price|quote|trading)\b/i.test(q)) return null;
  const t = tickersOf(q).find((x) => !/^(?:USD|EUR|GBP|JPY|BTC|ETH)$/.test(x));
  if (t) return t;
  // A company name alone ("apple watch price", "price of a US visa") is a product question;
  // it needs stock words to be about the share price.
  if (!/\b(?:stock|stocks|share|shares|ticker|market cap|trading at|quote)\b/i.test(q)) return null;
  const low = q.toLowerCase();
  for (const [name, tick] of Object.entries(COMPANY_TICKERS)) if (new RegExp(`\\b${name}\\b`).test(low)) return tick;
  return null;
}

const PRICE_FACT = /^(?:current price|price|last price|last|regular market price|market price|close|last close|quote)$/i;
const CHANGE_FACT = /(?:^|\b)(?:1d|1 day|day|daily|today|change)(?:\b|_)?.*(?:pct|percent|%)|^change ?%$|^percent change$|: 1 day$|^(?:1 day|day) change$/i;

/**
 * Stock price questions: the price from a market-data server's own quote,
 * quoted as given ("NVIDIA Corporation (NVDA): 216.47 USD, -0.29% today").
 */
export function quoteAnswer(results, query) {
  const ticker = tickerFor(query);
  if (!ticker) return null;
  for (const r of [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (r.general || r.view?.kind !== 'record') continue;
    const facts = r.view.facts || [];
    const get = (re) => facts.find((f) => re.test(f.label))?.value;
    const price = get(PRICE_FACT);
    const tick = get(/^(?:ticker|symbol)$/i);
    if (!price || !/\d/.test(price) || (tick && tick.toUpperCase() !== ticker.replace(/-.*$/, '').toUpperCase() && tick.toUpperCase() !== ticker.toUpperCase())) continue;
    const currency = get(/^currency$/i) || '';
    const change = get(CHANGE_FACT);
    const ext = get(/^(?:extended hours price|pre ?market price|after ?hours price)$/i);
    const name = r.view.title && r.view.title !== tick ? `${r.view.title} (${tick || ticker})` : tick || ticker;
    const ch = change != null ? parseFloat(String(change)) : NaN;
    const pct = Number.isFinite(ch) ? ` (1-day change ${ch > 0 ? '+' : ''}${Math.round(ch * 100) / 100}%)` : '';
    const extNum = ext != null ? parseFloat(String(ext)) : NaN;
    const extra = Number.isFinite(extNum) ? `; extended hours ${Math.round(extNum * 100) / 100}${currency ? ` ${currency}` : ''}` : '';
    return { text: `${name}: ${price}${currency ? ` ${currency}` : ''}${pct}${extra}.`, url: null, site: '', title: '', server: r.serverTitle };
  }
  return null;
}

// Major cities outside the US that share a name with US towns (Paris TX, London KY, …).
const WORLD_CITIES = /\b(?:paris|london|berlin|rome|madrid|lisbon|dublin|amsterdam|vienna|prague|athens|moscow|cairo|delhi|mumbai|tokyo|osaka|beijing|shanghai|seoul|sydney|melbourne|toronto|vancouver|montreal|mexico city|ciudad de m[eé]xico|rio|sao paulo|buenos aires|lima|bogota|santiago|nairobi|lagos|cape town|dubai|istanbul|bangkok|singapore|manila|jakarta|hong kong|taipei|kyoto|barcelona|milan|munich|zurich|geneva|stockholm|oslo|copenhagen|helsinki|warsaw|budapest|brussels|edinburgh|manchester|glasgow|birmingham|cambridge|oxford|perth|auckland|delft|athens|florence|venice|naples|valencia|seville|porto|marseille|lyon|nice|frankfurt|hamburg|cologne)\b|ベルリン|パリ|ロンドン|東京|서울|北京/i;

/**
 * A forecast for a US town ("Paris, TX") when the question names a city
 * abroad (Paris): the wrong place, not an answer.
 */
const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey',
  NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};

export function wrongPlace(query, text) {
  const place = forecastPlace(text);
  const code = (/,\s*([A-Z]{2})$/.exec(place || '') || [])[1];
  // Only a real US state suffix ("Paris, TX"), not "Toronto, ON" or "Berlin, DE".
  if (!code || !US_STATES[code]) return false;
  const q = String(query || '');
  // The question names that state (by code after a comma, or by name), or the US: it's the right place.
  if (new RegExp(`,\\s*${code}\\b|\\b${US_STATES[code]}\\b`, 'i').test(q) || /\b(?:usa|u\.s\.a?\.?|united states)\b/i.test(q)) return false;
  return WORLD_CITIES.test(q);
}

/**
 * A weather server that answers in words ({"answer": "Using London, England …
 * 8° to 11°. Rain from about 11:00 …"}): its first two sentences, quoted.
 */
function plainWeatherAnswer(results, query) {
  for (const r of [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (r.general || wrongPlace(query, r.text)) continue;
    let text = null;
    try {
      const j = JSON.parse(String(r.text || ''));
      text = [j?.answer, j?.summary, j?.forecast_text].find((x) => typeof x === 'string' && x.length >= 20) || null;
    } catch {
      const m = /"(?:answer|summary|forecast_text)"\s*:\s*"((?:[^"\\]|\\.){20,4000})"/.exec(String(r.text || '').slice(0, 8000));
      try {
        text = m ? JSON.parse(`"${m[1]}"`) : null;
      } catch {
        text = null;
      }
    }
    if (!text) continue;
    if (!/°|\b(?:rain|snow|sunny|cloud|wind|showers?|clear|storm|dry|drizzle)/i.test(text)) continue;
    // "Using Paris, Île-de-France Region, France (there are others …). Say the state if …" →
    // "Paris, Île-de-France Region, France: <the weather sentences>".
    // ("03:30 to tomorrow 03:30: mild, dry …" → "mild, dry …": the window is just "the next day")
    const sentences = text.split(/(?<=[.!?])\s+/).map((x) => x.replace(/^\d{1,2}:\d{2}(?:\s*[AP]M)?\s+to\s+(?:tomorrow\s+)?\d{1,2}:\d{2}(?:\s*[AP]M)?:\s*/i, '').replace(/^(?:(?:today|tomorrow)\s+)?midnight to midnight:\s*|^(?:today|tomorrow):\s*/i, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase()));
    const place = (/^Using ([^(.]+?)\s*(?:\(|\.)/.exec(text) || [])[1];
    const body = sentences.filter((x) => !/^Using |^Say |^Tell me|^Add /i.test(x) && !/jacket|coat|layer|\bhat\b|umbrella|shorts|pants|sunscreen|boots|sweater|hoodie|gloves/i.test(x) && /°|\b(?:rain|snow|sunny|cloud|wind|showers?|clear|storm|dry|drizzle|cool|warm|cold|hot|mild)\b/i.test(x)).slice(0, 2).join(' ');
    if (!body) continue;
    // "Dry all day." says nothing about warmth: add the temperatures the reply gives
    // elsewhere ("13° to 21°", or "58° air" right now).
    let extra = '';
    if (!/°/.test(body)) {
      const raw = String(r.text || '').slice(0, 6000);
      const range = /(-?\d{1,3}°)\s*(?:to|–|-)\s*(-?\d{1,3}°)/.exec(raw);
      const now = /(-?\d{1,3}°)\s*air\b/.exec(raw) || /\b(?:temperature|temp|now|currently)\b[^.]{0,20}?(-?\d{1,3}°)/i.exec(raw);
      if (range) extra = ` ${range[1]} to ${range[2]}.`;
      else if (now) extra = ` ${now[1]} now.`;
    }
    const said = `${body}${extra}`;
    return { text: place ? `${place.trim()}: ${said}` : said, url: null, site: '', title: '', server: r.serverTitle };
  }
  return null;
}
