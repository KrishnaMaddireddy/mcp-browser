// "Run on this Mac": approve a package MCP server (npm, PyPI, Docker image) and
// let MCP Browser start it on this computer. Shared by the catalog and the stack.
// The panel shows what will run before anything is downloaded: the exact command
// and pinned version, adoption and warning signs, and how it is isolated.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(b) }).then((r) => r.json());
  const fmt = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');
  const TYPES = new Set(['npm', 'pypi', 'oci']);
  const SOURCE = { npm: 'npm', pypi: 'PyPI', oci: 'a container registry' };
  const HOW = {
    sandbox: ['In the macOS sandbox', 'It can only read and write its own folder, not your files. Checked on this Mac.'],
    docker: ['In Docker', 'It runs in a container with none of your folders shared.'],
    none: ['Without a sandbox', 'It runs as you and can read and change your files. Only for servers you trust.'],
  };

  let state = { servers: [], sandbox: null, runtimes: {} };
  let loading = null;
  const listeners = new Set();
  function refresh() {
    loading = fetch('/api/local')
      .then((r) => r.json())
      .then((d) => {
        state = d;
        for (const f of listeners) f(state);
        return state;
      })
      .catch(() => state);
    return loading;
  }
  const ready = () => loading || refresh();
  const get = (id) => state.servers.find((s) => s.id === id) || null;
  /** Approved and every setting filled in: prompts can run. */
  const canRun = (id) => Boolean(get(id) && !get(id).missing.length);
  const isPackage = (type) => TYPES.has(type);

  function settingsHtml(settings, values, missingOnly) {
    const list = missingOnly ? settings.filter((s) => missingOnly.includes(s.name)) : settings;
    if (!list.length) return '';
    return `<div class="lr-settings">${list
      .map(
        (s) => `<label class="g-set"><span><code>${esc(s.name)}</code>${s.secret ? ' <em>secret</em>' : ''}</span><small>${esc(s.description || '')}</small><input type="${s.secret ? 'password' : 'text'}" data-lr-set="${esc(s.name)}" data-secret="${s.secret ? 1 : ''}" value="${esc((!s.secret && values[s.name]) || '')}" placeholder="${s.secret ? 'Kept only until MCP Browser quits, never saved' : 'value'}" autocomplete="off" spellcheck="false"></label>`
      )
      .join('')}</div>`;
  }

  function collect(box) {
    const values = {};
    const secrets = {};
    for (const x of box.querySelectorAll('[data-lr-set]')) if (x.value.trim()) (x.dataset.secret ? secrets : values)[x.dataset.lrSet] = x.value.trim();
    return { values, secrets };
  }

  function statusHtml(r) {
    if (r.ok) return `<p class="lr-ok">Running on this Mac with ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}${r.tools.length ? `: ${r.tools.slice(0, 8).map((t) => `<code>${esc(t)}</code>`).join(' ')}${r.tools.length > 8 ? ' …' : ''}` : ''}.</p>`;
    return `<div class="lr-fail"><p>It didn’t start: ${esc(String(r.error || 'unknown error').split('\n')[0])}</p>${r.log || String(r.error || '').includes('\n') ? `<details><summary>What it printed</summary><pre>${esc((r.log || r.error).slice(-3000))}</pre></details>` : ''}</div>`;
  }

  /**
   * Show the approval (or key) panel in host. onReady() runs once it is running.
   */
  async function panel(host, id, { onReady, onCancel } = {}) {
    host.innerHTML = '<div class="lr"><p class="hint">Looking up the package…</p></div>';
    const box = host.firstElementChild;
    let c;
    try {
      c = await fetch('/api/local/check?id=' + encodeURIComponent(id)).then((r) => r.json());
    } catch (e) {
      c = { error: e.message };
    }
    if (c.error) {
      box.innerHTML = `<p class="lr-fail">${esc(c.error)}</p><p><button type="button" class="link-btn" data-lr-cancel>Close</button></p>`;
      box.querySelector('[data-lr-cancel]').onclick = () => ((host.innerHTML = ''), onCancel?.());
      return;
    }
    // Approved already, but its keys are gone (MCP Browser restarted): just ask for them.
    if (c.approved && c.approved.version === c.package.version && c.approved.missing.length) {
      box.innerHTML = `<h4>${esc(c.title)} needs its key again</h4><p>Keys are never saved, so MCP Browser asks again after it restarts.</p>${settingsHtml(c.settings, c.approved.values, c.approved.missing)}<div class="lr-acts"><button type="button" class="st-dl-btn" data-lr-go>Start it</button><button type="button" class="link-btn" data-lr-cancel>Cancel</button></div><div data-lr-status></div>`;
      box.querySelector('[data-lr-cancel]').onclick = () => ((host.innerHTML = ''), onCancel?.());
      box.querySelector('[data-lr-go]').onclick = async (e) => {
        e.target.disabled = true;
        box.querySelector('[data-lr-status]').innerHTML = '<p class="hint">Starting…</p>';
        const r = await post('/api/local/keys', { id, secrets: collect(box).secrets });
        await refresh();
        box.querySelector('[data-lr-status]').innerHTML = statusHtml(r);
        e.target.disabled = false;
        if (r.ok) onReady?.();
      };
      return;
    }
    const p = c.package;
    const update = c.approved && c.approved.version !== p.version;
    const avail = Object.entries(c.how).filter(([, v]) => v.available).map(([k]) => k);
    if (p.error || !avail.length) {
      box.innerHTML = `<h4>Run ${esc(c.title)} on this Mac</h4><p class="lr-fail">${esc(p.error ? `Couldn’t look up the package: ${p.error}` : `MCP Browser can’t run it here: ${Object.values(c.how).map((v) => v.reason).filter(Boolean)[0] || 'nothing to run it with'}.`)}</p><p><button type="button" class="link-btn" data-lr-cancel>Close</button></p>`;
      box.querySelector('[data-lr-cancel]').onclick = () => ((host.innerHTML = ''), onCancel?.());
      return;
    }
    const values = { ...(c.stackValues || {}), ...(c.approved?.values || {}) };
    const facts = [
      c.stars >= 0 ? `★ ${fmt(c.stars)} on GitHub` : 'Not on GitHub',
      c.downloads >= 0 ? `${fmt(c.downloads)} downloads a month` : '',
      p.type === 'npm' ? (p.installScripts?.length ? `It has install scripts (${p.installScripts.join(', ')}). They are blocked, so it may not work.` : 'No install scripts.') : '',
      p.type === 'pypi' ? (p.wheel ? 'Installs from a prebuilt package: no code runs during install.' : 'Must be built from source, so it only runs in Docker.') : '',
      p.deprecated ? `Its publisher says: ${p.deprecated}` : '',
    ].filter(Boolean);
    box.innerHTML = `
      <h4>${update ? `Update ${esc(c.title)} to ${esc(p.version)}` : `Run ${esc(c.title)} on this Mac`}</h4>
      <p>This downloads <b>${esc(p.name)}</b> version <b>${esc(p.version)}</b> from ${SOURCE[p.type]} and starts it on your computer. It’s someone else’s code, so check it first.${update ? ` You approved version ${esc(c.approved.version)}; updates need your OK again.` : ' The version is pinned: updates need your OK again.'}</p>
      <ul class="lr-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}${c.github ? `<li><a href="${esc(c.github)}" target="_blank" rel="noopener noreferrer">Read the code on GitHub</a></li>` : ''}</ul>
      ${c.trust.trusted ? '' : `<div class="lr-warn"><p><b>Warning signs</b></p><ul>${c.trust.why.map((w) => `<li>${esc(w.replace(/^./, (x) => x.toUpperCase()))}</li>`).join('')}</ul><label class="lr-check"><input type="checkbox" data-lr-risk> I checked this server and want to run it anyway</label></div>`}
      <fieldset class="lr-how"><legend>How it runs</legend>
        ${['sandbox', 'docker', 'none']
          .map((k) => {
            const v = c.how[k];
            if (!v) return '';
            return `<label class="lr-opt ${v.available ? '' : 'off'}"><input type="radio" name="lr-how-${esc(id)}" value="${k}" ${v.available ? '' : 'disabled'} ${k === c.prefer ? 'checked' : ''}> <span><b>${HOW[k][0]}</b> ${v.available ? esc(HOW[k][1]) : `<small>${esc(v.reason || 'not available')}</small>`}</span></label>`;
          })
          .join('')}
        <label class="lr-check" data-lr-nosb hidden><input type="checkbox" data-lr-nosb-ok> I understand it can read and change my files</label>
      </fieldset>
      ${settingsHtml(c.settings, values)}
      <p class="lr-cmd-l">It will run</p><pre class="lr-cmd" data-lr-cmd></pre>
      <div class="lr-acts"><button type="button" class="st-dl-btn" data-lr-go>Allow and start</button><button type="button" class="link-btn" data-lr-cancel>Cancel</button></div>
      <div data-lr-status></div>`;
    const how = () => box.querySelector(`input[name="lr-how-${CSS.escape(id)}"]:checked`)?.value;
    const sync = () => {
      box.querySelector('[data-lr-cmd]').textContent = c.commands[how()] || '';
      box.querySelector('[data-lr-nosb]').hidden = how() !== 'none';
    };
    box.addEventListener('change', sync);
    sync();
    box.querySelector('[data-lr-cancel]').onclick = () => ((host.innerHTML = ''), onCancel?.());
    box.querySelector('[data-lr-go]').onclick = async (e) => {
      const st = box.querySelector('[data-lr-status]');
      if (!c.trust.trusted && !box.querySelector('[data-lr-risk]').checked) return (st.innerHTML = '<p class="lr-fail">Tick “run it anyway” above, or cancel.</p>');
      if (how() === 'none' && !box.querySelector('[data-lr-nosb-ok]').checked) return (st.innerHTML = '<p class="lr-fail">Tick “I understand” for running without a sandbox, or pick another way.</p>');
      const missing = c.settings.filter((s) => !box.querySelector(`[data-lr-set="${CSS.escape(s.name)}"]`)?.value.trim()).map((s) => s.name);
      if (missing.length) return (st.innerHTML = `<p class="lr-fail">Fill in ${missing.map(esc).join(', ')} first.</p>`);
      e.target.disabled = true;
      st.innerHTML = '<p class="hint">Starting… The first start downloads the package and can take a minute.</p>';
      const { values: v, secrets } = collect(box);
      let r;
      try {
        r = await post('/api/local/approve', { id, version: p.version, isolation: how(), acceptRisk: c.trust.trusted || box.querySelector('[data-lr-risk]')?.checked === true, acceptNoSandbox: how() === 'none' && box.querySelector('[data-lr-nosb-ok]').checked, values: v, secrets });
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      await refresh();
      st.innerHTML = r.error && !r.approved ? `<p class="lr-fail">${esc(r.error)}</p>` : statusHtml(r);
      e.target.disabled = false;
      if (r.ok) {
        e.target.hidden = true;
        box.querySelector('[data-lr-cancel]').textContent = 'Close';
        onReady?.();
      }
    };
  }

  /** The "Running on this Mac" list (stack page). */
  function listHtml() {
    const s = state;
    if (!s.servers.length) return '';
    const how = { sandbox: 'macOS sandbox', docker: 'Docker', none: 'no sandbox' };
    return `<section class="lr-list"><h2>Package servers on this Mac</h2><p class="hint">MCP Browser starts these when a question needs them and stops each after 10 minutes unused.</p><ul>${s.servers
      .map((x) => {
        const st = x.missing.length ? `<span class="cat-state warn">Needs ${esc(x.missing.join(', '))} again</span>` : x.state?.status === 'running' ? '<span class="cat-state ok">Running</span>' : x.state?.status === 'starting' ? '<span class="cat-state">Starting</span>' : '<span class="cat-state">Stopped</span>';
        return `<li data-lr-id="${esc(x.id)}"><div class="lr-row"><b>${esc(x.title)}</b> ${st} <span class="cat-tag">${esc(x.name)} ${esc(x.version)}</span> <span class="cat-tag">${esc(how[x.isolation] || x.isolation)}</span></div>
          <code class="lr-cmd-s">${esc(x.command)}</code>
          ${x.lastError ? `<p class="lr-fail">Last error: ${esc(String(x.lastError).split('\n')[0])}</p>` : ''}
          <div class="lr-acts">${x.missing.length ? '<button type="button" class="link-btn" data-lr-keys>Enter key</button>' : x.state?.status === 'running' ? '<button type="button" class="link-btn" data-lr-stop>Stop</button>' : '<button type="button" class="link-btn" data-lr-start>Start</button>'}<button type="button" class="link-btn" data-lr-forget>Remove from this Mac</button></div><div data-lr-panel></div></li>`;
      })
      .join('')}</ul></section>`;
  }

  /** Handle clicks inside listHtml(); returns true when handled. */
  async function handleListClick(e, rerender) {
    const li = e.target.closest('[data-lr-id]');
    if (!li) return false;
    const id = li.dataset.lrId;
    if (e.target.closest('[data-lr-stop]')) await post('/api/local/stop', { id });
    else if (e.target.closest('[data-lr-start]')) {
      e.target.textContent = 'Starting…';
      const r = await post('/api/local/start', { id });
      if (!r.ok) {
        await refresh();
        rerender();
        const l2 = document.querySelector(`[data-lr-id="${CSS.escape(id)}"] [data-lr-panel]`);
        if (l2) l2.innerHTML = statusHtml(r);
        return true;
      }
    } else if (e.target.closest('[data-lr-forget]')) await post('/api/local/forget', { id });
    else if (e.target.closest('[data-lr-keys]')) {
      panel(li.querySelector('[data-lr-panel]'), id, { onReady: () => refresh().then(rerender) });
      return true;
    } else return false;
    await refresh();
    rerender();
    return true;
  }

  window.MCPLocal = { refresh, ready, get, canRun, isPackage, panel, listHtml, handleListClick, onChange: (f) => listeners.add(f), state: () => state };
})();
