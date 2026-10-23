// mcp://check — cross-check a claim across independent sources. Each source's own
// sentence is quoted, sorted into "says the same", "says something different" and
// "mentions it", with the overall reading on top. Streams from POST /api/crosscheck.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const EXAMPLES = ['The Eiffel Tower is 330 meters tall', 'Mount Everest is 9,500 meters high', 'The default port for PostgreSQL is 5432', 'Saturn is the largest planet in the Solar System', 'The human body has 206 bones', 'Thomas Edison invented the telephone'];
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
            .map((e) => `<li class="ck-src"><blockquote>${mark(e.sentence, e.figure || e.other)}</blockquote><p class="ck-cite">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source)}</a>` : esc(e.source)}${e.kind ? ` <span class="src-kind" data-kind="${esc(e.kind)}">${e.kind === 'primary' ? 'Primary source' : 'Official'}</span>` : ''}${e.via && e.via !== e.source ? ` <span>via ${esc(e.via)}</span>` : ''}${e.other ? ` <span>names ${esc(e.other)}</span>` : ''}</p></li>`)
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

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const c = input.value.trim();
      if (c) run(c);
    });
    el.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-ck-ex]');
      if (ex) {
        input.value = ex.dataset.ckEx;
        run(ex.dataset.ckEx);
      }
    });
    if (hooks.claim) {
      input.value = hooks.claim;
      run(hooks.claim);
    } else setTimeout(() => input.focus(), 0);
  }

  window.MCPCheck = { mount };
})();
