// "Tools on this page": WebMCP tools a web page offers, in MCP Browser's web tabs
// (desktop app). The page registers them (document.modelContext.registerTool, or
// a <form toolname>); electron/webmcp-bridge.js collects them inside the page.
// Here you can ask the page a question (its read-only tools answer, in free mode
// or with your AI model) or run any tool yourself. Tools that may change things
// always ask you first, and the AI model is never given them.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(b) });
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  /** What a tool does, as far as we can tell: reads, fills a form, or may change things. */
  const effect = (t) => (t.kind === 'form' ? 'form' : t.readOnly || /^(get|list|search|find|lookup|read|fetch|query|describe|show|view|check|browse)[_-]/i.test(t.name) ? 'read' : 'change');
  const EFFECT = { read: ['Reads', 'ok'], form: ['Fills a form', 'warn'], change: ['May change things', 'warn'] };

  function fieldsHtml(t) {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const req = new Set((t.inputSchema && t.inputSchema.required) || []);
    const keys = Object.keys(props).slice(0, 30);
    if (!keys.length) return '<p class="hint">No inputs.</p>';
    return keys
      .map((k) => {
        const p = props[k] || {};
        const label = `<span><code>${esc(k)}</code>${req.has(k) ? ' <em>required</em>' : ''}</span>${p.description ? `<small>${esc(String(p.description).slice(0, 300))}</small>` : ''}`;
        const type = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
        let input;
        if (Array.isArray(p.enum)) input = `<select data-pt-arg="${esc(k)}" data-t="enum">${req.has(k) ? '' : '<option value=""></option>'}${p.enum.slice(0, 100).map((v) => `<option value="${esc(JSON.stringify(v))}">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</option>`).join('')}</select>`;
        else if (type === 'boolean') input = `<input type="checkbox" data-pt-arg="${esc(k)}" data-t="boolean">`;
        else if (type === 'number' || type === 'integer') input = `<input type="number" data-pt-arg="${esc(k)}" data-t="number" ${p.default != null ? `value="${esc(p.default)}"` : ''}>`;
        else if (type === 'object' || type === 'array') input = `<textarea data-pt-arg="${esc(k)}" data-t="json" rows="3" placeholder="JSON"></textarea>`;
        else input = `<input type="text" data-pt-arg="${esc(k)}" data-t="string" ${p.default != null ? `value="${esc(p.default)}"` : ''} autocomplete="off" spellcheck="false">`;
        return `<label class="g-set">${label}${input}</label>`;
      })
      .join('');
  }
  function collectArgs(box) {
    const args = {};
    for (const x of box.querySelectorAll('[data-pt-arg]')) {
      const k = x.dataset.ptArg;
      if (x.dataset.t === 'boolean') {
        if (x.checked) args[k] = true;
        continue;
      }
      const v = x.value.trim();
      if (!v) continue;
      if (x.dataset.t === 'number') args[k] = Number(v);
      else if (x.dataset.t === 'enum') args[k] = JSON.parse(v);
      else if (x.dataset.t === 'json') args[k] = JSON.parse(v);
      else args[k] = v;
    }
    return args;
  }

  function attach({ el, wv, entry, runInline }) {
    let tools = [];
    let site = null; // directory entry for this host, if any
    let open = false;
    const bar = document.createElement('div');
    bar.className = 'pt-bar';
    bar.hidden = true;
    const row = document.createElement('div');
    row.className = 'pt-row';
    const panel = document.createElement('aside');
    panel.className = 'pt-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Tools on this page');
    wv.replaceWith(row);
    row.append(wv, panel);
    el.insertBefore(bar, row);

    // ---------- talking to the page ----------
    async function list() {
      try {
        const r = await wv.executeJavaScript('window.__mcpbWebMCP ? window.__mcpbWebMCP.list() : null', false);
        return (Array.isArray(r) ? r : []).filter((t) => t && NAME.test(String(t.name))).slice(0, 100);
      } catch {
        return [];
      }
    }
    async function call(name, args, { user = false, submit = false } = {}) {
      if (!NAME.test(String(name))) return { ok: false, text: 'not a tool name' };
      const src = `window.__mcpbWebMCP ? window.__mcpbWebMCP.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})}, ${JSON.stringify({ submit })}) : { ok: false, text: 'This page has no tools now.' }`;
      try {
        const r = await withTimeout(wv.executeJavaScript(src, user), 60000, 'The page didn’t answer within 60 seconds.');
        return r && typeof r === 'object' ? { ok: r.ok === true, text: String(r.text ?? '') } : { ok: false, text: 'No answer from the page.' };
      } catch (e) {
        return { ok: false, text: e.message || String(e) };
      }
    }

    // "Ask this page": the agent's calls come back here; only tools that read run.
    const page = {
      info: () => ({ url: entry.url, title: (wv.getTitle && wv.getTitle()) || hostOf(entry.url), tools: tools.filter((t) => t.kind !== 'form') }),
      async answer(d) {
        const t = tools.find((x) => x.name === d.name);
        const r = !t || t.kind === 'form' ? { ok: false, text: 'That tool is not available to the AI.' } : await call(d.name, d.args);
        await post('/api/page-tool-result', { callId: d.callId, ok: r.ok, text: r.text }).catch(() => {});
      },
    };

    // ---------- rendering ----------
    function renderBar() {
      const host = hostOf(entry.url);
      if (tools.length) {
        bar.hidden = false;
        bar.innerHTML = `<span class="pt-dot" aria-hidden="true"></span><span>This page offers <b>${tools.length}</b> tool${tools.length === 1 ? '' : 's'} for AI agents (WebMCP).</span><button type="button" class="la-btn" data-pt-toggle aria-expanded="${open}">${open ? 'Hide tools' : 'Use them'}</button>`;
      } else if (site && site.toolCount) {
        bar.hidden = false;
        bar.innerHTML = `<span>webmcp.com lists <b>${site.toolCount}</b> tool${site.toolCount === 1 ? '' : 's'} for ${esc(host)}${site.here ? '; they appear here once the page registers them' : ', on other pages of the site'}.</span><button type="button" class="la-btn" data-pt-toggle aria-expanded="${open}">${open ? 'Hide' : 'Show where'}</button>`;
      } else {
        bar.hidden = true;
        if (open) toggle(false);
      }
    }
    function toolHtml(t, i) {
      const [label, tone] = EFFECT[effect(t)];
      return `<li class="pt-tool" data-pt-i="${i}">
        <div class="pt-tool-head"><b>${esc(t.title || t.name)}</b> <span class="cat-state ${tone}">${label}</span></div>
        ${t.title ? `<code class="pt-name">${esc(t.name)}</code>` : ''}
        <p class="pt-desc">${esc(t.description || 'No description.')}</p>
        <button type="button" class="link-btn" data-pt-use>Use it</button>
        <div class="pt-use" hidden></div>
      </li>`;
    }
    function renderPanel() {
      const host = hostOf(entry.url);
      if (!tools.length) {
        const pages = site ? [...new Set((site.pages || []).filter(Boolean))] : [];
        panel.innerHTML = `<div class="pt-head"><h2>Tools on ${esc(host)}</h2><button type="button" class="link-btn" data-pt-close>Close</button></div>
          <p>webmcp.com lists ${site?.toolCount || 0} tools for this site, but this page hasn’t registered any. They usually appear on the page they belong to${pages.length ? ':' : '.'}</p>
          ${pages.length ? `<ul class="pt-pages">${pages.map((p) => `<li><button type="button" class="link-btn" data-pt-go="${esc(p)}">${esc(p)}</button></li>`).join('')}</ul>` : ''}
          <p class="hint">${esc(site?.desc || '')}</p>`;
        return;
      }
      const reads = tools.filter((t) => effect(t) === 'read').length;
      panel.innerHTML = `<div class="pt-head"><h2>Tools on this page</h2><button type="button" class="link-btn" data-pt-close>Close</button></div>
        <p class="pt-note">${esc(host)} offers these through WebMCP. They run on this page as you, with your sign-in here. The AI model only gets tools that read; anything that may change things asks you first.</p>
        <form class="pt-ask" data-pt-ask><input type="text" placeholder="${reads ? 'Ask this page…' : 'No tools here only read'}" ${reads ? '' : 'disabled'} aria-label="Ask this page"><button type="submit" class="la-btn" ${reads ? '' : 'disabled'}>Ask</button></form>
        <div class="pt-answer" data-pt-answer></div>
        <ul class="pt-tools">${tools.map(toolHtml).join('')}</ul>`;
    }
    function toggle(on = !open) {
      open = on;
      panel.hidden = !open;
      row.classList.toggle('pt-open', open);
      if (open) renderPanel();
      renderBar();
    }

    // ---------- updates ----------
    let t1 = 0;
    async function refresh() {
      clearTimeout(t1);
      t1 = setTimeout(async () => {
        const next = await list();
        const same = JSON.stringify(next.map((t) => [t.name, t.description, t.kind])) === JSON.stringify(tools.map((t) => [t.name, t.description, t.kind]));
        tools = next;
        if (!same) {
          renderBar();
          if (open) renderPanel();
        }
      }, 150);
    }
    async function lookup() {
      try {
        const r = await fetch('/api/webmcp/lookup?url=' + encodeURIComponent(entry.url)).then((x) => x.json());
        site = r.site;
        if (site) {
          const d = await fetch('/api/webmcp/site?host=' + encodeURIComponent(site.host))
            .then((x) => x.json())
            .catch(() => null);
          site.pages = (d?.site?.tools || []).map((t) => t.page);
        }
      } catch {
        site = null;
      }
      renderBar();
    }
    wv.addEventListener('console-message', (e) => {
      if (e.message === '__mcpb_webmcp_toolchange') refresh();
    });
    wv.addEventListener('dom-ready', refresh);
    wv.addEventListener('did-stop-loading', refresh);
    wv.addEventListener('did-navigate', () => ((tools = []), (site = null), renderBar(), lookup(), refresh()));
    wv.addEventListener('did-navigate-in-page', refresh);

    bar.addEventListener('click', (e) => {
      if (e.target.closest('[data-pt-toggle]')) toggle();
    });
    panel.addEventListener('submit', (e) => {
      const f = e.target.closest('[data-pt-ask]');
      if (!f) return;
      e.preventDefault();
      const q = f.querySelector('input').value.trim();
      if (q) runInline(panel.querySelector('[data-pt-answer]'), q, [], [], page);
    });
    panel.addEventListener('click', async (e) => {
      if (e.target.closest('[data-pt-close]')) return toggle(false);
      const go = e.target.closest('[data-pt-go]');
      if (go) return wv.loadURL(new URL(go.dataset.ptGo, entry.url).href);
      const li = e.target.closest('[data-pt-i]');
      if (!li) return;
      const t = tools[Number(li.dataset.ptI)];
      if (!t) return;
      const use = li.querySelector('.pt-use');
      if (e.target.closest('[data-pt-use]')) {
        use.hidden = !use.hidden;
        if (!use.hidden && !use.dataset.done) {
          use.dataset.done = '1';
          const fx = effect(t);
          use.innerHTML = `<div class="pt-fields">${fieldsHtml(t)}</div>
            ${t.kind === 'form' && t.autosubmit ? '<label class="lr-check"><input type="checkbox" data-pt-submit> Also submit the form</label>' : ''}
            ${fx !== 'read' ? `<p class="pt-confirm">${t.kind === 'form' ? 'This fills in a form on this page' : `This runs <code>${esc(t.name)}</code> on ${esc(hostOf(entry.url))} as you. It may change things there`}.</p>` : ''}
            <div class="lr-acts"><button type="button" class="st-dl-btn" data-pt-run>${fx === 'read' ? 'Run' : t.kind === 'form' ? 'Fill it in' : 'Run it'}</button></div>
            <pre class="pt-out" hidden></pre>`;
        }
        return;
      }
      const run = e.target.closest('[data-pt-run]');
      if (run) {
        const out = use.querySelector('.pt-out');
        let args;
        try {
          args = collectArgs(use);
        } catch {
          out.hidden = false;
          out.textContent = 'One of the JSON fields isn’t valid JSON.';
          return;
        }
        run.disabled = true;
        out.hidden = false;
        out.textContent = 'Running…';
        const submit = Boolean(use.querySelector('[data-pt-submit]')?.checked);
        const r = await call(t.name, args, { user: true, submit });
        out.classList.toggle('bad', !r.ok);
        out.textContent = r.text || (r.ok ? 'Done.' : 'It failed without saying why.');
        run.disabled = false;
      }
    });
    lookup();
    return { refresh, page };
  }

  window.MCPPageTools = { attach };
})();
