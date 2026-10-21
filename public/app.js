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
  const SUGGESTIONS = ['Max timeout for an AWS Lambda function', 'Latest research on solid-state batteries', 'Weather in Seattle this weekend', 'What people say about Notion on Reddit'];

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
    omni.value = e.kind === 'search' ? e.query : e.kind === 'web' ? e.url : e.kind === 'home' ? '' : `mcp://${e.kind}`;
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
      case 'web':
        entry.title = hostOf(entry.url);
        return buildWeb(entry);
      default:
        entry.title = 'New tab';
        return buildHome(tab);
    }
  }

  // ---------- omnibox ----------
  function looksLikeUrl(s) {
    if (/\s/.test(s)) return false;
    return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s);
  }

  function open(input, tab = active) {
    const s = String(input || '').trim();
    if (!s) return;
    if (/^mcp:\/\/(home|newtab)\/?$/i.test(s)) return navigate(tab, { kind: 'home' });
    if (/^mcp:\/\/servers/i.test(s)) return navigate(tab, { kind: 'servers' });
    if (/^mcp:\/\/settings/i.test(s)) return navigate(tab, { kind: 'settings' });
    if (/^mcp:\/\/rank/i.test(s)) return navigate(tab, { kind: 'rank' });
    if (/^mcp:\/\/watches/i.test(s)) return navigate(tab, { kind: 'watches' });
    if (looksLikeUrl(s)) {
      const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      return openUrl(url, tab);
    }
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
    if (desktop) navigate(tab, { kind: 'web', url: u.href });
    else window.open(u.href, '_blank', 'noopener,noreferrer');
  }

  $('#omnibox').addEventListener('submit', (e) => {
    e.preventDefault();
    open(omni.value);
    omni.blur();
  });
  omni.addEventListener('focus', () => omni.select());
  $('#newTab').addEventListener('click', () => newTab());
  $('#back').addEventListener('click', () => go(-1));
  $('#home').addEventListener('click', () => navigate(active, { kind: 'home' }));
  $('#fwd').addEventListener('click', () => go(1));
  $('#reload').addEventListener('click', () => {
    const e = current();
    if (!e) return;
    if (e.kind === 'search') navigate(active, { kind: 'search', query: e.query, discovery: e.discovery, label: e.label });
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
    renderSetup(el);
    renderTemplates(tab, el);
    setTimeout(() => tab === active && input.focus(), 0);
    return el;
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
        await api.post('/api/watches', { query, every, discovery: Boolean(entry.discovery), label: firstTurn ? entry.label || '' : '' });
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

  function buildWatches() {
    const el = $('#tpl-watches').content.firstElementChild.cloneNode(true);
    const list = $('[data-watch-list]', el);
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
      const state = w.running
        ? 'Running now…'
        : !w.lastRun
          ? 'Waiting for the first run'
          : w.lastRun.error
            ? `Last run failed: ${w.lastRun.error}`
            : last?.first
              ? `First run ${timeAgo(w.lastRun.at)}: ${w.lastRun.sources?.length || 0} sources saved as the baseline`
              : last?.changed
                ? `Changed ${timeAgo(last.at)}: ${last.newSources.length} new source${last.newSources.length === 1 ? '' : 's'}${last.similarity < 0.75 ? ', answer reworded' : ''}`
                : `No changes ${timeAgo(w.lastRun.at)}`;
      li.innerHTML = `
        <div class="watch-main">
          <div class="watch-title">${w.unseen ? '<span class="new-pill">New</span>' : ''}${esc(w.label || w.query)}</div>
          <div class="watch-state">${esc(state)} · next ${esc(w.nextRunAt > Date.now() ? new Date(w.nextRunAt).toLocaleString() : 'soon')}</div>
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
        head.textContent = `${new Date(h.at).toLocaleString()}: ${h.error ? `failed (${h.error})` : h.first ? 'first run' : h.changed ? `${h.newSources.length} new source(s)` : 'no changes'}`;
        item.appendChild(head);
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
    el.appendChild(wv);
    entry.webview = wv;
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
    if (opts.wide) $('[data-q]', turn).insertAdjacentHTML('beforeend', ' <small class="wide-tag">wider search</small>');
    // Money, health and legal questions: a quiet reminder that results are sources, not advice.
    const advice = adviceTopic(query);
    if (advice) {
      const note = $('[data-advice-note]', turn);
      note.textContent = `These are third-party sources, not ${advice} advice. Check with a licensed professional before acting on them.`;
      note.hidden = false;
    }
    wireWatchForm(turn, query, entry);
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
        body: JSON.stringify({ query, history, discovery: Boolean(entry.discovery), wide: Boolean(opts?.wide) }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await readSSE(res.body, (type, data) => onEvent(ui, type, data));
    } catch (e) {
      if (!ac.signal.aborted) showNotice(ui, `Search failed: ${e.message}. Check that the MCP Browser server is still running.`, 'error');
    } finally {
      entry.busy = false;
      tab.btn.classList.remove('busy');
      for (const [, n] of ui.nodes) if (n.dataset.state === 'connecting' || n.dataset.state === 'working') n.dataset.state = 'idle';
      entry.turns.push({ q: query, a: ui.text || summarizeDirect(ui) });
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
        ui.answer.innerHTML = '';
        ui.answer.appendChild(box);
        // The card it quotes comes right after it, and the caption links to it.
        placeQuoted(ui);
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
          const meta = [it.site ? `<span class="site">${esc(it.site)}</span>` : '', it.date ? `<span>${esc(niceDate(it.date))}</span>` : ''].join('');
          return `<li class="ritem">${title}${meta ? `<div class="rmeta">${meta}</div>` : ''}${it.text ? `<p class="rtext">${esc(it.text)}</p>` : ''}${factsHtml(it.facts)}</li>`;
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
      const params = new URLSearchParams({ q: q.value, source: src.value, sort: sort.value, limit: '40', offset: String(offset) });
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
          <div class="srv-meta"><span class="health ${state}">${esc(stateText)}</span> <span class="srv-url">${esc(s.url)}</span></div>
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
    more.addEventListener('click', () => load(false));
    load(true);
    showRegistry();
    return el;
  }

  // ---------- settings ----------
  function buildSettings() {
    const el = $('#tpl-settings').content.firstElementChild.cloneNode(true);
    const form = $('[data-settings-form]', el);
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
  const initial = new URLSearchParams(location.search).get('q');
  newTab(initial ? { kind: 'search', query: initial } : { kind: 'home' });
})();
