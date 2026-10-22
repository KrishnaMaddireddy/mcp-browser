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

  function stepsHtml(p) {
    return `<ol class="pl-steps">${p.steps
      .map((s) => `<li><span class="pl-how">${s.each ? 'For each result of the step before, ask' : 'Ask'}${s.serverTitles?.length ? ` <b>${esc(s.serverTitles.join(' + '))}</b>` : ' the servers MCP Browser picks'}</span><q>${hl(s.ask)}</q></li>`)
      .join('')}</ol>`;
  }
  function cardHtml(p, mine) {
    return `<li class="pl-card" data-pl="${esc(p.id)}">
      <div class="pl-head"><h3>${esc(p.title)}</h3>${mine ? '<button type="button" class="link-btn" data-pl-del>Delete</button>' : ''}</div>
      ${p.description ? `<p class="pl-desc">${esc(p.description)}</p>` : ''}
      ${stepsHtml(p)}
      <form class="pl-run" data-pl-run><label><span>${esc(p.input?.label || 'Input')}</span><input type="text" value="${esc(p.input?.example || '')}" data-pl-input></label><button type="submit" class="st-dl-btn">Run</button><button type="button" class="link-btn" data-pl-edit>Change it</button><button type="button" class="link-btn" data-pl-sched>On a schedule</button></form>
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
    let data = { starters: [], mine: [] };
    const all = () => [...data.mine, ...data.starters];
    async function load() {
      data = await fetch('/api/pipelines').then((r) => r.json());
      $('[data-pl-mine]').innerHTML = data.mine.map((p) => cardHtml(p, true)).join('');
      $('[data-pl-mine-h]').hidden = !data.mine.length;
      $('[data-pl-starters]').innerHTML = data.starters.map((p) => cardHtml(p, false)).join('');
    }

    async function run(card, p, input) {
      const out = card.querySelector('[data-pl-out]');
      card.__ac?.abort();
      const ac = (card.__ac = new AbortController());
      out.innerHTML = '<p class="hint">Running…</p>';
      const steps = [];
      const box = (i) => {
        if (!steps[i]) {
          const s = document.createElement('section');
          s.className = 'pl-step-out';
          s.innerHTML = `<h4>Step ${i + 1}</h4><div data-runs></div>`;
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
          if (type === 'pipe_run') {
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
                 ${d.sources?.length ? `<ul class="pl-links">${d.sources.slice(0, 4).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> <span class="hint">${esc(s.host)}</span></li>`).join('')}</ul>` : d.answer ? '' : '<p class="hint">Nothing useful came back.</p>'}`;
          } else if (type === 'pipe_done') {
            out.insertAdjacentHTML('beforeend', `<p class="hint">Done in ${(d.ms / 1000).toFixed(1)} s.</p>`);
          } else if (type === 'error') out.insertAdjacentHTML('beforeend', `<p class="lr-fail">${esc(d.message)}</p>`);
        }
      }
    }

    function readEditor(f, base) {
      const steps = [...f.querySelectorAll('.pl-ed-step')].map((li) => ({
        ask: li.querySelector('[data-ed-ask]').value.trim(),
        each: Boolean(li.querySelector('[data-ed-each]')?.checked),
        servers: li.querySelector('[data-ed-servers]').value.split(',').map((x) => x.trim()).filter(Boolean),
      })).filter((s) => s.ask);
      return { ...(base?.id && data.mine.some((m) => m.id === base.id) ? { id: base.id } : {}), title: f.querySelector('[data-ed-title]').value, description: base?.description || '', input: { label: f.querySelector('[data-ed-label]').value, example: f.querySelector('[data-ed-example]').value }, steps };
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
      if (e.target.closest('[data-go]')) return hooks.open?.(e.target.closest('[data-go]').dataset.go);
      const card = e.target.closest('[data-pl]');
      if (!card) return;
      const p = all().find((x) => x.id === card.dataset.pl);
      if (e.target.closest('[data-pl-edit]')) return openEditor(p);
      if (e.target.closest('[data-pl-del]')) return post('/api/pipelines/delete', { id: p.id }).then(load);
      if (e.target.closest('[data-pl-sched]')) return (card.querySelector('[data-pl-schedbox]').hidden = !card.querySelector('[data-pl-schedbox]').hidden);
      if (e.target.closest('[data-pl-sched-save]')) {
        const r = await post('/api/pipelines/watch', { pipeline: p, input: card.querySelector('[data-pl-input]').value.trim(), every: card.querySelector('[data-pl-every]').value, until: card.querySelector('[data-pl-until]').value.trim() }).then((x) => x.json());
        card.querySelector('[data-pl-sched-msg]').innerHTML = r.error ? esc(r.error) : 'Scheduled. Results and changes show up in <button type="button" class="link-btn" data-go="mcp://watches">Watches</button>.';
      }
    });
    load().catch((e) => ($('[data-pl-starters]').innerHTML = `<li class="lr-fail">${esc(e.message)}</li>`));
  }

  window.MCPPipelines = { mount };
})();
