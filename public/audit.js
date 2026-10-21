// mcp://audit: the MCP servers installed in this computer's clients, matched to
// the registry, with risks and better-maintained alternatives.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LEVEL = { bad: 'Fix this', warn: 'Worth a look', ok: 'Looks fine' };
  const home = (f) => String(f).replace(/^\/(Users|home)\/[^/]+/, '~');

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    async function load() {
      $('[data-audit-sum]').textContent = 'Reading your MCP client configs…';
      let r;
      try {
        r = await fetch('/api/audit').then(async (x) => (x.ok ? x.json() : Promise.reject(new Error((await x.json().catch(() => ({}))).error || `HTTP ${x.status}`))));
      } catch (e) {
        $('[data-audit-sum]').textContent = `Couldn’t check: ${e.message}`;
        return;
      }
      const found = r.files.filter((f) => f.found);
      $('[data-audit-files]').innerHTML = r.files
        .map((f) => `<li class="${f.found ? 'found' : ''}"><b>${esc(f.client)}</b> <code>${esc(home(f.file))}</code> ${f.found ? (f.error ? `<span class="bad">${esc(f.error)}</span>` : `${f.servers} server${f.servers === 1 ? '' : 's'}`) : '<span class="muted">not found</span>'}</li>`)
        .join('');
      if (!r.servers.length) {
        $('[data-audit-sum]').textContent = found.length ? 'No MCP servers are configured in the clients found on this computer.' : 'No MCP client configs were found on this computer.';
        $('[data-audit-list]').innerHTML = '';
        return;
      }
      const { bad, warn } = r.counts;
      $('[data-audit-sum]').innerHTML = `<b>${r.servers.length}</b> servers in ${found.length} config file${found.length === 1 ? '' : 's'}: ${bad ? `<span class="bad">${bad} to fix</span>, ` : ''}${warn ? `<span class="warn">${warn} worth a look</span>, ` : ''}${r.servers.length - bad - warn} look fine. Secret values are never shown or sent anywhere; only their names.`;
      const order = { bad: 0, warn: 1, ok: 2 };
      const list = [...r.servers].sort((a, b) => order[a.level] - order[b.level] || a.name.localeCompare(b.name));
      $('[data-audit-list]').innerHTML = list
        .map(
          (s) => `<li class="a-item ${s.level}">
          <div class="a-head"><span class="a-level ${s.level}">${LEVEL[s.level]}</span><h3>${esc(s.name)}</h3><span class="a-where">${esc(s.client)}${s.scope !== 'user' ? ` · project ${esc(home(s.scope))}` : ''}</span></div>
          <p class="a-how"><code>${esc(s.how)}</code>${s.catalog ? ` → <button type="button" class="link-btn" data-a-show="${esc(s.catalog.server_id)}">${esc(s.catalog.title)}</button> in the registry${s.catalog.github_stars != null ? ` · ★ ${s.catalog.github_stars.toLocaleString()}` : ''}` : ''}</p>
          <ul class="g-checks">${s.checks.map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join('') || '<li class="ok">No problems found.</li>'}</ul>
          ${s.alternatives.length ? `<p class="a-alt">Alternatives: ${s.alternatives.map((a) => `<button type="button" class="u-server" data-a-show="${esc(a.server_id)}"><b>${esc(a.title)}</b>${a.stars ? `<span>★ ${a.stars.toLocaleString()}</span>` : ''}${a.runs_in_mcp_browser ? '<span class="u-live">works in MCP Browser</span>' : ''}</button>`).join(' ')}</p>` : ''}
        </li>`
        )
        .join('');
    }
    el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-a-show]');
      if (s) return hooks.showServer?.(s.dataset.aShow);
      if (e.target.closest('[data-audit-again]')) load();
    });
    load();
  }
  window.MCPAudit = { mount };
})();
