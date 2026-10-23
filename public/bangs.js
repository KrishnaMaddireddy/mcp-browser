// !bangs, as in DuckDuckGo: "!g rust ownership" or "rust ownership !g" goes
// straight to that site's search. Lets MCP Browser be your only search engine:
// anything MCP servers can't answer is one "!g" away. A few go inside the app.
(function () {
  'use strict';
  const e = encodeURIComponent;
  const BANGS = {
    g: ['Google', (q) => `https://www.google.com/search?q=${e(q)}`, 'https://www.google.com/'],
    ddg: ['DuckDuckGo', (q) => `https://duckduckgo.com/?q=${e(q)}`, 'https://duckduckgo.com/'],
    b: ['Bing', (q) => `https://www.bing.com/search?q=${e(q)}`, 'https://www.bing.com/'],
    w: ['Wikipedia', (q) => `https://en.wikipedia.org/w/index.php?search=${e(q)}`, 'https://en.wikipedia.org/'],
    yt: ['YouTube', (q) => `https://www.youtube.com/results?search_query=${e(q)}`, 'https://www.youtube.com/'],
    maps: ['Google Maps', (q) => `https://www.google.com/maps/search/${e(q)}`, 'https://www.google.com/maps'],
    gh: ['GitHub', (q) => `https://github.com/search?q=${e(q)}&type=repositories`, 'https://github.com/'],
    npm: ['npm', (q) => `https://www.npmjs.com/search?q=${e(q)}`, 'https://www.npmjs.com/'],
    pypi: ['PyPI', (q) => `https://pypi.org/search/?q=${e(q)}`, 'https://pypi.org/'],
    so: ['Stack Overflow', (q) => `https://stackoverflow.com/search?q=${e(q)}`, 'https://stackoverflow.com/'],
    mdn: ['MDN', (q) => `https://developer.mozilla.org/en-US/search?q=${e(q)}`, 'https://developer.mozilla.org/'],
    r: ['Reddit', (q) => `https://www.reddit.com/search/?q=${e(q)}`, 'https://www.reddit.com/'],
    hn: ['Hacker News', (q) => `https://hn.algolia.com/?q=${e(q)}`, 'https://news.ycombinator.com/'],
    a: ['Amazon', (q) => `https://www.amazon.com/s?k=${e(q)}`, 'https://www.amazon.com/'],
    imdb: ['IMDb', (q) => `https://www.imdb.com/find/?q=${e(q)}`, 'https://www.imdb.com/'],
    arxiv: ['arXiv', (q) => `https://arxiv.org/search/?query=${e(q)}&searchtype=all`, 'https://arxiv.org/'],
    scholar: ['Google Scholar', (q) => `https://scholar.google.com/scholar?q=${e(q)}`, 'https://scholar.google.com/'],
    news: ['Google News', (q) => `https://news.google.com/search?q=${e(q)}`, 'https://news.google.com/'],
    // Inside MCP Browser
    mcp: ['the MCP server catalog', null, null, (q) => ({ kind: 'catalog', view: 'all', q })],
    sites: ['websites with AI tools', null, null, (q) => ({ kind: 'webmcp', q })],
    stack: ['My MCP stack', null, null, () => ({ kind: 'stack' })],
    check: ['Cross-check', null, null, (q) => ({ kind: 'check', claim: q })],
  };
  /** { name, url } for a site, or { name, entry } for a page in the app; null when there's no bang. */
  function parse(input) {
    const m = /(?:^|\s)!([a-z]{1,8})(?=\s|$)/i.exec(String(input || ''));
    if (!m) return null;
    const b = BANGS[m[1].toLowerCase()];
    if (!b) return null;
    const q = String(input).replace(m[0], ' ').trim();
    if (b[3]) return { name: b[0], entry: b[3](q) };
    return { name: b[0], url: q ? b[1](q) : b[2] };
  }
  /** Where else to look for a query (shown under each question). */
  const elsewhere = (q) => ['g', 'ddg', 'w', 'yt', 'r'].map((k) => ({ key: k, name: BANGS[k][0], url: BANGS[k][1](q) }));
  const list = () => Object.entries(BANGS).map(([k, b]) => ({ key: k, name: b[0] }));
  window.MCPBangs = { parse, elsewhere, list };
})();
