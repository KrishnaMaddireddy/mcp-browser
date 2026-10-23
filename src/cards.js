// Answer cards: when a question names one thing (a company, a place, a CVE, a website,
// a piece of software), several specialist servers are asked about it at once and their
// answers make one card, like a knowledge panel built from open servers. Each section
// says which server it came from; nothing is generated.
import { COMPANY_TICKERS, zoneFor, timeAnswer } from './quality.js';
import { detailOf } from './pipelines.js';

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const NAME_OF = Object.fromEntries(Object.entries(COMPANY_TICKERS).map(([n, t]) => [t, n]));
const titleCase = (s) => s.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());

/**
 * What one thing a question is about, if it's only about that: { type, value, title } or null.
 * Kept strict: a card shows only when the question is the thing itself, or the thing plus
 * a word that asks for its card ("Nvidia stock", "Lisbon travel", "is example.com safe").
 */
export function detectEntity(query) {
  const q = String(query || '').trim().replace(/[?!.]+$/, '');
  if (!q || q.length > 80) return null;
  const cve = /\bCVE-\d{4}-\d{4,7}\b/i.exec(q);
  if (cve) return { type: 'cve', value: cve[0].toUpperCase(), title: cve[0].toUpperCase() };
  // A website: "is example.com safe", "example.com down", "check example.com".
  const site = /^(?:is\s+|check\s+|about\s+|site\s+)?((?:[a-z0-9-]+\.)+[a-z]{2,24})(?:\s+(?:safe|legit|legitimate|a scam|scam|down|up|status|trustworthy|real|security|ssl|dns|reviews?|check))?$/i.exec(q);
  if (site && (/\s/.test(q) || /^(?:check|about|site)\b/i.test(q))) return { type: 'website', value: site[1].toLowerCase(), title: site[1].toLowerCase() };
  // Software security: "Apache Struts vulnerabilities", "log4j exploits".
  const sw = /^(.{2,40}?)\s+(?:vulnerabilities|vulnerability|security issues|exploits?|cves?|security advisories)$/i.exec(q);
  if (sw) return { type: 'software', value: sw[1], title: sw[1] };
  // A company: its ticker or name alone, or with "stock" / "shares" / "company".
  const co = /^(?:\$?([A-Z]{1,5})|([A-Za-z][A-Za-z&.' -]{1,30}?))(?:\s+(?:stock|shares|share price|stock price|company|inc|corp))?$/.exec(q);
  if (co) {
    // (a name in lower case alone is a word first: "visa", "apple" — it needs "stock" or a capital)
    const named = co[2] && (/^\p{Lu}/u.test(co[2]) || /\s(?:stock|shares|share price|stock price)$/i.test(q));
    const tick = co[1] && NAME_OF[co[1]] ? co[1] : named ? COMPANY_TICKERS[co[2].toLowerCase().trim()] : null;
    if (tick) return { type: 'company', value: tick, title: titleCase(named ? co[2].trim() : NAME_OF[tick] || tick), ticker: tick };
  }
  // A city: its name alone, or with a travel word.
  const pl = /^([\p{L}][\p{L} .'-]{1,30}?)(?:\s+(?:travel|trip|city|visit|guide|tourism|things to do))?$/u.exec(q);
  if (pl && pl[1].split(/\s+/).length <= 3 && zoneFor(pl[1]) && !/^(?:utc|gmt|uk|india|china|japan|germany|france|spain|italy|mexico|brazil|korea|hawaii|california|texas|england|new zealand)$/i.test(pl[1].trim())) return { type: 'place', value: titleCase(pl[1].trim()), title: titleCase(pl[1].trim()) };
  return null;
}

/** The sections of a card: { key, label, ask, servers } each, asked side by side. */
export function cardSections(e) {
  switch (e.type) {
    case 'company':
      return [
        { key: 'quote', label: 'Share price', ask: `${e.value} stock price today`, servers: ['marketcrew'] },
        { key: 'rating', label: 'Rating', ask: `What's the Market Eyes rating for ${e.value}?`, servers: ['io.github.marketeyeslive/market-eyes-live'] },
        { key: 'about', label: 'About', ask: e.title, servers: ['wikexa'], summary: true },
        { key: 'news', label: 'Latest news', ask: `${e.title} latest news`, servers: ['keenable'], links: 4 },
      ];
    case 'place':
      return [
        { key: 'about', label: 'About', ask: e.value, servers: ['wikexa'], summary: true },
        { key: 'weather', label: 'Weather', ask: `weather in ${e.value}`, servers: ['weather-worldwide'] },
        { key: 'guides', label: 'Travel guides', ask: `Find travel guides about ${e.value}`, servers: ['com.meridiandispatch/travel-guides', 'keenable'], links: 4 },
      ];
    case 'cve':
      return [
        { key: 'severity', label: 'Severity and description', ask: e.value, servers: ['com.cve-security/cve-intelligence'], summary: true },
        { key: 'exploited', label: 'Exploited in the wild?', ask: e.value, servers: ['app.vercel.exploitwatch-kappa/exploitwatch'] },
        { key: 'fixes', label: 'Fixes and advisories', ask: `${e.value} patch fixed version advisory`, servers: ['keenable', 'exa'], links: 4 },
      ];
    case 'website':
      return [
        { key: 'up', label: 'Up right now?', ask: `Is https://${e.value} down right now?`, servers: ['io.ohsnap/mcp'] },
        { key: 'risk', label: 'Risk check', ask: `Is this URL risky: ${e.value}`, servers: ['io.github.insivotron/agent-utility-mcp'] },
        { key: 'tls', label: 'Certificate', ask: `When does the TLS certificate for ${e.value} expire?`, servers: ['io.github.hal-boring-utils/expiry-watch'] },
        { key: 'reputation', label: 'What people say', ask: `is ${e.value} legit or a scam reviews`, servers: ['keenable', 'exa'], links: 4 },
      ];
    case 'software':
      return [
        { key: 'exploited', label: 'Known exploited vulnerabilities', ask: e.value, servers: ['app.vercel.exploitwatch-kappa/exploitwatch'] },
        { key: 'graph', label: 'Vulnerabilities', ask: e.value, servers: ['io.echelongraph/echelongraph-mcp'] },
        { key: 'advisories', label: 'Advisories and patches', ask: `${e.value} security advisory patch latest`, servers: ['keenable', 'exa'], links: 4 },
      ];
    default:
      return [];
  }
}

/** The first sentence or two of a summary, up to ~300 characters. */
function firstSentences(t) {
  const parts = String(t).replace(/\s+/g, ' ').replace(/\s*\([^()]{0,80}\)/g, '').split(/(?<=[.!?])\s+(?=[A-Z])/);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > 300) break;
    out = out ? `${out} ${p}` : p;
  }
  return out || String(t).slice(0, 300);
}
/** Servers' sales lines out of their answers ("Free email alerts …: https://…", "sign up at …"). */
function unpitch(t) {
  return String(t)
    .split(/(?<=[.!?])\s+/)
    .filter((x) => !/(?:sign ?up|subscri(?:be|ption)|free (?:email )?alerts?|to be alerted|monitor it free|upgrade to|pricing|per call|not in this data)/i.test(x))
    .join(' ')
    .trim();
}

const SUBTITLE = { company: 'Company', place: 'City', cve: 'Vulnerability', website: 'Website', software: 'Software security' };

/**
 * Build a card: card_start { type, title, subtitle }, then card_section for each part as
 * it comes in ({ key, label, answer, details, links, servers }), then card_done.
 */
export async function runCard(agent, entity, { emit = () => {}, signal, resolveServers = (ids) => ({ servers: ids }) } = {}) {
  const sections = cardSections(entity);
  emit('card_start', { type: entity.type, title: entity.title, subtitle: SUBTITLE[entity.type] || '', sections: sections.map((s) => ({ key: s.key, label: s.label })) });
  // The time there needs no server.
  if (entity.type === 'place') {
    const t = timeAnswer(`time in ${entity.value}`);
    if (t) emit('card_section', { key: 'time', label: 'Local time', answer: t.text.replace(/ in [^,]+,/, ','), details: [], links: [], servers: ['MCP Browser'] });
  }
  const t0 = Date.now();
  await Promise.all(
    sections.map(async (s) => {
      const servers = [];
      const details = [];
      const links = [];
      const summaries = [];
      let quick = null;
      try {
        const r = await agent.search(s.ask, {
          signal,
          direct: true,
          ...resolveServers(s.servers),
          emit: (type, d) => {
            if (type === 'quick_answer') quick = d;
            if (type !== 'results' || d.isError || (d.kind || 'ok') !== 'ok' || d.offTopic) return;
            servers.push(d.serverTitle);
            const items = (d.view?.kind === 'items' ? d.view.items : []).filter((it) => it?.url && it.title);
            for (const it of items) if (links.length < (s.links || 3) && !links.some((l) => l.url === it.url)) links.push({ title: String(it.title).slice(0, 160), url: it.url, host: hostOf(it.url), date: it.date || '' });
            if (s.summary && items[0]?.text) summaries.push(firstSentences(items[0].text));
            if (!items.length && details.length < 1) {
              const x = detailOf(d.view, d.text);
              if (x) details.push({ server: d.serverTitle, ...x });
            }
          },
        });
        quick ||= r?.quickAnswer || null;
      } catch {
        /* a section that fails is left out */
      }
      let answer = quick?.text || '';
      // "About": the reference page's own opening, with its link.
      if (s.summary && !answer && summaries.length) answer = summaries[0];
      const clean = (d) => {
        if (!d.text) return d;
        const t = firstSentences(unpitch(d.text));
        return { ...d, text: t.length >= 20 && !/^[[{]/.test(t) ? t : d.text.slice(0, 300) };
      };
      const shown = answer ? [] : details.map(clean).filter((d) => d.text || d.facts?.length);
      if (answer || shown.length || links.length) emit('card_section', { key: s.key, label: s.label, answer, details: s.links ? [] : shown, links: s.summary ? links.slice(0, 1) : s.links || !shown.length ? links : [], servers: [...new Set(servers)] });
      else emit('card_section', { key: s.key, label: s.label, empty: true });
    })
  );
  emit('card_done', { ms: Date.now() - t0 });
}
