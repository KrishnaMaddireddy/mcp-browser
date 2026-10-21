// mcp://stack — "My MCP stack": the servers you picked from the catalog, their
// settings, whether they're installed, prompts to try, and one setup for all of
// them (a script that configures every client, or per-client snippets).
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(b) }).then((r) => r.json());
  const fmt = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');

  // Stack ids, shared by the catalog's "Add to my stack" buttons.
  let idsPromise = null;
  const ids = () => (idsPromise ||= fetch('/api/stack?ids=1').then((r) => r.json()).then((d) => new Set(d.ids || [])).catch(() => new Set()));
  async function toggle(id) {
    const set = await ids();
    const r = await post(set.has(id) ? '/api/stack/remove' : '/api/stack/add', { id });
    if (r.error) throw new Error(r.error);
    idsPromise = Promise.resolve(new Set(r.ids));
    return !set.has(id);
  }

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    let items = [];
    let F = null;
    let byName = null;
    let clients = null; // [{ id, label, present, file }]
    const typed = {}; // id → { NAME: key } typed this visit; kept in memory only, never saved
    const picked = new Set();

    async function load() {
      $('[data-st-sum]').textContent = 'Loading your stack…';
      const [s, D, cl] = await Promise.all([
        fetch('/api/stack').then((r) => r.json()),
        window.MCPCatalog.load().catch(() => null),
        clients ? null : fetch('/api/stack/clients').then((r) => r.json()).catch(() => ({ clients: [] })),
      ]);
      if (cl) {
        clients = cl.clients || [];
        for (const c of clients) if (c.present) picked.add(c.id);
      }
      items = s.items || [];
      idsPromise = Promise.resolve(new Set(items.map((x) => x.id)));
      if (D && !F) {
        F = Object.fromEntries(D.fields.map((f, i) => [f, i]));
        byName = new Map(D.rows.map((r) => [r[F.name], r]));
      }
      render();
    }

    function card(it, i) {
      const s = it.server;
      if (!s) return `<li class="st-item"><div class="st-head"><h3>${esc(it.id)}</h3></div><p class="hint">No longer in the registry catalog.</p><p><button type="button" class="link-btn" data-st-remove="${esc(it.id)}">Remove</button></p></li>`;
      const settings = (byName && byName.get(it.id) && F.envs != null ? byName.get(it.id)[F.envs] || [] : []);
      const warn = (s.checks || []).filter((c) => /^(warn|bad):/.test(c));
      return `<li class="st-item" data-st-id="${esc(it.id)}">
        <div class="st-head">
          <div class="st-title"><h3>${esc(s.title)}</h3><code>${esc(it.id)}</code></div>
          <div class="st-order"><button type="button" title="Move up" aria-label="Move up" data-st-move="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" title="Move down" aria-label="Move down" data-st-move="1" ${i === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="link-btn" data-st-remove="${esc(it.id)}">Take out of stack</button></div>
        </div>
        <p class="st-desc">${esc(s.description || '')}</p>
        <p class="st-chips">
          <span class="cat-tag">${esc(s.category)}</span>
          ${s.github_stars != null ? `<span class="cat-tag">★ ${fmt(s.github_stars)}</span>` : ''}
          ${s.downloads ? `<span class="cat-tag">${fmt(s.downloads.count)} ${esc(s.downloads.source)} / mo</span>` : ''}
          ${it.installedIn.length ? `<span class="cat-state ok">Installed in ${esc(it.installedIn.join(', '))}</span>` : '<span class="cat-state warn">Not installed yet</span>'}
          ${it.runnable ? '<span class="cat-state ok">Works in MCP Browser now</span>' : ''}
          ${warn.length ? `<span class="cat-state warn" title="${esc(warn.map((w) => w.replace(/^\w+: /, '')).join('\n'))}">${warn.length} thing${warn.length > 1 ? 's' : ''} to check</span>` : ''}
        </p>
        ${settings.length ? `<div class="st-settings">${settings.map(([n, secret, d]) => `<label class="g-set"><span><code>${esc(n)}</code>${secret ? ' <em>secret</em>' : ''}</span><small>${esc(window.MCPGuide.explain(n, d))}</small>${secret ? `<input type="password" data-st-secret="${esc(n)}" value="${esc(typed[it.id]?.[n] || '')}" placeholder="Paste it here: used only when you click Set up, never saved" autocomplete="off" spellcheck="false">` : `<input type="text" data-st-val="${esc(n)}" value="${esc(it.values[n] || '')}" placeholder="value" autocomplete="off" spellcheck="false">`}</label>`).join('')}</div>` : ''}
        ${s.sample_prompts?.length ? `<div class="cat-prompts" data-run-host><span class="cat-prompts-label">${it.runnable ? 'Try it' : 'Prompts to try once it’s installed'}</span><ul>${s.sample_prompts.map((p) => `<li><button type="button" class="cat-prompt" data-prompt="${esc(p)}" ${it.runnable ? `data-st-run="${esc(it.id)}"` : 'data-st-copy'}><span>${esc(p)}</span><span class="cat-prompt-act">${it.runnable ? 'Run' : 'Copy'}</span></button></li>`).join('')}</ul></div>` : ''}
        ${warn.length ? `<details class="st-warn"><summary>Things to check</summary><ul class="g-checks">${warn.map((w) => `<li class="${w.split(':')[0]}">${esc(w.replace(/^\w+: /, ''))}</li>`).join('')}</ul></details>` : ''}
        <p class="st-links">${s.github ? `<a href="${esc(s.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>` : ''}${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}<button type="button" class="link-btn" data-st-show="${esc(it.id)}">In the catalog</button></p>
      </li>`;
    }

    // Servers still missing a setting (they'd be skipped), from what's typed on the page right now.
    function missingHtml() {
      const missing = items.filter((it) => {
        const r = byName?.get(it.id);
        if (!r || F.envs == null) return false;
        const li = el.querySelector(`[data-st-id="${CSS.escape(it.id)}"]`);
        const now = (n) => li?.querySelector(`[data-st-val="${CSS.escape(n)}"],[data-st-secret="${CSS.escape(n)}"]`)?.value.trim();
        return (r[F.envs] || []).some(([n]) => !(now(n) ?? (typed[it.id]?.[n] || it.values?.[n])));
      });
      return missing.length ? `Fill in the settings above for ${missing.map((it) => `<b>${esc(it.server?.title || it.id)}</b>`).join(', ')}, or ${missing.length === 1 ? 'it is' : 'they are'} skipped.` : '';
    }

    function setupBlock() {
      const rows = byName ? items.map((it) => byName.get(it.id)).filter(Boolean) : [];
      const values = Object.fromEntries(items.map((it) => [it.id, it.values || {}]));
      const snippets = rows.length ? window.MCPGuide.setupHtml(rows, F, { title: 'Or paste the config yourself' }) : '';
      return `<section class="st-setup">
        <h2>Set up all ${items.length} in your apps</h2>
        <p>MCP Browser adds these servers to the apps you pick. It backs up each config file first and only adds or replaces these servers; everything else in your config stays as it is.</p>
        <fieldset class="st-clients"><legend>Apps on this computer</legend>
          ${(clients || []).map((c) => `<label class="st-client"><input type="checkbox" data-st-client="${esc(c.id)}" ${picked.has(c.id) ? 'checked' : ''}> <span>${esc(c.label)}</span>${c.present ? '' : ' <small>(not found)</small>'}</label>`).join('') || '<span class="hint">Checking which apps you have…</span>'}
        </fieldset>
        <p class="st-missing" data-st-missing>${missingHtml()}</p>
        <div class="st-dl">
          <button type="button" class="st-dl-btn" data-st-apply="go">Set up now</button>
          <button type="button" class="link-btn" data-st-apply="dry">Preview changes</button>
          <button type="button" class="link-btn" data-st-apply="remove">Remove these from the apps</button>
        </div>
        <pre class="st-out" data-st-out hidden></pre>
        <details class="u-setup"><summary>Prefer Terminal? Download a setup script</summary>
        <p>The same setup as a script you run yourself. It checks what’s needed (Node, uv, Docker), asks for each key with hidden typing (keys are never saved in the script), backs up and updates the Claude Desktop, Cursor and VS Code configs, and adds the servers to Claude Code. Try <code>--dry-run</code> first to see what it would change.</p>
        <div class="st-dl">
          <a class="st-dl-btn alt" href="/api/stack/script?format=mjs" download="setup-mcp.mjs">Download setup-mcp.mjs</a>
          <a class="link-btn" href="/api/stack/script?format=ts" download="setup-mcp.ts">TypeScript version (.ts)</a>
          <button type="button" class="link-btn" data-st-copy-script>Copy script</button>
        </div>
        <div class="g-code st-run"><pre>cd ~/Downloads
node setup-mcp.mjs --dry-run    # see what would change
node setup-mcp.mjs              # set up every client found
node setup-mcp.mjs --clients=desktop,code   # only some clients</pre><button type="button" class="cat-copy" data-cmd="cd ~/Downloads&#10;node setup-mcp.mjs --dry-run">Copy</button></div>
        <p class="g-note">TypeScript version: <code>npx tsx setup-mcp.ts</code>. Non-secret values you typed above (e.g. EDGAR_IDENTITY) are filled in; keys are asked for when it runs, or read from your environment if already set.</p>
        </details>
        ${snippets}
      </section>`;
    }

    function render() {
      if (!items.length) {
        $('[data-st-sum]').innerHTML = 'Your stack is empty. Add servers from the <button type="button" class="link-btn" data-st-open="mcp://catalog">Server catalog</button> (“Add to my stack” on any server or use case), then come back here to set them all up at once.';
        $('[data-st-list]').innerHTML = '';
        $('[data-st-setup]').innerHTML = '';
        return;
      }
      const installed = items.filter((x) => x.installedIn.length).length;
      $('[data-st-sum]').innerHTML = `<b>${items.length}</b> server${items.length > 1 ? 's' : ''} in your stack, <b>${installed}</b> already installed in one of your apps. <button type="button" class="link-btn" data-st-open="mcp://catalog">Add more</button> · <button type="button" class="link-btn" data-st-open="mcp://audit">Check installed servers</button>`;
      $('[data-st-list]').innerHTML = items.map(card).join('');
      $('[data-st-setup]').innerHTML = setupBlock();
    }

    // Preview / Set up now / Remove: runs the setup on this computer through MCP Browser.
    async function apply(btn) {
      const mode = btn.dataset.stApply;
      const out = $('[data-st-out]');
      if (!picked.size) {
        out.hidden = false;
        out.textContent = 'Tick at least one app above.';
        return;
      }
      const secrets = {};
      for (const li of el.querySelectorAll('[data-st-id]')) {
        const v = {};
        for (const x of li.querySelectorAll('[data-st-val],[data-st-secret]')) if (x.value.trim()) v[x.dataset.stVal || x.dataset.stSecret] = x.value.trim();
        secrets[li.dataset.stId] = v;
      }
      const buttons = el.querySelectorAll('[data-st-apply]');
      for (const b of buttons) b.disabled = true;
      const label = btn.textContent;
      btn.textContent = mode === 'dry' ? 'Previewing…' : mode === 'remove' ? 'Removing…' : 'Setting up…';
      out.hidden = false;
      out.textContent = '';
      try {
        const r = await post('/api/stack/apply', { clients: [...picked], secrets, dry: mode === 'dry', remove: mode === 'remove' });
        out.textContent = r.error || r.output || (r.ok ? 'Done.' : 'It stopped without saying why.');
        out.classList.toggle('bad', !r.ok);
        if (r.ok && mode !== 'dry') {
          for (const k of Object.keys(typed)) delete typed[k];
          const keep = out.textContent;
          await load();
          const o = $('[data-st-out]');
          o.hidden = false;
          o.textContent = keep;
          o.scrollIntoView({ block: 'nearest' });
          return;
        }
      } catch (e) {
        out.textContent = `Couldn’t reach MCP Browser: ${e.message}`;
        out.classList.add('bad');
      }
      btn.textContent = label;
      for (const b of buttons) b.disabled = false;
    }

    let saveTimer;
    el.addEventListener('input', (e) => {
      if (window.MCPGuide?.handleInput(e)) return;
      if (e.target.closest('[data-st-val],[data-st-secret]')) queueMicrotask(() => $('[data-st-missing]') && ($('[data-st-missing]').innerHTML = missingHtml()));
      const sec = e.target.closest('[data-st-secret]');
      if (sec) {
        const id = sec.closest('[data-st-id]').dataset.stId;
        (typed[id] ||= {})[sec.dataset.stSecret] = sec.value;
        return;
      }
      const cb = e.target.closest('[data-st-client]');
      if (cb) return cb.checked ? picked.add(cb.dataset.stClient) : picked.delete(cb.dataset.stClient);
      const inp = e.target.closest('[data-st-val]');
      if (!inp) return;
      const li = inp.closest('[data-st-id]');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const values = {};
        for (const x of li.querySelectorAll('[data-st-val]')) if (x.value.trim()) values[x.dataset.stVal] = x.value.trim();
        await post('/api/stack/values', { id: li.dataset.stId, values });
        const it = items.find((x) => x.id === li.dataset.stId);
        if (it) it.values = values;
      }, 500);
    });
    el.addEventListener('click', async (e) => {
      if (window.MCPGuide?.handleClick(e, { addToBrowser: async () => '' })) return;
      const t = (s) => e.target.closest(s);
      if (t('[data-st-open]')) return hooks.open?.(t('[data-st-open]').dataset.stOpen);
      if (t('[data-st-show]')) return hooks.showServer?.(t('[data-st-show]').dataset.stShow);
      if (t('[data-st-remove]')) {
        await post('/api/stack/remove', { id: t('[data-st-remove]').dataset.stRemove });
        return load();
      }
      if (t('[data-st-move]')) {
        const li = t('[data-st-move]').closest('[data-st-id]');
        await post('/api/stack/move', { id: li.dataset.stId, delta: Number(t('[data-st-move]').dataset.stMove) });
        return load();
      }
      const ap = t('[data-st-apply]');
      if (ap) return apply(ap);
      const run = t('[data-st-run]');
      if (run) {
        const it = items.find((x) => x.id === run.dataset.stRun);
        const host = run.closest('[data-run-host]');
        let box = host.querySelector(':scope > .cat-run');
        if (!box) {
          box = document.createElement('div');
          box.className = 'cat-run';
          box.innerHTML = '<div class="cat-run-bar"><span>Answer</span></div><div class="cat-run-body"></div>';
          host.appendChild(box);
        }
        return hooks.runInline?.(box.querySelector('.cat-run-body'), run.dataset.prompt, [it.id], it.adhoc ? [it.adhoc] : undefined);
      }
      const cp = t('[data-st-copy]');
      if (cp) {
        try {
          await navigator.clipboard.writeText(cp.dataset.prompt);
          cp.querySelector('.cat-prompt-act').textContent = 'Copied';
        } catch {}
        return;
      }
      if (t('[data-st-copy-script]')) {
        const b = t('[data-st-copy-script]');
        const text = await fetch('/api/stack/script?format=mjs').then((r) => r.text());
        try {
          await navigator.clipboard.writeText(text);
          b.textContent = 'Copied';
        } catch {
          b.textContent = 'Couldn’t copy: use Download';
        }
        return;
      }
      const cpy = t('.cat-copy');
      if (cpy) {
        try {
          await navigator.clipboard.writeText(cpy.dataset.cmd);
          cpy.textContent = 'Copied';
        } catch {}
      }
    });
    load().catch((e) => ($('[data-st-sum]').textContent = `Couldn’t load your stack: ${e.message}`));
  }

  window.MCPStack = { mount, ids, toggle };
})();
