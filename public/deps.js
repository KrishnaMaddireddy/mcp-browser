// mcp://deps — paste a package.json, requirements.txt or a list of packages; two OSV servers
// say which versions have known vulnerabilities (side by side), a registry server says what's
// latest and whether it's still maintained. Streams from POST /api/deps.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const EXAMPLE_NPM = JSON.stringify({ dependencies: { lodash: '^4.17.15', express: '4.17.1', axios: '~0.21.0', react: '18.2.0', request: '2.88.2' }, devDependencies: { jest: '^29.0.0' } }, null, 2);
  const EXAMPLE_PY = 'requests==2.19.0\ndjango==3.2.0\nflask==2.3.2\nnumpy==1.26.4\npyyaml==5.3';
  const SEV_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MODERATE: 'Moderate', MEDIUM: 'Medium', LOW: 'Low' };
  const KEY = 'mcpb.deps.last';

  function mount(el, hooks = {}) {
    const $ = (s) => el.querySelector(s);
    const ta = $('[data-dp-text]');
    const out = $('[data-dp-out]');
    let ac = null;
    let runId = 0;
    try {
      ta.value = localStorage.getItem(KEY) || '';
    } catch {}

    async function run(text) {
      ac?.abort();
      ac = new AbortController();
      const my = ++runId;
      try {
        // (a lockfile is too big to keep; a cut-off one wouldn't parse next time)
        if (text.length <= 20000) localStorage.setItem(KEY, text);
        else localStorage.removeItem(KEY);
      } catch {}
      const rows = [];
      const servers = {};
      let start = null;
      let repo = null;
      let source = null;
      let done = null;
      let error = null;
      const render = () => {
        if (my !== runId) return;
        if (error) return void (out.innerHTML = `<p class="lr-fail">${esc(error)}</p>`);
        const srv = Object.values(servers);
        const srvLine = srv.length
          ? `<p class="dp-servers">${srv.map((s) => `<span class="dp-srv" data-ok="${s.ok}">${esc(s.title)}${s.ok ? ` · ${(s.ms / 1000).toFixed(1)} s` : ` · ${esc(s.error || 'no answer')}`}</span>`).join('')}</p>`
          : '';
        let head = '';
        if (done) {
          const s = done.summary;
          const both = done.sources.osv && done.sources.audit;
          const answered = Object.values(servers).filter((x) => x.ok && x.key !== 'health').length;
          const agreeLine = both && s.agreed + s.disagreed > 0 ? (s.disagreed ? `The two services disagree on ${s.disagreed} package${s.disagreed === 1 ? '' : 's'}: both counts are shown.` : `Two services reading OSV.dev, from different publishers, agree on ${s.agreed === s.checked ? `all ${s.agreed}` : `${s.agreed} of ${s.checked}`}.`) : 'Only one service answered, so nothing was double-checked.';
          const notChecked = s.unchecked ? ` ${s.unchecked} package${s.unchecked === 1 ? ' wasn’t' : 's weren’t'} checked: no service answered for ${s.unchecked === 1 ? 'it' : 'them'}.` : '';
          const acts = `<p class="ck-acts dp-copy"><button type="button" class="link-btn" data-dp-watch title="Checked once a day, sent to the same servers">Tell me about new advisories</button> · <button type="button" class="link-btn" data-dp-copy>Copy as Markdown</button> <span data-dp-copied role="status"></span></p>`;
          head = !s.checked
            ? `<div class="ck-verdict" data-v="unclear"><b>Nothing was checked</b><p>${answered ? 'No service had an answer for these packages.' : 'No OSV service answered (switched off in Settings, or not reachable right now).'} Try again later; this is not a clean result.</p></div>`
            : `<div class="ck-verdict" data-v="${s.vulnerable ? (s.high ? 'contradicted' : 'disputed') : 'supported'}"><b>${s.vulnerable ? `${s.vulnerable} of ${s.checked} package${s.checked === 1 ? '' : 's'} ${s.vulnerable === 1 ? 'has' : 'have'} known vulnerabilities${s.high ? `, ${s.high} with high or critical ones` : ''}` : `No known vulnerabilities in ${s.checked} package${s.checked === 1 ? '' : 's'}`}${s.deprecated ? `; ${s.deprecated} deprecated` : ''}</b><p>${agreeLine}${notChecked} Known means published in OSV.dev; a clean result isn’t proof of safety.</p>${acts}</div>`;
        } else if (repo && !start) head = `<p class="ck-wait">Reading ${esc(repo.repo)}${repo.dir ? `/${esc(repo.dir)}` : ''} from GitHub through the Page Fetch server…</p>`;
        else head = `<p class="ck-wait">Asking two OSV servers and a package registry about ${start ? `${start.pinned} package${start.pinned === 1 ? '' : 's'}` : 'your packages'}…</p>`;
        const lock = start?.lockfile ? `<p class="hint">From your lockfile: the versions installed${start.indirect && start.indirect < start.packages ? `, ${start.packages - start.indirect} you depend on directly and ${start.indirect} pulled in by them (marked with the direct one that brings each in)` : ''}.${start.total > start.packages ? ` The first ${start.packages} of ${start.total} are checked${start.directKnown ? ', direct ones first' : ''}.` : ''}${done && rows.length > 12 ? ' Packages with known vulnerabilities are listed first.' : ''}</p>` : '';
        // ("6 of 7 come in through express": where to start)
        let through = '';
        if (done && start?.lockfile) {
          const bad = rows.filter((r) => r.vulns.length || r.counts.audit);
          const tally = new Map();
          for (const r of bad) for (const v of r.indirect ? r.via || [] : [r.name]) tally.set(v, (tally.get(v) || 0) + 1);
          const [top, n] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
          if (top && n > 1 && bad.length > 1) through = `<p class="hint"><b>${n === bad.length ? `All ${n}` : `${n} of ${bad.length}`} packages with known vulnerabilities come in through ${esc(top)}.</b> Updating it is the place to start.</p>`;
        }
        // (which files of the repo were read, so the result can be checked against them)
        const from = source
          ? `<p class="hint dp-from">From <a href="https://github.com/${encodeURIComponent(source.repo.split('/')[0])}/${encodeURIComponent(source.repo.split('/')[1])}" target="_blank" rel="noopener noreferrer">${esc(source.repo)}</a>${source.dir ? `/${esc(source.dir)}` : ''}: ${source.files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.file.startsWith('/') ? `${f.file.slice(1)} (repo root)` : f.file)}</a>${f.truncated ? ' (its first part only: the page server reads up to 100,000 characters)' : ''}`).join(', ')}.</p>`
          : '';
        const unpinned = start?.unpinned?.length ? `<p class="hint">No version given for ${start.unpinned.map(esc).join(', ')}: only its latest version and upkeep are shown.</p>` : '';
        const ranged = rows.some((r) => /^[\^~]/.test(r.range || '') && r.version) ? '<p class="hint">For ranges like ^4.17.15 or ~=3.4 the lowest version the range allows is checked; your lockfile may have a newer one.</p>' : '';
        const loose = rows.some((r) => /^(?:!=|>=?|<=?)/.test(r.range || '')) ? '<p class="hint">Requirements like >=2.19 or !=1.24.1 don’t pin a version, so only the latest version and upkeep are shown for them. Check your lockfile’s versions for the full picture.</p>' : '';
        const body = rows
          .map((r, i) => {
            const n = r.partial ? r.counts.osv : r.vulns.length || r.counts.audit || 0;
            const counts = r.counts.comparable && r.counts.osv != null && r.counts.audit != null && r.counts.osv !== r.counts.audit ? ` <span class="dp-dis" title="The two servers give different counts">${r.counts.osv} / ${r.counts.audit}</span>` : '';
            const label = `${n} known${r.worst ? ` <span class="dp-sev" data-sev="${esc(r.worst)}">${esc(SEV_LABEL[r.worst] || r.worst)}</span>` : ''}`;
            const vul = !r.version ? `<span class="dp-muted">${/^(?:!=|>=?|<=?)/.test(r.range || '') ? 'not pinned' : 'no version'}</span>` : !r.checked ? '<span class="dp-muted">Not checked</span>' : n ? `${r.vulns.length ? `<button type="button" class="link-btn dp-open" data-dp-i="${i}" aria-expanded="false">${label}</button>` : `<span>${label}</span> <a class="dp-muted" href="https://osv.dev/list?ecosystem=${r.ecosystem === 'pypi' ? 'PyPI' : r.ecosystem === 'cargo' ? 'crates.io' : 'npm'}&q=${encodeURIComponent(r.name)}" target="_blank" rel="noopener noreferrer">list on osv.dev</a>`}${counts}` : '<span class="dp-ok">None known</span>';
            const fix = r.unfixed ? '<span class="dp-bad">No fixed version</span>' : r.fix ? esc(r.fix) : '';
            const notes = [r.deprecated ? '<span class="dp-bad">Deprecated</span>' : '', r.maintained === false && !r.deprecated ? '<span class="dp-bad">Not maintained</span>' : '', r.dev ? '<span class="dp-muted">dev</span>' : '', r.indirect ? `<span class="dp-muted" title="Pulled in by another package${r.via?.length ? `: update ${esc(r.via.join(' or '))} to move it` : ''}">${r.via?.length ? `via ${esc(r.via.join(', '))}` : 'indirect'}</span>` : '', r.notFound ? '<span class="dp-muted">not found</span>' : ''].filter(Boolean).join(' ');
            const adv = r.vulns.length
              ? `<tr class="dp-adv" data-dp-adv="${i}" hidden><td colspan="6"><ul>${r.vulns
                  .map(
                    (v) =>
                      `<li><span class="dp-sev" data-sev="${esc(v.severity)}">${esc(SEV_LABEL[v.severity] || v.severity || '?')}</span> ${esc(v.summary || v.id)} <span class="dp-ids"><a href="https://osv.dev/vulnerability/${encodeURIComponent(v.id)}" target="_blank" rel="noopener noreferrer">${esc(v.id)}</a>${v.aliases.map((a) => ` <button type="button" class="link-btn" data-dp-cve="${esc(a)}">${esc(a)}</button>`).join('')}${v.fixedVersions.length ? ` · fixed in ${esc(v.fixedVersions.join(', '))}` : ''}</span></li>`
                  )
                  .join('')}</ul></td></tr>`
              : '';
            return `<tr><td><b>${esc(r.name)}</b> <span class="dp-muted">${esc(r.ecosystem)}</span>${notes ? `<div class="dp-notes-m">${notes}</div>` : ''}</td><td>${esc(r.version || r.range || '—')}</td><td>${vul}</td><td>${fix}</td><td>${esc(r.latest || '')}</td><td>${notes}</td></tr>${adv}`;
          })
          .join('');
        out.innerHTML = head + srvLine + from + through + lock + unpinned + ranged + loose + (rows.length ? `<div class="dp-wrap"><table class="dp-table"><thead><tr><th>Package</th><th>Version</th><th>Known vulnerabilities</th><th>Fixed in</th><th>Latest</th><th><span class="sr-only">Notes</span></th></tr></thead><tbody>${body}</tbody></table></div>` : '');
      };
      out.innerHTML = '<p class="ck-wait">Reading your packages…</p>';
      let res;
      try {
        res = await fetch('/api/deps', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ text }), signal: ac.signal });
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
        const { value, done: end } = await reader.read().catch(() => ({ done: true }));
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (!type || !raw) continue;
          const d = JSON.parse(raw);
          if (type === 'deps_start') start = d;
          else if (type === 'deps_repo') repo = d;
          else if (type === 'deps_source') source = d;
          else if (type === 'deps_server') servers[d.key] = d;
          else if (type === 'deps_row') rows.push(d);
          else if (type === 'deps_done') {
            done = d;
            // (a long list: the ones with advisories first, worst first; the rest as they came)
            if (rows.length > 12) {
              const rank = (r) => ({ CRITICAL: 5, HIGH: 4, MODERATE: 3, MEDIUM: 3, LOW: 2 })[r.worst] || (r.vulns.length || r.counts.audit ? 1 : 0);
              rows.sort((a, b) => rank(b) - rank(a));
            }
          }
          else if (type === 'error') error = d.message;
          render();
        }
      }
      render();
      // Checked again each day: a new advisory for one of these versions is news.
      const wb = out.querySelector('[data-dp-watch]');
      if (wb && my === runId && done)
        wb.onclick = async () => {
          const st = out.querySelector('[data-dp-copied]');
          try {
            const r = await fetch('/api/watches', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify(source ? { every: 'daily', repo: `https://github.com/${source.repo}${source.ref && source.ref !== 'HEAD' ? `/tree/${source.ref}${source.dir ? `/${source.dir}` : ''}` : source.dir ? `/tree/HEAD/${source.dir}` : ''}` } : { every: 'daily', deps: rows.filter((r) => r.version).map((r) => ({ name: r.name, version: r.version, ecosystem: r.ecosystem })) }) });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `failed (${r.status})`);
            if (st) st.textContent = source ? 'Watching: the repo is read again and checked every day, on the Watches page' : 'Watching: checked every day, on the Watches page';
            hooks.watching?.();
          } catch (e) {
            if (st) st.textContent = `Couldn’t start watching: ${e.message}`;
          }
        };
      // A table to paste into a pull request, an issue or a chat.
      const btn = out.querySelector('[data-dp-copy]');
      if (btn && my === runId && done)
        btn.onclick = async () => {
          const s = done.summary;
          // (names and summaries come from servers: no links, images or HTML of their own in the paste)
          const cell = (x) => String(x ?? '').replace(/\s+/g, ' ').replace(/[\\`*_[\]<>!|]/g, '\\$&');
          const md = [
            `## Dependency check: ${s.vulnerable ? `${s.vulnerable} of ${s.checked} packages have known vulnerabilities` : `no known vulnerabilities in ${s.checked} packages`}`,
            '',
            `Checked ${new Date().toISOString().slice(0, 10)} with ${Object.values(servers).filter((x) => x.ok).map((x) => cell(x.title)).join(', ')} (OSV.dev data), in MCP Browser.`,
            '',
            '| Package | Version | Known vulnerabilities | Fixed in | Latest | Notes |',
            '|---|---|---|---|---|---|',
            ...rows.map((r) => `| ${cell(r.name)} (${r.ecosystem}) | ${cell(r.version || r.range || '—')} | ${!r.version ? 'not pinned' : !r.checked ? 'not checked' : (r.partial ? r.counts.osv : r.vulns.length || r.counts.audit || 0) || 'none'}${r.worst ? ` (${SEV_LABEL[r.worst] || r.worst})` : ''} | ${r.unfixed ? 'no fix yet' : cell(r.fix || '')} | ${cell(r.latest || '')} | ${[r.deprecated ? 'deprecated' : '', r.maintained === false && !r.deprecated ? 'not maintained' : '', r.dev ? 'dev' : '', r.indirect ? (r.via?.length ? `via ${cell(r.via.join(', '))}` : 'indirect') : ''].filter(Boolean).join(', ')} |`),
          ];
          const adv = rows.filter((r) => r.vulns.length);
          if (adv.length) {
            md.push('', '### Advisories', '');
            for (const r of adv) for (const v of r.vulns) md.push(`- **${cell(r.name)}** ${SEV_LABEL[v.severity] || v.severity || ''}: ${cell(v.summary || v.id)} ([${cell(v.id)}](https://osv.dev/vulnerability/${encodeURIComponent(v.id)})${v.aliases.length ? `, ${cell(v.aliases.join(', '))}` : ''})${v.fixedVersions.length ? `, fixed in ${cell(v.fixedVersions.join(', '))}` : ''}`);
          }
          let ok = false;
          try {
            await navigator.clipboard.writeText(md.join('\n'));
            ok = true;
          } catch {}
          const st = out.querySelector('[data-dp-copied]');
          if (st) st.textContent = ok ? 'Copied' : 'Couldn’t copy: your browser blocked it';
        };
    }

    // A lockfile is easier to choose than to paste.
    const file = $('[data-dp-file]');
    file?.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      if (f.size > 7.5 * 1024 * 1024) return void (out.innerHTML = '<p class="lr-fail">That file is over 7.5 MB. Paste the dependencies part instead.</p>');
      try {
        ta.value = await f.text();
      } catch (e) {
        return void (out.innerHTML = `<p class="lr-fail">Couldn’t read ${esc(f.name)}: ${esc(e.message)}</p>`);
      }
      run(ta.value.trim());
    });
    $('[data-dp-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = ta.value.trim();
      if (t) run(t);
    });
    el.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-dp-ex]');
      if (ex) {
        ta.value = ex.dataset.dpEx === 'py' ? EXAMPLE_PY : EXAMPLE_NPM;
        return run(ta.value);
      }
      const o = e.target.closest('[data-dp-i]');
      if (o) {
        const row = el.querySelector(`[data-dp-adv="${o.dataset.dpI}"]`);
        if (row) {
          row.hidden = !row.hidden;
          o.setAttribute('aria-expanded', String(!row.hidden));
        }
        return;
      }
      const cve = e.target.closest('[data-dp-cve]');
      if (cve) hooks.search?.(cve.dataset.dpCve);
    });
    // (opened from a watch: its packages, checked right away)
    if (hooks.text) {
      ta.value = hooks.text;
      run(hooks.text);
    } else setTimeout(() => ta.focus(), 0);
  }

  window.MCPDeps = { mount };
})();
