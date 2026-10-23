// mcp://check — cross-check a claim across independent sources. Each source's own
// sentence is quoted, sorted into "says the same", "says something different" and
// "mentions it", with the overall reading on top. Streams from POST /api/crosscheck.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const EXAMPLES = ['The Eiffel Tower is 330 meters tall', 'Mount Everest is 9,500 meters high', 'The default port for PostgreSQL is 5432', 'Saturn is the largest planet in the Solar System', 'The human body has 206 bones', 'Thomas Edison invented the telephone'];
  // (the same labels as the results page: a preprint or a package page is not "Official")
  const KIND = { official: 'Official', primary: 'Primary source', own: 'Official site', package: 'Package page', preprint: 'Preprint' };
  // (a short reading for each fact in a paragraph)
  const SHORT = { supported: 'Backed by several sources', mostly: 'Mostly backed', disputed: 'Sources disagree', contradicted: 'Sources say something different', weak: 'Only one or two sources say this', unclear: 'Not enough said', error: 'Couldn’t check' };
  const EXAMPLE_PARA = 'The Eiffel Tower was completed in 1889 for the World’s Fair. It is 330 meters tall and was designed by Gustave Eiffel. Mount Everest is 9,500 meters high. Thomas Edison invented the telephone in 1876. You should visit both at least once.';
  const GROUPS = [
    ['supports', 'Say the same'],
    ['differs', 'Say something different'],
    ['mentions', 'Mention it without saying it'],
  ];

  // The figure or name a source gives, marked in its sentence.
  function mark(sentence, bit) {
    const s = esc(sentence);
    if (!bit) return s;
    const b = esc(bit);
    const i = s.indexOf(b);
    return i < 0 ? s : `${s.slice(0, i)}<mark>${b}</mark>${s.slice(i + b.length)}`;
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      return false;
    }
  }

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    const form = $('[data-ck-form]');
    const input = $('[data-ck-claim]');
    $('[data-ck-examples]').innerHTML = EXAMPLES.map((x) => `<button type="button" data-ck-ex="${esc(x)}">${esc(x)}</button>`).join('');
    let ac = null;

    let runId = 0;
    async function run(claim) {
      ac?.abort();
      ac = new AbortController();
      const my = ++runId;
      hooks.onClaim?.(claim);
      const out = $('[data-ck-out]');
      const ev = [];
      out.innerHTML = `<p class="ck-wait">Asking web search, Wikipedia and specialist servers, then reading what each one says…</p>`;
      let verdict = null;
      let error = null;
      let progress = null;
      const render = () => {
        // (a check that was replaced by a newer one doesn't draw over it)
        if (my !== runId) return;
        const groups = GROUPS.map(([k, label]) => {
          const list = ev.filter((e) => e.stance === k);
          if (!list.length) return '';
          const items = list
            .map((e) => `<li class="ck-src"><blockquote>${mark(e.sentence, e.figure || e.other)}</blockquote><p class="ck-cite">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source)}</a>` : esc(e.source)}${KIND[e.kind] ? ` <span class="src-kind" data-kind="${esc(e.kind)}">${KIND[e.kind]}</span>` : ''}${e.via && e.via !== e.source ? ` <span>via ${esc(e.via)}</span>` : ''}${e.other ? ` <span>names ${esc(e.other)}</span>` : ''}</p></li>`)
            .join('');
          const body = `<ul class="ck-list">${items}</ul>`;
          return k === 'mentions'
            ? `<details class="ck-group ck-${k}"><summary>${esc(label)} (${list.length})</summary>${body}</details>`
            : `<section class="ck-group ck-${k}"><h3>${esc(label)} <span>${list.length}</span></h3>${body}</section>`;
        }).join('');
        const head = verdict
          ? `<div class="ck-verdict" data-v="${esc(verdict.verdict)}"><b>${esc(verdict.label)}</b><p>${verdict.judged === 'ai' ? 'An AI model read each quoted sentence.' : 'Each source’s own sentence, matched on the figures and names in your claim. Copies of the same page count once; forums count as mentions.'} Read the quotes: they are the evidence.</p><p class="ck-acts"><button type="button" class="link-btn" data-ck-copy>Copy as Markdown</button> <span data-ck-copied role="status"></span></p></div>`
          : '';
        const wait = verdict || error ? '' : `<p class="ck-wait">${progress ? `${progress.replies} server${progress.replies === 1 ? '' : 's'} replied (last: ${esc(progress.server)}). Reading what each source says…` : 'Asking web search, Wikipedia and specialist servers, then reading what each one says…'}</p>`;
        out.innerHTML = error ? `<p class="lr-fail">${esc(error)}</p>` : head + wait + (groups || (verdict ? '<p class="hint">No source said anything about it. Try wording it the way a reference page would.</p>' : ''));
      };
      let res;
      try {
        res = await fetch('/api/crosscheck', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ claim }), signal: ac.signal });
      } catch (e) {
        if (my === runId && e.name !== 'AbortError') out.innerHTML = `<p class="lr-fail">${esc(e.message)}</p>`;
        return;
      }
      // A refused claim comes back as JSON ("Write the claim as a sentence …"), not a stream.
      if (!res.ok || !/event-stream/.test(res.headers.get('content-type') || '')) {
        let msg = `The check failed (${res.status}).`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        if (my === runId) out.innerHTML = `<p class="lr-fail">${esc(msg)}</p>`;
        return;
      }
      let last = 0;
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
          if (type === 'check_source') {
            ev.push(d);
            // sources as they come in, a few times a second at most
            if (Date.now() - last > 250) {
              last = Date.now();
              render();
            }
          }
          else if (type === 'check_progress') {
            progress = d;
            if (Date.now() - last > 250) {
              last = Date.now();
              render();
            }
          } else if (type === 'check_verdict') verdict = d;
          else if (type === 'error') error = d.message;
        }
      }
      render();
      // The verdict with every quote and its link, to paste into a doc, an issue or a chat.
      const btn = out.querySelector('[data-ck-copy]');
      if (btn && my === runId)
        btn.onclick = async () => {
          const md = [`## Cross-check: “${claim.replace(/[\\`*_[\]<>!|]/g, '\\$&')}”`, '', `**${verdict.label}** (${new Date().toISOString().slice(0, 10)}, MCP Browser)`, ''];
          for (const [k, label] of GROUPS) {
            const list = ev.filter((e) => e.stance === k);
            if (!list.length) continue;
            md.push(`### ${label} (${list.length})`, '');
            // (quotes are other people's text: no links, images or HTML of their own in the paste)
            const mdText = (t) => String(t).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>!|]/g, '\\$&');
            const mdUrl = (u) => (/^https?:\/\//i.test(u) ? u.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : '');
            for (const e of list) md.push(`> ${mdText(e.sentence)}`, `> — ${e.url && mdUrl(e.url) ? `[${mdText(e.source)}](${mdUrl(e.url)})` : mdText(e.source)}${e.kind ? ` (${e.kind})` : ''}`, '');
          }
          const ok = await copyText(md.join('\n'));
          const st = out.querySelector('[data-ck-copied]');
          if (st) st.textContent = ok ? 'Copied' : 'Couldn’t copy: your browser blocked it';
        };
    }

    // A whole paragraph: each plain fact checked on its own, two at a time (POST /api/crosscheck/text).
    const pform = $('[data-pc-form]');
    const ptext = $('[data-pc-text]');
    async function runPara(text) {
      ac?.abort();
      ac = new AbortController();
      const my = ++runId;
      const out = $('[data-ck-out]');
      out.innerHTML = '<p class="ck-wait">Finding the facts in it…</p>';
      let claims = [];
      const verdicts = {};
      const busy = new Set();
      let finished = false;
      const render = () => {
        if (my !== runId) return;
        const todo = claims.filter((c) => c.claim);
        const done = todo.filter((c, n) => verdicts[claims.indexOf(c)]);
        const count = (v) => todo.filter((c) => verdicts[claims.indexOf(c)]?.verdict === v).length;
        const backed = count('supported') + count('mostly');
        const against = count('contradicted');
        const mixed = count('disputed') + count('weak');
        const sum = finished || done.length === todo.length
          ? `<p class="pc-sum"><b>${todo.length} fact${todo.length === 1 ? '' : 's'} checked:</b> ${[backed && `${backed} backed`, against && `${against} where sources say something different`, mixed && `${mixed} with mixed or thin support`, todo.length - backed - against - mixed && `${todo.length - backed - against - mixed} not settled`].filter(Boolean).join(', ')}.</p>`
          : `<p class="ck-wait">Checking ${todo.length} fact${todo.length === 1 ? '' : 's'}, two at a time: ${done.length} done…</p>`;
        const q = (x, how) => `<p class="pc-q">${how}: “${mark(x.sentence, x.figure || x.other)}” ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.source)}</a>` : esc(x.source || '')}</p>`;
        const items = todo
          .map((c) => {
            const n = claims.indexOf(c);
            const v = verdicts[n];
            const as = c.rewritten ? `<p class="pc-as">Checked as: ${esc(c.claim)}${c.unchecked ? `. Not checked: “${esc(c.unchecked)}”` : ''}</p>` : '';
            const body = v
              ? `<p class="pc-v">${v.verdict === 'error' ? `${SHORT.error}: ` : ''}${esc(v.label || SHORT[v.verdict] || v.verdict)}</p>${(v.quotes?.differs || []).slice(0, 1).map((x) => q(x, 'Says otherwise')).join('')}${(v.quotes?.supports || []).slice(0, 1).map((x) => q(x, 'Agrees')).join('')}<p class="ck-acts"><button type="button" class="link-btn" data-pc-open="${esc(c.claim)}">See every source</button></p>`
              : `<p class="pc-v ck-wait">${busy.has(n) ? 'Checking…' : 'Waiting…'}</p>`;
            // (a sentence split into two facts: each fact on its own line)
            const split = claims.filter((x) => x.i === c.i && x.claim).length > 1;
            return `<li class="pc-item" data-v="${esc(v?.verdict || '')}"><p class="pc-claim">${esc(split ? c.claim : c.sentence)}</p>${split ? '' : as}${body}</li>`;
          })
          .join('');
        // (the same sentence split into two facts shows once per fact; skipped ones once)
        const skipped = claims.filter((c) => !c.claim);
        const skip = skipped.length ? `<details class="ck-group"><summary>${skipped.length} sentence${skipped.length === 1 ? '' : 's'} not checked</summary><ul class="pc-skip">${skipped.map((c) => `<li>${esc(c.sentence)} <span>(${esc(c.skip)})</span></li>`).join('')}</ul></details>` : '';
        const copy = finished || done.length === todo.length ? '<p class="ck-acts"><button type="button" class="link-btn" data-pc-copy>Copy as Markdown</button> <span data-pc-copied role="status"></span></p>' : '';
        out.innerHTML = `${sum}<ol class="pc-list">${items}</ol>${skip}${copy}`;
        // Each fact with its reading and clearest quotes, to paste under the text it checks.
        const cb = out.querySelector('[data-pc-copy]');
        if (cb)
          cb.onclick = async () => {
            const mdText = (t) => String(t).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>!|]/g, '\\$&');
            const mdUrl = (u) => (/^https?:\/\//i.test(u || '') ? u.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : '');
            const line = (x, how) => `   - ${how}: “${mdText(x.sentence)}” ${mdUrl(x.url) ? `([${mdText(x.source || 'source')}](${mdUrl(x.url)}))` : mdText(x.source || '')}`;
            const md = [`**Fact check** (${new Date().toISOString().slice(0, 10)}, MCP Browser: each fact against independent sources)`, ''];
            todo.forEach((c, k) => {
              const v = verdicts[claims.indexOf(c)];
              md.push(`${k + 1}. ${mdText(c.claim)}: **${mdText(v?.label || 'not checked')}**${c.unchecked ? ` (not checked: “${mdText(c.unchecked)}”)` : ''}`);
              for (const x of (v?.quotes?.differs || []).slice(0, 1)) md.push(line(x, 'Says otherwise'));
              for (const x of (v?.quotes?.supports || []).slice(0, 1)) md.push(line(x, 'Agrees'));
            });
            if (skipped.length) md.push('', `Not checked: ${skipped.map((c) => `“${mdText(c.sentence)}” (${mdText(c.skip)})`).join('; ')}`);
            const ok = await copyText(md.join('\n'));
            const st = out.querySelector('[data-pc-copied]');
            if (st) st.textContent = ok ? 'Copied' : 'Couldn’t copy: your browser blocked it';
          };
      };
      let res;
      try {
        res = await fetch('/api/crosscheck/text', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ text }), signal: ac.signal });
      } catch (e) {
        if (my === runId && e.name !== 'AbortError') out.innerHTML = `<p class="lr-fail">${esc(e.message)}</p>`;
        return;
      }
      if (!res.ok || !/event-stream/.test(res.headers.get('content-type') || '')) {
        let msg = `The check failed (${res.status}).`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        if (my === runId) out.innerHTML = `<p class="lr-fail">${esc(msg)}</p>`;
        return;
      }
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
          if (type === 'para_claims') claims = d.claims;
          else if (type === 'para_start') busy.add(d.n);
          else if (type === 'para_verdict') (verdicts[d.n] = d), busy.delete(d.n);
          else if (type === 'done') finished = true;
          render();
        }
      }
      finished = true;
      render();
    }
    pform.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = ptext.value.trim();
      if (t) runPara(t);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const c = input.value.trim();
      if (!c) return;
      // (more than one sentence typed or pasted: check each fact)
      if ((c.match(/[.!?]\s+["“(]?\p{Lu}/gu) || []).length) {
        $('[data-pc-box]').open = true;
        ptext.value = c;
        return runPara(c);
      }
      run(c);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pc-ex]')) {
        ptext.value = EXAMPLE_PARA;
        return runPara(EXAMPLE_PARA);
      }
      const po = e.target.closest('[data-pc-open]');
      if (po) return hooks.checkInNewTab ? hooks.checkInNewTab(po.dataset.pcOpen) : run((input.value = po.dataset.pcOpen));
      const ex = e.target.closest('[data-ck-ex]');
      if (ex) {
        input.value = ex.dataset.ckEx;
        run(ex.dataset.ckEx);
      }
    });
    if (hooks.paragraph) {
      $('[data-pc-box]').open = true;
      ptext.value = hooks.paragraph;
      runPara(hooks.paragraph);
    } else if (hooks.claim && (hooks.claim.match(/[.!?]\s+["“(]?\p{Lu}/gu) || []).length) {
      // (several sentences: each fact on its own)
      $('[data-pc-box]').open = true;
      ptext.value = hooks.claim;
      runPara(hooks.claim);
    } else if (hooks.claim) {
      input.value = hooks.claim;
      run(hooks.claim);
    } else if (hooks.paragraphOpen) {
      $('[data-pc-box]').open = true;
      setTimeout(() => ptext.focus(), 0);
    } else setTimeout(() => input.focus(), 0);
  }

  window.MCPCheck = { mount };
})();
