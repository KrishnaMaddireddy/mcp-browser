// mcp://webmcp — "Websites with AI tools": sites whose pages offer tools to AI
// agents through WebMCP, from the webmcp.com directory (downloaded about once a
// day and searched locally). Opening one in a desktop tab lets MCP Browser pick
// the tools up from the page itself. Everything shown is written by site owners.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const KIND = { answer: ['Answers questions', 'ok'], act: ['Acts on the page', 'warn'], transact: ['Buys or books', 'bad'] };
  const count = (tools, k) => tools.filter((t) => t.kind === k).length;

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    let q = '';
    let kind = '';
    let category = '';
    let shown = [];
    let total = 0;

    function siteHtml(s, i) {
      const pages = [...new Set(s.tools.map((t) => t.page))];
      const kinds = Object.keys(KIND)
        .map((k) => [k, count(s.tools, k)])
        .filter(([, n]) => n)
        .map(([k, n]) => `<span class="cat-state ${KIND[k][1]}">${n} ${KIND[k][0].toLowerCase()}</span>`)
        .join('');
      return `<li class="wm-site" data-wm-i="${i}">
        <div class="wm-head"><h3>${esc(s.host)}</h3>${s.type === 'demo' ? '<span class="cat-tag">Demo</span>' : ''}${s.category ? `<span class="cat-tag">${esc(s.category)}</span>` : ''}</div>
        ${s.desc ? `<p class="wm-desc">${esc(s.desc)}</p>` : ''}
        <p class="wm-kinds">${kinds}</p>
        <details class="wm-tools"><summary>${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}</summary><ul>${s.tools
          .slice(0, 60)
          .map((t) => `<li><code>${esc(t.name)}</code> <span class="cat-state ${KIND[t.kind][1]}">${KIND[t.kind][0]}</span>${t.page !== '/' ? ` <span class="hint">on ${esc(t.page)}</span>` : ''}${t.description ? `<p>${esc(t.description)}</p>` : ''}</li>`)
          .join('')}${s.tools.length > 60 ? `<li class="hint">and ${s.tools.length - 60} more</li>` : ''}</ul></details>
        <p class="wm-acts">${pages
          .slice(0, 4)
          .map((p) => `<button type="button" class="la-btn" data-wm-open="${esc(new URL(p, s.url).href)}">${pages.length === 1 ? 'Open it' : `Open ${esc(p)}`}</button>`)
          .join('')}</p>
      </li>`;
    }

    async function load(more = false) {
      const offset = more ? shown.length : 0;
      $('[data-wm-sum]').textContent = more ? '' : 'Loading the directory…';
      let r;
      try {
        r = await fetch(`/api/webmcp/sites?q=${encodeURIComponent(q)}&kind=${kind}&category=${encodeURIComponent(category)}&offset=${offset}&limit=30`).then((x) => x.json());
      } catch (e) {
        $('[data-wm-sum]').textContent = `Couldn’t load the directory: ${e.message}`;
        return;
      }
      shown = more ? shown.concat(r.sites) : r.sites;
      total = r.total;
      if (!more && r.categories?.length && $('[data-wm-cat]').options.length <= 1) $('[data-wm-cat]').insertAdjacentHTML('beforeend', r.categories.map((c) => `<option>${esc(c)}</option>`).join(''));
      const info = r.info || {};
      $('[data-wm-sum]').innerHTML = info.sites
        ? `<b>${total.toLocaleString()}</b> of ${info.sites.toLocaleString()} sites${q || kind || category ? ' match' : ''}. Directory from webmcp.com, updated ${esc(new Date(info.fetchedAt).toLocaleDateString())}. <button type="button" class="link-btn" data-wm-refresh>Update now</button>`
        : `The directory couldn’t be downloaded${info.error ? `: ${esc(info.error)}` : ''}. <button type="button" class="link-btn" data-wm-refresh>Try again</button>`;
      $('[data-wm-list]').innerHTML = shown.map(siteHtml).join('');
      $('[data-wm-more]').hidden = shown.length >= total;
    }

    let timer;
    $('[data-wm-q]').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => ((q = e.target.value.trim()), load()), 200);
    });
    $('[data-wm-cat]').addEventListener('change', (e) => ((category = e.target.value), load()));
    el.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-wm-kind]');
      if (k) {
        kind = k.dataset.wmKind;
        for (const b of el.querySelectorAll('[data-wm-kind]')) b.setAttribute('aria-pressed', String(b === k));
        return load();
      }
      if (e.target.closest('[data-wm-more]')) return load(true);
      if (e.target.closest('[data-wm-refresh]')) {
        $('[data-wm-sum]').textContent = 'Updating…';
        await fetch('/api/webmcp/refresh', { method: 'POST', headers: { 'x-mcpb': '1' } }).catch(() => {});
        return load();
      }
      const o = e.target.closest('[data-wm-open]');
      if (o) hooks.openWeb?.(o.dataset.wmOpen);
    });
    if (!hooks.desktop) $('[data-wm-desk]').hidden = false;
    load();
  }

  window.MCPWebSites = { mount };
})();
