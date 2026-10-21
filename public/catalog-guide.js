// How-to-use helpers for the server catalog: setup snippets for the common MCP
// clients, "before you rely on it" checks, and the per-server guide panel.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const keyName = (name) => (String(name).split('/').pop() || String(name)).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'server';
  const placeholder = (n) => `<${n}>`;

  /** How to launch one server: { kind: 'local'|'remote'|'none', name, command, args, env, url, headers, note } */
  function launchOf(row, F) {
    const name = keyName(row[F.name]);
    const envs = (F.envs != null && row[F.envs]) || [];
    const t = row[F.pkgType];
    const id = row[F.pkgId];
    const env = {};
    for (const [n, , , kind] of envs) if (kind !== 'h') env[n] = placeholder(n);
    if (t === 'npm') return { kind: 'local', name, command: 'npx', args: ['-y', id], env };
    if (t === 'pypi') return { kind: 'local', name, command: 'uvx', args: [id], env };
    if (t === 'oci') return { kind: 'local', name, command: 'docker', args: ['run', '-i', '--rm', ...Object.keys(env).flatMap((k) => ['-e', k]), id], env };
    if (t === 'nuget') return { kind: 'local', name, command: 'dnx', args: [id, '--yes'], env };
    const url = row[F.remoteUrl];
    if (url) {
      const headers = {};
      for (const [n, , , kind] of envs) if (kind === 'h') headers[n] = placeholder(n);
      return { kind: 'remote', name, url, transport: row[F.remoteType] === 'sse' ? 'sse' : 'http', headers, note: /[{}]/.test(url) ? 'Replace the {placeholders} in the address with your own values.' : '' };
    }
    if (t === 'cargo') return { kind: 'none', name, note: `Install it with cargo install ${id}, then point your client at the installed command (see its README).` };
    if (t === 'mcpb') return { kind: 'none', name, note: 'This is an MCP bundle (.mcpb): download it and open it with Claude Desktop to install.' };
    return { kind: 'none', name, note: 'The registry doesn’t say how to run this server. Check its README.' };
  }

  const json = (o) => JSON.stringify(o, null, 2);
  const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

  /** Snippets for several servers at once, one per client. */
  function setupFor(rows, F) {
    const ls = rows.map((r) => launchOf(r, F));
    const ok = ls.filter((l) => l.kind !== 'none');
    const notes = ls.filter((l) => l.note).map((l) => `${l.name}: ${l.note}`);
    const claudeCode = ok
      .map((l) =>
        l.kind === 'remote'
          ? `claude mcp add --transport ${l.transport} ${l.name} ${shq(l.url)}${Object.entries(l.headers).map(([k, v]) => ` --header ${shq(`${k}: ${v}`)}`).join('')}`
          : `claude mcp add ${l.name}${Object.entries(l.env).map(([k, v]) => ` -e ${shq(`${k}=${v}`)}`).join('')} -- ${[l.command, ...l.args].map(shq).join(' ')}`
      )
      .join('\n');
    const desktop = { mcpServers: {} };
    const cursor = { mcpServers: {} };
    const vscode = { servers: {} };
    for (const l of ok) {
      if (l.kind === 'remote') {
        const hdrArgs = Object.keys(l.headers).flatMap((k) => ['--header', `${k}:\${${k.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}}`]);
        const hdrEnv = Object.fromEntries(Object.entries(l.headers).map(([k, v]) => [k.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase(), v]));
        desktop.mcpServers[l.name] = { command: 'npx', args: ['-y', 'mcp-remote', l.url, ...hdrArgs], ...(hdrArgs.length ? { env: hdrEnv } : {}) };
        cursor.mcpServers[l.name] = { url: l.url, ...(Object.keys(l.headers).length ? { headers: l.headers } : {}) };
        vscode.servers[l.name] = { type: l.transport, url: l.url, ...(Object.keys(l.headers).length ? { headers: l.headers } : {}) };
      } else {
        const base = { command: l.command, args: l.args, ...(Object.keys(l.env).length ? { env: l.env } : {}) };
        desktop.mcpServers[l.name] = base;
        cursor.mcpServers[l.name] = base;
        vscode.servers[l.name] = { type: 'stdio', ...base };
      }
    }
    const empty = !ok.length;
    return {
      notes,
      clients: [
        { id: 'code', label: 'Claude Code', where: 'Run in your terminal', text: empty ? '' : claudeCode },
        { id: 'desktop', label: 'Claude Desktop', where: 'Settings → Developer → Edit config (claude_desktop_config.json)', text: empty ? '' : json(desktop) },
        { id: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json, or .cursor/mcp.json in a project', text: empty ? '' : json(cursor) },
        { id: 'vscode', label: 'VS Code', where: '.vscode/mcp.json in your workspace', text: empty ? '' : json(vscode) },
      ],
    };
  }

  // What a few common settings are, when the registry's own description is thin.
  const KNOWN = [
    [/^EDGAR_IDENTITY$|^SEC_(USER_AGENT|IDENTITY)$/i, 'The SEC asks every program that reads EDGAR to say who is calling: your name and email, e.g. “Jane Doe jane@example.com”. Not a password, no sign-up.'],
    [/GITHUB_(PERSONAL_)?(ACCESS_)?TOKEN|GH_TOKEN/i, 'A GitHub personal access token: github.com → Settings → Developer settings → Personal access tokens. Give it only the access this server needs (read-only if you can).'],
    [/OPENAI_API_KEY/i, 'An OpenAI API key from platform.openai.com → API keys.'],
    [/ANTHROPIC_API_KEY/i, 'An Anthropic API key from console.anthropic.com → API keys.'],
    [/^Authorization$/i, 'Usually “Bearer” followed by the API key the service gave you.'],
    [/DATABASE_URL|POSTGRES_(URL|CONNECTION)|PG_CONNECTION|CONNECTION_STRING/i, 'The connection string of your database, e.g. postgres://user:password@host:5432/dbname. Prefer a read-only user.'],
  ];
  const explain = (name, d) => KNOWN.find(([re]) => re.test(name))?.[1] || d || '';

  /** Tabbed setup block (HTML), with a small form for required settings that fills the snippets in place. */
  function setupHtml(rows, F, { title = 'Set it up' } = {}) {
    const s = setupFor(rows, F);
    const any = s.clients.some((c) => c.text);
    const tabs = s.clients.filter((c) => c.text);
    const settings = [];
    const seen = new Set();
    for (const r of rows) for (const [n, secret, d] of (F.envs != null && r[F.envs]) || []) if (!seen.has(n)) (seen.add(n), settings.push({ n, secret, d: explain(n, d) }));
    const form = settings.length
      ? `<div class="g-settings"><p class="g-where">${settings.length === 1 ? 'This server needs one setting' : `These servers need ${settings.length} settings`}. Fill ${settings.length === 1 ? 'it' : 'them'} in here and the snippets below update (stays on this page, never sent anywhere):</p>${settings
          .map((x) => `<label class="g-set"><span><code>${esc(x.n)}</code>${x.secret ? ' <em>secret</em>' : ''}</span>${x.d ? `<small>${esc(x.d)}</small>` : ''}<input type="${x.secret ? 'password' : 'text'}" data-g-env="${esc(x.n)}" autocomplete="off" spellcheck="false" placeholder="${esc(x.n === 'EDGAR_IDENTITY' ? 'Jane Doe jane@example.com' : x.secret ? 'paste it here' : 'value')}"></label>`)
          .join('')}</div>`
      : '';
    return `<section class="g-sec"><h4>${esc(title)}</h4>${
      any
        ? `${form}<div class="g-setup"><div class="g-tabs" role="tablist">${tabs.map((c, i) => `<button type="button" role="tab" data-g-tab="${c.id}" aria-selected="${i === 0}">${c.label}</button>`).join('')}</div>${tabs
            .map((c, i) => `<div class="g-pane" data-g-pane="${c.id}" ${i ? 'hidden' : ''}><p class="g-where">${esc(c.where)}</p><div class="g-code"><pre data-g-tpl="${esc(c.text)}">${esc(c.text)}</pre><button type="button" class="cat-copy" data-cmd="${esc(c.text)}">Copy</button></div></div>`)
            .join('')}</div>${settings.some((x) => x.secret) ? '<p class="g-note">Keys pasted into a config file sit there in plain text: keep that file private, and prefer read-only keys.</p>' : ''}`
        : ''
    }${s.notes.map((n) => `<p class="g-note">${esc(n)}</p>`).join('')}</section>`;
  }

  /** Typing in the settings form: refill every snippet in that setup block. */
  function handleInput(e) {
    const input = e.target.closest('[data-g-env]');
    if (!input) return false;
    const sec = input.closest('.g-sec');
    const values = {};
    for (const i of sec.querySelectorAll('[data-g-env]')) if (i.value) values[i.dataset.gEnv] = i.value;
    for (const pre of sec.querySelectorAll('pre[data-g-tpl]')) {
      const pane = pre.closest('[data-g-pane]')?.dataset.gPane;
      let t = pre.dataset.gTpl;
      for (const [k, v] of Object.entries(values)) {
        // Shell lines quote with '…'; JSON snippets need JSON escaping.
        const safe = pane === 'code' ? v.replace(/'/g, `'\\''`) : JSON.stringify(v).slice(1, -1);
        t = t.split(`<${k}>`).join(safe);
      }
      pre.textContent = t;
      const btn = pre.parentElement.querySelector('.cat-copy');
      if (btn) btn.dataset.cmd = t;
    }
    return true;
  }

  /** Things to know before relying on a server: [level, text]. */
  function gotchas(row, F, toolsDetail) {
    const out = [];
    const envs = (F.envs != null && row[F.envs]) || [];
    if (envs.length) out.push(['info', `Needs ${envs.length === 1 ? 'a setting' : envs.length + ' settings'}: ${envs.map(([n, secret, d]) => { const x = explain(n, d); return n + (secret ? ' (secret)' : '') + (x ? ` — ${x.replace(/[.\s]+$/, '')}` : ''); }).join('; ')}. Fill ${envs.length === 1 ? 'it' : 'them'} in under Set it up.`]);
    else if (row[F.required] > 0) out.push(['info', `Needs ${row[F.required]} setting${row[F.required] > 1 ? 's' : ''} before it works; see its README.`]);
    const reach = row[F.reach];
    if (reach === 2) out.push(['warn', 'Asks for sign-in or an API key when you connect.']);
    if (reach === 3) out.push(['warn', 'Paid: answers ask for payment or a subscription.']);
    if (reach === 4) out.push(['bad', 'Blocks automated clients at the last check.']);
    if (reach === 5) out.push(['bad', 'Didn’t answer at the last check: it may be down or moved.']);
    const writes = toolsDetail ? toolsDetail.filter((t) => t.w).length : (F.writeTools != null && row[F.writeTools]) || 0;
    if (writes) out.push(['warn', `${writes} tool${writes > 1 ? 's' : ''} can change things (send, write, delete, pay). MCP Browser hides them; in other clients, keep approval prompts on.`]);
    const name = row[F.name];
    const ns = name.split('/')[0].toLowerCase();
    const repo = String(row[F.repo] || '').toLowerCase();
    const ghOwner = /^[a-z0-9-_.]+\/[a-z0-9-_.]+$/.test(repo) ? repo.split('/')[0] : '';
    if (ns.startsWith('io.github.') && ghOwner && ns.slice(10) !== ghOwner) out.push(['warn', `Published by GitHub user ${ns.slice(10)}, but the code is in ${ghOwner}’s repo. Check it’s the official server before giving it keys.`]);
    if (!ns.startsWith('io.github.')) {
      const domain = ns.split('.').reverse().join('.');
      const site = String(row[F.website] || '').toLowerCase();
      if (site && !site.includes(domain.replace(/^www\./, ''))) out.push(['info', `Publisher verified the domain ${domain}; its website link points elsewhere.`]);
      else if (domain.includes('.')) out.push(['ok', `Publisher verified ownership of ${domain} with the registry.`]);
    }
    if (row[F.pubCount] >= 100) out.push(['info', `This publisher has ${row[F.pubCount].toLocaleString()} servers in the registry; many are generated from templates.`]);
    if (row[F.archived]) out.push(['bad', 'The GitHub repo is archived: no longer maintained.']);
    if (row[F.deprecated]) out.push(['bad', 'Marked deprecated in the registry.']);
    if (row[F.pushed] && Date.now() - Date.parse(row[F.pushed]) > 365 * 864e5) out.push(['warn', `No code pushed since ${row[F.pushed]}.`]);
    if (row[F.stars] >= 0 && row[F.stars] < 5 && row[F.downloads] < 100) out.push(['info', 'Few users so far: test it before depending on it.']);
    if (!out.some(([l]) => l !== 'ok' && l !== 'info')) out.push(['ok', 'No warning signs found in the registry, GitHub and our probes.']);
    return out;
  }

  function toolsHtml(tools) {
    if (!tools.length) return '';
    const read = tools.filter((t) => !t.w);
    const write = tools.filter((t) => t.w);
    const one = (t) => `<li><code>${esc(t.n)}</code>${t.p?.length ? `<span class="g-args">(${t.p.map((p) => esc(p.k)).join(', ')})</span>` : ''}${t.w ? '<span class="g-w">changes things</span>' : ''}${t.d ? `<p>${esc(t.d)}</p>` : ''}</li>`;
    return `<section class="g-sec"><h4>Tools <span class="g-count">${tools.length}</span></h4><ul class="g-tools">${read.map(one).join('')}${write.map(one).join('')}</ul></section>`;
  }

  function gotchaHtml(list) {
    return `<section class="g-sec"><h4>Before you rely on it</h4><ul class="g-checks">${list.map(([l, t]) => `<li class="${l}">${esc(t)}</li>`).join('')}</ul></section>`;
  }

  /**
   * Fill a guide panel for one catalog row. ctx: { F, goalsFor(name) → [{id,title}], hooks }.
   * Tools come from /api/catalog/tools when the server was listed.
   */
  async function renderGuide(panel, row, ctx) {
    const { F } = ctx;
    const goals = ctx.goalsFor ? ctx.goalsFor(row[F.name]) : [];
    const canAdd = F.listed != null && row[F.listed] === 1;
    panel.innerHTML = `
      ${goals.length ? `<section class="g-sec"><h4>Good for</h4><p class="g-goals">${goals.map((g) => `<button type="button" class="g-goal" data-goal="${esc(g.id)}">${esc(g.title)}</button>`).join('')}</p></section>` : ''}
      ${setupHtml([row], F)}
      ${canAdd ? `<p class="g-add"><button type="button" data-g-add="${esc(row[F.name])}">Add to MCP Browser</button> <span class="g-add-msg">Hosted and works without a key: questions you ask in MCP Browser can use it.</span></p>` : ''}
      <div data-g-tools>${row[F.listed] ? '<p class="g-note">Loading tools…</p>' : ''}</div>
      <div data-g-checks>${gotchaHtml(gotchas(row, F))}</div>`;
    if (!row[F.listed]) return;
    try {
      const r = await fetch(`/api/catalog/tools?id=${encodeURIComponent(row[F.name])}`).then((x) => x.json());
      panel.querySelector('[data-g-tools]').innerHTML = toolsHtml(r.tools || []) || '';
      panel.querySelector('[data-g-checks]').innerHTML = gotchaHtml(gotchas(row, F, r.tools || []));
    } catch {
      panel.querySelector('[data-g-tools]').innerHTML = '';
    }
  }

  /** Shared click handling for tabs, copy and add buttons inside guide/setup blocks. */
  function handleClick(e, ctx) {
    const tab = e.target.closest('[data-g-tab]');
    if (tab) {
      const box = tab.closest('.g-setup');
      for (const b of box.querySelectorAll('[data-g-tab]')) b.setAttribute('aria-selected', String(b === tab));
      for (const p of box.querySelectorAll('[data-g-pane]')) p.hidden = p.dataset.gPane !== tab.dataset.gTab;
      return true;
    }
    const add = e.target.closest('[data-g-add]');
    if (add) {
      const msg = add.parentElement.querySelector('.g-add-msg');
      add.disabled = true;
      ctx.addToBrowser(add.dataset.gAdd).then(
        (t) => ((msg.textContent = t), (add.textContent = 'Added')),
        (err) => ((msg.textContent = `Couldn’t add it: ${err.message}`), (add.disabled = false))
      );
      return true;
    }
    return false;
  }

  window.MCPGuide = { setupFor, setupHtml, gotchas, renderGuide, handleClick, handleInput, keyName, explain };
})();
