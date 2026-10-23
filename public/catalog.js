// mcp://catalog: every server in the official MCP Registry, by category, with
// search, time filters, links, GitHub stars and package downloads.
// Data: GET /api/catalog (built by scripts/build-catalog.js).
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nf = new Intl.NumberFormat('en-US');
  const PAGE = 40;
  let dataPromise = null;

  const fmt = (n) => (n < 0 ? '–' : n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k' : (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M');
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const fmtDate = (d) => {
    if (!d) return '';
    const t = new Date(d.length === 10 ? d + 'T00:00:00Z' : d);
    return isNaN(t) ? '' : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const cmpDate = (x, y) => ((x || '') > (y || '') ? 1 : (x || '') < (y || '') ? -1 : 0);

  const PKG = {
    npm: { label: 'npm', page: (id) => `https://www.npmjs.com/package/${id}`, cmd: (id) => `npx -y ${id}`, unit: 'npm / month' },
    pypi: { label: 'PyPI', page: (id) => `https://pypi.org/project/${id}/`, cmd: (id) => `uvx ${id}`, unit: 'PyPI / month' },
    oci: { label: 'Docker', page: (id) => { const m = id.replace(/^docker\.io\//, '').replace(/:.*$/, ''); return /^(ghcr|quay|gcr)\./.test(m) ? '' : `https://hub.docker.com/r/${m}`; }, cmd: (id) => `docker run -i --rm ${id}`, unit: 'Docker pulls' },
    nuget: { label: 'NuGet', page: (id) => `https://www.nuget.org/packages/${id}`, cmd: (id) => `dnx ${id} --yes`, unit: '' },
    cargo: { label: 'crates.io', page: (id) => `https://crates.io/crates/${id}`, cmd: (id) => `cargo install ${id}`, unit: 'crates.io / 90 days' },
    mcpb: { label: 'MCP bundle', page: (id) => safeUrl(id), cmd: () => '', unit: '' },
  };
  const REACH = { 1: ['ok', 'Works without a key'], 2: ['warn', 'Needs sign-in or key'], 3: ['warn', 'Paid'], 4: ['bad', 'Blocks automated use'], 5: ['bad', 'Not answering'] };
  const SORT_NOTE = { pop: 'Ranked by GitHub stars, downloads and test results', stars: 'Servers without a GitHub repo come last', dl: 'npm and PyPI: last 30 days', rank: 'Only hosted servers are tested', added: 'By the date the server first appeared in the registry', new: 'By the date the latest version was published', pushed: 'By the last push to the GitHub repo', oldest: 'Earliest registry entries first', name: '' };

  function load() {
    dataPromise ||= fetch('/api/catalog', { headers: { accept: 'application/json' } }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    });
    dataPromise.catch(() => (dataPromise = null));
    return dataPromise;
  }

  function mount(el, entry = {}, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    const F = {};
    let D, rows, cats, hues = {}, months = [];
    let view = [], shown = 0, catSel = entry.category || 'all', range = null;
    const filters = new Set();
    let stackIds = new Set();
    window.MCPLocal?.refresh();
    window.MCPStack?.ids().then((s) => (stackIds = s));

    const popularity = (r) => {
      const s = Math.max(0, r[F.stars]), d = Math.max(0, r[F.downloads]);
      return Math.log10(s + 1) + Math.log10(d + 1) * 0.75 + (r[F.rank] ? r[F.rank] / 40 : 0) + (r[F.reach] === 1 ? 0.3 : 0) - (r[F.archived] ? 1 : 0) - (r[F.deprecated] ? 1 : 0) - (r[F.pubCount] >= 100 ? 0.4 : 0);
    };
    const shortName = (r) => (r[F.name].split('/').pop() || r[F.name]).replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 40);
    // MCP Browser can call it right now: hosted over HTTPS, no key, last seen answering.
    function runnable(r) {
      if (F.listed != null && r[F.listed] === 1) return true;
      const u = r[F.remoteUrl];
      return Boolean(u) && /^https:\/\/[^\s{}]+$/i.test(u) && !(r[F.required] > 0) && ![2, 3, 5].includes(r[F.reach]);
    }
    function installCmd(r) {
      const t = r[F.pkgType];
      // With the startup arguments from the registry (e.g. "uvx --with edgartools[ai] edgartools mcp").
      const l = window.MCPGuide?.launchOf(r, F);
      if (l && l.kind === 'local') return [l.command, ...l.args].map((x) => (/^[\w@%+=:,./[\]-]+$/.test(x) ? x : `'${String(x).replace(/'/g, `'\\''`)}'`)).join(' ');
      if (t && PKG[t]) return PKG[t].cmd(r[F.pkgId]);
      const u = r[F.remoteUrl];
      return u ? `claude mcp add --transport ${r[F.remoteType] === 'sse' ? 'sse' : 'http'} ${shortName(r)} ${u}` : '';
    }

    function readRange() {
      const field = $('[data-cat-datefield]').value, p = $('[data-cat-period]').value;
      $('[data-cat-range]').hidden = p !== 'custom';
      $('[data-cat-clear]').hidden = p === 'any';
      if (p === 'any') return (range = null);
      if (p === 'custom') {
        const f = $('[data-cat-from]').value, t = $('[data-cat-to]').value;
        return (range = f || t ? { field, from: f || '0000-00-00', to: t || '9999-12-31' } : null);
      }
      return (range = { field, from: iso(Date.parse(D.generatedAt) - Number(p) * 86400000), to: '9999-12-31' });
    }
    function pass(r) {
      for (const f of filters) {
        if (f === 'remote' && !r[F.remoteUrl]) return false;
        if (f === 'pkg' && !r[F.pkgType]) return false;
        if (f === 'gh' && r[F.stars] < 0) return false;
        if (f === 'free' && r[F.reach] !== 1) return false;
        if (f === 'rank' && !r[F.rank]) return false;
        if (f === 'noenv' && r[F.required] > 0) return false;
        if (f === 'bulk' && r[F.pubCount] >= 100) return false;
        // Started (and listed tools) when we ran it in a test machine; hosted servers count if they answered our probe.
        if (f === 'works' && !(F.tested != null && ['a', 's'].includes(r[F.tested]?.[0])) && !(runnable(r) && r[F.reach] === 1)) return false;
      }
      if (range) {
        const d = r[F[range.field]] || '';
        if (!d || d < range.from || d > range.to) return false;
      }
      return true;
    }

    function render() {
      readRange();
      const t = $('[data-cat-q]').value.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const res = t.map((w) => new RegExp('(?:^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const sort = $('[data-cat-sort]').value;
      const base = [];
      const counts = new Array(cats.length).fill(0);
      for (const r of rows) {
        if (!pass(r)) continue;
        let ok = true, score = 0;
        for (let k = 0; k < t.length; k++) {
          if (!r._hay.includes(t[k])) { ok = false; break; }
          score += res[k].test(r._titleHay) ? 4 : r._titleHay.includes(t[k]) ? 2 : res[k].test(r._hay) ? 1.2 : 0.5;
        }
        if (!ok) continue;
        r._score = score;
        counts[r[F.cat]]++;
        base.push(r);
      }
      view = catSel === 'all' ? base : base.filter((r) => cats[r[F.cat]].id === catSel);
      const by = {
        pop: (a, b) => (t.length ? b._score * 1.5 + b._pop - (a._score * 1.5 + a._pop) : b._pop - a._pop),
        stars: (a, b) => b[F.stars] - a[F.stars] || b._pop - a._pop,
        dl: (a, b) => b[F.downloads] - a[F.downloads] || b._pop - a._pop,
        rank: (a, b) => b[F.rank] - a[F.rank] || b._pop - a._pop,
        added: (a, b) => cmpDate(b[F.added], a[F.added]) || b._pop - a._pop,
        new: (a, b) => cmpDate(b[F.updated], a[F.updated]) || b._pop - a._pop,
        pushed: (a, b) => cmpDate(b[F.pushed], a[F.pushed]) || b._pop - a._pop,
        oldest: (a, b) => cmpDate(a[F.added] || '9999', b[F.added] || '9999') || b._pop - a._pop,
        name: (a, b) => (a[F.title] || a[F.name]).localeCompare(b[F.title] || b[F.name]),
      }[sort];
      view.sort(by);
      renderCats(counts, base.length);
      renderMonths();
      const cl = catSel === 'all' ? '' : ` in ${cats.find((c) => c.id === catSel).label}`;
      $('[data-cat-count]').textContent = `${nf.format(view.length)} server${view.length === 1 ? '' : 's'}${cl}`;
      let note = t.length && sort === 'pop' ? 'Name matches and popularity combined' : SORT_NOTE[sort];
      if (range) {
        const what = { added: 'Added', updated: 'Released', pushed: 'Pushed to GitHub' }[range.field];
        const span = range.from === '0000-00-00' ? `up to ${fmtDate(range.to)}` : range.to === '9999-12-31' ? `${fmtDate(range.from)} or later` : `${fmtDate(range.from)} to ${fmtDate(range.to)}`;
        note = `${what} ${span}${note ? '. ' + note : ''}`;
      }
      $('[data-cat-note]').textContent = note;
      shown = 0;
      $('[data-cat-list]').innerHTML = '';
      if (!view.length) {
        $('[data-cat-list]').innerHTML = '<li class="empty">No servers match. Try fewer words, another category, or turn off a filter.</li>';
        $('[data-cat-more]').hidden = true;
        return;
      }
      more();
    }

    function renderCats(counts, total) {
      const order = cats.map((c) => c.i).sort((a, b) => (cats[a].id === 'other') - (cats[b].id === 'other') || counts[b] - counts[a]);
      const li = [`<li><button type="button" data-cat="all" aria-pressed="${catSel === 'all'}"><span class="cat-dot all"></span><span>All categories</span><span class="n">${nf.format(total)}</span></button></li>`];
      for (const i of order) {
        const c = cats[i];
        li.push(`<li><button type="button" data-cat="${c.id}" aria-pressed="${catSel === c.id}" class="${counts[i] ? '' : 'zero'}"><span class="cat-dot" style="--h:${hues[i]}"></span><span>${esc(c.label)}</span><span class="n">${nf.format(counts[i])}</span></button></li>`);
      }
      $('[data-cat-cats]').innerHTML = li.join('');
      const top = order.filter((i) => counts[i] && cats[i].id !== 'other');
      $('[data-cat-spectrum]').innerHTML = order.filter((i) => counts[i]).map((i) => `<button type="button" style="--h:${hues[i]};flex:${counts[i]}" data-cat="${cats[i].id}" class="${catSel === cats[i].id ? 'on' : ''}" title="${esc(cats[i].label)}: ${nf.format(counts[i])}" aria-label="${esc(cats[i].label)}, ${nf.format(counts[i])} servers"></button>`).join('');
      $('[data-cat-speckey]').textContent = top.length && total ? `Largest: ${cats[top[0]].label}, ${Math.round((counts[top[0]] / total) * 100)}% of ${nf.format(total)}` : '';
    }

    const monthLabel = (k, long) => new Date(k + '-01T00:00:00Z').toLocaleDateString('en-US', { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' });
    function selectedMonth() {
      return range && range.field === 'added' && range.from.slice(8) === '01' && range.from.slice(0, 7) === range.to.slice(0, 7) ? range.from.slice(0, 7) : '';
    }
    function renderMonths() {
      const max = Math.max(...months.map((x) => x[1]), 1);
      const sel = selectedMonth();
      $('[data-cat-months]').innerHTML = months.map(([k, n]) => `<button type="button" data-month="${k}" class="${sel === k ? 'on' : ''}" title="${monthLabel(k, true)}: ${nf.format(n)} added" aria-label="${monthLabel(k, true)}, ${nf.format(n)} servers added"><i style="height:${Math.max(3, (n / max) * 100)}%"></i></button>`).join('');
      $('[data-cat-axis]').innerHTML = months.map(([k], i) => `<span>${(months.length - 1 - i) % 2 === 0 ? monthLabel(k) + (k.endsWith('-01') || i === 0 ? ` ’${k.slice(2, 4)}` : '') : ''}</span>`).join('');
      const last = months[months.length - 1];
      $('[data-cat-monthnote]').innerHTML = sel ? `Showing <b>${monthLabel(sel, true)}</b>` : last ? `<b>${nf.format(last[1])}</b> added in ${monthLabel(last[0], true)} so far` : '';
    }
    function pickMonth(k) {
      const [y, mo] = k.split('-').map(Number);
      const end = `${k}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
      $('[data-cat-datefield]').value = 'added';
      if (selectedMonth() === k) $('[data-cat-period]').value = 'any';
      else {
        $('[data-cat-period]').value = 'custom';
        $('[data-cat-from]').value = k + '-01';
        $('[data-cat-to]').value = end;
      }
      render();
    }

    function hl(text, t) {
      const s = esc(text);
      if (!t.length) return s;
      const re = new RegExp('(' + t.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
      return s.replace(re, '<mark>$1</mark>');
    }
    function item(r, t) {
      const c = cats[r[F.cat]];
      const title = r[F.title] || r[F.name].split('/').pop();
      const repo = r[F.repo];
      const ghUrl = /^[a-z0-9-_.]+\/[a-z0-9-_.]+$/i.test(repo) ? `https://github.com/${repo}` : safeUrl(repo);
      const site = safeUrl(r[F.website]);
      const pk = PKG[r[F.pkgType]];
      const pkgUrl = pk ? pk.page(r[F.pkgId]) : '';
      const tags = [`<button type="button" class="cat-tag" data-cat="${c.id}" title="${r[F.guessed] ? 'Category matched from similar servers' : 'Category from the title and description'}"><span class="cat-dot" style="--h:${hues[r[F.cat]]}"></span>${esc(c.label)}</button>`];
      if (r[F.remoteUrl]) tags.push(`<span class="cat-tag">Hosted (${esc(r[F.remoteType] || 'http')})</span>`);
      if (pk) tags.push(`<span class="cat-tag">${pk.label} package</span>`);
      const rc = REACH[r[F.reach]];
      if (rc) tags.push(`<span class="cat-state ${rc[0]}">${rc[1]}</span>`);
      if (r[F.required] > 0) tags.push(`<span class="cat-tag">${r[F.required]} required setting${r[F.required] > 1 ? 's' : ''}</span>`);
      if (r[F.archived]) tags.push('<span class="cat-state bad">Repo archived</span>');
      if (r[F.deprecated]) tags.push('<span class="cat-state bad">Deprecated</span>');
      if (r[F.pubCount] >= 100) tags.push(`<span class="cat-tag" title="This publisher has ${nf.format(r[F.pubCount])} servers in the registry">Bulk publisher</span>`);
      if (r[F.version]) tags.push(`<span class="cat-tag">v${esc(r[F.version].slice(0, 16))}</span>`);
      if (r[F.added]) tags.push(`<span class="cat-tag" title="First version published to the registry">Added ${esc(fmtDate(r[F.added]))}</span>`);
      if (r[F.updated] && r[F.updated] !== r[F.added]) tags.push(`<span class="cat-tag" title="Latest version published${r[F.versions] > 1 ? `, ${r[F.versions]} versions in all` : ''}">Released ${esc(fmtDate(r[F.updated]))}</span>`);
      if (r[F.pushed]) tags.push(`<span class="cat-tag" title="Last push to the GitHub repo">Pushed ${esc(fmtDate(r[F.pushed]))}</span>`);
      const links = [];
      const a = (href, label) => links.push(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      if (site) a(site, 'Website');
      if (ghUrl) a(ghUrl, /github\.com/.test(ghUrl) ? 'GitHub' : 'Source');
      if (pkgUrl) a(pkgUrl, pk.label);
      if (r[F.remoteUrl] && !/[{}]/.test(r[F.remoteUrl]) && safeUrl(r[F.remoteUrl])) a(r[F.remoteUrl], 'Endpoint');
      const cmd = installCmd(r);
      // A package server MCP Browser can start on this computer, once you approve it.
      const L = window.MCPLocal;
      const local = Boolean(L) && !runnable(r) && L.isPackage(r[F.pkgType]);
      const localReady = local && L.canRun(r[F.name]);
      const localApproved = local && L.get(r[F.name]);
      if (localReady) tags.unshift('<span class="cat-state ok">Runs on this Mac</span>');
      // Our test run of the package (scripts/probe-packages.mjs), if any.
      const tested = F.tested != null && r[F.tested];
      if (tested) {
        const [code, day, nTools, why] = tested;
        const T = { a: ['ok', 'Tested: starts and answers'], s: ['ok', 'Tested: starts'], n: ['warn', 'Tested: no tools'], f: ['bad', 'Tested: didn’t start'], k: ['', 'Needs a key to test'], g: ['', 'Needs arguments to test'] }[code];
        if (T) tags.push(`<span class="cat-state ${T[0]}" title="${esc(`Tested ${day}${nTools ? `, ${nTools} tools` : ''}${why ? `: ${why}` : ''}`)}">${T[1]}</span>`);
      }
      else if (localApproved) tags.unshift(`<span class="cat-state warn">Needs ${esc(localApproved.missing.join(', '))} again</span>`);
      const canAsk = (runnable(r) || local) && typeof hooks.ask === 'function';
      const prompts = F.prompts != null ? r[F.prompts] || [] : [];
      const promptHtml = prompts.length
        ? `<div class="cat-prompts"><span class="cat-prompts-label">${canAsk ? 'Try asking' : 'Example prompts'}</span><ul>${prompts
            .map(([p, src]) => {
              const via = src && src.startsWith('t:') ? `<span class="cat-via" title="Built from this tool">${esc(src.slice(2))}</span>` : src === 'd' ? '<span class="cat-via" title="Built from the server’s description">from description</span>' : '';
              return `<li><button type="button" class="cat-prompt" data-prompt="${esc(p)}" data-ask="${canAsk ? esc(r[F.name]) : ''}"${local ? ' data-local="1"' : ''} title="${local && !localReady ? 'Run this here: MCP Browser starts this server on your computer after you approve it' : canAsk ? 'Run this here, sent to this server' : 'Copy this prompt: this server has to be installed first'}"><span>${esc(p)}</span><span class="cat-prompt-act">${canAsk ? 'Run' : 'Copy'}</span></button>${via}</li>`;
            })
            .join('')}</ul></div>`
        : '';
      const toolNames = F.tools != null ? r[F.tools] || [] : [];
      const toolsHtml = toolNames.length ? `<p class="cat-toolnames"><span>Tools</span> ${toolNames.map((n) => `<code>${hl(n, t)}</code>`).join(' ')}</p>` : '';
      const unit = pk && pk.unit ? pk.unit : 'downloads';
      return `<li class="cat-item"><div class="cat-main" data-run-host><h3>${hl(title, t)}</h3><div class="cat-id">${hl(r[F.name], t)}</div>${r[F.desc] ? `<p class="cat-desc">${hl(r[F.desc], t)}</p>` : ''}<div class="cat-tags">${tags.join('')}</div>${promptHtml}${toolsHtml}${links.length ? `<div class="cat-links">${links.join('')}</div>` : ''}${cmd ? `<div class="cat-install"><code>${esc(cmd)}</code><button type="button" class="cat-copy" data-cmd="${esc(cmd)}">Copy</button></div>` : ''}<div class="cat-actions">${local && !localReady ? `<button type="button" class="cat-stack-btn" data-local-run="${esc(r[F.name])}">${localApproved ? 'Enter key to run' : 'Run on this Mac'}</button>` : ''}<button type="button" class="cat-guide-btn" data-guide="${esc(r[F.name])}" aria-expanded="false">How to use it</button><button type="button" class="cat-stack-btn" data-stack="${esc(r[F.name])}" aria-pressed="${stackIds.has(r[F.name])}">${stackIds.has(r[F.name]) ? '✓ In my stack' : '+ Add to my stack'}</button><button type="button" class="link-btn" data-open="mcp://stack" data-stack-go="${esc(r[F.name])}" ${stackIds.has(r[F.name]) ? '' : 'hidden'}>Set it up in my apps</button></div><div class="cat-guide" hidden></div></div>
        <div class="cat-metrics">
          <div class="m star"><span>GitHub stars</span><b class="${r[F.stars] < 0 ? 'none' : ''}">${r[F.stars] < 0 ? 'none' : fmt(r[F.stars])}</b></div>
          <div class="m"><span>${esc(unit)}</span><b class="${r[F.downloads] < 0 ? 'none' : ''}">${r[F.downloads] < 0 ? (pk ? 'n/a' : 'none') : fmt(r[F.downloads])}</b></div>
          <div class="m"><span>MCP Rank</span><b class="${r[F.rank] ? '' : 'none'}">${r[F.rank] ? r[F.rank] + '/100' : 'untested'}</b></div>
        </div></li>`;
    }
    function more() {
      const t = $('[data-cat-q]').value.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const next = view.slice(shown, shown + PAGE);
      $('[data-cat-list]').insertAdjacentHTML('beforeend', next.map((r) => item(r, t)).join(''));
      shown += next.length;
      $('[data-cat-more]').hidden = shown >= view.length;
      $('[data-cat-more]').textContent = `Show ${Math.min(PAGE, view.length - shown)} more of ${nf.format(view.length - shown)}`;
    }
    function setCat(id) {
      catSel = entry.category = id;
      render();
    }

    // Shared with the use-case view and the per-server guide.
    const ctx = { hooks };
    const byName = new Map();
    let uses = null;
    function setView(v) {
      entry.view = v;
      for (const b of el.querySelectorAll('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
      $('[data-cat-uses]').hidden = v !== 'uses';
      $('[data-cat-all]').hidden = v !== 'all';
    }
    function showServer(name) {
      setView('all');
      catSel = entry.category = 'all';
      filters.clear();
      for (const b of el.querySelectorAll('[data-cat-filter]')) b.setAttribute('aria-pressed', 'false');
      $('[data-cat-period]').value = 'any';
      $('[data-cat-q]').value = name;
      render();
      const first = $('[data-cat-list] .cat-item');
      first?.scrollIntoView({ block: 'start' });
      first?.querySelector('[data-guide]')?.click();
    }
    async function addToBrowser(id) {
      const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(body) });
      let r = await post('/api/servers/toggle', { id, enabled: true });
      if (r.ok) return 'Turned on in MCP Browser. Questions can now use it.';
      const row = byName.get(id);
      if (!row || !row[F.remoteUrl]) throw new Error('it has no hosted address');
      r = await post('/api/servers/custom', { url: row[F.remoteUrl], title: row[F.title] || id.split('/').pop(), description: row[F.desc] || '' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return 'Added to MCP Browser (under “Added by you”).';
    }
    Object.assign(ctx, { showServer, addToBrowser, runnable: (r) => runnable(r) });

    // Run a prompt right where it was clicked; the answer appears below, with the
    // same view as a search tab (servers asked, results, sources, follow-ups).
    function adhocFor(id) {
      const r = byName.get(id);
      return r && r[F.remoteUrl] ? { id, url: r[F.remoteUrl], transport: r[F.remoteType] === 'sse' ? 'sse' : 'streamable-http', title: r[F.title] || id.split('/').pop(), description: r[F.desc] || '' } : undefined;
    }
    const adhocList = (ids) => (ids || []).map(adhocFor).filter(Boolean);
    function runHere(btn) {
      const prompt = btn.dataset.prompt;
      // data-ask: one server, several (comma-separated, asked together), or * (normal routing).
      const ids = btn.dataset.ask === '*' ? [] : btn.dataset.ask.split(',').filter(Boolean);
      const id = ids.length ? ids : undefined;
      const host = btn.closest('[data-run-host]') || btn.closest('li') || btn.parentElement;
      if (typeof hooks.runInline !== 'function') return hooks.ask?.(prompt, id, adhocList(id));
      let box = host.querySelector(':scope > .cat-run');
      if (!box) {
        box = document.createElement('div');
        box.className = 'cat-run';
        box.innerHTML = '<div class="cat-run-bar"><span>Answer</span><button type="button" class="link-btn" data-run-tab>Open in a tab</button><button type="button" class="link-btn" data-run-close>Close</button></div><div class="cat-run-body"></div>';
        host.appendChild(box);
      }
      for (const b of host.querySelectorAll('.cat-prompt[aria-pressed="true"]')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      box.dataset.prompt = prompt;
      box.dataset.server = (id || []).join(',');
      hooks.runInline(box.querySelector('.cat-run-body'), prompt, id, adhocList(id));
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // The approval panel for a package server, under the item; then run what was asked.
    function localPanel(btn, id, then) {
      const host = btn.closest('[data-run-host]') || btn.parentElement;
      let slot = host.querySelector(':scope > .lr-host');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'lr-host';
        host.appendChild(slot);
      }
      window.MCPLocal.panel(slot, id, {
        onReady: () => {
          for (const b of host.querySelectorAll('[data-local-run]')) b.remove();
          const tags = host.querySelector('.cat-tags');
          if (tags && !tags.querySelector('.lr-on')) tags.insertAdjacentHTML('afterbegin', '<span class="cat-state ok lr-on">Runs on this Mac</span>');
          then?.();
        },
      });
      slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    el.addEventListener('input', (e) => window.MCPGuide?.handleInput(e));
    el.addEventListener('click', (e) => {
      if (window.MCPGuide?.handleClick(e, ctx)) return;
      const sb = e.target.closest('[data-stack]');
      if (sb) {
        sb.disabled = true;
        window.MCPStack.toggle(sb.dataset.stack).then(
          async (on) => {
            stackIds = await window.MCPStack.ids();
            for (const b of el.querySelectorAll(`[data-stack="${CSS.escape(sb.dataset.stack)}"]`)) (b.setAttribute('aria-pressed', String(on)), (b.textContent = on ? '✓ In my stack' : '+ Add to my stack'));
            for (const b of el.querySelectorAll(`[data-stack-go="${CSS.escape(sb.dataset.stack)}"]`)) b.hidden = !on;
            sb.disabled = false;
          },
          (err) => ((sb.textContent = err.message), (sb.disabled = false))
        );
        return;
      }
      const sa = e.target.closest('[data-stack-all]');
      if (sa) {
        const list = sa.dataset.stackAll.split(',').filter(Boolean);
        sa.disabled = true;
        (async () => {
          for (const id of list) if (!(await window.MCPStack.ids()).has(id)) await window.MCPStack.toggle(id);
          stackIds = await window.MCPStack.ids();
          sa.innerHTML = `Added to <button type="button" class="link-btn" data-open="mcp://stack">my stack</button>`;
        })();
        return;
      }
      const op = e.target.closest('[data-open]');
      if (op) return hooks.open?.(op.dataset.open);
      const rt = e.target.closest('[data-run-tab]');
      if (rt) {
        const box = rt.closest('.cat-run');
        const ids = box.dataset.server ? box.dataset.server.split(',') : undefined;
        return hooks.ask(box.dataset.prompt, ids, adhocList(ids));
      }
      const rc = e.target.closest('[data-run-close]');
      if (rc) {
        const box = rc.closest('.cat-run');
        box.querySelector('.cat-run-body').__entry?.abort?.abort();
        for (const b of box.parentElement.querySelectorAll('.cat-prompt[aria-pressed="true"]')) b.setAttribute('aria-pressed', 'false');
        return box.remove();
      }
      const v = e.target.closest('[data-view]');
      if (v) return setView(v.dataset.view);
      const sv = e.target.closest('[data-show]');
      if (sv) return showServer(sv.dataset.show);
      const gb = e.target.closest('[data-guide]');
      if (gb) {
        const panel = gb.nextElementSibling;
        const open = panel.hidden;
        panel.hidden = !open;
        gb.setAttribute('aria-expanded', String(open));
        gb.textContent = open ? 'Hide how to use it' : 'How to use it';
        if (open && !panel.dataset.done) {
          panel.dataset.done = '1';
          window.MCPGuide.renderGuide(panel, byName.get(gb.dataset.guide), ctx);
        }
        return;
      }
      const gl = e.target.closest('.cat-guide [data-goal]');
      if (gl && uses) return setView('uses'), uses.showGoal(gl.dataset.goal);
      const c = e.target.closest('[data-cat]');
      if (c) return setCat(c.dataset.cat === catSel && c.dataset.cat !== 'all' ? 'all' : c.dataset.cat);
      const f = e.target.closest('[data-cat-filter]');
      if (f) {
        const k = f.dataset.catFilter;
        filters.has(k) ? filters.delete(k) : filters.add(k);
        f.setAttribute('aria-pressed', String(filters.has(k)));
        return render();
      }
      const m = e.target.closest('[data-month]');
      if (m) return pickMonth(m.dataset.month);
      const lr = e.target.closest('[data-local-run]');
      if (lr) return localPanel(lr, lr.dataset.localRun);
      const pr = e.target.closest('.cat-prompt');
      if (pr) {
        if (pr.dataset.local && !window.MCPLocal.canRun(pr.dataset.ask)) return localPanel(pr, pr.dataset.ask, () => runHere(pr));
        if (pr.dataset.ask) return runHere(pr);
        const act = pr.querySelector('.cat-prompt-act');
        const done = () => { act.textContent = 'Copied'; setTimeout(() => (act.textContent = 'Copy'), 1400); };
        try { navigator.clipboard.writeText(pr.dataset.prompt).then(done, () => {}); } catch {}
        return;
      }
      const cp = e.target.closest('.cat-copy');
      if (cp) {
        const done = () => { cp.textContent = 'Copied'; setTimeout(() => (cp.textContent = 'Copy'), 1400); };
        const fallback = () => { const s = getSelection(); const rg = document.createRange(); rg.selectNodeContents(cp.previousElementSibling); s.removeAllRanges(); s.addRange(rg); cp.textContent = 'Selected'; };
        try { navigator.clipboard.writeText(cp.dataset.cmd).then(done, fallback); } catch { fallback(); }
      }
    });
    $('[data-cat-more]').addEventListener('click', more);
    let timer;
    $('[data-cat-q]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 140); });
    for (const s of ['[data-cat-sort]', '[data-cat-datefield]', '[data-cat-period]', '[data-cat-from]', '[data-cat-to]']) $(s).addEventListener('change', render);
    $('[data-cat-clear]').addEventListener('click', () => {
      $('[data-cat-period]').value = 'any';
      $('[data-cat-from]').value = $('[data-cat-to]').value = '';
      render();
    });

    // (wait for the approved package servers so "Runs on this Mac" shows on first render)
    Promise.all([load(), window.MCPLocal?.ready()]).then(([data]) => {
      D = data;
      D.fields.forEach((f, i) => (F[f] = i));
      cats = D.cats.map(([id, label], i) => ({ id, label, i }));
      cats.forEach((c, i) => (hues[i] = c.id === 'other' ? -1 : Math.round(i * 137.508 + 190) % 360));
      rows = D.rows;
      const m = {};
      for (const r of rows) {
        r._hay ||= [r[F.title], r[F.name], r[F.desc], r[F.pkgId], cats[r[F.cat]].label, ...(F.tools != null ? r[F.tools] || [] : [])].join(' ').toLowerCase();
        r._titleHay ||= (r[F.title] + ' ' + r[F.name]).toLowerCase();
        r._pop = popularity(r);
        const k = (r[F.added] || r[F.updated] || '').slice(0, 7);
        if (k) m[k] = (m[k] || 0) + 1;
      }
      months = Object.keys(m).sort().map((k) => [k, m[k]]);
      const gh = rows.filter((r) => r[F.stars] >= 0).length;
      const dl = rows.filter((r) => r[F.downloads] >= 0).length;
      const remote = rows.filter((r) => r[F.remoteUrl]).length;
      $('[data-cat-lede]').innerHTML = `<b>${nf.format(rows.length)}</b> servers from the official MCP Registry in ${cats.length - 1} categories, as of ${esc(fmtDate(D.generatedAt))}. <b>${nf.format(gh)}</b> have GitHub stars, <b>${nf.format(dl)}</b> have package download counts and <b>${nf.format(remote)}</b> run at a hosted URL. Start from what you want to do, or browse every server.`;
      for (const r of rows) byName.set(r[F.name], r);
      Object.assign(ctx, { F, rows, byName, catIndex: (id) => cats.findIndex((c) => c.id === id) });
      if (window.MCPUseCases) {
        uses = window.MCPUseCases.create($('[data-cat-uses]'), ctx);
        uses.render();
      }
      if (entry.q) $('[data-cat-q]').value = entry.q; // "!mcp weather"
      setView(entry.view || (window.MCPUseCases ? 'uses' : 'all'));
      render();
      if (entry.show) showServer(entry.show);
    }).catch((e) => {
      $('[data-cat-lede]').textContent = '';
      $('[data-cat-count]').textContent = '';
      $('[data-cat-list]').innerHTML = `<li class="empty">The catalog didn’t load: ${esc(e.message)}</li>`;
    });
  }

  window.MCPCatalog = { mount, load };
})();
