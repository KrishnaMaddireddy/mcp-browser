// mcp://pipelines — MCP servers working together. A pipeline is a few steps; a
// step can use what the step before found ({answer}, {titles}) or run once for
// each result of the step before ({title}, {url}). Run one now, change it and
// save your own, or put it on a schedule that stops when the result says
// something (a loop). Runs stream from POST /api/pipelines/run.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(b) });
  const hl = (s) => esc(s).replace(/\{(input|answer|titles|title|url|host)\}/g, '<span class="pl-var">{$1}</span>');

  // (what each kind of step does, in a few words)
  const HOW = {
    brief: () => 'Read your request in code (no server)',
    research: (s) => `Search ${s.serverTitles?.length ? `<b>${esc(s.serverTitles.join(' + '))}</b>` : 'the servers MCP Browser picks'} for`,
    generate: (s) => `Ask <b>${esc(s.serverTitles?.[0] || s.call?.server || '')}</b> to`,
    call: (s) => `Ask <b>${esc(s.serverTitles?.[0] || s.call?.server || '')}</b> for`,
    fetch: () => 'Read from the site itself',
    check: () => 'Check in code (no server)',
  };
  function stepsHtml(p) {
    const items = p.steps.map((s) => {
      const how = HOW[s.kind]?.(s) || `${s.each ? 'For each result of the step before, ask' : 'Ask'}${s.serverTitles?.length ? ` <b>${esc(s.serverTitles.join(' + '))}</b>` : ' the servers MCP Browser picks'}`;
      const what = s.kind === 'research' && s.queries?.length ? s.queries.map((q) => hl(q)).join(' · ') : s.kind === 'fetch' ? hl(`{domain}${s.path || '/robots.txt'}`) : hl(s.ask);
      return `<li><span class="pl-how">${how}</span><q>${what}</q></li>`;
    });
    // (every pipeline ends with a result that answers from the steps above)
    items.push('<li><span class="pl-how">Then</span><q>a result that answers from the steps above, citing them</q></li>');
    return `<ol class="pl-steps">${items.join('')}</ol>`;
  }
  const niceDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  function cardHtml(p, mine) {
    return `<li class="pl-card" data-pl="${esc(p.id)}">
      <div class="pl-head"><h3>${esc(p.title)}</h3>${mine ? '<button type="button" class="link-btn" data-pl-del>Delete</button>' : p.tested?.on ? `<span class="pl-tested" title="Every step returned results when we ran it with the example">Tested ${esc(niceDay(p.tested.on))}</span>` : ''}</div>
      ${p.description ? `<p class="pl-desc">${esc(p.description)}</p>` : ''}
      ${stepsHtml(p)}
      <form class="pl-run" data-pl-run><label><span>${esc(p.input?.label || 'Input')}</span><input type="text" value="${esc(p.input?.example || '')}" data-pl-input></label><button type="submit" class="st-dl-btn">Run</button><button type="button" class="link-btn" data-pl-edit>Change it</button><button type="button" class="link-btn" data-pl-sched>On a schedule</button><button type="button" class="link-btn" data-pl-tab title="Run it in a tab of its own (Ctrl- or ⌘-click Run does the same)">Open in new tab</button></form>
      <div class="pl-sched" data-pl-schedbox hidden>
        <label>Run it <select data-pl-every><option value="hourly">every hour</option><option value="daily" selected>every day</option><option value="weekly">every week</option></select></label>
        <label>and stop when the result mentions <input type="text" data-pl-until placeholder="optional, e.g. “released” or “$199”"></label>
        <button type="button" class="la-btn" data-pl-sched-save>Start</button><span class="hint" data-pl-sched-msg></span>
      </div>
      <div class="pl-out" data-pl-out></div>
    </li>`;
  }

  const stepEdHtml = (s, i) => `<li class="pl-ed-step" data-i="${i}">
      <label>Step ${i + 1}: ask <input type="text" data-ed-ask value="${esc(s.ask)}" placeholder="e.g. latest news about {input}"></label>
      ${i ? `<label class="lr-check"><input type="checkbox" data-ed-each ${s.each ? 'checked' : ''}> once for each result of the step before (use {title}, {url})</label>` : ''}
      <label>Servers <input type="text" data-ed-servers value="${esc((s.servers || []).join(', '))}" placeholder="server ids, or empty to let MCP Browser choose"></label>
      <button type="button" class="link-btn" data-ed-rm>Remove step</button></li>`;
  function editorHtml(p) {
    const st = stepEdHtml;
    return `<form class="pl-editor" data-pl-editor>
      <h2>${p.id ? 'Change pipeline' : 'New pipeline'}</h2>
      <label>Name <input type="text" data-ed-title value="${esc(p.title || '')}"></label>
      <label>What you type when you run it <input type="text" data-ed-label value="${esc(p.input?.label || 'Topic')}"></label>
      <label>Example <input type="text" data-ed-example value="${esc(p.input?.example || '')}"></label>
      <ol class="pl-ed-steps">${(p.steps || [{ ask: '' }]).map(st).join('')}</ol>
      <p class="hint">In a question: <code>{input}</code> what you typed · <code>{answer}</code> the step before’s answer · <code>{titles}</code> its results · in a “for each” step <code>{title}</code> <code>{url}</code> <code>{host}</code> of one result. Server ids are in the Server catalog (e.g. <code>keenable</code>, <code>exa</code>, <code>wikexa</code>, <code>context7</code>, <code>marketcrew</code>, <code>weather-worldwide</code>).</p>
      <div class="lr-acts"><button type="button" class="link-btn" data-ed-add>Add a step</button><button type="submit" class="st-dl-btn">Save</button><button type="button" class="link-btn" data-ed-cancel>Cancel</button><span class="hint" data-ed-msg></span></div>
    </form>`;
  }

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    let data = { starters: [], library: [], topics: [], mine: [] };
    const all = () => [...data.mine, ...data.starters, ...(data.library || [])];
    // The library: a topic, words to find, and how many cards are showing.
    const view = { topic: 'all', find: '', shown: 12 };
    const words = (p) => `${p.title} ${p.description} ${p.input?.label || ''} ${p.steps.map((s) => `${s.ask} ${(s.serverTitles || []).join(' ')}`).join(' ')}`.toLowerCase();
    function renderLibrary() {
      const lib = data.library?.length ? data.library : data.starters.map((p) => ({ ...p, category: 'featured' }));
      const terms = view.find.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = lib.filter((p) => (view.topic === 'all' || p.category === view.topic) && terms.every((t) => words(p).includes(t)));
      const counts = {};
      for (const p of lib) counts[p.category] = (counts[p.category] || 0) + 1;
      const topics = (data.topics || []).filter(([k]) => counts[k]);
      $('[data-pl-topics]').innerHTML = [['all', 'All', lib.length], ...topics.map(([k, label]) => [k, label, counts[k]])]
        .map(([k, label, n]) => `<button type="button" data-pl-topic="${esc(k)}" aria-pressed="${view.topic === k}">${esc(label)} <span>${n}</span></button>`)
        .join('');
      $('[data-pl-lib-h]').textContent = `Ready to run (${lib.length})`;
      $('[data-pl-starters]').innerHTML = hits.length ? hits.slice(0, view.shown).map((p) => cardHtml(p, false)).join('') : '<li class="hint">No pipeline matches. Try other words, or make your own with New pipeline.</li>';
      const more = $('[data-pl-more]');
      more.hidden = hits.length <= view.shown;
      more.textContent = `Show more (${hits.length - Math.min(view.shown, hits.length)} left)`;
    }
    async function load() {
      data = await fetch('/api/pipelines').then((r) => r.json());
      $('[data-pl-mine]').innerHTML = data.mine.map((p) => cardHtml(p, true)).join('');
      $('[data-pl-mine-h]').hidden = !data.mine.length;
      renderLibrary();
    }
    el.addEventListener('input', (e) => {
      if (!e.target.closest('[data-pl-find]')) return;
      view.find = e.target.value;
      view.shown = 12;
      renderLibrary();
    });

    async function run(card, p, input) {
      const out = card.querySelector('[data-pl-out]');
      card.__ac?.abort();
      const ac = (card.__ac = new AbortController());
      out.innerHTML = '<p class="hint">Running…</p>';
      const steps = [];
      const kinds = [];
      const KIND_WORD = { brief: 'brief', research: 'research', generate: 'write', call: 'look up', fetch: 'read the site', check: 'check' };
      const box = (i) => {
        if (!steps[i]) {
          const s = document.createElement('section');
          s.className = 'pl-step-out';
          s.innerHTML = `<h4>Step ${i + 1}${kinds[i] ? `: ${esc(kinds[i])}` : ''}</h4><div data-runs></div>`;
          out.appendChild(s);
          steps[i] = s;
        }
        return steps[i].querySelector('[data-runs]');
      };
      let res;
      try {
        res = await fetch('/api/pipelines/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ pipeline: p, input }), signal: ac.signal });
      } catch (e) {
        out.innerHTML = `<p class="lr-fail">${esc(e.message)}</p>`;
        return;
      }
      out.innerHTML = '';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
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
          if (type === 'pipe_step') kinds[d.i] = KIND_WORD[d.kind] || '';
          else if (type === 'pipe_final') out.appendChild(finalHtml(d));
          else if (type === 'pipe_run') {
            const r = document.createElement('div');
            r.className = 'pl-run-out';
            r.dataset.k = `${d.i}:${d.j}`;
            r.innerHTML = `<p class="pl-q">${esc(d.q)} <span class="hint">asking…</span></p>`;
            box(d.i).appendChild(r);
          } else if (type === 'pipe_result') {
            let r = out.querySelector(`[data-k="${d.i}:${d.j}"]`);
            if (!r) {
              r = document.createElement('div');
              r.className = 'pl-run-out';
              box(d.i).appendChild(r);
            }
            r.innerHTML = d.note
              ? `<p class="hint">${esc(d.note)}</p>`
              : `<p class="pl-q">${esc(d.q)}${d.servers?.length ? ` <span class="pl-from">${esc(d.servers.join(', '))}</span>` : ''}</p>
                 ${d.answer ? `<p class="pl-a">${esc(d.answer)}</p>` : ''}
                 ${(d.details || []).map((x) => `<div class="pl-detail"><span class="pl-from">${esc(x.server)}</span>${x.title ? `<b>${esc(x.title)}</b>` : ''}${x.text ? `<p>${esc(x.text)}</p>` : ''}${x.facts?.length ? `<dl>${x.facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>` : ''}</div>`).join('')}
                 ${d.check ? checkHtml(d.check) : ''}
                 ${d.dropped ? `<p class="hint">${d.dropped} result${d.dropped === 1 ? '' : 's'} that didn’t mention the subject left out.</p>` : ''}
                 ${d.sources?.length ? `<ul class="pl-links">${d.sources.slice(0, 4).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> <span class="hint">${esc(s.host)}</span></li>`).join('')}</ul>` : d.answer || d.details?.length ? '' : '<p class="hint">Nothing useful came back.</p>'}`;
          } else if (type === 'pipe_done') {
            out.insertAdjacentHTML('beforeend', `<p class="hint">Done in ${(d.ms / 1000).toFixed(1)} s.</p>`);
          } else if (type === 'error') out.insertAdjacentHTML('beforeend', `<p class="lr-fail">${esc(d.message)}</p>`);
        }
      }
    }

    // The check step: what passed, and what was left out and why.
    function checkHtml(c) {
      const row = (h) => `<li>${esc(h.text)} <span class="hint">${h.chars} characters${h.reason ? `: ${esc(h.reason)}` : ''}</span></li>`;
      return `${c.kept.length ? `<ul class="pl-check">${c.kept.map(row).join('')}</ul>` : ''}${c.dropped.length ? `<details class="pl-check-out"><summary>${c.dropped.length} left out</summary><ul>${c.dropped.map(row).join('')}</ul></details>` : ''}`;
    }
    // The result that ends every pipeline: an answer, a table if there is one, notes, and citations.
    function finalHtml(d) {
      const sec = document.createElement('section');
      sec.className = 'pl-final';
      const cites = (t) => esc(t).replace(/\[(\d{1,2})\]/g, (m, n) => {
        const c = (d.citations || []).find((x) => x.n === Number(n));
        return c?.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="${esc(c.title || '')}">[${n}]</a>` : m;
      });
      const table = d.table?.rows?.length ? `<div class="table-wrap"><table class="pl-final-table"><thead><tr>${d.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${d.table.rows.map((r) => `<tr>${r.map((v) => `<td>${cites(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
      sec.innerHTML = `<h4>Result</h4>${String(d.text || '').split('\n').filter(Boolean).map((l) => `<p class="${d.format === 'question' ? 'pl-ask' : 'pl-a'}">${cites(l)}</p>`).join('')}${table}${(d.notes || []).map((n) => `<p class="hint">${cites(n)}</p>`).join('')}${d.citations?.length ? `<ol class="pl-cites">${d.citations.map((c) => `<li value="${c.n}"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a> <span class="hint">${esc(c.host || '')}${c.step ? ` · step ${c.step}` : ''}</span></li>`).join('')}</ol>` : ''}`;
      return sec;
    }

    function readEditor(f, base) {
      // (a step's other settings — its kind, searches, tool call — come along from the pipeline it was made from)
      const keep = ({ kind, queries, call, path, check }) => ({ ...(kind ? { kind } : {}), ...(queries ? { queries } : {}), ...(call ? { call } : {}), ...(path ? { path } : {}), ...(check ? { check } : {}) });
      const steps = [...f.querySelectorAll('.pl-ed-step')].map((li, k) => ({
        ...(base?.steps?.[k] ? keep(base.steps[k]) : {}),
        ask: li.querySelector('[data-ed-ask]').value.trim(),
        each: Boolean(li.querySelector('[data-ed-each]')?.checked),
        servers: li.querySelector('[data-ed-servers]').value.split(',').map((x) => x.trim()).filter(Boolean),
      })).filter((s) => s.ask);
      return { ...(base?.id && data.mine.some((m) => m.id === base.id) ? { id: base.id } : {}), title: f.querySelector('[data-ed-title]').value, description: base?.description || '', input: { label: f.querySelector('[data-ed-label]').value, example: f.querySelector('[data-ed-example]').value }, steps, ...(base?.result ? { result: base.result } : {}) };
    }
    function openEditor(p) {
      const host = $('[data-pl-edhost]');
      host.innerHTML = editorHtml(p || {});
      const f = host.querySelector('[data-pl-editor]');
      f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      f.addEventListener('click', (e) => {
        if (e.target.closest('[data-ed-cancel]')) return (host.innerHTML = '');
        if (e.target.closest('[data-ed-add]')) {
          const ol = f.querySelector('.pl-ed-steps');
          const n = ol.children.length;
          if (n < 5) ol.insertAdjacentHTML('beforeend', stepEdHtml({ ask: '', each: n > 0 }, n));
        }
        if (e.target.closest('[data-ed-rm]')) e.target.closest('.pl-ed-step').remove();
      });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await post('/api/pipelines/save', { pipeline: readEditor(f, p) }).then((x) => x.json());
        if (r.error) return (f.querySelector('[data-ed-msg]').textContent = r.error);
        host.innerHTML = '';
        await load();
        $(`[data-pl="${CSS.escape(r.pipeline.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    // A pipeline in a tab of its own: "Open in new tab", or Ctrl/⌘-click (or middle-click) on Run.
    const toTab = (card) => {
      const p = all().find((x) => x.id === card.dataset.pl);
      if (!p || !hooks.openInTab) return false;
      const input = card.querySelector('[data-pl-input]').value.trim();
      const saved = !p.temp && p.id !== 'go-deeper' && all().some((x) => x.id === p.id);
      hooks.openInTab(saved ? { id: p.id, input, title: p.title } : { pipeline: p, input });
      return true;
    };
    el.addEventListener('auxclick', (e) => {
      const b = e.target.closest('[data-pl-run] button[type=submit]');
      if (b && e.button === 1 && toTab(b.closest('[data-pl]'))) e.preventDefault();
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pl-run] button[type=submit]');
      if (b && (e.metaKey || e.ctrlKey) && toTab(b.closest('[data-pl]'))) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    el.addEventListener('submit', (e) => {
      const f = e.target.closest('[data-pl-run]');
      if (!f) return;
      e.preventDefault();
      const card = f.closest('[data-pl]');
      const p = all().find((x) => x.id === card.dataset.pl);
      if (p) run(card, p, f.querySelector('[data-pl-input]').value.trim());
    });
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-pl-new]')) return openEditor(null);
      const topic = e.target.closest('[data-pl-topic]');
      if (topic) {
        view.topic = topic.dataset.plTopic;
        view.shown = 12;
        return renderLibrary();
      }
      if (e.target.closest('[data-pl-more]')) {
        view.shown += 24;
        return renderLibrary();
      }
      if (e.target.closest('[data-go]')) return hooks.open?.(e.target.closest('[data-go]').dataset.go);
      if (e.target.closest('[data-pl-show-all]')) return hooks.showAll?.();
      const card = e.target.closest('[data-pl]');
      if (!card) return;
      const p = all().find((x) => x.id === card.dataset.pl);
      if (e.target.closest('[data-pl-tab]')) return toTab(card);
      if (e.target.closest('[data-pl-edit]')) return openEditor(p);
      if (e.target.closest('[data-pl-del]')) return post('/api/pipelines/delete', { id: p.id }).then(load);
      if (e.target.closest('[data-pl-sched]')) return (card.querySelector('[data-pl-schedbox]').hidden = !card.querySelector('[data-pl-schedbox]').hidden);
      if (e.target.closest('[data-pl-sched-save]')) {
        const r = await post('/api/pipelines/watch', { pipeline: p, input: card.querySelector('[data-pl-input]').value.trim(), every: card.querySelector('[data-pl-every]').value, until: card.querySelector('[data-pl-until]').value.trim() }).then((x) => x.json());
        card.querySelector('[data-pl-sched-msg]').innerHTML = r.error ? esc(r.error) : 'Scheduled. Results and changes show up in <button type="button" class="link-btn" data-go="mcp://watches">Watches</button>.';
      }
    });
    load()
      .then(() => {
        // One pipeline in this tab ("Go deeper", "Open in new tab", mcp://pipelines/<id>): just that
        // card, run right away; the rest of the library is a click away.
        const found = hooks.run?.pipeline || (hooks.run?.id && all().find((x) => x.id === hooks.run.id));
        if (hooks.run && !found) {
          $('[data-pl-temp]').innerHTML = `<li class="lr-fail">No pipeline called “${esc(hooks.run.id)}”. <button type="button" class="link-btn" data-pl-show-all>See all pipelines</button></li>`;
          return;
        }
        if (!found) return;
        el.classList.add('pl-solo');
        hooks.titled?.(found.title);
        $('[data-pl-edhost]').insertAdjacentHTML('beforebegin', '<p class="pl-back"><button type="button" class="link-btn" data-pl-show-all>All pipelines</button></p>');
        const p = { ...found, steps: found.steps.map((s) => ({ ...s })) };
        data.starters = [p, ...data.starters.filter((x) => x.id !== p.id)];
        $('[data-pl-temp]').innerHTML = cardHtml(p, false);
        const card = $('[data-pl-temp] [data-pl]');
        const input = hooks.run.input || p.input?.example || '';
        card.querySelector('[data-pl-input]').value = input;
        run(card, p, input);
      })
      .catch((e) => ($('[data-pl-starters]').innerHTML = `<li class="lr-fail">${esc(e.message)}</li>`));
  }

  window.MCPPipelines = { mount };
})();
