// Small shared helpers: timeouts, text cleanup, tokenizing, logging.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise against a timer. The timer is always cleared. */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zero-width, bidi-override and other invisible characters commonly used to
// hide instructions inside text that a model will read.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
// ANSI escape sequences and C0 controls except tab/newline/carriage return.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip invisible / control characters that can smuggle hidden text. */
export function cleanText(s) {
  if (s == null) return '';
  return String(s).replace(ANSI, '').replace(INVISIBLE, '').replace(CONTROL, '');
}

/** Truncate to max chars, marking the cut. */
export function truncate(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

const STOP = new Set(
  'a an and are as at be by for from has have how i in is it its me my of on or our so that the this to was what when where which who why will with you your can do does get give find show tell about any some please there their them then than into over under via vs'.split(' ')
);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * Lowercase word tokens in any script, stopwords removed, light English plural
 * stemming. Combining marks stay inside words (Hindi, Thai…). Runs of Chinese,
 * Japanese or Korean characters (no spaces between words) become overlapping
 * character pairs; Latin text next to them stays whole ("API" in "APIの使い方").
 */
export function tokenize(s) {
  if (!s) return [];
  const out = [];
  const text = String(s).toLowerCase().normalize('NFKC');
  for (let w of text.replace(CJK_RUN, (run) => ` \u0001${run} `).split(/[^\p{L}\p{M}\p{N}\u0001]+/u)) {
    if (!w) continue;
    if (w.startsWith('\u0001')) {
      const chars = [...w.slice(1)];
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (w.length < 2 || STOP.has(w)) continue;
    if (/^[a-z]+$/.test(w)) {
      if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
      else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    }
    out.push(w);
  }
  return out;
}

/** Split camelCase / snake_case identifiers into words (for tool names). */
export function splitIdentifier(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\/]+/g, ' ')
    .toLowerCase();
}

/** Run async fn over items with bounded concurrency; preserves order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const level = LEVELS[process.env.MCPB_LOG || 'info'] ?? 20;
export const log = {
  debug: (...a) => level <= 10 && console.error('[debug]', ...a),
  info: (...a) => level <= 20 && console.error('[info]', ...a),
  warn: (...a) => level <= 30 && console.error('[warn]', ...a),
  error: (...a) => level <= 40 && console.error('[error]', ...a),
};

export function errMsg(e) {
  if (!e) return 'unknown error';
  const m = e.message || String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

/**
 * Parse JSON that may have been cut off (replies are capped in size) or that
 * has a short text preamble. Closes open strings, arrays and objects at the last
 * complete value. Returns undefined when the text isn't JSON-like.
 */
export function parseJsonLenient(text) {
  let s = String(text || '').trim();
  const start = s.search(/[[{]/);
  if (start < 0 || start > 200) return undefined;
  s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {
    /* repair below */
  }
  const stack = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1; // index after the last complete value inside a container
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) {
        // A complete top-level value followed by trailing text: JSON only when the
        // value is most of the text ("[ ] Buy milk …" is prose, not an empty list).
        const rest = s.length - (i + 1);
        if (rest > Math.max(40, 0.2 * s.length)) return undefined;
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          return undefined;
        }
      }
      lastSafe = i + 1;
    } else if (c === ',' && stack.length) lastSafe = i;
  }
  if (lastSafe < 0) return undefined;
  // Cut at the last complete element and close what's still open.
  const head = s.slice(0, lastSafe).replace(/,\s*$/, '');
  const open = [];
  let str = false;
  let e2 = false;
  for (const c of head) {
    if (str) {
      if (e2) e2 = false;
      else if (c === '\\') e2 = true;
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') str = true;
    else if (c === '{' || c === '[') open.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') open.pop();
  }
  try {
    return JSON.parse(head + open.reverse().join(''));
  } catch {
    return undefined;
  }
}
