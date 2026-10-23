// "Tell me when …": a sentence becomes a watch. Three kinds:
//   a threshold  — "tell me when NVDA drops below 200": the answer's figure is checked each run;
//   a word       — "tell me when the iPhone 18 is released": stops once results say it;
//   anything new — "tell me about new recalls for Kia Sorento": new sources are the news.
import { tickerFor, tickersOf, COMPANY_TICKERS } from './quality.js';
import { figuresOf } from './crosscheck.js';

const LEAD = /^(?:please\s+)?(?:tell|notify|alert|ping|let)\s+(?:me\s+)?(?:know\s+)?(?:when|whenever|once|as soon as|if)\s+|^(?:please\s+)?(?:tell|notify|alert|ping|let)\s+(?:me\s+)?(?:know\s+)?about\s+(?=(?:new|any new|the latest|latest)\s)|^(?:track|watch|follow|monitor)\s+/i;
const NUMBER = String.raw`\$?\s*([\d,]*\.?\d+)\s*(k|m|bn|b|%|percent)?(?![\p{L}\d])`;
const DOWN = new RegExp(String.raw`\b(?:drops?|falls?|goes|go|gets?|is|are|dips?|sinks?|trades?|hits?|declines?)?\s*(?:below|under|less than|lower than|beneath|<)\s*` + NUMBER, 'iu');
const UP = new RegExp(String.raw`\b(?:rises?|climbs?|goes|go|gets?|is|are|jumps?|trades?|hits?|reaches?|tops?|surges?)?\s*(?:above|over|more than|higher than|past|beyond|>)\s*` + NUMBER, 'iu');
// "hits 300", "reaches $100k": the direction is toward the line from wherever it is now.
const REACH = new RegExp(String.raw`\b(?:hits?|reaches?|touches?|gets? to|goes to|crosses)\s*` + NUMBER, 'iu');
const EVENT = /\b(?:is|are|gets?|goes)?\s*(released|announced|available|launched|out|in stock|on sale|approved|confirmed|published|open|opens|cancelled|canceled|delayed|recalled)\b/i;
const NEWISH = /^(?:new|any new|the latest|latest)\s+/i;
const SCALE = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
// Things with a market price.
const PRICED = /^(?:bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|cardano|litecoin|gold|silver|platinum|copper|oil|crude(?: oil)?|brent(?: crude)?|natural gas|wheat|corn)$/i;

function amount(m) {
  const v = Number(String(m[1]).replace(/,/g, ''));
  const u = (m[2] || '').toLowerCase();
  return Number.isFinite(v) ? v * (SCALE[u] || 1) : null;
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^(?:the|a|an)\s+/i, '').replace(/[\s,.?!]+$/, '').trim();
// (the verb before the line belongs to the sentence, not the thing: "mortgage rates go above 7%")
const VERB_TAIL = /\s+(?:go|goes|gets?|is|are|drops?|falls?|rises?|climbs?|trades?|hits?|reaches?|dips?|sinks?|jumps?|tops?|declines?|surges?)$/i;

/** The words that say it happened, for each kind of "until" (built here, never taken from a client). */
export function saidPattern(word) {
  const released = '\\b(?:(?:was|has been|is now|got|were|have been)\\s+(?:officially\\s+)?released|released (?:on|today|yesterday|this week)|out now|now available|available now)\\b';
  return (
    {
      released,
      out: released,
      announced: '\\b(?:(?:was|has been|were|have been)\\s+(?:officially\\s+)?announced|announced (?:today|yesterday|on))\\b',
      available: '\\b(?:now available|available now|is available|in stock|back in stock)\\b',
      'in stock': '\\b(?:in stock|back in stock|available now)\\b',
      approved: '\\b(?:was|has been|were|got|received)\\s+(?:fda\\s+|full\\s+)?approv(?:ed|al)\\b',
      launched: '\\b(?:(?:was|has been|were|officially)\\s+launched|launched (?:today|yesterday|on))\\b',
      delayed: '\\b(?:was|has been|is|were|have been|got)\\s+(?:officially\\s+)?(?:delayed|postponed|pushed back)\\b',
      open: '\\b(?:(?:is|are|was|has been)\\s+(?:now\\s+)?open(?:ed)?|opened (?:today|yesterday|on|its doors)|now open)\\b',
      opens: '\\b(?:(?:is|are|was|has been)\\s+(?:now\\s+)?open(?:ed)?|opened (?:today|yesterday|on|its doors)|now open)\\b',
    }[word] || (/^[a-z ]{2,20}$/.test(word) ? `\\b(?:was|has been|is now|were|have been)\\s+${word}\\b` : null)
  );
}
export const UNTIL_WORDS = ['released', 'out', 'announced', 'available', 'in stock', 'on sale', 'approved', 'confirmed', 'published', 'open', 'opens', 'cancelled', 'canceled', 'delayed', 'recalled', 'launched'];

/**
 * A proposed watch from a sentence: { kind, query, label, every, when?, until?, note? }, or
 * null when it isn't a "tell me when" sentence. { error } when it is one we can't use.
 */
export function parseTrack(text) {
  const t = String(text || '').trim().replace(/[?!.]+$/, '');
  if (!LEAD.test(t)) return null;
  const rest = t.replace(LEAD, '').trim();
  // "tell me if I need a visa" is a question; "let me know if NVDA drops below 200" is a watch.
  const asIf = /\bif\s*$/i.test(LEAD.exec(t)[0].trim());
  if (rest.length < 3) return null;
  // A threshold on a price or rate.
  for (const [re, op] of [[DOWN, 'below'], [UP, 'above'], [REACH, 'reach']]) {
    const m = re.exec(rest);
    if (!m) continue;
    const value = amount(m);
    if (value == null) continue;
    const pct = /^(?:%|percent)$/i.test(m[2] || '');
    let thing = clean(rest.slice(0, m.index).replace(VERB_TAIL, '').replace(/\b(?:the price of|price of)\b/i, ''));
    thing = clean(thing.replace(VERB_TAIL, ''));
    const base = clean(thing.replace(/\s+(?:price|stock|shares?|cost|prices)$/i, ''));
    if (!base || !/[\p{L}\p{N}]/u.test(base)) continue;
    const show = `${value.toLocaleString('en-US')}${pct ? '%' : ''}`;
    const opWord = op === 'reach' ? 'reaches' : op;
    const pair = /^([A-Z]{3})\s*(?:to|\/|-|in)\s*([A-Z]{3})$/i.exec(base);
    if (pair) {
      const [a, b] = [pair[1].toUpperCase(), pair[2].toUpperCase()];
      return { kind: 'threshold', query: `${a} to ${b} exchange rate`, label: `${a}/${b} ${opWord} ${show}`, every: 'hourly', when: { op, value } };
    }
    const tick = tickersOf(base).find((x) => !/^(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR|BTC|ETH)$/.test(x)) || COMPANY_TICKERS[base.toLowerCase()] || (/\b(?:stock|shares?)$/i.test(thing) ? tickerFor(`${base} stock price`) : null);
    // Only things with a market price get "price today"; anything else is asked as it is
    // ("temperature in London" → the weather there, "mortgage rates" → today's rates).
    const weather = /^(?:temperature|temp|weather)\s+(?:in|at|for)\s+(.+)$/i.exec(base);
    const query = tick ? `${tick} stock price today` : PRICED.test(base) ? `${base} price today` : weather ? `weather in ${weather[1]}` : `${thing} today`;
    return { kind: 'threshold', query, label: `${tick || thing} ${opWord} ${show}`, every: 'hourly', when: { op, value, ...(pct ? { unit: '%' } : {}) } };
  }
  // Something happening: stop once the results say it.
  const ev = EVENT.exec(rest);
  if (ev && ev.index > 0) {
    const thing = clean(rest.slice(0, ev.index));
    const word = ev[1].toLowerCase();
    // …and it has to be about this thing ("iPhone 17 was released" isn't iPhone 18): the words just before the verb.
    const about = (thing.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => (w.length > 1 || /\d/.test(w)) && !/^(?:new|the|game|next|upcoming|latest|a|an|my|of|for)$/.test(w)).slice(0, 5);
    if (!about.length) return { error: 'Name the thing to watch in words, e.g. “tell me when the iPhone 18 is released”.' };
    const ask = { released: 'release date', out: 'release date', launched: 'launch date', announced: 'announcement', approved: 'approval', available: 'availability', 'in stock': 'in stock', 'on sale': 'on sale' }[word] || word;
    return { kind: 'until', query: `${thing} ${ask}`, label: `${thing}: ${word === 'out' ? 'released' : word}`, every: 'daily', until: word === 'out' ? 'released' : word, untilAbout: about };
  }
  // Anything new about it: new sources are the news.
  if (asIf) return null;
  const thing = clean(rest.replace(NEWISH, ''));
  if (!/[\p{L}\p{N}]/u.test(thing)) return { error: 'Name the thing to watch in words.' };
  const note = /\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i.test(rest) ? 'Moves by a percentage aren’t understood yet, so this tells you about new sources instead. Try “drops below” a price.' : /\b(?:hits?|reaches?|drops?|falls?|rises?|goes)\b/i.test(rest) ? 'No price or level was found in that, so this tells you about new sources instead.' : '';
  return { kind: 'new', query: NEWISH.test(rest) ? `latest ${thing}` : thing, label: `New: ${thing}`, every: 'daily', ...(note ? { note } : {}) };
}

/**
 * The figure an answer gives for a watch (a price, a rate), or null when it can't tell.
 * Picks the quoted figure, not the first number: "As of Oct 23, NVDA trades at 212.21 USD"
 * is 212.21, "1 USD = 152.3 JPY" is 152.3, and "Top 10" or "30-year" are never it.
 */
const CUR = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', dollar: 'USD', 'us dollar': 'USD', euro: 'EUR', pound: 'GBP', 'british pound': 'GBP', yen: 'JPY', 'japanese yen': 'JPY', franc: 'CHF', 'swiss franc': 'CHF', rupee: 'INR', yuan: 'CNY' };
const curOf = (x) => {
  const v = String(x || '').trim().toLowerCase().replace(/s$/, '');
  return /^[a-z]{3}$/.test(v) ? v.toUpperCase() : CUR[v] || CUR[String(x || '').trim()] || null;
};
export function figureIn(text, { unit = '', pair = null } = {}) {
  const t = String(text || '');
  // "NVIDIA Corporation (NVDA): 212.21 USD": the figure after the ticker comes first.
  const after = unit !== '%' && /\)\s*:\s*\$?\s*([\d,]+(?:\.\d+)?)/.exec(t);
  if (after) return Number(after[1].replace(/,/g, ''));
  // "1 USD = 152.3 JPY", "$1 = €0.8910", "1 US Dollar equals 152.30 Japanese Yen": the second
  // figure, turned round when it's the other way from the pair asked about.
  const rate = unit !== '%' && /(?:^|[^\d.,])([$€£¥])?\s*1(?:\.0+)?\s*([A-Z]{3}|[A-Za-z][A-Za-z ]{1,20}?)?\s*(?:=|equals|is worth)\s*([$€£¥])?\s*([\d,]*\.?\d+)\s*([A-Z]{3}|[A-Za-z][A-Za-z ]{1,20}?)?(?=[\s.,;)]|$)/.exec(t);
  if (rate) {
    const v = Number(rate[4].replace(/,/g, ''));
    const from = curOf(rate[1] || rate[2]);
    const to = curOf(rate[3] || rate[5]);
    if (pair && from === pair[1] && to === pair[0] && v > 0) return 1 / v;
    return v;
  }
  const MONTH = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;
  const cands = figuresOf(t).filter((f) => {
    if (f.year) return false;
    if ((unit === '%') !== (f.unit === '%')) return false;
    const before = t.slice(Math.max(0, f.at - 12), f.at);
    const next = t.slice(f.end, f.end + 8);
    if (MONTH.test(before) || /(?:top|#|no\.|number|rank(?:ed)?|step|page|chapter|part)\s*$/i.test(before)) return false;
    if (/^\s*[-‑]?\s*(?:year|yr|month|day|week|hour|minute)s?\b/i.test(next) || /^(?:st|nd|rd|th)\b/.test(next)) return false;
    if (/^(?:years?|days?|hours?|minutes?|seconds?|months?)$/.test(f.unit)) return false;
    return true;
  });
  if (!cands.length) return null;
  // A figure with money on it ("$212.21", "212.21 USD", "at 212.21") beats a bare one.
  const money = (f) => /\$\s*$/.test(t.slice(Math.max(0, f.at - 2), f.at)) || /^\s*(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|dollars?|euros?)\b/i.test(t.slice(f.end, f.end + 9)) || /\b(?:at|price|is|trades?|traded|trading|closed|rate|=)\s*\$?\s*$/i.test(t.slice(Math.max(0, f.at - 14), f.at));
  return (cands.find(money) || cands[0]).value;
}

/** Is a new reading believable next to the last one? A page with a stale or wrong figure shouldn't trip a watch. */
export function plausibleReading(value, last) {
  if (value == null || !Number.isFinite(value) || value <= 0) return false;
  if (last == null || !Number.isFinite(last) || last <= 0) return true;
  return value / last <= 1.5 && value / last >= 0.5;
}

/** Is the threshold met? */
export function thresholdMet(when, value) {
  if (!when || value == null || !Number.isFinite(value)) return false;
  return when.op === 'below' ? value < when.value : value > when.value;
}

/**
 * Does the text say it happened? The pattern, in a sentence that names the thing just before
 * it ("GTA 6 is out now"), and not about a trailer, a pre-order or a beta. Returns that
 * sentence or null.
 */
export function saysItHappened(text, re, about = []) {
  const pattern = new RegExp(re, 'i');
  const waitingForDelay = /delay|postpon/.test(re);
  const NOT_YET = new RegExp(`\\b(?:trailer|teaser|pre-?orders?|preorders?|beta|demo|expected|rumou?red|leak(?:ed|s)?|could|might|will|soon|if|when|whether${waitingForDelay ? '' : '|delay(?:ed)?|postponed'})\\b|\\bmay\\s+(?:be|have|come|arrive|launch|release)\\b`, 'i');
  // "is not available", "isn't out yet", "no longer"
  const DENIED = /\b(?:not|n['’]t|never|no longer|yet to)\b/i;
  const word = (w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u');
  for (const raw of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    const m = pattern.exec(s);
    if (!m || NOT_YET.test(s)) continue;
    // the thing's words in the few words before the verb ("GTA 6 is out now"; not "GTA 6 fans: GTA 5 … is out now")
    const leadWords = s.slice(0, m.index).toLowerCase().split(/\s+/).filter(Boolean).slice(-(about.length + 2));
    const lead = leadWords.join(' ');
    if (DENIED.test(lead.split(/\s+/).slice(-3).join(' ')) || DENIED.test(m[0])) continue;
    // the thing itself, not "a case for the iPhone 18" or "the first photo of …"
    const firstAbout = leadWords.findIndex((w) => word(about[0] || '').test(w));
    const pre = s.slice(0, m.index).toLowerCase().split(/\s+/).filter(Boolean);
    const at = pre.length - leadWords.length + Math.max(0, firstAbout);
    if (/^(?:for|of|about|than|from|with|like|to|asked|when)$/.test(pre[at - 1] || '') || /^(?:the\s+)?(?:case|photo|image|render|version|copy|cheaper|leak|teaser|trailer|accessor\w*)$/.test(pre[at - 2] || '')) continue;
    // (another version number right there is another thing: "GTA 5 was released")
    const otherNumber = (lead.match(/\b\d+\b/g) || []).some((n) => !about.includes(n));
    if (!otherNumber && about.every((w) => word(w).test(lead))) return s.slice(0, 300);
  }
  return null;
}
