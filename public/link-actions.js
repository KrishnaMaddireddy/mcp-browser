// "Open with" for links: what MCP servers can do with a URL you paste.
// Each rule matches a URL and offers actions: a prompt (with {url}, {host}, and
// parts captured from the URL) plus catalog search words for the servers to ask.
(function () {
  'use strict';
  const RULES = [
    {
      name: 'YouTube video', test: /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([\w-]{6,})/i,
      actions: [
        { label: 'Transcript', prompt: 'Get the transcript of {url}', q: 'youtube transcript' },
        { label: 'Summarize the video', prompt: 'Summarize this video and list its main points: {url}', q: 'youtube transcript' },
        { label: 'Top comments', prompt: 'What do the top comments on {url} say?'},
      ],
    },
    {
      name: 'GitHub repository', test: /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/?(?:$|[?#]|tree\/|blob\/)/i,
      actions: [
        { label: 'Explain this repo', prompt: 'How does the GitHub repo {1} work: what it does, how it is structured, how to get started?' },
        { label: 'Open issues and activity', prompt: 'List the most active open issues and recent releases in the GitHub repo {1}' },
        { label: 'Security advisories', prompt: 'Are there known security advisories or vulnerable dependencies in {1}?', q: 'cve vulnerability' },
      ],
    },
    {
      name: 'GitHub issue or PR', test: /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i,
      actions: [{ label: 'Summarize the thread', prompt: 'Summarize {url}: the problem, the discussion and where it stands' }],
    },
    {
      name: 'arXiv paper', test: /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\d.]+v?\d*)/i,
      actions: [
        { label: 'Summarize the paper', prompt: 'Summarize arXiv paper {1}: question, method, results and limits', q: 'arxiv' },
        { label: 'Related papers', prompt: 'Find recent papers related to arXiv {1}', q: 'arxiv' },
      ],
    },
    {
      name: 'Research paper', test: /^https?:\/\/(?:doi\.org\/|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc?|pubmed\.ncbi\.nlm\.nih\.gov\/|(?:www\.)?biorxiv\.org\/|(?:www\.)?medrxiv\.org\/)/i,
      actions: [
        { label: 'Summarize the paper', prompt: 'Summarize this paper: {url}', q: 'pubmed' },
        { label: 'Related research', prompt: 'Find related recent research to {url}', q: 'pubmed' },
      ],
    },
    {
      name: 'npm package', test: /^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[\w.-]+\/)?[\w.-]+)/i,
      actions: [
        { label: 'Is it safe and maintained?', prompt: 'Is the npm package {1} maintained and safe? Downloads, last release, known vulnerabilities', q: 'package vulnerability' },
        { label: 'Alternatives', prompt: 'What are good alternatives to the npm package {1}?'},
        { label: 'Current docs', prompt: 'Show the current documentation and usage examples for {1}', q: 'context7' },
      ],
    },
    {
      name: 'PyPI package', test: /^https?:\/\/pypi\.org\/project\/([\w.-]+)/i,
      actions: [
        { label: 'Is it safe and maintained?', prompt: 'Is the Python package {1} maintained and safe? Downloads, last release, known vulnerabilities', q: 'package vulnerability' },
        { label: 'Current docs', prompt: 'Show the current documentation and usage examples for {1}', q: 'context7' },
      ],
    },
    {
      name: 'Reddit thread', test: /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/([\w]+)\/comments\//i,
      actions: [{ label: 'Summarize the thread', prompt: 'Summarize the discussion in {url}: main opinions and any consensus', q: 'reddit posts comments' }],
    },
    {
      name: 'Hacker News thread', test: /^https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i,
      actions: [{ label: 'Summarize the discussion', prompt: 'Summarize the Hacker News discussion {url}', q: 'hacker news' }],
    },
    {
      name: 'Wikipedia article', test: /^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/([^?#]+)/i,
      actions: [{ label: 'Summarize', prompt: 'Summarize the Wikipedia article {2} in 5 points', q: 'wikipedia article' }],
    },
    {
      name: 'Product page', test: /^https?:\/\/(?:www\.)?(?:amazon\.[a-z.]+\/(?:.*\/)?(?:dp|gp\/product)\/|ebay\.[a-z.]+\/itm\/|walmart\.com\/ip\/|bestbuy\.com\/site\/)/i,
      actions: [
        { label: 'Price history and deals', prompt: 'What is the price history and best current price for {url}?', q: 'price tracking product' },
        { label: 'Review summary', prompt: 'Summarize customer reviews for {url}: pros, cons, common problems'},
      ],
    },
  ];

  // Any web page or site.
  const ANY_PAGE = [
    { label: 'Summarize this page', prompt: 'Summarize {url}' },
    { label: 'Who’s talking about it', prompt: 'Find discussion and coverage of {url}' },
  ];
  const ANY_SITE = [
    { label: 'What is this company?', prompt: 'What does {host} do? Company, product, pricing and competitors' },
    { label: 'Check SSL and DNS', prompt: 'Check the SSL certificate and DNS records for {host}', q: 'ssl certificate dns' },
    { label: 'Is it up?', prompt: 'Is {host} up right now, and how fast does it respond?', q: 'uptime' },
    { label: 'SEO overview', prompt: 'SEO overview of {host}: traffic, top keywords and backlinks', q: 'seo domain keywords' },
  ];

  function actionsFor(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.host.replace(/^www\./, '');
    const fill = (t, m) => t.replace(/\{url\}/g, u.href).replace(/\{host\}/g, host).replace(/\{(\d)\}/g, (_, i) => decodeURIComponent((m && m[i]) || '').replace(/_/g, ' '));
    const groups = [];
    for (const r of RULES) {
      const m = u.href.match(r.test);
      if (m) groups.push({ name: r.name, actions: r.actions.map((a) => ({ ...a, prompt: fill(a.prompt, m) })) });
    }
    const isRoot = u.pathname === '/' || u.pathname === '';
    if (!isRoot) groups.push({ name: 'This page', actions: ANY_PAGE.map((a) => ({ ...a, prompt: fill(a.prompt) })) });
    groups.push({ name: `The site ${host}`, actions: ANY_SITE.map((a) => ({ ...a, prompt: fill(a.prompt) })) });
    return { url: u.href, host, groups };
  }

  /** Servers to ask for one action: catalog servers MCP Browser can call now, or none (normal routing). */
  async function serversFor(action) {
    if (!action.q) return { ids: [], adhoc: [], titles: [] }; // general questions: MCP Browser's own routing does best
    try {
      const r = await fetch(`/api/catalog/find?runnable=1&limit=3&q=${encodeURIComponent(action.q)}`).then((x) => x.json());
      const list = (r.servers || []).filter((s) => s.adhoc);
      return { ids: list.map((s) => s.server_id), adhoc: list.map((s) => s.adhoc), titles: list.map((s) => s.title) };
    } catch {
      return { ids: [], adhoc: [], titles: [] };
    }
  }

  window.MCPLinkActions = { actionsFor, serversFor };
})();
