// "Tell me when …": a sentence becomes a watch. Three kinds:
//   a threshold  — "tell me when NVDA drops below 200": the answer's figure is checked each run;
//   a word       — "tell me when the iPhone 18 is released": stops once results say it;
//   anything new — "tell me about new recalls for Kia Sorento": new sources are the news.
import { tickerFor, tickersOf, COMPANY_TICKERS } from './quality.js';
import { figuresOf } from './crosscheck.js';

const LEAD = /^(?:please\s+)?(?:tell|notify|alert|ping|let)\s+(?:me\s+)?(?:know\s+)?(?:when|if|whenever|once|as soon as|about)\s+|^(?:track|watch|follow|monitor)\s+/i;
const DOWN = /\b(?:drops?|falls?|goes|gets|is|dips?|sinks?|trades?|hits?)?\s*(?:below|under|less than|lower than|beneath|<)\s*\$?\s*([\d,.]+)\s*(k|m|bn|b)?\b/i;
const UP = /\b(?:rises?|climbs?|goes|gets|is|jumps?|trades?|hits?|reaches?|tops?)?\s*(?:above|over|more than|higher than|past|beyond|>)\s*\$?\s*([\d,.]+)\s*(k|m|bn|b)?\b/i;
const EVENT = /\b(?:is|are|gets?|goes)?\s*(released|announced|available|launched|out|in stock|on sale|approved|confirmed|published|open|opens|cancelled|canceled|delayed|recalled)\b/i;
const NEWISH = /^(?:new|any new|the latest|latest)\s+/i;
const SCALE = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };

function amount(m) {
  const v = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(v) ? v * (SCALE[(m[2] || '').toLowerCase()] || 1) : null;
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^(?:the|a|an)\s+/i, '').replace(/[\s,.?!]+$/, '').trim();

/**
 * A proposed watch from a sentence: { kind, query, label, every, when?, until? }, or null
 * when it isn't a "tell me when" sentence.
 */
export function parseTrack(text) {
  const t = String(text || '').trim().replace(/[?!.]+$/, '');
  if (!LEAD.test(t)) return null;
  const rest = t.replace(LEAD, '').trim();
  if (rest.length < 3) return null;
  // A threshold on a price or rate.
  for (const [re, op] of [[DOWN, 'below'], [UP, 'above']]) {
    const m = re.exec(rest);
    if (!m) continue;
    const value = amount(m);
    if (value == null) continue;
    const thing = clean(rest.slice(0, m.index).replace(/\b(?:price|stock|shares?|rate|cost)$/i, '').replace(/\b(?:the price of|price of)\b/i, ''));
    if (!thing) continue;
    const pair = /^([A-Z]{3})\s*(?:to|\/|-|in)\s*([A-Z]{3})$/i.exec(thing);
    if (pair) {
      const [a, b] = [pair[1].toUpperCase(), pair[2].toUpperCase()];
      return { kind: 'threshold', query: `${a} to ${b} exchange rate`, label: `${a}/${b} ${op} ${value.toLocaleString('en-US')}`, every: 'hourly', when: { op, value } };
    }
    const tick = tickersOf(thing).find((x) => !/^(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR|BTC|ETH)$/.test(x)) || COMPANY_TICKERS[thing.toLowerCase()] || tickerFor(`${thing} stock price`);
    const query = tick ? `${tick} stock price today` : `${thing} price today`;
    return { kind: 'threshold', query, label: `${tick || thing} ${op} ${value.toLocaleString('en-US')}`, every: 'hourly', when: { op, value } };
  }
  // Something happening: stop once the results say it.
  const ev = EVENT.exec(rest);
  if (ev && ev.index > 0) {
    const thing = clean(rest.slice(0, ev.index));
    const word = ev[1].toLowerCase();
    const ask = { released: 'release date', out: 'release date', launched: 'launch date', announced: 'announcement', approved: 'approval', available: 'availability', 'in stock': 'in stock', 'on sale': 'on sale' }[word] || word;
    // Pages that only expect it ("is expected to be released") don't count: the words have to say it happened.
    const said = {
      released: '\\b(?:(?:was|has been|is now|got|were|have been)\\s+(?:officially\\s+)?released|released (?:on|today|yesterday|this week)|out now|now available|available now)\\b',
      out: '\\b(?:(?:was|has been|is now|got|were|have been)\\s+(?:officially\\s+)?released|released (?:on|today|yesterday|this week)|out now|now available|available now)\\b',
      announced: '\\b(?:(?:was|has been|were|have been)\\s+(?:officially\\s+)?announced|announced (?:today|yesterday|on))\\b',
      available: '\\b(?:now available|available now|is available|in stock|back in stock)\\b',
      'in stock': '\\b(?:in stock|back in stock|available now)\\b',
      approved: '\\b(?:was|has been|were|got|received)\\s+(?:fda\\s+|full\\s+)?approv(?:ed|al)\\b',
      launched: '\\b(?:(?:was|has been|were|officially)\\s+launched|launched (?:today|yesterday|on))\\b',
    }[word] || `\\b(?:was|has been|is now|were|have been)\\s+${word}\\b`;
    // …and it has to be about this thing ("iPhone 17 was released" isn't iPhone 18): a sentence with its words.
    const about = thing.toLowerCase().match(/[\p{L}\p{N}]+/gu).filter((w) => w.length > 1 || /\d/.test(w)).slice(0, 5);
    return { kind: 'until', query: `${thing} ${ask}`, label: `${thing}: ${word === 'out' ? 'released' : word}`, every: 'daily', until: word === 'out' ? 'released' : word, untilRe: said, untilAbout: about };
  }
  // Anything new about it: new sources are the news.
  const thing = clean(rest.replace(NEWISH, ''));
  return { kind: 'new', query: NEWISH.test(rest) ? `latest ${thing}` : thing, label: `New: ${thing}`, every: 'daily' };
}

/** The figure an answer gives (a price, a rate), for threshold checks; null when there is none. */
export function figureIn(text) {
  const t = String(text || '');
  // "NVIDIA Corporation (NVDA): 212.21 USD": the figure after the colon comes first.
  const after = /\)\s*:\s*([\d,.]+)/.exec(t);
  if (after) return Number(after[1].replace(/,/g, ''));
  const f = figuresOf(t).find((x) => !x.year && x.unit !== '%');
  return f ? f.value : null;
}

/** Is the threshold met? */
export function thresholdMet(when, value) {
  if (!when || value == null || !Number.isFinite(value)) return false;
  return when.op === 'below' ? value < when.value : value > when.value;
}

/** Does the text say it happened (the pattern, in a sentence that names the thing)? Returns that sentence or null. */
export function saysItHappened(text, re, about = []) {
  const pattern = new RegExp(re, 'i');
  for (const raw of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!pattern.test(s)) continue;
    const low = s.toLowerCase();
    if (about.every((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(low))) return s.slice(0, 300);
  }
  return null;
}
