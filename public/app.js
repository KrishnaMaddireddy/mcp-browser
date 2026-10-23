// MCP Browser UI: tabs, omnibox, streamed answers, servers and settings pages.
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = window.MD.esc;
  const desktop = window.mcpbDesktop || null; // set by the Electron preload

  const api = {
    async get(path) {
      const r = await fetch(path, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    async post(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
  };

  // One per kind of user: developer, researcher, everyday, marketer.
  // Everyday questions that get a good answer in free mode (checked with scripts/e2e.js).
  const SUGGESTIONS = ['Weather in Lisbon tomorrow', 'Nvidia stock price today', 'USD to JPY exchange rate', 'Convert 5 miles to km', 'How do I cancel a fetch request in JavaScript?', 'How to file a small claims case in California', 'Who won the 2022 World Cup', '!w Ada Lovelace'];

  // ---------- search history (this browser only) ----------
  const HIST = 'mcpb.history';
  const history = {
    list() {
      try {
        return JSON.parse(localStorage.getItem(HIST) || '[]').filter((x) => typeof x === 'string');
      } catch {
        return [];
      }
    },
    add(q) {
      const s = String(q || '').trim().slice(0, 200);
      if (!s || /^mcp:\/\//i.test(s)) return;
      try {
        localStorage.setItem(HIST, JSON.stringify([s, ...history.list().filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, 30)));
      } catch {
        /* storage blocked */
      }
    },
    clear() {
      try {
        localStorage.removeItem(HIST);
      } catch {
        /* storage blocked */
      }
    },
  };

  // Suggestions while typing: your recent searches, then questions from the catalog.
  let suggestSeq = 0;
  function attachSuggest(input) {
    const dl = document.createElement('datalist');
    dl.id = `sg-${++suggestSeq}`;
    input.setAttribute('list', dl.id);
    input.after(dl);
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim();
      t = setTimeout(async () => {
        const mine = history.list().filter((x) => q && x.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
        let more = [];
        if (q.length >= 2 && !/^!|^mcp:|^https?:/i.test(q)) more = (await api.get('/api/suggest?q=' + encodeURIComponent(q)).catch(() => [q, []]))[1] || [];
        dl.replaceChildren(...[...new Set([...mine, ...more])].slice(0, 8).map((v) => Object.assign(document.createElement('option'), { value: v })));
      }, 150);
    });
  }

  // ---------- tabs ----------
  const tabs = [];
  let active = null;
  let seq = 0;
  const pages = $('#pages');
  const strip = $('#tabstrip');
  const omni = $('#omni');

  function newTab(entry = { kind: 'home' }, focus = true) {
    const tab = { id: ++seq, history: [], idx: -1, btn: null };
    tab.btn = document.createElement('div');
    tab.btn.className = 'tab';
    tab.btn.setAttribute('role', 'tab');
    tab.btn.tabIndex = 0;
    tab.btn.innerHTML = '<span class="tab-dot" aria-hidden="true"></span><span class="tab-title">New tab</span><button class="tab-close" aria-label="Close tab">×</button>';
    tab.btn.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) closeTab(tab);
      else activate(tab);
    });
    tab.btn.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab));
    tab.btn.addEventListener('keydown', (e) => e.key === 'Enter' && activate(tab));
    strip.insertBefore(tab.btn, $('#newTab'));
    tabs.push(tab);
    navigate(tab, entry);
    if (focus) activate(tab);
    return tab;
  }

  function closeTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    for (const e of tab.history) {
      e.abort?.abort();
      e.el.remove();
    }
    tab.btn.remove();
    tabs.splice(i, 1);
    if (!tabs.length) newTab();
    else if (active === tab) activate(tabs[Math.max(0, i - 1)]);
  }

  function activate(tab) {
    active = tab;
    for (const t of tabs) {
      t.btn.classList.toggle('active', t === tab);
      t.btn.setAttribute('aria-selected', String(t === tab));
      for (const e of t.history) e.el.hidden = !(t === tab && e === t.history[t.idx]);
    }
    syncChrome();
  }

  function current(tab = active) {
    return tab?.history[tab.idx];
  }

  function syncChrome() {
    const e = current();
    if (!e) return;
    // (a cross-check shows its claim, so the address can be copied, re-entered or reloaded)
    omni.value = e.kind === 'search' ? e.query : e.kind === 'web' ? e.url : e.kind === 'home' ? '' : e.kind === 'check' && e.claim ? `check: ${e.claim}` : `mcp://${e.kind}`;
    $('#back').disabled = !active || active.idx <= 0;
    $('#fwd').disabled = !active || active.idx >= active.history.length - 1;
    document.title = `${e.title || 'New tab'} – MCP Browser`;
  }

  function setTitle(tab, entry, title) {
    entry.title = title;
    if (current(tab) === entry) {
      $('.tab-title', tab.btn).textContent = title;
      tab.btn.title = title;
      if (tab === active) syncChrome();
    }
  }

  function navigate(tab, entry) {
    // Drop forward history.
    for (const e of tab.history.splice(tab.idx + 1)) {
      e.abort?.abort();
      e.el.remove();
    }
    entry.el = buildPage(tab, entry);
    pages.appendChild(entry.el);
    tab.history.push(entry);
    tab.idx = tab.history.length - 1;
    showEntry(tab);
  }

  function showEntry(tab) {
    for (const e of tab.history) e.el.hidden = !(tab === active && e === tab.history[tab.idx]);
    const e = current(tab);
    $('.tab-title', tab.btn).textContent = e.title || 'New tab';
    tab.btn.classList.toggle('busy', Boolean(e.busy));
    if (tab === active) syncChrome();
  }

  function go(delta) {
    if (!active) return;
    const n = active.idx + delta;
    if (n < 0 || n >= active.history.length) return;
    active.idx = n;
    showEntry(active);
  }

  function buildPage(tab, entry) {
    switch (entry.kind) {
      case 'search':
        return buildSearch(tab, entry);
      case 'servers':
        entry.title = 'MCP servers';
        return buildServers(entry);
      case 'settings':
        entry.title = 'Settings';
        return buildSettings(entry);
      case 'watches':
        entry.title = 'Watches';
        return buildWatches(entry);
      case 'rank':
        entry.title = 'MCP Rank';
        return buildRank(entry);
      case 'check': {
        entry.title = entry.claim ? `Check: ${entry.claim}` : 'Cross-check';
        const el = $('#tpl-check').content.firstElementChild.cloneNode(true);
        window.MCPCheck?.mount(el, {
          claim: entry.claim,
          open: (u) => open(u),
          onClaim: (c) => {
            entry.claim = c;
            setTitle(tab, entry, `Check: ${c}`);
          },
        });
        return el;
      }
      case 'deps': {
        entry.title = 'Dependency check';
        const el = $('#tpl-deps').content.firstElementChild.cloneNode(true);
        window.MCPDeps?.mount(el, { text: entry.text, search: (q) => newTab({ kind: 'search', query: q }), watching: () => typeof askNotify === 'function' && askNotify() });
        return el;
      }
      case 'pipelines': {
        entry.title = 'Pipelines';
        const el = $('#tpl-pipelines').content.firstElementChild.cloneNode(true);
        window.MCPPipelines?.mount(el, { open: (u) => open(u), run: entry.run });
        return el;
      }
      case 'webmcp': {
        entry.title = 'Websites with AI tools';
        const el = $('#tpl-webmcp').content.firstElementChild.cloneNode(true);
        window.MCPWebSites?.mount(el, { q: entry.q, desktop: Boolean(desktop), openWeb: (url) => (desktop ? newTab({ kind: 'web', url }) : window.open(url, '_blank', 'noopener,noreferrer')) });
        return el;
      }
      case 'stack': {
        entry.title = 'My MCP stack';
        const el = $('#tpl-stack').content.firstElementChild.cloneNode(true);
        window.MCPStack?.mount(el, { open: (u) => open(u), runInline, showServer: (id) => navigate(active, { kind: 'catalog', view: 'all', show: id }) });
        return el;
      }
      case 'audit': {
        entry.title = 'My installed servers';
        const el = $('#tpl-audit').content.firstElementChild.cloneNode(true);
        window.MCPAudit?.mount(el, { showServer: (id) => navigate(active, { kind: 'catalog', view: 'all', show: id }) });
        return el;
      }
      case 'catalog': {
        entry.title = 'Server catalog';
        const el = $('#tpl-catalog').content.firstElementChild.cloneNode(true);
        window.MCPCatalog?.mount(el, entry, {
          // Run a sample prompt in a new tab, sent to that server.
          open: (url) => open(url),
          ask: (query, ids, adhoc) => newTab({ kind: 'search', query, servers: ids?.length ? [].concat(ids) : undefined, adhoc: adhoc?.length ? adhoc : undefined, label: query }),
          runInline,
        });
        return el;
      }
      case 'web':
        entry.title = hostOf(entry.url);
        return buildWeb(entry);
      case 'link':
        entry.title = `Open with: ${hostOf(entry.url)}`;
        return buildLink(entry);
      default:
        entry.title = 'New tab';
        return buildHome(tab);
    }
  }

  // Run a question inside another page (catalog, link actions): the same answer
  // view as a search tab, embedded, with follow-ups. ids/adhoc pin the servers.
  // page: a web tab's WebMCP tools ("Ask this page"), see page-tools.js.
  function runInline(box, query, ids, adhoc, pageCtx) {
    box.__entry?.abort?.abort();
    const inlineEntry = { kind: 'search', query, servers: ids?.length ? [].concat(ids) : undefined, adhoc: adhoc?.length ? adhoc : undefined, label: query, inline: true, page: pageCtx };
    const fakeTab = { btn: Object.assign(document.createElement('div'), { innerHTML: '<span class="tab-title"></span>' }), history: [inlineEntry], idx: 0 };
    const page = buildSearch(fakeTab, inlineEntry);
    page.classList.add('inline-run');
    page.hidden = false;
    box.replaceChildren(page);
    box.__entry = inlineEntry;
    return inlineEntry;
  }

  // "Open with": what MCP servers can do with a link.
  function linkActionsHtml(info) {
    return info.groups
      .map((g, gi) => `<div class="la-group"><span class="la-name">${esc(g.name)}</span><div class="la-actions">${g.actions.map((a, ai) => `<button type="button" class="la-btn" data-la="${gi}:${ai}" title="${esc(a.prompt)}">${esc(a.label)}</button>`).join('')}</div></div>`)
      .join('');
  }
  async function runLinkAction(info, key, box, note) {
    const [gi, ai] = key.split(':').map(Number);
    const a = info.groups[gi]?.actions[ai];
    if (!a) return;
    note.textContent = 'Finding servers for this…';
    const s = await window.MCPLinkActions.serversFor(a);
    note.textContent = s.ids.length ? `Asking ${s.titles.join(', ')}` : 'Asking the servers MCP Browser picks for this';
    runInline(box, a.prompt, s.ids, s.adhoc);
  }
  function buildLink(entry) {
    const info = window.MCPLinkActions?.actionsFor(entry.url);
    const el = document.createElement('section');
    el.className = 'page panel link';
    if (!info) {
      el.innerHTML = '<p class="hint">That doesn’t look like a web address.</p>';
      return el;
    }
    if (entry.autorun) setTimeout(() => el.querySelector(`[data-la="${entry.autorun}"]`)?.click(), 0);
    el.innerHTML = `<header class="panel-head"><h1>Open with…</h1><p class="la-url"><code>${esc(info.url)}</code></p>
      <p class="la-open"><button type="button" class="la-open-btn" data-la-open>Open the page</button> <span class="hint">or let MCP servers work on it:</span></p></header>
      <p class="la-webmcp" data-la-webmcp hidden></p>
      <div class="la-list">${linkActionsHtml(info)}</div><p class="hint" data-la-note></p><div class="la-run" data-la-run></div>`;
    // The site in the WebMCP directory (checked locally): its pages offer tools to agents.
    fetch('/api/webmcp/lookup?url=' + encodeURIComponent(info.url))
      .then((r) => r.json())
      .then(({ site }) => {
        if (!site) return;
        const p = $('[data-la-webmcp]', el);
        p.hidden = false;
        p.innerHTML = `<b>${esc(site.host)}</b> offers ${site.toolCount} tool${site.toolCount === 1 ? '' : 's'} for AI agents (WebMCP, listed on webmcp.com)${site.sample.length ? `: ${site.sample.map((n) => `<code>${esc(n)}</code>`).join(', ')}` : ''}. ${desktop ? 'Open the page and use them from the bar above it.' : 'Open it in the MCP Browser desktop app to use them.'}`;
      })
      .catch(() => {});
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-la-open]')) return desktop ? navigate(active, { kind: 'web', url: info.url }) : window.open(info.url, '_blank', 'noopener,noreferrer');
      const b = e.target.closest('[data-la]');
      if (b) {
        for (const x of el.querySelectorAll('.la-btn[aria-pressed="true"]')) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        runLinkAction(info, b.dataset.la, $('[data-la-run]', el), $('[data-la-note]', el));
      }
    });
    return el;
  }

  // ---------- omnibox ----------
  function looksLikeUrl(s) {
    if (/\s/.test(s)) return false;
    return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s);
  }

  function open(input, tab = active) {
    const s = String(input || '').trim();
    if (!s) return;
    // !g, !w, !yt…: straight to that site (or a page of the app: !mcp, !sites).
    const bang = window.MCPBangs?.parse(s);
    if (bang) {
      if (bang.entry) return navigate(tab, bang.entry);
      if (desktop) return navigate(tab, { kind: 'web', url: bang.url });
      return window.open(bang.url, '_blank', 'noopener,noreferrer');
    }
    if (/^mcp:\/\/(home|newtab)\/?$/i.test(s)) return navigate(tab, { kind: 'home' });
    if (/^mcp:\/\/servers/i.test(s)) return navigate(tab, { kind: 'servers' });
    if (/^mcp:\/\/settings/i.test(s)) return navigate(tab, { kind: 'settings' });
    if (/^mcp:\/\/rank/i.test(s)) return navigate(tab, { kind: 'rank' });
    if (/^mcp:\/\/watches/i.test(s)) return navigate(tab, { kind: 'watches' });
    if (/^mcp:\/\/catalog/i.test(s)) return navigate(tab, { kind: 'catalog' });
    if (/^mcp:\/\/audit/i.test(s)) return navigate(tab, { kind: 'audit' });
    if (/^mcp:\/\/stack/i.test(s)) return navigate(tab, { kind: 'stack' });
    if (/^mcp:\/\/webmcp/i.test(s)) return navigate(tab, { kind: 'webmcp' });
    if (/^mcp:\/\/pipelines/i.test(s)) return navigate(tab, { kind: 'pipelines' });
    if (/^mcp:\/\/check/i.test(s)) return navigate(tab, { kind: 'check' });
    if (/^mcp:\/\/deps/i.test(s)) return navigate(tab, { kind: 'deps' });
    // "tell me when …", "notify me if NVDA drops below 200", "tell me about new recalls …" → set up a watch.
    // ("tell me about the French Revolution" and "tell me if I need a visa" are questions: they search.)
    const lead = /^(?:please\s+)?(?:(?:tell|notify|alert|ping)\s+me|let me know)\s+/i.exec(s);
    if (lead) {
      const rest = s.slice(lead[0].length);
      if (/^(?:when|whenever|once|as soon as)\s+\S/i.test(rest) || /^about\s+(?:new|any new|the latest|latest)\s+\S/i.test(rest) || /^if\s+.*\b(?:below|under|above|over|less than|more than|hits?|reaches?|is (?:released|out|announced|available|approved))\b/i.test(rest)) return navigate(tab, { kind: 'watches', track: s });
    }
    // "is it true that …", "fact check: …", "true or false: …" → Cross-check.
    const claim = /^(?:is it true that|is it true|fact[- ]?check:?|true or false:?|verify:|verify that|check:)\s+(.{6,300}?)\??$/i.exec(s);
    if (claim) {
      history.add(s);
      return navigate(tab, { kind: 'check', claim: claim[1].replace(/^that\s+/i, '') });
    }
    if (looksLikeUrl(s)) {
      const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      return openUrl(url, tab);
    }
    history.add(s);
    navigate(tab, { kind: 'search', query: s });
  }

  function openUrl(url, tab = active) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    // Desktop app: the page, with "Open with" actions on top. In a browser: the actions page.
    if (desktop) navigate(tab, { kind: 'web', url: u.href });
    else navigate(tab, { kind: 'link', url: u.href });
  }

  $('#omnibox').addEventListener('submit', (e) => {
    e.preventDefault();
    open(omni.value);
    omni.blur();
  });
  omni.addEventListener('focus', () => omni.select());
  attachSuggest(omni);
  $('#newTab').addEventListener('click', () => newTab());
  $('#back').addEventListener('click', () => go(-1));
  $('#home').addEventListener('click', () => navigate(active, { kind: 'home' }));
  $('#fwd').addEventListener('click', () => go(1));
  $('#reload').addEventListener('click', () => {
    const e = current();
    if (!e) return;
    if (e.kind === 'search') navigate(active, { kind: 'search', query: e.query, discovery: e.discovery, label: e.label, servers: e.servers });
    else if (e.kind === 'web' && e.webview) e.webview.reload();
    else navigate(active, { kind: e.kind, url: e.url });
  });
  $('#openServers').addEventListener('click', () => open('mcp://servers'));
  // Narrow windows: the four page buttons live in one menu.
  const menuBtn = $('#menuBtn');
  const menuPanel = $('#menuPanel');
  menuBtn.addEventListener('click', () => {
    menuPanel.hidden = !menuPanel.hidden;
    menuBtn.setAttribute('aria-expanded', String(!menuPanel.hidden));
  });
  menuPanel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    menuPanel.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    open(b.dataset.go);
  });
  document.addEventListener('click', (e) => {
    if (!menuPanel.hidden && !e.target.closest('#menuPanel, #menuBtn')) {
      menuPanel.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });
  $('#openRank').addEventListener('click', () => open('mcp://rank'));
  $('#openWatches').addEventListener('click', () => open('mcp://watches'));
  $('#openSettings').addEventListener('click', () => open('mcp://settings'));
  $('#openCatalog').addEventListener('click', () => open('mcp://catalog'));
  $('#openStack').addEventListener('click', () => open('mcp://stack'));
  $('#modeChip').addEventListener('click', () => open('mcp://settings'));

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault();
      newTab();
    } else if (mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeTab(active);
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      navigate(active, { kind: 'home' });
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      omni.focus();
    } else if (e.key === '/' && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) {
      // "/" jumps to the search box (the page's own box on the start page).
      e.preventDefault();
      const homeBox = [...document.querySelectorAll('[data-home-input]')].find((x) => x.offsetParent !== null);
      (homeBox || omni).focus();
    } else if (e.altKey && e.key === 'ArrowLeft') go(-1);
    else if (e.altKey && e.key === 'ArrowRight') go(1);
  });

  // Links inside answers: open as tabs in the desktop app, new windows otherwise.
  pages.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !desktop) return;
    e.preventDefault();
    newTab({ kind: 'web', url: a.href }, !(e.metaKey || e.ctrlKey));
  });

  // ---------- status / mode chip ----------
  let status = null;
  async function refreshStatus() {
    try {
      status = await api.get('/api/status');
    } catch {
      return;
    }
    const p = status.provider;
    const chip = $('#modeChip');
    if (p.provider === 'none') {
      chip.textContent = 'Free mode';
      chip.className = 'mode-chip free';
      chip.title = 'No AI model configured: results come straight from the servers. Click to add one.';
    } else {
      chip.textContent = p.model || p.provider;
      chip.className = 'mode-chip';
      chip.title = `Answers written by ${p.provider} ${p.model || ''}`;
    }
    document.querySelectorAll('[data-stats]').forEach((el) => (el.textContent = statsLine()));
    const badge = $('#watchBadge');
    badge.hidden = !status.watchesUnseen;
    $('#openWatches').title = status.watchesUnseen ? `Watches: ${status.watchesUnseen} with changes` : 'Watches';
  }
  // ---------- desktop notifications for watches ----------
  // While the app is open, a watch that changed or hit its line shows a notification
  // (once per change; remembered in this browser).
  const NOTIFIED = 'mcpb.watch.notified';
  function askNotify() {
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch {}
  }
  async function checkWatchNews() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let data;
    try {
      data = await api.get('/api/watches');
    } catch {
      return;
    }
    let seen = {};
    // Only what happens after notifications were turned on here, not a backlog of every past change.
    let since = 0;
    try {
      seen = JSON.parse(localStorage.getItem(NOTIFIED) || '{}');
      since = Number(localStorage.getItem(`${NOTIFIED}.since`)) || 0;
      if (!since) localStorage.setItem(`${NOTIFIED}.since`, String((since = Date.now())));
    } catch {
      since = Date.now() - 120_000;
    }
    for (const w of data.watches || []) {
      const h = w.history?.[0];
      const at = w.met?.at || (h?.changed ? h.at : 0);
      // (the server remembers what was notified, so other windows don't repeat it)
      if (!at || at <= since || seen[w.id] >= at || (w.notifiedAt || 0) >= at) continue;
      seen[w.id] = at;
      api.post('/api/watches/update', { id: w.id, notifiedAt: at }).catch(() => {});
      const what = w.deps ? ['new advisory', 'new advisories'] : ['new source', 'new sources'];
      const body = w.met ? w.met.snippet : w.page ? `The page changed: ${h.added?.[0] || `${h.removedCount || 0} line(s) removed`}` : `${h.newSources?.length || 0} ${h.newSources?.length === 1 ? what[0] : what[1]}${h.newSources?.[0] ? `: ${h.newSources[0].title}` : ''}`;
      try {
        const n = new Notification(w.label || w.query, { body: String(body).slice(0, 180), tag: `watch-${w.id}` });
        n.onclick = () => {
          window.focus();
          newTab({ kind: 'watches' });
        };
      } catch {}
    }
    try {
      localStorage.setItem(NOTIFIED, JSON.stringify(seen));
    } catch {}
  }
  setInterval(checkWatchNews, 60_000);
  setTimeout(checkWatchNews, 8000);

  function statsLine() {
    if (!status?.registry.syncedAt) return 'Ask a question. It goes to the few MCP servers that know the answer.';
    const n = status.registry.answering || status.registry.keyless;
    return `Ask a question. It goes to the few MCP servers that know the answer, out of ${n.toLocaleString()} that answer without a key.`;
  }

  // ---------- home ----------
  function buildHome(tab) {
    const el = $('#tpl-home').content.firstElementChild.cloneNode(true);
    $('[data-stats]', el).textContent = statsLine();
    const input = $('[data-home-input]', el);
    $('[data-home-form]', el).addEventListener('submit', (e) => {
      e.preventDefault();
      open(input.value, tab);
    });
    const sug = $('[data-suggest]', el);
    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', () => open(s, tab));
      sug.appendChild(b);
    }
    attachSuggest(input);
    renderRecent(tab, el);
    renderToday(tab, el);
    renderDiscover(tab, el);
    renderSearchEngine(el);
    renderSetup(el);
    renderTemplates(tab, el);
    setTimeout(() => tab === active && input.focus(), 0);
    return el;
  }

  // ---------- answer cards ----------
  // One thing (a company, a city, a CVE, a website…) gets a card from several servers at
  // once; "A vs B" gets two cards side by side.
  async function loadCard(box, query) {
    let res;
    try {
      res = await fetch('/api/card', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ query }) });
    } catch {
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const sides = [{ sections: new Map(), order: [] }, { sections: new Map(), order: [] }];
    const facts = (x) => (x.facts?.length ? `<dl>${x.facts.slice(0, 5).map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>` : '');
    const sectionHtml = (d) =>
      `<h4>${esc(d.label)}</h4>${d.answer ? `<p class="ac-a">${esc(d.answer)}</p>` : ''}${(d.details || []).map((x) => `${x.title ? `<p class="ac-t">${esc(x.title)}</p>` : ''}${x.text ? `<p class="ac-x">${esc(x.text.slice(0, 320))}${x.text.length > 320 ? '…' : ''}</p>` : ''}${facts(x)}`).join('')}${d.links?.length ? `<ul class="ac-links">${d.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a> <span>${esc(l.host)}</span></li>`).join('')}</ul>` : ''}${d.servers?.length ? `<p class="ac-from">${esc(d.servers.join(', '))}</p>` : ''}`;
    const render = (i) => {
      const s = sides[i];
      const grid = box.querySelector(`[data-ac-grid="${i}"]`);
      if (!grid) return;
      grid.innerHTML = s.order.map((k) => s.sections.get(k)).filter((d) => d && !d.empty).map((d) => `<div class="ac-sec" data-k="${esc(d.key)}">${sectionHtml(d)}</div>`).join('') + s.order.filter((k) => !s.sections.has(k)).map(() => '<div class="ac-sec ac-wait"><span></span><span></span></div>').join('');
    };
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1];
        const raw = /^data: (.*)$/m.exec(block)?.[1];
        if (!type || !raw) continue;
        const d = JSON.parse(raw);
        const i = d.side ?? 0;
        if (type === 'card_none') return;
        if (type === 'card_pair') {
          box.dataset.type = d.type;
          box.classList.add('ac-pair');
          box.innerHTML = `<div class="ac-side" data-side="0"></div><div class="ac-side" data-side="1"></div>`;
          box.hidden = false;
        } else if (type === 'card_start') {
          sides[i].order = ['time', ...d.sections.map((x) => x.key)].filter((x) => x !== 'time' || d.type === 'place');
          box.dataset.type = d.type;
          sides[i].subtitle = d.subtitle;
          const head = `<header><h3>${esc(d.title)}</h3><span data-ac-sub>${esc(d.subtitle)} · asking ${d.sections.length} servers at once</span></header><div class="ac-grid" data-ac-grid="${i}"></div>`;
          const host = d.side != null ? box.querySelector(`[data-side="${i}"]`) : box;
          host.innerHTML = head;
          box.hidden = false;
          render(i);
        } else if (type === 'card_section') {
          sides[i].sections.set(d.key, d);
          render(i);
          // A price in a single company card: one click to be told when it crosses a line (5% away).
          if (d.side == null && d.key === 'quote' && d.answer && box.dataset.type === 'company' && !box.querySelector('[data-ac-track]')) {
            const m = /\(([A-Z.]{1,6})\)\s*:\s*([\d,.]+)/.exec(d.answer);
            if (m) {
              const p = Number(m[2].replace(/,/g, ''));
              const down = Math.round(p * 0.95 * 100) / 100;
              const up = Math.round(p * 1.05 * 100) / 100;
              box.querySelector('header').insertAdjacentHTML('beforeend', `<span class="ac-track" data-ac-track>Tell me when it <button type="button" class="link-btn" data-ac-tw="tell me when ${esc(m[1])} drops below ${down}">drops below ${down}</button> or <button type="button" class="link-btn" data-ac-tw="tell me when ${esc(m[1])} goes above ${up}">goes above ${up}</button></span>`);
              box.querySelectorAll('[data-ac-tw]').forEach((b) => b.addEventListener('click', () => newTab({ kind: 'watches', track: b.dataset.acTw })));
            }
          }
        } else if (type === 'card_done') {
          for (const j of d.all || box.classList.contains('ac-pair') ? [0, 1] : [i]) {
            for (const k2 of sides[j].order) if (!sides[j].sections.has(k2)) sides[j].sections.set(k2, { key: k2, empty: true });
            render(j);
            // (what it says it's from: the servers whose answers are on it, not the ones asked)
            const used = new Set([...sides[j].sections.values()].filter((y) => !y.empty).flatMap((y) => y.servers || []).filter((x) => x !== 'MCP Browser'));
            const sub = (d.all || box.classList.contains('ac-pair') ? box.querySelector(`[data-side="${j}"]`) : box)?.querySelector('[data-ac-sub]');
            if (sub) sub.textContent = used.size ? `${sides[j].subtitle} · from ${used.size} server${used.size === 1 ? '' : 's'}` : sides[j].subtitle;
          }
          const any = sides.some((x) => [...x.sections.values()].some((y) => !y.empty));
          if (!any) box.hidden = true;
          // The card has what was found: the "no useful results" notice would contradict it.
          else box.closest('.turn')?.classList.add('has-card');
        }
      }
    }
  }

  // ---------- start page: today (weather where you are, the market, headlines) ----------
  // Your city stays in this browser only. Off until you add one.
  const TODAY_KEY = 'mcpb.today.city';
  const todayCity = {
    get() {
      try {
        return localStorage.getItem(TODAY_KEY);
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        if (v == null) localStorage.removeItem(TODAY_KEY);
        else localStorage.setItem(TODAY_KEY, v);
      } catch {}
    },
  };
  async function renderToday(tab, el) {
    const box = $('[data-today]', el);
    const city = todayCity.get();
    box.hidden = false;
    // (the topics you follow show with or without a city)
    const topicsOnly = () => {
      if (!myTopics.get().length) return false;
      box.innerHTML = '<div class="today-topics" data-today-topics></div>';
      renderTopics(tab, $('[data-today-topics]', box));
      return true;
    };
    if (city == null) {
      box.innerHTML = `<form class="today-ask" data-today-form><span>See your weather, the market, today’s headlines and topics you follow here:</span><input type="text" data-today-city placeholder="Your city" aria-label="Your city" maxlength="60"><button type="submit">Show</button><button type="button" class="link-btn" data-today-no>No thanks</button></form><div class="today-topics" data-today-topics></div>`;
      if (myTopics.get().length) renderTopics(tab, $('[data-today-topics]', box));
      $('[data-today-form]', box).addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('[data-today-city]', box).value.trim();
        if (!v) return;
        todayCity.set(v);
        renderToday(tab, el);
      });
      $('[data-today-no]', box).addEventListener('click', () => {
        todayCity.set('');
        if (!topicsOnly()) box.hidden = true;
      });
      return;
    }
    if (city === '') {
      if (!topicsOnly()) box.hidden = true;
      return;
    }
    const card = (title, q, body) => `<div class="today-card"><h3><button type="button" class="link-btn" data-today-q="${esc(q)}">${esc(title)}</button></h3>${body}</div>`;
    box.innerHTML = `<div class="today-grid">${card(`Weather in ${city}`, `weather in ${city}`, '<p class="today-wait">Checking…</p>')}${card('Market', 'S&P 500 today', '<p class="today-wait">Checking…</p>')}${card('Today’s news', 'latest news', '<p class="today-wait">Checking…</p>')}</div><div class="today-topics" data-today-topics></div><p class="today-foot"><button type="button" class="link-btn" data-today-change>Change city</button> · <button type="button" class="link-btn" data-today-off>Hide this</button></p>`;
    renderTopics(tab, $('[data-today-topics]', box));
    const wire = () => {
      box.querySelectorAll('[data-today-q]').forEach((b) => b.addEventListener('click', () => open(b.dataset.todayQ, tab)));
      $('[data-today-change]', box).addEventListener('click', () => (todayCity.set(null), renderToday(tab, el)));
      $('[data-today-off]', box).addEventListener('click', () => (todayCity.set(''), (box.hidden = true)));
    };
    wire();
    let d;
    try {
      d = await api.get(`/api/today?city=${encodeURIComponent(city)}`);
    } catch {
      d = null;
    }
    const cards = box.querySelectorAll('.today-card');
    const say = (a, none, short = (t) => t) => (a?.answer ? `<p class="today-a">${esc(short(a.answer.text))}</p><p class="today-src">${esc(a.answer.server || a.answer.site || '')}</p>` : `<p class="today-wait">${esc(none)}</p>`);
    // "San Francisco, CA: Dry all day. 58° now." → "Dry all day. 58° now." (the title names the city)
    const weatherShort = (t) => t.replace(/^[^:]{2,80}:\s+/, '');
    // "SPDR S&P 500 ETF (SPY): 763.96 USD (1-day change -1.18%); extended hours …" → "SPY 763.96 USD, -1.18% today"
    const quoteShort = (t) => {
      const m = /\(([A-Z.^-]{1,10})\):\s*([\d.,]+\s*[A-Z]{3})\s*\(1-day change ([-+]?[\d.]+%)\)/.exec(t);
      return m ? `${m[1]} ${m[2]}, ${m[3].startsWith('-') ? m[3].replace('-', '−') : `+${m[3].replace('+', '')}`} today` : t;
    };
    cards[0].querySelector('.today-wait')?.remove();
    cards[0].insertAdjacentHTML('beforeend', say(d?.weather, 'No forecast found. Click the title to search.', weatherShort));
    cards[1].querySelector('.today-wait')?.remove();
    cards[1].insertAdjacentHTML('beforeend', say(d?.market, 'No quote found right now.', quoteShort));
    cards[2].querySelector('.today-wait')?.remove();
    cards[2].insertAdjacentHTML(
      'beforeend',
      d?.news?.items?.length
        ? `<ul class="today-news">${d.news.items.map((it) => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a> <span>${esc(it.site)}</span></li>`).join('')}</ul>`
        : '<p class="today-wait">No headlines found right now.</p>'
    );
  }

  // ---------- Today: your topics, each with its latest headlines ----------
  // The topics stay in this browser only (up to 5).
  const TOPICS_KEY = 'mcpb.today.topics';
  const myTopics = {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(TOPICS_KEY) || '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : [];
      } catch {
        return [];
      }
    },
    set(list) {
      try {
        localStorage.setItem(TOPICS_KEY, JSON.stringify(list.slice(0, 5)));
      } catch {}
    },
  };
  function renderTopics(tab, host) {
    const list = myTopics.get();
    const topicCard = (t) => `<div class="today-card today-topic" data-topic="${esc(t)}"><h3><button type="button" class="link-btn" data-topic-q="${esc(t)}">${esc(t)}</button><span class="tt-acts"><button type="button" class="link-btn" data-topic-watch="${esc(t)}" title="Get a notification when there are new stories">Notify me</button><button type="button" class="link-btn tt-x" data-topic-rm="${esc(t)}" aria-label="Stop following ${esc(t)}">×</button></span></h3><p class="today-wait">Checking…</p></div>`;
    host.innerHTML = `${list.length ? `<div class="today-tgrid">${list.map(topicCard).join('')}</div>` : ''}<form class="today-tform" data-topic-form>${list.length < 5 ? `<input type="text" data-topic-in maxlength="60" placeholder="${list.length ? 'Follow another topic' : 'Follow a topic: a team, a company, a subject…'}" aria-label="Follow a topic"><button type="submit">Follow</button>` : '<span>Following 5 topics (the most there’s room for).</span>'}</form><p class="today-note">Your topics are kept in this browser. To find their stories they’re sent as searches to web-search servers.</p>`;
    host.onclick = (e) => {
      const q = e.target.closest('[data-topic-q]');
      if (q) return open(`${q.dataset.topicQ} news`, tab);
      const rm = e.target.closest('[data-topic-rm]');
      if (rm) {
        myTopics.set(myTopics.get().filter((x) => x !== rm.dataset.topicRm));
        return renderTopics(tab, host);
      }
      const w = e.target.closest('[data-topic-watch]');
      if (w) return newTab({ kind: 'watches', track: `tell me about new ${w.dataset.topicWatch} news` });
    };
    const form = $('[data-topic-form]', host);
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = $('[data-topic-in]', host)?.value.replace(/\s+/g, ' ').trim();
      if (!v || v.length < 2) return;
      const cur = myTopics.get();
      if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) myTopics.set([...cur, v]);
      renderTopics(tab, host);
    };
    // (a list redrawn since these were asked for ignores their answers)
    const gen = String((Number(host.dataset.gen) || 0) + 1);
    host.dataset.gen = gen;
    for (const t of list) {
      api
        .get(`/api/today/topic?q=${encodeURIComponent(t)}`)
        .catch(() => null)
        .then((d) => {
          const el = [...host.querySelectorAll('[data-topic]')].find((x) => x.dataset.topic === t);
          if (!el || host.dataset.gen !== gen) return;
          el.querySelector('.today-wait')?.remove();
          el.insertAdjacentHTML(
            'beforeend',
            d?.items?.length
              ? `<ul class="today-news">${d.items.map((it) => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a> <span>${esc(it.site)}${it.date ? ` · ${esc(niceDate(it.date))}` : ''}</span></li>`).join('')}</ul>`
              : '<p class="today-wait">No fresh stories found. Click the topic to search.</p>'
          );
        });
    }
  }

  // ---------- start page: recent searches, things to discover ----------
  function renderRecent(tab, el) {
    const box = $('[data-recent]', el);
    const list = history.list().slice(0, 6);
    box.hidden = !list.length;
    $('[data-recent-list]', box).replaceChildren(
      ...list.map((q) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = q;
        b.addEventListener('click', () => open(q, tab));
        return b;
      })
    );
    $('[data-recent-clear]', box).onclick = () => (history.clear(), (box.hidden = true));
  }
  async function renderDiscover(tab, el) {
    let d;
    try {
      d = await api.get('/api/discover');
    } catch {
      return;
    }
    if (!d?.tryNow) return;
    const box = $('[data-discover]', el);
    const item = (x, withPrompt) =>
      `<li><div class="dc-t"><b>${esc(x.title)}</b> <span class="dc-c">${esc(x.category)}</span></div>${withPrompt && x.prompt ? `<button type="button" class="dc-q" data-dc-ask="${esc(x.id)}" data-dc-prompt="${esc(x.prompt)}">${esc(x.prompt)}</button>` : `<button type="button" class="link-btn dc-show" data-dc-show="${esc(x.id)}">${esc(x.desc)}</button>`}</li>`;
    $('[data-dc-try]', box).innerHTML = d.tryNow.map((x) => item(x, true)).join('');
    $('[data-dc-fresh]', box).innerHTML = (d.fresh || []).map((x) => item(x, true)).join('');
    // Package servers we tested: MCP Browser starts them on this computer after you approve.
    if (d.local?.length) {
      $('[data-dc-local-h]', box).hidden = false;
      $('[data-dc-local]', box).innerHTML = d.local.map((x) => `<li data-dc-li="${esc(x.id)}"><div class="dc-t"><b>${esc(x.title)}</b> <span class="dc-c">${esc(x.category)} · ${x.type === 'npm' ? 'npm' : 'Python'} package</span></div><button type="button" class="dc-q" data-dc-local="${esc(x.id)}" data-dc-prompt="${esc(x.prompt)}">${esc(x.prompt)}</button><div class="lr-host" data-dc-lr></div></li>`).join('');
    }
    $('[data-dc-popular]', box).innerHTML = d.popular.map((x) => item(x, false)).join('');
    const n = { servers: d.counts?.servers, sites: d.sites?.count, pipelines: d.pipelines };
    for (const b of box.querySelectorAll('[data-dc-n]')) if (n[b.dataset.dcN]) b.insertAdjacentHTML('beforeend', ` <span class="dc-n">${Number(n[b.dataset.dcN]).toLocaleString()}</span>`);
    const all = [...d.tryNow, ...(d.fresh || [])];
    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-dc-ask]');
      if (a) {
        const x = all.find((y) => y.id === a.dataset.dcAsk);
        history.add(a.dataset.dcPrompt);
        return navigate(tab, { kind: 'search', query: a.dataset.dcPrompt, servers: [a.dataset.dcAsk], adhoc: x?.adhoc ? [x.adhoc] : undefined, label: a.dataset.dcPrompt });
      }
      const lo = e.target.closest('[data-dc-local]');
      if (lo) {
        const id = lo.dataset.dcLocal;
        const go = () => (history.add(lo.dataset.dcPrompt), navigate(tab, { kind: 'search', query: lo.dataset.dcPrompt, servers: [id], label: lo.dataset.dcPrompt }));
        if (window.MCPLocal?.canRun(id)) return go();
        return window.MCPLocal?.ready().then(() => (window.MCPLocal.canRun(id) ? go() : window.MCPLocal.panel(lo.closest('li').querySelector('[data-dc-lr]'), id, { onReady: go })));
      }
      const s = e.target.closest('[data-dc-show]');
      if (s) return navigate(tab, { kind: 'catalog', view: 'all', show: s.dataset.dcShow });
      const g = e.target.closest('[data-go]');
      if (g) return open(g.dataset.go, tab);
    });
    box.hidden = false;
  }
  function renderSearchEngine(el) {
    const box = $('[data-se]', el);
    try {
      if (localStorage.getItem('mcpb.se.hidden') === '1') return;
    } catch {
      /* storage blocked */
    }
    if (desktop) return; // the desktop app has its own window; this is for your everyday browser
    const url = `${location.origin}/?q=%s`;
    $('[data-se-url]', box).textContent = url;
    $('[data-se-copy]', box).onclick = async (e) => {
      try {
        await navigator.clipboard.writeText(url);
        e.target.textContent = 'Copied';
      } catch {
        getSelection().selectAllChildren($('[data-se-url]', box));
      }
    };
    $('[data-se-close]', box).onclick = () => {
      box.hidden = true;
      try {
        localStorage.setItem('mcpb.se.hidden', '1');
      } catch {
        /* storage blocked */
      }
    };
    box.hidden = false;
  }

  // ---------- first-run setup ----------
  async function renderSetup(el) {
    const box = $('[data-setup]', el);
    let hidden = false;
    try {
      hidden = localStorage.getItem('mcpb.setup.hidden') === '1';
    } catch {
      /* storage blocked */
    }
    if (!status) await refreshStatus();
    if (hidden || !status || status.provider.provider !== 'none') return;
    const L = status.mcpLaunch || { command: 'node', args: ['/full/path/to/mcp-browser/bin/mcp-server.js'], env: {} };
    const envFlags = Object.entries(L.env || {}).map(([k, v]) => `-e ${k}=${v} `).join('');
    const cc = `claude mcp add --scope user mcp-browser ${envFlags}-- "${L.command}" ${L.args.map((a) => `"${a}"`).join(' ')}`;
    const entry = { command: L.command, args: L.args, ...(Object.keys(L.env || {}).length ? { env: L.env } : {}) };
    const cd = JSON.stringify({ mcpServers: { 'mcp-browser': entry } }, null, 2);
    $('[data-cc-cmd]', box).textContent = cc;
    $('[data-cd-json]', box).textContent = cd;
    const texts = { cc, cd, ollama: 'ollama pull qwen3:8b' };
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      try {
        await navigator.clipboard.writeText(texts[b.dataset.copy]);
        b.textContent = 'Copied';
      } catch {
        const sel = window.getSelection();
        sel.selectAllChildren(b.previousElementSibling);
        b.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Press ⌘C' : 'Press Ctrl+C';
      }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
    $('[data-open-settings]', box).addEventListener('click', () => open('mcp://settings'));
    $('[data-use-ollama]', box).addEventListener('click', async () => {
      const msg = $('[data-ollama-msg]', box);
      try {
        await api.post('/api/settings', { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' });
        msg.textContent = 'Done. Make sure Ollama is running, then ask a question.';
        refreshStatus();
        setTimeout(() => (box.hidden = true), 2500);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    const toggle = $('[data-setup-toggle]', box);
    toggle.addEventListener('click', () => {
      const body = $('[data-setup-body]', box);
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      toggle.textContent = body.hidden ? 'Set up' : 'Close';
    });
    $('[data-setup-close]', box).addEventListener('click', () => {
      box.hidden = true;
      try {
        localStorage.setItem('mcpb.setup.hidden', '1');
      } catch {
        /* storage blocked */
      }
    });
    box.hidden = false;
  }

  // ---------- watches ----------
  function wireWatchForm(turn, query, entry) {
    const form = $('[data-watch-form]', turn);
    const pick = $('[data-watch-pick]', form);
    const done = $('[data-watch-done]', form);
    const toggle = $('[data-watch-toggle]', form);
    toggle.addEventListener('click', () => {
      pick.hidden = !pick.hidden;
      toggle.setAttribute('aria-expanded', String(!pick.hidden));
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const every = $('[data-watch-every]', form).value;
      try {
        // A follow-up re-runs on its own (without the earlier turns), so it gets its own label.
        const firstTurn = entry.turns.length === 0 || entry.query === query;
        await api.post('/api/watches', { query, every, discovery: Boolean(entry.discovery), label: firstTurn ? entry.label || '' : '', ...(firstTurn && entry.servers ? { servers: entry.servers, adhoc: entry.adhoc } : {}) });
        askNotify();
        pick.hidden = true;
        toggle.hidden = true;
        done.hidden = false;
        done.textContent = `Watching ${every === 'hourly' ? 'every hour' : every === 'daily' ? 'every day' : 'every week'}`;
      } catch (err) {
        done.hidden = false;
        done.textContent = err.message;
      }
    });
  }

  function timeAgo(t) {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 0) return 'soon';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  }

  function buildWatches(entry = {}) {
    const el = $('#tpl-watches').content.firstElementChild.cloneNode(true);
    const list = $('[data-watch-list]', el);
    // "Tell me when …": parse the sentence, show what will be watched, then save it.
    const twText = $('[data-tw-text]', el);
    const twPrev = $('[data-tw-preview]', el);
    const TW_EX = ['Tell me when NVDA drops below 200', 'Tell me when bitcoin goes above 100k', 'Tell me when USD to JPY is above 160', 'Tell me when GTA 6 is out', 'Tell me about new recalls for Kia Sorento', 'Tell me about new papers on solid-state batteries'];
    $('[data-tw-examples]', el).innerHTML = TW_EX.map((x) => `<button type="button" data-tw-ex="${esc(x)}">${esc(x)}</button>`).join('');
    async function propose(text) {
      let p;
      try {
        p = await api.post('/api/track/parse', { text });
      } catch (e) {
        twPrev.hidden = false;
        twPrev.innerHTML = `<p class="lr-fail">${esc(e.message)}</p>`;
        return;
      }
      const line = p.when ? `${p.when.value.toLocaleString()}${p.when.unit === '%' ? '%' : ''}` : '';
      const opText = p.when?.op === 'reach' ? 'reaches' : `goes ${p.when?.op}`;
      // What it reads right now, so you can see it's reading the right number.
      const now = p.now ? ` Right now it reads <b>${esc(p.now.value.toLocaleString())}</b>${p.now.met ? ', already past the line: you’ll be told once a second check confirms it' : ''}. If that isn’t the figure you mean, cancel and word it differently.` : p.kind === 'threshold' && p.nowChecked ? ' It couldn’t read a figure right now; it will try again on each check.' : '';
      const what = p.kind === 'threshold' ? `When the figure in the answer to <q>${esc(p.query)}</q> ${esc(opText)} <b>${esc(line)}</b>, you get a notification and it stops.${now}` : p.kind === 'until' ? `When a source says <b>${esc(p.label.split(': ')[0])}</b> has been ${esc(p.until)} (not a trailer, a pre-order or a date it’s expected), you get a notification and it stops.` : `Each new source about <q>${esc(p.query)}</q> is news: you get a notification when there are new ones.`;
      twPrev.hidden = false;
      twPrev.innerHTML = `<p>${what}</p>${p.note ? `<p class="hint">${esc(p.note)}</p>` : ''}<div class="tw-acts"><label>Check <select data-tw-every><option value="hourly">every hour</option><option value="daily">every day</option><option value="weekly">every week</option></select></label><button type="button" class="la-btn" data-tw-save>Start watching</button><button type="button" class="link-btn" data-tw-cancel>Cancel</button></div>`;
      $('[data-tw-every]', twPrev).value = p.every;
      $('[data-tw-cancel]', twPrev).onclick = () => (twPrev.hidden = true);
      $('[data-tw-save]', twPrev).onclick = async () => {
        try {
          await api.post('/api/watches', { query: p.query, label: p.label, every: $('[data-tw-every]', twPrev).value, until: p.until, untilAbout: p.untilAbout, when: p.when });
        } catch (e) {
          twPrev.innerHTML = `<p class="lr-fail">${esc(e.message)}</p>`;
          return;
        }
        askNotify();
        twPrev.hidden = true;
        twText.value = '';
        load();
      };
    }
    $('[data-tw-form]', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const t = twText.value.trim();
      if (t) propose(/^(?:tell|notify|alert|track|watch|let)\b/i.test(t) ? t : `tell me when ${t}`);
    });
    el.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-tw-ex]');
      if (ex) {
        twText.value = ex.dataset.twEx;
        propose(ex.dataset.twEx);
      }
    });
    if (entry.track) {
      twText.value = entry.track;
      propose(entry.track);
    }
    async function load() {
      let data;
      try {
        data = await api.get('/api/watches');
      } catch (e) {
        list.innerHTML = `<li class="empty">Could not load watches: ${esc(e.message)}</li>`;
        return;
      }
      list.innerHTML = '';
      if (!data.watches.length) {
        list.innerHTML = '<li class="empty">No watches yet. Run a search, then press Watch next to the question.</li>';
        return;
      }
      for (const w of data.watches) list.appendChild(watchRow(w));
      if (data.watches.some((w) => w.running)) setTimeout(() => el.isConnected && load(), 3000);
      refreshStatus();
    }
    function watchRow(w) {
      const li = document.createElement('li');
      li.className = 'watch-row' + (w.unseen ? ' has-news' : '');
      const last = w.history[0];
      const src = w.deps ? ['advisory', 'advisories'] : ['source', 'sources'];
      const state = w.running
        ? 'Running now…'
        : !w.lastRun
          ? 'Waiting for the first run'
          : w.lastRun.error
            ? `Last run failed: ${w.lastRun.error}`
            : last?.first
              ? w.page
                ? `First read ${timeAgo(w.lastRun.at)}: saved as the baseline`
                : `First run ${timeAgo(w.lastRun.at)}: ${w.lastRun.sources?.length || 0} ${src[1]} saved as the baseline`
              : w.page && last?.changed
                ? `Changed ${timeAgo(last.at)}: ${last.addedCount || 0} line${last.addedCount === 1 ? '' : 's'} added, ${last.removedCount || 0} removed`
              : last?.changed
                ? `Changed ${timeAgo(last.at)}: ${last.newSources.length} new ${last.newSources.length === 1 ? src[0] : src[1]}${last.similarity < 0.75 && !w.deps ? ', answer reworded' : ''}`
                : `No changes ${timeAgo(w.lastRun.at)}`;
      li.innerHTML = `
        <div class="watch-main">
          <div class="watch-title">${w.unseen ? '<span class="new-pill">New</span>' : ''}${esc(w.label || w.query)}</div>
          ${w.met ? (w.when ? `<div class="watch-met"><b>${esc(w.when.op === 'below' ? 'Below' : 'Above')} ${esc(w.when.value.toLocaleString())}</b> ${esc(timeAgo(w.met.at))}, so it stopped: ${esc(w.met.snippet)}</div>` : `<div class="watch-met"><b>Found “${esc(w.until)}”</b> ${esc(timeAgo(w.met.at))}, so it stopped: …${esc(w.met.snippet)}…</div>`) : ''}
          ${w.when && !w.met ? `<div class="watch-line">Tells you when it ${w.when.op === 'reach' ? 'reaches' : `goes ${esc(w.when.op)}`} <b>${esc(w.when.value.toLocaleString())}</b>${w.lastValue ? ` · last ${esc(Number(w.lastValue.value).toLocaleString())} (${esc(timeAgo(w.lastValue.at))})` : ''}${w.lastMiss ? ` · last reading ignored (${w.lastMiss.value == null ? 'no figure found' : `${esc(Number(w.lastMiss.value).toLocaleString())} looked wrong; taken if the next check agrees`})` : ''}</div>` : ''}
          <div class="watch-state">${w.pipeline ? '<span class="cat-tag">Pipeline</span> ' : w.deps ? '<span class="cat-tag">Packages</span> ' : w.page ? '<span class="cat-tag">Page</span> ' : ''}${esc(state)}${w.met ? '' : ` · next ${esc(w.nextRunAt > Date.now() ? new Date(w.nextRunAt).toLocaleString() : 'soon')}`}${w.until && !w.met ? (w.untilRe ? ` · stops when a source says it’s ${esc(w.until)}` : ` · stops when it mentions “${esc(w.until)}”`) : ''}</div>
          <details class="watch-hist">
            <summary>History (${w.history.length})</summary>
            <ol></ol>
          </details>
        </div>
        <div class="watch-actions">
          <select aria-label="How often">
            <option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option>
          </select>
          <button data-act="open">Open</button>
          <button data-act="run">Run now</button>
          <button data-act="delete">Delete</button>
        </div>`;
      const sel = $('select', li);
      sel.value = w.every;
      sel.addEventListener('change', () => api.post('/api/watches/update', { id: w.id, every: sel.value }).then(load));
      const ol = $('ol', li);
      for (const h of w.history) {
        const item = document.createElement('li');
        const head = document.createElement('div');
        head.textContent = `${new Date(h.at).toLocaleString()}: ${h.error ? `failed (${h.error})` : h.first ? 'first run' : h.changed ? (w.page ? `${h.addedCount || 0} added, ${h.removedCount || 0} removed` : `${h.newSources.length} new ${h.newSources.length === 1 ? src[0] : src[1]}`) : 'no changes'}`;
        item.appendChild(head);
        // (a page: the lines that changed, as text)
        if (w.page && h.changed && (h.added?.length || h.removed?.length)) {
          const ul = document.createElement('ul');
          ul.className = 'watch-diff';
          for (const [sign, lines] of [['+', h.added || []], ['−', h.removed || []]])
            for (const l of lines) {
              const li2 = document.createElement('li');
              li2.dataset.sign = sign;
              li2.textContent = `${sign} ${l}`;
              ul.appendChild(li2);
            }
          item.appendChild(ul);
        }
        if (h.newSources?.length && !h.first) {
          const ul = document.createElement('ul');
          for (const s of h.newSources) {
            const a = document.createElement('a');
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = s.title || hostOf(s.url);
            const sli = document.createElement('li');
            sli.appendChild(a);
            ul.appendChild(sli);
          }
          item.appendChild(ul);
        }
        ol.appendChild(item);
      }
      $('details', li).addEventListener('toggle', (e) => {
        if (e.target.open && w.unseen) api.post('/api/watches/update', { id: w.id, seen: true }).then(() => {
          li.classList.remove('has-news');
          $('.new-pill', li)?.remove();
          refreshStatus();
        });
      });
      li.addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        if (b.dataset.act === 'open' && w.page) return navigate(active, { kind: 'web', url: w.page });
        if (b.dataset.act === 'open' && w.deps) return navigate(active, { kind: 'deps', text: w.deps.map((p) => (p.ecosystem === 'pypi' ? `${p.name}==${p.version}` : `${p.name}@${p.version}`)).join('\n') });
        if (b.dataset.act === 'open') return navigate(active, { kind: 'search', query: w.query, discovery: w.discovery, label: w.label });
        if (b.dataset.act === 'run') {
          b.disabled = true;
          await api.post('/api/watches/run', { id: w.id }).catch(() => {});
          setTimeout(load, 800);
        }
        if (b.dataset.act === 'delete') {
          if (b.dataset.confirm !== '1') {
            b.dataset.confirm = '1';
            b.textContent = 'Delete watch?';
            return;
          }
          await api.post('/api/watches/delete', { id: w.id });
          load();
        }
      });
      return li;
    }
    load();
    return el;
  }

  // ---------- templates ----------
  let templatesCache = null;
  async function renderTemplates(tab, el) {
    try {
      templatesCache ??= (await api.get('/api/templates')).templates;
    } catch {
      return;
    }
    const wrap = $('[data-templates]', el);
    const list = $('[data-tpl-list]', el);
    const form = $('[data-tpl-form]', el);
    const groups = {};
    for (const t of templatesCache) (groups[t.group] ||= []).push(t);
    for (const [g, items] of Object.entries(groups)) {
      const box = document.createElement('div');
      box.className = 'tpl-group';
      box.innerHTML = `<h3>${esc(g)}</h3>`;
      for (const t of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tpl-card';
        b.innerHTML = `<b>${esc(t.title)}</b><span>${esc(t.description)}</span>`;
        b.addEventListener('click', () => showForm(t));
        box.appendChild(b);
      }
      list.appendChild(box);
    }
    wrap.hidden = false;
    let current = null;
    function showForm(t) {
      current = t;
      $('[data-tpl-title]', form).textContent = t.title;
      $('[data-tpl-desc]', form).textContent = t.description;
      $('[data-tpl-note]', form).textContent = t.discovery ? 'Also searches community servers from the MCP Registry (ad libraries, social, SEO tools) for this question.' : '';
      const fields = $('[data-tpl-fields]', form);
      fields.innerHTML = '';
      for (const f of t.fields) {
        const l = document.createElement('label');
        l.innerHTML = `<span>${esc(f.label)}</span><input name="${esc(f.name)}" placeholder="${esc(f.placeholder)}" required maxlength="200">`;
        fields.appendChild(l);
      }
      list.hidden = true;
      form.hidden = false;
      $('input', fields)?.focus();
    }
    $('[data-tpl-cancel]', form).addEventListener('click', () => {
      form.hidden = true;
      list.hidden = false;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const vals = Object.fromEntries([...form.querySelectorAll('[data-tpl-fields] input')].map((i) => [i.name, i.value.trim()]));
      const query = current.prompt.replace(/\{(\w+)\}/g, (_, k) => vals[k] || `[${k}]`);
      const label = `${current.title}: ${Object.values(vals).filter(Boolean).join(', ')}`;
      navigate(tab, { kind: 'search', query, discovery: current.discovery, label });
    });
  }

  // ---------- MCP Rank ----------
  function fmtStars(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  }
  /** GitHub stars badge (+ archived / stale / missing flags) for a server or rank result. */
  // A plain link to the server's source repo (GitHub or elsewhere), when known.
  function repoLink(s) {
    const href = s.github?.url || (s.github?.repo ? `https://github.com/${s.github.repo}` : '') || s.repo || '';
    if (!/^https?:\/\//i.test(href) || s.github?.missing) return '';
    const label = /github\.com/i.test(href) ? 'GitHub' : /gitlab\.com/i.test(href) ? 'GitLab' : 'Source';
    return `<a class="srv-site srv-repo" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href.replace(/^https?:\/\//, ''))}">${label}</a> `;
  }

  function starChip(g) {
    if (!g || g.unknown) return '';
    if (g.missing) return `<span class="badge warn" title="${esc(`GitHub repo ${g.repo} not found: deleted, renamed or private.`)}">repo gone</span>`;
    const days = g.pushedAt ? Math.floor((Date.now() - Date.parse(g.pushedAt)) / 864e5) : null;
    const title = `${g.stars.toLocaleString()} GitHub stars · ${g.repo}${g.sharedWith ? ` (one repo shared by ${g.sharedWith + 1} servers)` : ''}${g.pushedAt ? ` · last commit ${g.pushedAt}` : ''}\nPopularity, not answer quality.`;
    const borrowed = g.otherOwner ? `<span class="badge warn" title="${esc(`The publisher's GitHub account doesn't own ${g.repo}. Often fine (a company org), but the stars may not be this server's.`)}">other owner</span>` : '';
    const flag = borrowed + (g.archived ? '<span class="badge warn" title="Archived on GitHub: no longer maintained">archived</span>' : days != null && days > 365 ? '<span class="badge" title="No commits for over a year">stale</span>' : '');
    return `<a class="badge stars" href="${esc(g.url || `https://github.com/${g.repo}`)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">★ ${fmtStars(g.stars)}${g.sharedWith ? '*' : ''}</a>${flag}`;
  }

  function buildRank(entry) {
    const el = $('#tpl-rank').content.firstElementChild.cloneNode(true);
    const tabsEl = $('[data-rank-tabs]', el);
    const list = $('[data-rank-list]', el);
    const meta = $('[data-rank-meta]', el);
    const statusEl = $('[data-rank-status]', el);
    const runBtn = $('[data-rank-run]', el);
    let data = null;
    let cat = entry.category || 'web-search';

    async function load() {
      try {
        data = await api.get('/api/rank');
      } catch (e) {
        list.innerHTML = `<li class="empty">Could not load rankings: ${esc(e.message)}</li>`;
        return;
      }
      tabsEl.innerHTML = '';
      for (const [k, v] of Object.entries(data.suites)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.role = 'tab';
        b.textContent = v.title;
        b.setAttribute('aria-selected', String(k === cat));
        b.addEventListener('click', () => {
          cat = entry.category = k;
          load();
        });
        tabsEl.appendChild(b);
      }
      const st = data.state;
      runBtn.disabled = st.running;
      statusEl.textContent = st.running ? `Testing ${st.category}: ${st.progress?.done || 0} of ${st.progress?.total || '?'} servers…` : st.error ? `Last run failed: ${st.error}` : '';
      if (st.running) setTimeout(() => el.isConnected && load(), 2500);
      render();
    }

    function render() {
      const c = data.categories?.[cat];
      list.innerHTML = '';
      if (!c) {
        meta.textContent = '';
        list.innerHTML = '<li class="empty">Not tested yet. Run tests to rank the servers in this category (takes a minute or two).</li>';
        return;
      }
      meta.textContent = `${c.results.length} servers tested on ${new Date(c.ranAt).toLocaleString()} with ${c.tests.length} known-answer questions${c.aiAssisted ? ' (an AI model filled arguments for servers without a plain search tool)' : ''}: ${c.tests.join(' · ')}`;
      c.results.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'rank-row';
        const acc = r.accuracy == null ? 'not measured' : `${Math.round(r.accuracy * 100)}% correct${r.method === 'ai' ? ' (AI-assisted)' : ''}`;
        const speed = r.medianMs == null ? '' : `${(r.medianMs / 1000).toFixed(1)}s`;
        const flags = [
          r.reachable ? null : 'unreachable',
          r.paywall ? 'paywall' : null,
          r.rateLimited ? 'rate limited' : null,
          r.injected ? 'injects text' : null,
        ].filter(Boolean);
        li.innerHTML = `
          <div class="rank-score" style="--s:${r.avgScore ?? r.score}" title="${r.runs > 1 ? `Average of ${r.runs} runs; last run ${r.score}` : 'One run so far'}"><b>${r.avgScore ?? r.score}</b></div>
          <div class="rank-main">
            <div class="srv-title">${esc(r.title)} <span class="badge ${esc(r.source)}">${r.source === 'curated' ? 'Curated' : r.source === 'registry' ? 'Registry' : 'Added by you'}</span>${flags.map((f) => `<span class="badge warn">${esc(f)}</span>`).join('')}${starChip(r.github)}</div>
            <div class="rank-stats">${esc(acc)}${speed ? ` · ${esc(speed)} median` : ''}${r.tools != null ? ` · ${r.tools} tool${r.tools === 1 ? '' : 's'}` : ''}</div>
            ${r.issues.length ? `<details><summary>Report card (${r.issues.length})</summary><ul>${r.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>${r.tests.length ? `<ul class="rank-tests">${r.tests.map((t) => `<li class="${t.untested ? '' : t.pass ? 'ok' : 'bad'}">${t.untested ? '–' : t.pass ? '✓' : '✗'} ${esc(t.asked || t.q)}${t.untested ? ` (not counted: ${esc(t.untested)})` : ''}</li>`).join('')}</ul>` : ''}</details>` : '<p class="rank-clean">No problems found.</p>'}
            <div class="srv-url">${esc(r.id)}</div>
          </div>`;
        list.appendChild(li);
      });
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try {
        await api.post('/api/rank/run', { category: cat, limit: 20 });
      } catch (e) {
        statusEl.textContent = e.message;
      }
      load();
    });
    load();
    return el;
  }

  // ---------- web (desktop only) ----------
  function buildWeb(entry) {
    const el = document.createElement('section');
    el.className = 'page web';
    const wv = document.createElement('webview');
    wv.setAttribute('src', entry.url);
    wv.setAttribute('partition', 'persist:web');
    wv.addEventListener('page-title-updated', (e) => {
      const tab = tabs.find((t) => t.history.includes(entry));
      if (tab) setTitle(tab, entry, e.title);
    });
    wv.addEventListener('did-navigate', (e) => {
      entry.url = e.url;
      if (current() === entry) omni.value = e.url;
    });
    // "Open with" bar: what MCP servers can do with this page.
    const bar = document.createElement('div');
    bar.className = 'la-bar';
    const renderBar = () => {
      const info = window.MCPLinkActions?.actionsFor(entry.url);
      const host = /^https?:/i.test(entry.url) ? hostOf(entry.url).replace(/^www\./, '') : '';
      // Any site: is it up, risky, its certificate, what people say (the website card).
      const site = host && /\.[a-z]{2,}$/i.test(host) ? `<button type="button" class="la-btn" data-la-site="${esc(host)}" title="Uptime, risk check, certificate and reputation from several servers">Check this site</button><button type="button" class="la-btn" data-la-watch title="Read this page again every day and tell you when its text changes">Watch this page</button>` : '';
      if (!info && !site) return (bar.hidden = true);
      bar.hidden = false;
      const first = info?.groups[0];
      bar.innerHTML = `<span class="la-name">Ask about this page:</span>${site}${first ? first.actions.map((a, ai) => `<button type="button" class="la-btn" data-la="0:${ai}" title="${esc(a.prompt)}">${esc(a.label)}</button>`).join('') : ''}${info ? '<button type="button" class="link-btn" data-la-more>More…</button>' : ''}`;
      bar.__info = info;
    };
    bar.addEventListener('click', (e) => {
      const sc = e.target.closest('[data-la-site]');
      if (sc) return newTab({ kind: 'search', query: `is ${sc.dataset.laSite} safe` });
      const pw = e.target.closest('[data-la-watch]');
      if (pw) {
        pw.disabled = true;
        return api
          .post('/api/watches', { page: entry.url, label: entry.title && entry.title !== hostOf(entry.url) ? entry.title : '', every: 'daily' })
          .then(() => ((pw.textContent = 'Watching: checked daily'), askNotify(), refreshStatus?.()))
          .catch((err) => ((pw.textContent = `Couldn’t watch: ${err.message}`), (pw.disabled = false)));
      }
      if (e.target.closest('[data-la-more]')) return navigate(tabs.find((t) => t.history.includes(entry)) || active, { kind: 'link', url: entry.url });
      const b = e.target.closest('[data-la]');
      if (b) newTab({ kind: 'link', url: entry.url, autorun: b.dataset.la });
    });
    wv.addEventListener('did-navigate', renderBar);
    renderBar();
    el.appendChild(bar);
    el.appendChild(wv);
    entry.webview = wv;
    // WebMCP: tools the page offers (bar + "Tools on this page" panel).
    window.MCPPageTools?.attach({ el, wv, entry, runInline });
    return el;
  }

  // ---------- search ----------
  function buildSearch(tab, entry) {
    const el = $('#tpl-search').content.firstElementChild.cloneNode(true);
    entry.turns = [];
    entry.title = entry.label || entry.query;
    const thread = $('[data-thread]', el);
    const follow = $('[data-followup]', el);
    follow.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('input', follow);
      const q = input.value.trim();
      if (!q || entry.busy) return;
      input.value = '';
      runTurn(tab, entry, thread, q);
    });
    runTurn(tab, entry, thread, entry.query);
    return el;
  }

  async function runTurn(tab, entry, thread, query, opts = {}) {
    const turn = $('#tpl-turn').content.firstElementChild.cloneNode(true);
    thread.appendChild(turn);
    $('[data-q]', turn).textContent = query;
    // Not what you wanted? The same question elsewhere, one click away.
    const ew = $('[data-elsewhere]', turn);
    if (ew && window.MCPBangs) ew.innerHTML = `<span>Also search</span> ${window.MCPBangs.elsewhere(query).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>`).join('')}`;
    if (opts.wide) $('[data-q]', turn).insertAdjacentHTML('beforeend', ' <small class="wide-tag">wider search</small>');
    // Money, health and legal questions: a quiet reminder that results are sources, not advice.
    const advice = adviceTopic(query);
    if (advice) {
      const note = $('[data-advice-note]', turn);
      note.textContent = `These are third-party sources, not ${advice} advice. Check with a licensed professional before acting on them.`;
      note.hidden = false;
    }
    wireWatchForm(turn, query, entry);
    // One thing named (a company, a city, a CVE, a website…): a card from several servers at once.
    if (!opts.servers?.length) loadCard($('[data-card]', turn), query);
    if (entry.turns.length) turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const ui = {
      board: $('[data-switchboard]', turn),
      answer: $('[data-answer]', turn),
      direct: $('[data-direct]', turn),
      directExtra: $('[data-direct-extra]', turn),
      boardSummary: $('[data-board-summary]', turn),
      empties: [],
      ads: [],
      groups: [], // useful free-mode results, for Copy as Markdown
      quick: null,
      wide: Boolean(opts.wide),
      // Ask the same question again with a bigger net (more servers, more time).
      wider: () => !entry.busy && runTurn(tab, entry, thread, query, { wide: true }),
      notice: $('[data-notice]', turn),
      activity: $('[data-activity]', turn),
      activityCount: $('[data-activity-count]', turn),
      sourcesWrap: $('[data-sources-wrap]', turn),
      sources: $('[data-sources]', turn),
      nodes: new Map(),
      calls: new Map(),
      text: '',
      sourceList: [],
      mode: null,
      renderPending: false,
    };
    const copyBtn = $('[data-copy-md]', turn);
    copyBtn?.addEventListener('click', async () => {
      const md = turnMarkdown(ui, query);
      try {
        await navigator.clipboard.writeText(md);
        copyBtn.textContent = 'Copied';
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    });
    const history = entry.turns.slice(-3);
    entry.busy = true;
    tab.btn.classList.add('busy');
    const ac = new AbortController();
    entry.abort = ac;
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcpb': '1' },
        // A question asked from the catalog goes to that one server (first turn only).
        body: JSON.stringify({ query, history, discovery: Boolean(entry.discovery), wide: Boolean(opts?.wide), ...(entry.servers && !history.length ? { servers: entry.servers, ...(entry.adhoc ? { adhoc: entry.adhoc } : {}) } : {}), ...(entry.page ? { page: entry.page.info() } : {}) }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      // A page tool the agent asked for runs in the web tab; the result goes back to the server.
      await readSSE(res.body, (type, data) => (type === 'page_tool_call' ? entry.page?.answer(data) : onEvent(ui, type, data)));
    } catch (e) {
      if (!ac.signal.aborted) showNotice(ui, `Search failed: ${e.message}. Check that the MCP Browser server is still running.`, 'error');
    } finally {
      entry.busy = false;
      tab.btn.classList.remove('busy');
      for (const [, n] of ui.nodes) if (n.dataset.state === 'connecting' || n.dataset.state === 'working') n.dataset.state = 'idle';
      entry.turns.push({ q: query, a: ui.text || summarizeDirect(ui) });
      // Go deeper: run a step over each result (a pipeline built on the spot).
      const deeper = $('[data-deeper]', turn);
      if (deeper && !entry.inline && !ac.signal.aborted && (ui.direct?.querySelectorAll('a[href]').length || 0) + turn.querySelectorAll('[data-sources] li').length >= 3) {
        const GO = [
          ['More coverage of each', '{title}'],
          ['Code for each', '{title} github code'],
          ['Discussion of each', '{title} reddit OR hacker news discussion'],
        ];
        deeper.innerHTML = `<span>Go deeper</span>${GO.map(([l], k) => `<button type="button" class="la-btn" data-deeper-k="${k}">${esc(l)}</button>`).join('')}`;
        deeper.hidden = false;
        deeper.onclick = (e) => {
          const b = e.target.closest('[data-deeper-k]');
          if (!b) return;
          const [label, ask] = GO[Number(b.dataset.deeperK)];
          newTab({ kind: 'pipelines', run: { input: query, pipeline: { id: 'go-deeper', title: `${label}: ${query}`, input: { label: 'Question', example: query }, steps: [{ ask: '{input}', max: 4 }, { ask, each: true }] } } });
        };
      }
      if (ui.answer.querySelector('.placeholder')) ui.answer.innerHTML = '';
    }
  }

  async function readSSE(body, cb) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let type = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          cb(type, JSON.parse(data));
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  function onEvent(ui, type, d) {
    switch (type) {
      case 'provider':
        ui.mode = d.provider;
        break;
      case 'rewrite': {
        // Free mode read a short follow-up against the last question: say what it searched.
        const ew = $('[data-elsewhere]', ui.board.closest('.turn') || document);
        const note = document.createElement('p');
        note.className = 'rewrite-note';
        note.textContent = `Searched for “${d.query}”`;
        (ew || ui.board).insertAdjacentElement('beforebegin', note);
        break;
      }
      case 'route': {
        ui.board.innerHTML = '';
        const you = document.createElement('span');
        you.className = 'sb-origin';
        you.textContent = 'Your question';
        ui.board.appendChild(you);
        for (const s of d.servers) {
          const n = document.createElement('span');
          n.className = 'sb-node';
          n.dataset.state = 'idle';
          n.dataset.trust = s.trust;
          n.title = `${s.title}\n${s.reason}${s.rank != null ? `\nBest MCP Rank score: ${s.rank}/100` : ''}${s.trust === 'community' ? '\nCommunity server: results are treated with extra care.' : ''}`;
          n.innerHTML = `<i aria-hidden="true"></i><b>${esc(s.title)}</b><small></small>`;
          ui.board.appendChild(n);
          ui.nodes.set(s.id, n);
        }
        for (const h of d.signIn || []) {
          const b = document.createElement('button');
          b.className = 'sb-node signin-hint';
          b.title = `Sign in to ${h.title} so questions like this can include your own data.`;
          b.innerHTML = `<i aria-hidden="true"></i><b>Sign in to ${esc(h.title)}</b><small>your data</small>`;
          b.addEventListener('click', () => navigate(active, { kind: 'servers', q: h.title }));
          ui.board.appendChild(b);
        }
        setPlaceholder(ui, `Asking ${d.servers.length} server${d.servers.length === 1 ? '' : 's'}…`);
        break;
      }
      case 'route_add': {
        const s = d.server;
        if (ui.nodes.has(s.id)) break;
        const n = document.createElement('span');
        n.className = 'sb-node discovered';
        n.dataset.state = 'idle';
        n.dataset.trust = s.trust;
        n.title = `${s.title}\n${s.reason}\nFound in the MCP Registry during this search.`;
        n.innerHTML = `<i aria-hidden="true"></i><b>${esc(s.title)}</b><small>found</small>`;
        ui.board.appendChild(n);
        ui.nodes.set(s.id, n);
        break;
      }
      case 'server': {
        let n = ui.nodes.get(d.id);
        // A backup web engine stepping in for one that failed gets its own chip.
        if (!n && d.backupFor && d.title) {
          n = document.createElement('span');
          n.className = 'sb-node';
          n.dataset.trust = d.trust === 'trusted' ? 'trusted' : 'community';
          n.title = `${d.title}\nAsked because ${ui.nodes.get(d.backupFor)?.querySelector('b')?.textContent || 'another web search'} didn't answer.`;
          n.innerHTML = `<i aria-hidden="true"></i><b>${esc(d.title)}</b><small></small>`;
          ui.board.appendChild(n);
          ui.nodes.set(d.id, n);
        }
        if (!n) break;
        n.dataset.state = d.status;
        const small = $('small', n);
        if (d.status === 'ready') small.textContent = `${d.tools} tool${d.tools === 1 ? '' : 's'}`;
        if (d.status === 'failed') {
          small.textContent = 'unreachable';
          n.title += `\n${d.error}`;
        }
        if (d.status === 'skipped') {
          small.textContent = /ticker/.test(d.error || '') ? 'needs a ticker' : 'needs AI';
          n.title += `\n${d.error}`;
        }
        if (d.blocked?.length) n.title += `\nWrite actions hidden: ${d.blocked.map((b) => b.name).join(', ')}`;
        break;
      }
      case 'step':
        if (d.n > 1 && ui.text.trim()) addActivity(ui, { kind: 'note', text: ui.text.trim() });
        ui.text = '';
        if (d.n > 1) setPlaceholder(ui, 'Reading results…');
        break;
      case 'text':
        ui.text += d.delta;
        scheduleRender(ui);
        break;
      case 'tool_call': {
        const n = ui.nodes.get(d.serverId);
        if (n) n.dataset.state = 'working';
        const item = addActivity(ui, { kind: 'call', server: d.serverTitle || '?', tool: d.tool, args: d.args });
        ui.calls.set(d.callId, { item, serverId: d.serverId });
        break;
      }
      case 'tool_result': {
        const c = ui.calls.get(d.callId);
        if (!c) break;
        const n = ui.nodes.get(c.serverId);
        if (n) {
          n.dataset.calls = String(Number(n.dataset.calls || 0) + 1);
          if (d.ok && (d.kind === 'empty' || d.kind === 'ad') && n.dataset.state !== 'answered') {
            n.dataset.state = d.kind === 'ad' ? 'ad' : 'empty';
            $('small', n).textContent = d.kind === 'ad' ? 'sales pitch' : 'no results';
          } else {
            n.dataset.state = d.ok ? 'answered' : 'failed';
            $('small', n).textContent = d.ok ? `${n.dataset.calls} result${n.dataset.calls === '1' ? '' : 's'}` : 'error';
          }
        }
        finishActivity(c.item, d);
        break;
      }
      case 'results':
        addDirectCard(ui, d);
        break;
      case 'quick_answer': {
        ui.quick = d;
        // Quoted word for word from a result; the source link is the point.
        const box = document.createElement('figure');
        box.className = 'quick-answer';
        box.innerHTML = `<blockquote>${esc(d.text)}</blockquote><figcaption>${
          d.url
            ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.site || hostOf(d.url))}</a> <span>quoted from ${esc(d.server || 'a result')}; check the source</span>`
            : d.calculated === true
              ? '<span>Calculated by MCP Browser</span>'
              : `<span>Quoted from <a href="#" class="quoted-link">${esc(d.server || 'a result')}</a>, shown in full below</span>`
        }</figcaption>`;
        // Quoted from one page: one click checks it against the others.
        // (a statement, not a live price, a forecast or a list: those can't be checked against other pages)
        const claimLike = (t) => t.split(/\s+/).length >= 5 && /\b(?:is|was|are|were|has|have|had|invented|discovered|founded|wrote|won|created|built|became|released|launched|painted|designed|developed|acquired)\b/i.test(t) && !/\([A-Z.^-]{1,10}\)\s*:|1-day change|°|\b(?:forecast|today|now|right now|currently)\b|^\s*[-•*]/i.test(t);
        if (!d.calculated && d.text && d.text.length <= 300 && claimLike(d.text)) {
          const ck = document.createElement('button');
          ck.type = 'button';
          ck.className = 'link-btn ck-btn';
          ck.textContent = 'Cross-check this';
          ck.addEventListener('click', () => newTab({ kind: 'check', claim: d.text.replace(/^[^:]{2,60}:\s+(?=\p{Lu})/u, '') }));
          box.querySelector('figcaption').appendChild(ck);
        }
        ui.answer.innerHTML = '';
        ui.answer.appendChild(box);
        // The card it quotes comes right after it, and the caption links to it.
        placeQuoted(ui);
        break;
      }
      case 'quick_agree': {
        // The same figure in other sources: listed under the quote.
        const cap = $('.quick-answer figcaption', ui.answer);
        if (!cap || ui.quick?.text !== d.text || !d.sources?.length) break;
        $('.agree', cap)?.remove();
        const links = d.sources.map((x) => (x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>` : esc(x.name)));
        cap.insertAdjacentHTML('beforeend', `<span class="agree">Same figure in ${d.sources.length === 1 ? '1 other source' : `${d.sources.length} other sources`}: ${links.join(', ')}</span>`);
        break;
      }
      case 'sources':
        ui.sourceList = d.list || [];
        renderSources(ui);
        renderAnswer(ui);
        break;
      case 'answer':
        ui.text = d.text || ui.text;
        renderAnswer(ui);
        renderSources(ui);
        break;
      case 'error':
        showNotice(ui, d.message, 'error');
        break;
      case 'done':
        if (d.mode === 'direct') {
          // Only off-topic replies came back: open their fold instead of saying "nothing".
          if (!ui.direct.children.length && ui.offWrap) ui.offWrap.open = true;
          if (!ui.direct.children.length && !ui.offWrap) showEmptyState(ui);
          else {
            showFreeTip(ui);
            // Few answers: offer a wider search for this one question.
            if (ui.direct.children.length < 3 && !ui.wide) {
              const p = document.createElement('p');
              p.className = 'wider-line';
              p.innerHTML = `Only ${ui.direct.children.length} server${ui.direct.children.length === 1 ? '' : 's'} had results. <button type="button" class="link-btn">Search wider</button> asks more servers (takes a little longer).`;
              $('button', p).addEventListener('click', ui.wider);
              ui.directExtra.after(p);
            }
          }
        }
        summarizeBoard(ui);
        if (ui.answer.querySelector('.placeholder')) ui.answer.innerHTML = '';
        if (d.ms) ui.activityCount.textContent = `· ${ui.activity.children.length} steps · ${(d.ms / 1000).toFixed(1)}s`;
        break;
    }
  }

  function setPlaceholder(ui, text) {
    if (!ui.text) ui.answer.innerHTML = `<p class="placeholder">${esc(text)}</p>`;
  }

  function scheduleRender(ui) {
    if (ui.renderPending) return;
    ui.renderPending = true;
    requestAnimationFrame(() => {
      ui.renderPending = false;
      renderAnswer(ui);
    });
  }

  function renderAnswer(ui) {
    if (!ui.text) return;
    ui.answer.innerHTML = window.MD.render(ui.text, ui.sourceList);
  }

  function renderSources(ui) {
    ui.sources.innerHTML = '';
    const extra = ui.sourcesWrap.querySelector('.more-sources');
    if (extra) extra.remove();
    if (!ui.sourceList.length) {
      ui.sourcesWrap.hidden = true;
      return;
    }
    ui.sourcesWrap.hidden = false;
    // Free mode: the results already show every link, so the rail becomes an
    // index of the servers that answered, in page order.
    ui.sources.classList.toggle('index', Boolean(!ui.text && ui.direct.children.length));
    if (!ui.text && ui.direct.children.length) {
      const h = ui.sourcesWrap.querySelector('h3');
      if (h) h.textContent = 'On this page';
      for (const g of ui.direct.children) {
        const li = document.createElement('li');
        const n = $('.via', g)?.textContent || '';
        li.innerHTML = `<a href="#${esc(g.id)}"><span class="src-title">${esc($('h3', g)?.textContent || '')}</span><span class="src-host">${esc(n)}</span></a>`;
        $('a', li).addEventListener('click', (e) => {
          e.preventDefault();
          g.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        ui.sources.appendChild(li);
      }
      return;
    }
    const h3 = ui.sourcesWrap.querySelector('h3');
    if (h3) h3.textContent = 'Sources';
    // With a written answer, list what it cites first; the rest go under "more".
    const cited = new Set();
    for (const m of ui.text.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)) for (const n of m[1].split(/\s*,\s*/)) cited.add(Number(n));
    const main = ui.text && cited.size ? ui.sourceList.filter((s) => cited.has(s.n)) : ui.sourceList;
    const rest = ui.text && cited.size ? ui.sourceList.filter((s) => !cited.has(s.n)) : [];
    const item = (s) => {
      const li = document.createElement('li');
      li.value = s.n;
      li.innerHTML = `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span class="src-title">${esc(s.title || hostOf(s.url))}</span><span class="src-host">${esc(hostOf(s.url))} · via ${esc(s.origin || '')}</span></a>`;
      return li;
    };
    for (const s of main) ui.sources.appendChild(item(s));
    if (rest.length) {
      const det = document.createElement('details');
      det.className = 'more-sources';
      det.innerHTML = `<summary>${rest.length} more found</summary><ol></ol>`;
      for (const s of rest) det.querySelector('ol').appendChild(item(s));
      ui.sourcesWrap.appendChild(det);
    }
  }

  /** Nothing useful came back: say why it may have happened and what to try. */
  function showEmptyState(ui) {
    ui.notice.hidden = false;
    ui.notice.className = 'notice empty-state';
    const tried = ui.nodes.size;
    ui.notice.innerHTML = `<p><b>No useful results.</b> ${tried ? `${tried} server${tried === 1 ? '' : 's'} were asked; none had an answer.` : 'No server matched this question.'} Try fewer or different words, or turn on Discovery to reach more servers.</p><p class="empty-actions">${ui.wide ? '' : '<button type="button" class="primary" data-wider>Search wider</button> '}<button type="button"${ui.wide ? ' class="primary"' : ''} data-retry>Try again</button> <button type="button" data-servers>Check servers</button></p>`;
    $('[data-wider]', ui.notice)?.addEventListener('click', ui.wider);
    $('[data-retry]', ui.notice).addEventListener('click', () => $('#reload').click());
    $('[data-servers]', ui.notice).addEventListener('click', () => open('mcp://servers'));
  }

  function adviceTopic(q) {
    const s = String(q || '');
    if (/\b(?:stocks?|shares?|invest(?:ing|ment)?s?|crypto|bitcoin|portfolio|etf|options trading|buy or sell|retire(?:ment)?|401k|ira)\b/i.test(s) && /\b(?:buy|sell|invest|should|best|top|pick|worth|hold|good)\b/i.test(s)) return 'financial';
    // (a plain unit conversion, "convert 500 mg to g", is not a medical question)
    if (/^\s*(?:convert\s+)?-?\d+(?:\.\d+)?\s*[a-zµ°]+\s+(?:to|in)\s+[a-zµ°]+\s*\??$/i.test(s)) return null;
    if (/\b(?:side effects?|dose|dosage|symptoms?|treatment|diagnos\w*|medication|drug interactions?|pregnan\w*|vaccines?)\b/i.test(s)) return 'medical';
    if (/\b(?:lawsuit|sue|legal advice|attorney|lawyer|small claims|custody|divorce|visa application|immigration|tenant rights|employment contract|breach of contract)\b/i.test(s)) return 'legal';
    return null;
  }

  /** Put the quoted server's card first, so the answer and its source sit together. */
  function placeQuoted(ui) {
    const name = ui.quick?.server;
    if (!name || ui.quick?.calculated) return;
    const id = ui.quick?.serverId;
    const card = [...ui.direct.children].find((c) => (id ? c.dataset.serverId === id : $('h3', c)?.textContent === name));
    if (!card) return; // not in yet: addDirectCard calls this again when it arrives
    for (const c of ui.direct.children) if (c !== card) delete c.dataset.quoted;
    card.dataset.quoted = '1';
    if (ui.direct.firstElementChild !== card) ui.direct.prepend(card);
    const link = $('.quoted-link', ui.answer);
    if (link && !link.dataset.wired) {
      link.dataset.wired = '1';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  /** The free-mode tip: shown until dismissed once (remembered in this browser). */
  function showFreeTip(ui) {
    try {
      if (localStorage.getItem('mcpb.freeTipDone') === '1' || sessionStorage.getItem('mcpb.freeTipShown') === '1') return;
      sessionStorage.setItem('mcpb.freeTipShown', '1');
    } catch {}
    // Below the results, once per session: the answer comes first.
    const p = document.createElement('p');
    p.className = 'free-tip notice info';
    p.innerHTML = 'Free mode shows each server\'s own results. <button type="button" class="link-btn" data-act="settings">Add an AI model</button> for one written answer with citations. <button type="button" class="link-btn" data-act="dismiss">Got it</button>';
    $('[data-act="settings"]', p).addEventListener('click', () => open('mcp://settings'));
    $('[data-act="dismiss"]', p).addEventListener('click', () => {
      try {
        localStorage.setItem('mcpb.freeTipDone', '1');
      } catch {}
      p.remove();
    });
    ui.directExtra.before(p);
  }

  function showNotice(ui, text, kind, prepend) {
    ui.notice.hidden = false;
    ui.notice.className = `notice ${kind}`;
    const p = document.createElement('p');
    p.textContent = text;
    if (prepend) ui.notice.prepend(p);
    else ui.notice.appendChild(p);
  }

  function addActivity(ui, a) {
    const li = document.createElement('li');
    if (a.kind === 'note') {
      li.className = 'act-note';
      li.textContent = a.text.length > 400 ? a.text.slice(0, 400) + '…' : a.text;
    } else {
      li.className = 'act-call pending';
      const args = JSON.stringify(a.args || {});
      li.innerHTML = `<div class="act-head"><b>${esc(a.server)}</b> <code>${esc(a.tool)}</code> <span class="act-meta">running…</span></div><div class="act-args">${esc(args.length > 300 ? args.slice(0, 300) + '…' : args)}</div>`;
    }
    ui.activity.appendChild(li);
    ui.activityCount.textContent = `· ${ui.activity.children.length}`;
    return li;
  }

  function finishActivity(li, d) {
    li.classList.remove('pending');
    li.classList.add(d.ok ? 'ok' : 'err');
    $('.act-meta', li).textContent = d.ok ? `${d.ms} ms · ${d.chars.toLocaleString()} chars${d.sources?.length ? ` · ${d.sources.length} links` : ''}` : `failed: ${d.error || 'error'}`;
    if (d.flags?.length) {
      const w = document.createElement('div');
      w.className = 'act-flag';
      w.textContent = `This result contained text trying to instruct the AI (${d.flags.join('; ')}). It was treated as data only.`;
      li.appendChild(w);
    }
    if (d.preview) {
      const det = document.createElement('details');
      det.innerHTML = `<summary>Preview</summary><pre>${esc(d.preview)}</pre>`;
      li.appendChild(det);
    }
  }

  /** The question, the answer (or quick answer + results) and sources, as Markdown. */
  function turnMarkdown(ui, query) {
    const out = [`# ${query}`, ''];
    const link = (title, url) => (url ? `[${String(title || url).replace(/[[\]]/g, '')}](${url})` : String(title || ''));
    if (ui.text) {
      out.push(ui.text.trim(), '');
      if (ui.sourceList.length) out.push('## Sources', '', ...ui.sourceList.map((s) => `${s.n}. ${link(s.title || hostOf(s.url), s.url)}`), '');
      return out.join('\n');
    }
    if (ui.quick) out.push(`> ${ui.quick.text}`, `> ${link(ui.quick.site || ui.quick.server, ui.quick.url)}`, '');
    const groups = [...ui.groups].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const g of groups) {
      out.push(`## ${g.serverTitle}`, '');
      const v = g.view || { kind: 'text', text: g.text };
      if (v.kind === 'items') for (const it of v.items) out.push(`- ${link(it.title, it.url)}${it.date ? ` (${it.date})` : ''}${it.text ? `: ${it.text}` : ''}`);
      else if (v.kind === 'table') out.push(`| ${v.columns.join(' | ')} |`, `| ${v.columns.map(() => '---').join(' | ')} |`, ...v.rows.map((r) => `| ${r.join(' | ')} |`));
      else if (v.kind === 'record') out.push(...v.facts.map((f) => `- ${f.label}: ${f.value}`));
      else out.push(String(v.text || '').slice(0, 2000));
      out.push('');
    }
    return out.join('\n');
  }

  /** One line under the server panel; quiet servers fold away when there are many. */
  function summarizeBoard(ui) {
    const nodes = [...ui.nodes.values()];
    const count = (st) => nodes.filter((n) => st.includes(n.dataset.state)).length;
    const parts = [
      [count(['answered']), 'answered'],
      [count(['offtopic']), 'off-topic'],
      [count(['empty']), 'no results'],
      [count(['ad']), 'sales pitch'],
      [count(['failed']), 'unreachable or error'],
      [count(['skipped', 'ready', 'idle', 'connecting', 'working']), 'need an AI model or didn\'t answer'],
    ].filter(([n]) => n);
    if (nodes.length < 6) return;
    ui.boardSummary.hidden = false;
    ui.boardSummary.textContent = `${nodes.length} servers asked: ${parts.map(([n, t]) => `${n} ${t}`).join(', ')}.`;
    const quiet = nodes.filter((n) => n.dataset.state !== 'answered');
    if (nodes.length > 6 && quiet.length) {
      for (const n of quiet) n.classList.add('sb-quiet');
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'link-btn';
      t.textContent = `Show all ${nodes.length}`;
      t.addEventListener('click', () => {
        const on = ui.board.classList.toggle('show-quiet');
        t.textContent = on ? 'Show only servers that answered' : `Show all ${nodes.length}`;
      });
      ui.boardSummary.append(' ', t);
    }
  }

  /** Empty replies and sales pitches go into one folded list instead of cards. */
  function renderDirectExtra(ui) {
    const parts = [];
    if (ui.empties.length)
      parts.push(`<details><summary>No results from ${ui.empties.length} server${ui.empties.length === 1 ? '' : 's'}</summary><ul>${ui.empties.map((e) => `<li><b>${esc(e.serverTitle)}</b> <span class="muted">${esc(e.reason || 'no results')}</span></li>`).join('')}</ul></details>`);
    if (ui.ads.length)
      parts.push(`<details><summary>${ui.ads.length} sales pitch${ui.ads.length === 1 ? '' : 'es'} hidden</summary><p class="muted">These servers answered with a price list or paid offer instead of an answer.</p><div class="direct">${ui.ads.map((a) => `<section class="direct-card ad"><header><b>${esc(a.serverTitle)}</b> <code>${esc(a.tool)}</code></header><pre class="direct-text">${esc(String(a.text).slice(0, 1500))}</pre></section>`).join('')}</div></details>`);
    ui.directExtra.innerHTML = parts.join('');
  }

  function niceDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return v || '';
    const t = new Date(`${v}T12:00:00Z`);
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- perspectives: who is saying it ----------
  // Each result is tagged by the kind of source, so a page can show only official
  // bodies, research, news or what people say.
  const NEWS_HOSTS = /(?:^|\.)(?:reuters\.com|apnews\.com|bbc\.(?:com|co\.uk)|npr\.org|nytimes\.com|theguardian\.com|washingtonpost\.com|wsj\.com|bloomberg\.com|cnbc\.com|cnn\.com|nbcnews\.com|abcnews\.go\.com|cbsnews\.com|axios\.com|politico\.com|ft\.com|economist\.com|aljazeera\.com|dw\.com|france24\.com|euronews\.com|latimes\.com|usatoday\.com|theverge\.com|techcrunch\.com|wired\.com|arstechnica\.com|forbes\.com|businessinsider\.com|time\.com|newsweek\.com|independent\.co\.uk|telegraph\.co\.uk|sky\.com|foxnews\.com|yahoo\.com|engadget\.com|tomshardware\.com|zdnet\.com|theatlantic\.com|vox\.com|nature\.com\/news)$|news/;
  const COMMUNITY_HOSTS = /(?:^|\.)(?:reddit\.com|news\.ycombinator\.com|stackoverflow\.com|stackexchange\.com|superuser\.com|quora\.com|bsky\.app|x\.com|twitter\.com|mastodon\.social|medium\.com|substack\.com|dev\.to|tiktok\.com|youtube\.com|facebook\.com|discord\.com|tripadvisor\.[a-z.]+|trustpilot\.com|github\.com\/[^/]+\/[^/]+\/issues)$|forum|community|discuss/;
  const RESEARCH_HOSTS = /(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|arxiv\.org|doi\.org|nature\.com|science\.org|cell\.com|thelancet\.com|nejm\.org|bmj\.com|jamanetwork\.com|springer\.com|link\.springer\.com|sciencedirect\.com|wiley\.com|plos\.org|frontiersin\.org|mdpi\.com|biorxiv\.org|medrxiv\.org|ssrn\.com|semanticscholar\.org|researchgate\.net|cochranelibrary\.com|acm\.org|ieee\.org|openreview\.net)$|\.edu$|\.ac\.[a-z]{2}$/;
  function perspectiveOf(it) {
    if (it.srcKind === 'official') return 'official';
    const h = it.site || hostOf(it.url || '');
    if (!h) return 'data';
    if (it.srcKind === 'primary' || it.srcKind === 'preprint' || RESEARCH_HOSTS.test(h)) return 'research';
    if (COMMUNITY_HOSTS.test(h)) return 'community';
    if (NEWS_HOSTS.test(h)) return 'news';
    return 'web';
  }
  const PERSPECTIVES = [['all', 'Everything'], ['official', 'Official'], ['research', 'Research'], ['news', 'News'], ['community', 'What people say'], ['web', 'Other sites']];
  // The chips appear once results from at least two kinds of source are in.
  function renderPerspectives(ui) {
    const items = [...ui.direct.querySelectorAll('.ritem[data-persp]')];
    const n = {};
    for (const li of items) n[li.dataset.persp] = (n[li.dataset.persp] || 0) + 1;
    const kinds = PERSPECTIVES.filter(([k]) => k !== 'all' && n[k]);
    let bar = ui.persp;
    if (kinds.length < 2) {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      bar = ui.persp = document.createElement('div');
      bar.className = 'persp';
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Show results from');
      ui.direct.parentNode.insertBefore(bar, ui.direct);
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-p]');
        if (!b) return;
        ui.perspSel = b.dataset.p;
        applyPerspective(ui);
        renderPerspectives(ui);
      });
    }
    bar.hidden = false;
    const sel = ui.perspSel || 'all';
    bar.innerHTML = [['all', 'Everything', items.length], ...kinds.map(([k, l]) => [k, l, n[k]])].map(([k, l, c]) => `<button type="button" data-p="${k}" aria-pressed="${sel === k}">${esc(l)} <span>${c}</span></button>`).join('');
  }
  function applyPerspective(ui) {
    const sel = ui.perspSel || 'all';
    // (a class, not "hidden": the "Show N more" fold uses that)
    for (const li of ui.direct.querySelectorAll('.ritem[data-persp]')) li.classList.toggle('p-out', sel !== 'all' && li.dataset.persp !== sel);
    for (const g of ui.direct.querySelectorAll('.rgroup')) {
      const lis = [...g.querySelectorAll('.ritem[data-persp]')];
      // A server's reply that isn't a list (a quote, a record) is "data": shown with Everything only.
      g.classList.toggle('p-out', sel !== 'all' && (lis.length ? lis.every((li) => li.classList.contains('p-out')) : true));
      // While filtering, every match shows (the fold would hide some).
      if (sel !== 'all') lis.forEach((li) => !li.classList.contains('p-out') && (li.hidden = false));
      g.querySelector('.rmore-items')?.classList.toggle('p-out', sel !== 'all');
    }
  }

  /** Readable view of one server's reply (built by src/format.js on the server). */
  function renderView(view) {
    const factsHtml = (facts) =>
      facts?.length ? `<dl class="facts">${facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${linkify(String(f.value))}</dd></div>`).join('')}</dl>` : '';
    if (view.kind === 'items') {
      return `<ol class="ritems">${view.items
        .map((it) => {
          const title = it.url
            ? `<a class="rt" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title || it.site)}</a>`
            : `<span class="rt-plain">${esc(it.title)}</span>`;
          const kind = { official: ['Official', 'A government or international body'], primary: ['Primary source', 'The registry of record: the paper or filing itself'], own: ['Official site', 'The company’s own website'], package: ['Package page', 'A package registry page: anyone can publish one'], preprint: ['Preprint', 'Not yet peer reviewed'] }[it.srcKind];
          const meta = [it.site ? `<span class="site">${esc(it.site)}</span>` : '', kind ? `<span class="src-kind" data-kind="${esc(it.srcKind)}" title="${esc(kind[1])}">${esc(kind[0])}</span>` : '', it.date ? `<span>${esc(niceDate(it.date))}</span>` : ''].join('');
          return `<li class="ritem" data-persp="${esc(perspectiveOf(it))}">${title}${meta ? `<div class="rmeta">${meta}</div>` : ''}${it.text ? `<p class="rtext">${esc(it.text)}</p>` : ''}${factsHtml(it.facts)}</li>`;
        })
        .join('')}</ol>`;
    }
    if (view.kind === 'table') {
      const isNum = (v) => /^-?[\d,.]+%?$/.test(String(v));
      return `${factsHtml(view.facts)}<div class="table-wrap"><table class="rtable"><thead><tr>${view.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${view.rows
        .map((r) => `<tr>${r.map((v) => `<td${isNum(v) ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>${view.more ? `<p class="via">and ${view.more} more rows (see raw reply)</p>` : ''}`;
    }
    if (view.kind === 'record') {
      const head = view.title ? `<p class="rt-plain">${view.url ? `<a class="rt" href="${esc(view.url)}" target="_blank" rel="noopener noreferrer">${esc(view.title)}</a>` : esc(view.title)}</p>` : '';
      // The first 6 facts; the rest behind "Show all N details".
      const row = (f, i) => `<dt${i >= 6 ? ' hidden' : ''}>${esc(f.label)}</dt><dd${i >= 6 ? ' hidden' : ''}>${linkify(String(f.value))}</dd>`;
      const more = view.facts.length > 6 ? `<button type="button" class="more record-more" data-count="${view.facts.length}">Show all ${view.facts.length} details</button>` : '';
      return `${head}<dl class="record">${view.facts.map(row).join('')}</dl>${more}`;
    }
    return `<p class="rprose">${linkify(view.text || '')}</p>`;
  }

  function addDirectCard(ui, d) {
    const node = ui.nodes.get(d.serverId);
    if (node && d.kind === 'ok') {
      const v = d.view || {};
      const n = v.kind === 'items' ? v.items.length + (v.more || 0) : v.kind === 'table' ? v.rows.length + (v.more || 0) : 1;
      $('small', node).textContent = d.offTopic ? 'off-topic' : `${n} result${n === 1 ? '' : 's'}`;
      if (d.offTopic) node.dataset.state = 'offtopic';
    }
    if (d.kind === 'empty' || d.kind === 'ad') {
      (d.kind === 'ad' ? ui.ads : ui.empties).push(d);
      renderDirectExtra(ui);
      return;
    }
    ui.groups.push(d);
    const card = document.createElement('section');
    card.className = 'rgroup';
    card.id = `g-${String(d.serverId).replace(/[^\w-]/g, '-')}`;
    card.dataset.score = String(d.score ?? 0);
    card.dataset.serverId = String(d.serverId);
    card.dataset.trust = d.serverTrust || 'community';
    const text = d.text || '';
    const view = d.view || { kind: 'text', text };
    const count = view.kind === 'items' ? view.items.length + (view.more || 0) : view.kind === 'table' ? view.rows.length + (view.more || 0) : 0;
    card.innerHTML = `<header class="rgroup-head"><h3>${esc(d.serverTitle)}</h3><span class="via">${count ? `${count} result${count === 1 ? '' : 's'}` : ''}</span><button type="button" class="raw-btn">Show raw reply</button></header>${
      d.flags?.length ? `<p class="act-flag">This reply contains text aimed at AI assistants (${esc(d.flags.join('; '))}).</p>` : ''
    }<div class="rbody">${renderView(view)}</div><pre class="direct-text" hidden>${linkify(text)}</pre>`;
    const rawBtn = $('.raw-btn', card);
    rawBtn.addEventListener('click', () => {
      const pre = $('.direct-text', card);
      pre.hidden = !pre.hidden;
      rawBtn.textContent = pre.hidden ? 'Show raw reply' : 'Hide raw reply';
    });
    const recMore = $('.record-more', card);
    if (recMore)
      recMore.addEventListener('click', () => {
        const hidden = card.querySelectorAll('.record [hidden]');
        const open = hidden.length > 0;
        card.querySelectorAll('.record dt, .record dd').forEach((el, i) => (el.hidden = !open && i >= 12));
        recMore.textContent = open ? 'Show fewer' : `Show all ${recMore.dataset.count} details`;
      });
    // Long lists fold after 5 items; long prose folds after a few lines.
    // A reply that never mentions the question's topic folds completely.
    const items = card.querySelectorAll('.ritem');
    if (d.offTopic) card.classList.add('offtopic');
    if (items.length > 5) {
      items.forEach((li, i) => i >= 5 && (li.hidden = true));
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more rmore-items';
      more.textContent = `Show ${items.length - 5} more`;
      more.addEventListener('click', () => {
        const folded = [...items].some((li) => li.hidden);
        items.forEach((li, i) => i >= 5 && (li.hidden = !folded));
        more.textContent = folded ? 'Show fewer' : `Show ${items.length - 5} more`;
      });
      $('.ritems', card).after(more);
    }
    if (view.kind === 'text' && (text.split('\n').length > 10 || text.length > 900)) {
      card.classList.add('clamped');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more rmore-items';
      more.textContent = 'Show all';
      more.addEventListener('click', () => {
        card.classList.toggle('clamped');
        more.textContent = card.classList.contains('clamped') ? 'Show all' : 'Show less';
      });
      $('.rprose', card).after(more);
    }
    // Replies that never mention the topic go into one fold below the rest.
    if (d.offTopic) {
      if (!ui.offWrap) {
        ui.offWrap = document.createElement('details');
        ui.offWrap.className = 'offtopic-fold';
        ui.offWrap.innerHTML = '<summary></summary><p class="muted"></p><div class="offtopic-cards"></div>';
        ui.direct.after(ui.offWrap);
      }
      const box = $('.offtopic-cards', ui.offWrap);
      const later = [...box.children].find((c) => Number(c.dataset.score) < Number(card.dataset.score));
      box.insertBefore(card, later || null);
      const n = box.children.length;
      $('summary', ui.offWrap).textContent = `${n} server${n === 1 ? '' : 's'} replied about something else`;
      $('p', ui.offWrap).textContent = n === 1 ? 'This server answered, but its results never mention what you asked about.' : 'These servers answered, but their results never mention what you asked about.';
    } else {
      // Best results first: insert before the first card with a lower score (the quoted card stays first).
      const after = [...ui.direct.children].find((c) => !c.dataset.quoted && Number(c.dataset.score) < Number(card.dataset.score));
      ui.direct.insertBefore(card, after || null);
      renderPerspectives(ui);
      applyPerspective(ui);
      placeQuoted(ui);
    }
    if (ui.answer.querySelector('.placeholder')) ui.answer.innerHTML = '';
  }

  function summarizeDirect(ui) {
    return [...ui.direct.querySelectorAll('.direct-text')].map((p) => p.textContent.slice(0, 800)).join('\n\n');
  }

  function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (u) => {
      const raw = u.replace(/&amp;/g, '&');
      try {
        const x = new URL(raw);
        if (x.protocol !== 'http:' && x.protocol !== 'https:') return u;
        return `<a href="${esc(x.href)}" target="_blank" rel="noopener noreferrer">${u}</a>`;
      } catch {
        return u;
      }
    });
  }

  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return u;
    }
  }

  // ---------- servers ----------
  function buildServers(entry) {
    const el = $('#tpl-servers').content.firstElementChild.cloneNode(true);
    const list = $('[data-server-list]', el);
    const q = $('[data-server-q]', el);
    const src = $('[data-server-source]', el);
    const sort = $('[data-server-sort]', el);
    const since = $('[data-server-since]', el);
    const more = $('[data-more]', el);
    const regStatus = $('[data-registry-status]', el);
    const disc = $('[data-discovery]', el);
    const preview = $('[data-route-preview]', el);
    if (entry.q) q.value = entry.q;
    let offset = 0;
    let timer = null;

    let loadSeq = 0;
    async function load(reset) {
      if (reset) {
        offset = 0;
        list.innerHTML = '';
      }
      const my = ++loadSeq;
      const params = new URLSearchParams({ q: q.value, source: src.value, sort: sort.value, since: since.value, limit: '40', offset: String(offset) });
      try {
        const r = await api.get(`/api/servers?${params}`);
        if (my !== loadSeq) return; // a newer search or filter replaced this one
        for (const s of r.servers) list.appendChild(serverRow(s));
        offset += r.servers.length;
        more.hidden = offset >= r.total;
        if (!r.total) list.innerHTML = `<li class="empty">No servers match. ${src.value === 'registry' && !status?.registry.syncedAt ? 'Update the registry to search it.' : 'Try another word.'}</li>`;
      } catch (e) {
        list.innerHTML = `<li class="empty">Could not load servers: ${esc(e.message)}</li>`;
      }
      if (q.value.trim()) {
        const r = await api.get(`/api/route?q=${encodeURIComponent(q.value)}`).catch(() => null);
        preview.textContent = r?.servers.length ? `A question like this would go to: ${r.servers.map((s) => s.title).join(', ')}.` : '';
      } else preview.textContent = '';
    }

    function serverRow(s) {
      const li = document.createElement('li');
      li.className = 'server-row';
      const h = s.health;
      const state = !h ? 'unknown' : h.status === 'ok' ? 'ok' : 'fail';
      const stateText = !h ? 'Not checked' : h.status === 'ok' ? `Works · ${h.tools} tools · ${h.latencyMs} ms` : `Failed: ${h.error || 'error'}`;
      li.innerHTML = `
        <label class="switch"><input type="checkbox" ${s.enabled ? 'checked' : ''} ${s.needsAuth && !s.hasAuth ? 'disabled title="Add a key first"' : s.signIn && s.signIn !== 'signed-in' && !s.enabled ? 'disabled title="Sign in first"' : ''} aria-label="Use ${esc(s.title)}"><span></span></label>
        <div class="srv-main">
          <div class="srv-title">${esc(s.title)} <span class="badge ${esc(s.source)}">${s.source === 'curated' ? 'Curated' : s.source === 'registry' ? 'Registry' : 'Added by you'}</span>${s.trust === 'community' && s.source !== 'curated' ? '' : ''}${s.needsAuth ? `<span class="badge key">${s.hasAuth ? 'Key added' : 'Needs a key'}</span>` : ''}${s.signIn === 'signed-in' ? '<span class="badge key">Signed in</span>' : s.signIn === 'needed' ? '<span class="badge key">Needs sign-in</span>' : ''}${starChip(s.github)}</div>
          <div class="srv-desc">${esc(s.description || '')}</div>
          <div class="srv-meta"><span class="health ${state}">${esc(stateText)}</span> ${/^https?:\/\//i.test(s.website || '') ? `<a class="srv-site" href="${esc(s.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(s.website))}</a> ` : ''}${repoLink(s)}${/^https?:\/\/[^{}\s]+$/i.test(s.url || '') ? `<a class="srv-url" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="Open the server address">${esc(s.url)}</a>` : `<span class="srv-url">${esc(s.url)}</span>`}${s.updatedAt ? ` <span class="srv-date" title="Last change to its registry entry">Updated ${esc(new Date(s.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}${s.github?.pushedAt ? ` <span class="srv-date" title="Last push to its GitHub repo">Pushed ${esc(new Date(s.github.pushedAt + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}</div>
        </div>
        <div class="srv-actions"><button class="probe">Check</button><button class="signin" ${s.signIn ? '' : 'hidden'}>${s.signIn === 'signed-in' ? 'Sign out' : 'Sign in'}</button><button class="keybtn${s.needsAuth || s.hasAuth ? '' : ' quiet'}" ${s.signIn && !s.hasAuth && s.source === 'curated' ? 'hidden' : ''}>${s.hasAuth ? 'Change key' : s.needsAuth ? 'Add key' : 'Use own key'}</button>${s.source === 'custom' ? '<button class="removebtn">Remove</button>' : ''}</div>
        <form class="keyform" hidden>
          <p>${s.authHeaders[0]?.description ? esc(s.authHeaders[0].description) : 'Paste the key this server gave you, or a full URL that already contains it.'}</p>
          <label>Header <input name="header" value="${esc(s.authHeaders[0]?.name || 'Authorization')}" pattern="[A-Za-z0-9_-]{1,64}"></label>
          <label>Key <input name="value" type="password" autocomplete="off" placeholder="${(s.authHeaders[0]?.name || 'Authorization') === 'Authorization' ? 'Bearer …' : ''}"></label>
          <label>or URL <input name="url" placeholder="https://…"></label>
          <div><button type="submit">Save key</button>${s.hasAuth ? ' <button type="button" class="clearkey">Remove key</button>' : ''} <span class="keymsg"></span></div>
        </form>`;
      $('input', li).addEventListener('change', async (e) => {
        try {
          await api.post('/api/servers/toggle', { id: s.id, enabled: e.target.checked });
        } catch (err) {
          e.target.checked = !e.target.checked;
          alert(err.message);
        }
      });
      $('.removebtn', li)?.addEventListener('click', async (e) => {
        const b = e.target;
        if (b.dataset.confirm !== '1') {
          b.dataset.confirm = '1';
          b.textContent = 'Remove server?';
          return;
        }
        await api.post('/api/servers/custom/delete', { id: s.id });
        li.remove();
      });
      const kf = $('.keyform', li);
      $('.keybtn', li).addEventListener('click', () => {
        kf.hidden = !kf.hidden;
        if (!kf.hidden) kf.elements.value.focus();
      });
      kf.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const v = await api.post('/api/servers/auth', { id: s.id, header: kf.elements.header.value, value: kf.elements.value.value, url: kf.elements.url.value });
          li.replaceWith(serverRow(v));
        } catch (err) {
          $('.keymsg', kf).textContent = err.message;
        }
      });
      $('.clearkey', li)?.addEventListener('click', async () => {
        li.replaceWith(serverRow(await api.post('/api/servers/auth', { id: s.id, clear: true })));
      });
      const signBtn = $('.signin', li);
      signBtn.addEventListener('click', async () => {
        const msg = $('.health', li);
        signBtn.disabled = true;
        try {
          if (s.signIn === 'signed-in') {
            await api.post('/api/servers/oauth/signout', { id: s.id });
            li.replaceWith(serverRow({ ...s, signIn: null }));
            return;
          }
          const r = await api.post('/api/servers/oauth/start', { id: s.id });
          if (r.url) {
            if (desktop) await desktop.openExternal(r.url);
            else window.open(r.url, '_blank', 'noopener');
            msg.textContent = 'Finish signing in in your browser, then come back here.';
            // Wait for the callback to land (up to 5 minutes).
            for (let i = 0; i < 150 && li.isConnected; i++) {
              await new Promise((ok) => setTimeout(ok, 2000));
              const list = (await api.get(`/api/servers?q=${encodeURIComponent(s.title)}&limit=200`)).servers || [];
              const v = list.find((x) => x.id === s.id);
              if (v?.signIn === 'signed-in') return li.replaceWith(serverRow(v));
            }
          } else {
            li.replaceWith(serverRow({ ...s, signIn: 'signed-in' }));
          }
        } catch (err) {
          msg.className = 'health fail';
          msg.textContent = err.message;
        } finally {
          signBtn.disabled = false;
        }
      });
      $('.probe', li).addEventListener('click', async (e) => {
        const b = e.target;
        b.disabled = true;
        b.textContent = 'Checking…';
        try {
          const r = await api.post('/api/servers/probe', { ids: [s.id] });
          const x = r.results[0];
          $('.health', li).className = `health ${x.ok ? 'ok' : 'fail'}`;
          $('.health', li).textContent = x.ok ? `Works · ${x.tools} tools` : `Failed: ${x.error}`;
          if (!x.ok && /needs sign-in|sign-in expired/.test(x.error || '')) signBtn.hidden = false;
        } catch (err) {
          $('.health', li).textContent = `Failed: ${err.message}`;
        }
        b.disabled = false;
        b.textContent = 'Check';
      });
      return li;
    }

    async function showRegistry() {
      await refreshStatus();
      if (!status) return;
      disc.checked = status.discovery;
      const r = status.registry;
      const s = status.sync;
      if (s.running) {
        regStatus.textContent = `Downloading the registry… ${s.progress?.seen?.toLocaleString() || 0} records read, ${s.progress?.kept?.toLocaleString() || 0} usable so far.`;
        setTimeout(() => !el.isConnected || showRegistry(), 1500);
      } else if (r.syncedAt) {
        const st = r.stats;
        regStatus.textContent = `${r.keyless.toLocaleString()} keyless remote servers from the official MCP Registry${st?.seen ? ` (of ${st.seen.toLocaleString()} listed). Another ${(st.needsAuth || 0).toLocaleString()} work once you add a key; ${(st.packageOnly || 0).toLocaleString()} must be installed locally and aren't supported yet` : ''}. Updated ${new Date(r.syncedAt).toLocaleString()}.`;
        if (s.error) regStatus.textContent += ` Last update failed: ${s.error}`;
        const sem = status.semantic || {};
        regStatus.textContent +=
          sem.status === 'ready'
            ? ' Meaning-based routing is on.'
            : sem.status === 'building'
              ? ` Preparing meaning-based routing (${sem.done.toLocaleString()} of ${sem.total.toLocaleString()})…`
              : sem.status === 'unavailable'
                ? ' Meaning-based routing is off (embedding model not available), so routing uses keywords.'
                : '';
        if (sem.status === 'building') setTimeout(() => !el.isConnected || showRegistry(), 3000);
        if (entry.wasSyncing) {
          entry.wasSyncing = false;
          load(true);
        }
      } else regStatus.textContent = s.error ? `Registry download failed: ${s.error}` : 'Registry not downloaded yet.';
      if (s.running) entry.wasSyncing = true;
    }

    const addForm = $('[data-add-server]', el);
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('[data-add-msg]', addForm);
      const btn = $('button[type=submit]', addForm);
      btn.disabled = true;
      msg.className = 'add-msg';
      msg.textContent = 'Adding and checking…';
      try {
        const r = await api.post('/api/servers/custom', { url: addForm.elements.url.value, title: addForm.elements.title.value, description: addForm.elements.description.value });
        msg.textContent = r.probe.ok ? `Added. It works: ${r.probe.tools} tools.` : `Added, but it didn't answer yet (${r.probe.error}). If it needs a key, use Add key on it below.`;
        msg.classList.add(r.probe.ok ? 'ok' : 'warn');
        addForm.reset();
        src.value = 'custom';
        q.value = '';
        load(true);
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add('warn');
      }
      btn.disabled = false;
    });
    $('[data-sync]', el).addEventListener('click', async () => {
      try {
        await api.post('/api/registry/sync', {});
      } catch (e) {
        regStatus.textContent = e.message;
      }
      showRegistry();
    });
    disc.addEventListener('change', async () => {
      await api.post('/api/settings', { discovery: disc.checked });
      refreshStatus();
      load(true);
    });
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 250);
    });
    src.addEventListener('change', () => load(true));
    sort.addEventListener('change', () => load(true));
    since.addEventListener('change', () => load(true));
    more.addEventListener('click', () => load(false));
    load(true);
    showRegistry();
    return el;
  }

  // ---------- settings ----------
  function buildSettings() {
    const el = $('#tpl-settings').content.firstElementChild.cloneNode(true);
    const form = $('[data-settings-form]', el);
    // (Today lives in this browser: turning it back on asks for the city again)
    const todayShow = $('[data-today-show]', el);
    todayShow.checked = todayCity.get() !== '';
    todayShow.addEventListener('change', () => todayCity.set(todayShow.checked ? null : ''));
    const state = $('[data-provider-state]', el);
    const saved = $('[data-saved]', el);

    function fill(s) {
      for (const [k, v] of Object.entries(s)) {
        const f = form.elements.namedItem(k);
        if (!f) continue;
        if (f.type === 'checkbox') f.checked = Boolean(v);
        else f.value = v ?? '';
      }
    }
    async function describe() {
      await refreshStatus();
      const p = status?.provider;
      if (!p) return;
      state.textContent = p.provider === 'none' ? `Free mode${p.reason ? ` (${p.reason})` : ''}. Answers will be raw server results.` : `Using ${p.provider}${p.model ? ` · ${p.model}` : ''}${p.baseUrl ? ` at ${p.baseUrl}` : ''}.`;
    }
    // Search depth presets fill the advanced numbers; "custom" when they don't match.
    const DEPTHS = { fast: { discovery: false, maxServers: 4, discoveryMax: 2 }, balanced: { discovery: true, maxServers: 8, discoveryMax: 4 }, wide: { discovery: true, maxServers: 20, discoveryMax: 14 } };
    const depthBox = $('[data-depth]', el);
    const syncDepth = () => {
      const cur = { discovery: form.elements.discovery.checked, maxServers: Number(form.elements.maxServers.value), discoveryMax: Number(form.elements.discoveryMax.value) };
      const match = Object.entries(DEPTHS).find(([, d]) => d.discovery === cur.discovery && d.maxServers === cur.maxServers && (!d.discovery || d.discoveryMax === cur.discoveryMax));
      for (const r of depthBox.querySelectorAll('input')) r.checked = match?.[0] === r.value;
      $('[data-depth-custom]', el).hidden = Boolean(match);
    };
    depthBox.addEventListener('change', (e) => {
      const d = DEPTHS[e.target.value];
      if (!d) return;
      form.elements.discovery.checked = d.discovery;
      form.elements.maxServers.value = d.maxServers;
      form.elements.discoveryMax.value = d.discoveryMax;
      syncDepth();
    });
    for (const n of ['discovery', 'maxServers', 'discoveryMax']) form.elements[n].addEventListener('input', syncDepth);
    api.get('/api/settings').then(fill).then(syncDepth).then(describe).then(starsState);
    const starsEl = $('[data-stars-state]', el);
    const starsBtn = $('[data-stars-refresh]', el);
    async function starsState() {
      await refreshStatus();
      const st = status?.stars;
      if (!st) return;
      starsBtn.disabled = st.running;
      starsEl.textContent = st.running
        ? `Refreshing… ${st.progress?.done ?? 0} of ${st.progress?.total ?? '?'} repos`
        : `${st.repos.toLocaleString()} repos known${st.fetchedAt ? `, updated ${new Date(st.fetchedAt).toLocaleDateString()}` : ''}${st.source ? ` from ${st.source}` : ''}.${st.error ? ` Last refresh stopped: ${st.error}.` : ''}`;
      if (st.running && el.isConnected) setTimeout(starsState, 2000);
    }
    starsBtn.addEventListener('click', async () => {
      try {
        await api.post('/api/stars/refresh', {});
      } catch (err) {
        starsEl.textContent = err.message;
      }
      starsState();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      for (const f of form.elements) {
        if (!f.name) continue;
        body[f.name] = f.type === 'checkbox' ? f.checked : f.value;
      }
      try {
        fill(await api.post('/api/settings', body));
        saved.hidden = false;
        saved.textContent = 'Saved';
        setTimeout(() => (saved.hidden = true), 2000);
        describe();
      } catch (err) {
        saved.hidden = false;
        saved.textContent = `Not saved: ${err.message}`;
      }
    });
    return el;
  }

  // ---------- boot ----------
  if (desktop) {
    desktop.onOpenTab((url) => newTab({ kind: 'web', url }));
    // Right-click on selected text (desktop app): cross-check it, or search for it.
    desktop.onOpenEntry?.((e) => {
      if (e.kind === 'check' && e.claim) newTab({ kind: 'check', claim: e.claim });
      else if (e.kind === 'search' && e.query) newTab({ kind: 'search', query: e.query, label: e.query });
    });
    if (desktop.platform === 'darwin') document.documentElement.style.setProperty('--traffic-lights', '78px');
  }
  refreshStatus().then(() => {
    // Dev mode (npm run dev / desktop:dev): reload when the server restarts or the UI changes.
    if (!status?.dev) return;
    let build = status.build;
    setInterval(async () => {
      try {
        const r = await api.get('/api/dev/build');
        if (build && r.build !== build) location.reload();
        build = r.build;
      } catch {
        /* server restarting: try again */
      }
    }, 2000);
  });
  setInterval(refreshStatus, 30000);
  // /?q=… : MCP Browser as the browser's search engine. A !bang goes straight to that site.
  const initial = new URLSearchParams(location.search).get('q');
  const initialBang = initial && window.MCPBangs?.parse(initial);
  if (initialBang?.url && !desktop) location.replace(initialBang.url);
  else if (initialBang?.entry) newTab(initialBang.entry);
  else newTab(initial ? { kind: 'search', query: initial } : { kind: 'home' });
})();
