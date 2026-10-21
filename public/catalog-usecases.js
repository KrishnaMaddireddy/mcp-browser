// Use cases for mcp://catalog: a "what do you want to do?" planner, goals by
// persona (servers + prompts + setup), and multi-server workflows.
// ctx: { F, rows, byName: Map, popularity(row), hooks, addToBrowser(id), showServer(name) }
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const STOP = new Set('a an and are as at be by can do does for from get give have help how i if in into is it its me my of on or our please show so some that the their them then this to up us use want we what when where which who why will with you your would like need make find tell about want able just more any all also'.split(' '));
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(?<=\w{3})(ies)$/, 'y').replace(/(?<=\w{3})s$/, ''));
  const fmt = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');

  function create(el, ctx) {
    const U = window.MCP_USE_CASES || { personas: [], goals: [], workflows: [] };
    const { F, rows, byName } = ctx;
    const pickCache = new Map();
    let persona = 'all';

    // ---------- picking servers for a need ----------
    function pick(need, n = 3) {
      const key = JSON.stringify(need) + n;
      if (pickCache.has(key)) return pickCache.get(key);
      const out = [];
      for (const id of need.prefer || []) if (byName.has(id)) out.push(byName.get(id));
      if (out.length < n) {
        const terms = words(need.q);
        const want = Math.max(1, Math.ceil(terms.length * 0.6));
        const catIdx = need.cat ? ctx.catIndex(need.cat) : -1;
        const cands = [];
        for (const r of rows) {
          if (r[F.pubCount] >= 100 || r[F.deprecated] || r[F.archived] || out.includes(r)) continue;
          if (catIdx >= 0 && r[F.cat] !== catIdx) continue;
          let m = 0;
          for (const t of terms) if (r._hay.includes(t)) m++;
          if (m < want) continue;
          cands.push([m * 1.2 + r._pop + (r[F.listed] ? 0.8 : 0), r]);
        }
        cands.sort((a, b) => b[0] - a[0]);
        for (const [, r] of cands) {
          if (out.length >= n) break;
          out.push(r);
        }
      }
      pickCache.set(key, out.slice(0, n));
      return out.slice(0, n);
    }

    const goalIndex = new Map(); // server name → goals that recommend it
    function indexGoals() {
      if (goalIndex.size) return;
      for (const g of U.goals) for (const need of g.needs) for (const r of pick(need)) {
        const list = goalIndex.get(r[F.name]) || [];
        if (!list.includes(g)) list.push(g);
        goalIndex.set(r[F.name], list);
      }
    }
    ctx.goalsFor = (name) => (indexGoals(), (goalIndex.get(name) || []).slice(0, 4));

    // ---------- rendering ----------
    const chip = (r, label) => `<button type="button" class="u-server" data-show="${esc(r[F.name])}" title="${esc(r[F.desc] || '')}"><b>${esc(r[F.title] || r[F.name].split('/').pop())}</b>${r[F.stars] > 0 ? `<span>★ ${fmt(r[F.stars])}</span>` : ''}${r[F.listed] ? '<span class="u-live">works in MCP Browser</span>' : ''}${label ? `<em>${esc(label)}</em>` : ''}</button>`;
    const promptBtn = (p, serverName) => `<li><button type="button" class="cat-prompt" data-prompt="${esc(p)}" data-ask="${esc(serverName || '*')}" title="Run this here in MCP Browser"><span>${esc(p)}</span><span class="cat-prompt-act">Run</span></button></li>`;

    function goalCard(g) {
      const needs = g.needs.map((nd) => ({ nd, picks: pick(nd) }));
      const first = needs.map((x) => x.picks[0]).filter(Boolean);
      return `<article class="u-card" id="goal-${esc(g.id)}" data-goal-card="${esc(g.id)}" data-run-host>
        <h3>${esc(g.title)}</h3>
        <p class="u-why">${esc(g.why)}</p>
        ${needs.map(({ nd, picks }) => `<div class="u-need"><span class="u-label">${esc(nd.label)}</span><div class="u-servers">${picks.map((r) => chip(r)).join('') || '<span class="u-none">No match in the catalog yet</span>'}</div></div>`).join('')}
        <div class="u-prompts"><span class="u-label">Try asking <em class="u-runs">runs here, on the best servers MCP Browser has for it</em></span><ul>${g.prompts.map((p) => promptBtn(p)).join('')}</ul></div>
        ${first.length ? `<p class="u-stack-all"><button type="button" class="link-btn" data-stack-all="${esc(first.map((r) => r[F.name]).join(','))}">+ Add ${first.length === 1 ? 'it' : `these ${first.length}`} to my stack</button></p>` : ''}
        ${first.length ? `<details class="u-setup"><summary>Set up ${first.length === 1 ? 'this server' : `these ${first.length} servers`} in Claude, Cursor or VS Code</summary>${window.MCPGuide.setupHtml(first, F, { title: 'Setup' })}</details>` : ''}
      </article>`;
    }

    function workflowCard(w) {
      const steps = w.steps.map((s) => ({ s, r: pick(s.need, 1)[0] }));
      const servers = steps.map((x) => x.r).filter(Boolean);
      return `<article class="u-card u-flow" id="wf-${esc(w.id)}" data-run-host>
        <h3>${esc(w.title)}</h3>
        <p class="u-why">${esc(w.outcome)}</p>
        <ol class="u-steps">${steps
          .map(({ s, r }) => `<li><div class="u-step-head"><b>${esc(s.label)}</b>${r ? chip(r) : '<span class="u-none">No match yet</span>'}</div><ul>${promptBtn(s.prompt, r && ctx.runnable?.(r) ? r[F.name] : '')}</ul></li>`)
          .join('')}</ol>
        <div class="u-auto" data-flow="${esc(w.id)}">
          <button type="button" class="u-runall" data-flow-run>Run all steps now</button>
          <span class="u-auto-sched"><label>Autopilot <select data-flow-every aria-label="How often"><option value="daily">daily</option><option value="weekly" selected>weekly</option><option value="hourly">hourly</option></select></label><button type="button" class="link-btn" data-flow-watch>Put on autopilot</button></span>
          <p class="g-note" data-flow-msg>Autopilot re-runs every step on schedule while MCP Browser is open and flags only what changed (in Watches).</p>
        </div>
        ${servers.length ? `<p class="u-stack-all"><button type="button" class="link-btn" data-stack-all="${esc(servers.map((r) => r[F.name]).join(','))}">+ Add all ${servers.length} to my stack</button></p>` : ''}
        ${servers.length ? `<details class="u-setup"><summary>Set up all ${servers.length} servers at once</summary>${window.MCPGuide.setupHtml(servers, F, { title: 'Setup' })}<p class="g-note">With all of them connected, ask for the whole outcome in one message and Claude chains the steps.</p></details>` : ''}
      </article>`;
    }

    // Steps of a workflow with the server each one asks (when MCP Browser can call it).
    function flowSteps(id) {
      const w = U.workflows.find((x) => x.id === id);
      if (!w) return null;
      return {
        w,
        steps: w.steps.map((s) => {
          const r = pick(s.need, 1)[0];
          const live = r && ctx.runnable?.(r);
          return { label: s.label, prompt: s.prompt, ids: live ? [r[F.name]] : [], adhoc: live && r[F.remoteUrl] ? [{ id: r[F.name], url: r[F.remoteUrl], transport: r[F.remoteType] === 'sse' ? 'sse' : 'streamable-http', title: r[F.title] || r[F.name].split('/').pop(), description: r[F.desc] || '' }] : [] };
        }),
      };
    }
    async function runAll(card, id) {
      const f = flowSteps(id);
      const host = card;
      let box = host.querySelector(':scope > .u-flow-run');
      if (!box) {
        box = document.createElement('div');
        box.className = 'u-flow-run';
        host.appendChild(box);
      }
      box.innerHTML = f.steps.map((s, i) => `<section class="u-flow-step"><h4>${i + 1}. ${esc(s.label)}</h4><div class="u-flow-body"></div></section>`).join('');
      // One step at a time, so later steps don't compete with earlier ones for servers.
      const bodies = [...box.querySelectorAll('.u-flow-body')];
      for (let i = 0; i < f.steps.length; i++) {
        const s = f.steps[i];
        const entry = ctx.hooks.runInline(bodies[i], s.prompt, s.ids, s.adhoc);
        await new Promise((resolve) => {
          const t0 = Date.now();
          const tick = setInterval(() => {
            if ((entry.turns?.length && !entry.busy) || Date.now() - t0 > 120000) (clearInterval(tick), resolve());
          }, 500);
        });
      }
    }
    async function autopilot(card, id) {
      const f = flowSteps(id);
      const every = card.querySelector('[data-flow-every]').value;
      const msg = card.querySelector('[data-flow-msg]');
      msg.textContent = 'Setting up…';
      let ok = 0;
      for (const s of f.steps) {
        const r = await fetch('/api/watches', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb': '1' }, body: JSON.stringify({ query: s.prompt, every, label: `${f.w.title}: ${s.label}`, group: f.w.title, servers: s.ids.length ? s.ids : undefined, adhoc: s.adhoc.length ? s.adhoc : undefined }) });
        if (r.ok) ok++;
        else msg.textContent = `Couldn’t add “${s.label}”: ${(await r.json().catch(() => ({}))).error || r.status}`;
      }
      if (ok) msg.innerHTML = `On autopilot: ${ok} step${ok > 1 ? 's' : ''} run ${every}, starting now. See them in <button type="button" class="link-btn" data-open="mcp://watches">Watches</button>; you’ll get a badge when something changes.`;
    }

    function renderLibrary() {
      const goals = U.goals.filter((g) => persona === 'all' || g.persona === persona);
      const flows = U.workflows.filter((w) => persona === 'all' || w.persona === persona);
      el.querySelector('[data-u-personas]').innerHTML = [['all', 'All'], ...U.personas].map(([id, label]) => `<button type="button" data-persona="${id}" aria-pressed="${persona === id}">${esc(label)}</button>`).join('');
      el.querySelector('[data-u-goals]').innerHTML = goals.map(goalCard).join('') || '<p class="hint">No goals for this group yet.</p>';
      el.querySelector('[data-u-flows]').innerHTML = flows.map(workflowCard).join('') || '<p class="hint">No workflows for this group yet.</p>';
      el.querySelector('[data-u-flows-head]').hidden = !flows.length;
    }

    // ---------- "what do you want to do?" ----------
    async function plan(text) {
      const out = el.querySelector('[data-u-plan]');
      const terms = [...new Set(words(text))];
      if (!terms.length) {
        out.innerHTML = '<p class="hint">Describe a task in a few words, e.g. “track competitor pricing” or “summarize my unread email”.</p>';
        return;
      }
      // Goals whose words overlap the request.
      const goalHits = U.goals
        .map((g) => {
          const bag = new Set(words([g.title, g.why, ...g.prompts, ...g.needs.map((n) => n.label + ' ' + n.q)].join(' ')));
          const hit = terms.filter((t) => bag.has(t));
          return [hit.length / Math.sqrt(terms.length) + (words(g.title).some((t) => terms.includes(t)) ? 0.5 : 0), g, hit];
        })
        .filter(([s]) => s >= 0.5)
        .sort((a, b) => b[0] - a[0])
        .slice(0, 3);
      // Catalog servers whose name or description match.
      const scored = [];
      for (const r of rows) {
        if (r[F.pubCount] >= 100 || r[F.deprecated]) continue;
        let m = 0;
        const hit = [];
        for (const t of terms) {
          if (r._titleHay.includes(t)) (m += 2), hit.push(t);
          else if (r._hay.includes(t)) (m += 1), hit.push(t);
        }
        // Most of the request's words should match, not just one popular word.
        if (hit.length < Math.min(terms.length, Math.max(1, Math.ceil(terms.length * 0.6)))) continue;
        scored.push([m * 1.5 + r._pop + (r[F.listed] ? 0.8 : 0), r, hit]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      const servers = scored.slice(0, 6);
      out.innerHTML = `
        <div class="u-plan-cols">
          <section><h3>Servers for this</h3>${
            servers.length
              ? `<ul class="u-plan-list">${servers.map(([, r, hit]) => `<li><label><input type="checkbox" data-plan-pick="${esc(r[F.name])}" checked> ${chip(r)}</label><p>${esc((r[F.desc] || '').slice(0, 140))}</p><p class="u-why-match">Matches: ${hit.map(esc).join(', ')}</p></li>`).join('')}</ul><div data-u-plan-setup></div>`
              : '<p class="hint">No catalog server matches those words. Try other words, or browse the goals below.</p>'
          }</section>
          <section data-run-host><h3>Ask MCP Browser now</h3><ul class="u-plan-ask">${promptBtn(text)}</ul><p class="hint" data-u-route>Checking which servers would answer…</p>
          ${goalHits.length ? `<h3>Related use cases</h3><p class="g-goals">${goalHits.map(([, g]) => `<button type="button" class="g-goal" data-goal="${esc(g.id)}">${esc(g.title)}</button>`).join('')}</p>` : ''}</section>
        </div>`;
      updatePlanSetup();
      try {
        const r = await fetch(`/api/route?q=${encodeURIComponent(text)}`).then((x) => x.json());
        const s = (r.servers || []).slice(0, 5);
        el.querySelector('[data-u-route]').textContent = s.length ? `It would ask: ${s.map((x) => x.title).join(', ')}.` : 'None of the servers MCP Browser has turned on fits this yet; turn on discovery in MCP servers to search the whole registry.';
      } catch {
        el.querySelector('[data-u-route]').textContent = '';
      }
    }
    function updatePlanSetup() {
      const box = el.querySelector('[data-u-plan-setup]');
      if (!box) return;
      const picked = [...el.querySelectorAll('[data-plan-pick]:checked')].map((c) => byName.get(c.dataset.planPick)).filter(Boolean).slice(0, 4);
      box.innerHTML = picked.length ? window.MCPGuide.setupHtml(picked, F, { title: `Set up the ${picked.length === 1 ? 'selected server' : picked.length + ' selected servers'}` }) : '';
    }

    function showGoal(id) {
      persona = 'all';
      renderLibrary();
      const card = el.querySelector(`#goal-${CSS.escape(id)}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card?.classList.add('u-flash');
      setTimeout(() => card?.classList.remove('u-flash'), 1600);
    }

    // ---------- events ----------
    el.addEventListener('click', (e) => {
      const p = e.target.closest('[data-persona]');
      if (p) return (persona = p.dataset.persona), renderLibrary();
      const g = e.target.closest('[data-goal]');
      if (g) return showGoal(g.dataset.goal);
    });
    el.addEventListener('click', (e) => {
      const card = e.target.closest('.u-flow');
      if (!card) return;
      const id = card.querySelector('[data-flow]')?.dataset.flow;
      if (e.target.closest('[data-flow-run]')) runAll(card, id);
      else if (e.target.closest('[data-flow-watch]')) autopilot(card, id);
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-plan-pick]')) updatePlanSetup();
    });
    el.querySelector('[data-u-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      plan(el.querySelector('[data-u-q]').value.trim());
    });
    for (const b of el.querySelectorAll('[data-u-example]')) b.addEventListener('click', () => ((el.querySelector('[data-u-q]').value = b.textContent), plan(b.textContent)));

    return { render: renderLibrary, goalsFor: ctx.goalsFor, showGoal };
  }

  window.MCPUseCases = { create };
})();
