// How-to-use helpers for the server catalog: setup snippets for the common MCP
// clients, "before you rely on it" checks, and the per-server guide panel.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const keyName = (name) => (String(name).split('/').pop() || String(name)).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'server';
  const placeholder = (n) => `<${n}>`;

  // ---------- command-line arguments from the registry ----------
  // Runtime arguments go to npx / uvx / docker before the package; package
  // arguments go to the server after it ("uvx --with edgartools[ai] edgartools mcp").
  // Both come from the publisher, so runtime arguments are limited to safe ones:
  // no other package index, URL or local path, and for Docker no folder mounts,
  // host network or extra privileges.
  const PY_REQ = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._ -]+\])?(\s*(===?|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]+(\s*,\s*(===?|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]+)*)?$/;
  const NPM_SPEC = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[A-Za-z0-9.^~<>=*|+-]{1,40})?$/;
  const HOLE = /\{[^{}]*\}|<[^<>]*>|\$\{/;
  const pyName = (spec) => String(spec).replace(/[\[=<>!~@ ].*$/, '').toLowerCase().replace(/[-_.]+/g, '-');
  const bare = (t, id) => String(id || '').replace(t === 'npm' ? /(?<=.)@[^/@]*$/ : t === 'pypi' ? /[=<>!~@].*$/ : /$^/, '');
  const PY_VER = /^(python)?3(\.\d{1,2})?$/;
  const ENV_ARG = /^[A-Za-z_][A-Za-z0-9_]{0,63}(=\S{0,200})?$/;
  // Per runtime: flags that are always there (skipped), flags allowed with a checked value,
  // and flags known to take a value (dropped together with it).
  const RT = {
    npm: { skip: ['-y', '--yes'], ok: { '-p': NPM_SPEC, '--package': NPM_SPEC }, valued: ['--registry', '--cache', '--prefix', '--userconfig', '--node-options', '-c', '--call', '--workspace', '-w'] },
    pypi: { skip: [], ok: { '--with': PY_REQ, '-w': PY_REQ, '--python': PY_VER, '-p': PY_VER, '--from': PY_REQ }, valued: ['--index-url', '-i', '--extra-index-url', '--index', '--default-index', '--find-links', '-f', '--python-preference', '--env-file', '--directory', '--project', '--config-file', '-m', '--with-requirements', '--with-editable', '--constraints', '-c', '--overrides'] },
    oci: { skip: ['run', '-i', '--interactive', '--rm', '--init', '-t', '-it', '--tty'], ok: { '-e': ENV_ARG, '--env': ENV_ARG }, valued: ['-v', '--volume', '--mount', '-p', '--publish', '--network', '--net', '--add-host', '--security-opt', '--name', '-w', '--workdir', '-u', '--user', '--env-file', '--cap-add', '--device', '--entrypoint', '--platform', '--memory', '-m', '--pid', '--ipc', '--label', '-l', '--group-add', '--privileged'] },
  };
  const tokensOf = (list) => list.flatMap(([t, n, v]) => (t === 'n' ? (v !== '' && v != null ? [String(n), String(v)] : [String(n)]) : v !== '' && v != null ? [String(v)] : []));
  /**
   * { runtime: [...], pkg: [...], dropped: [labels], needs: [labels], unpinned } for a catalog row.
   * pin: the version the package is pinned to.
   */
  function argsOf(row, F, { pin } = {}) {
    // viaFlag: the package is named by -p / --from, so the next word is the command, not the package.
    const out = { runtime: [], pkg: [], dropped: [], needs: [], moved: [], unpinned: false, viaFlag: false };
    const a = (F.args != null && row[F.args]) || 0;
    if (!a) return out;
    const [rargs = [], pargs = []] = a;
    const type = row[F.pkgType];
    const rt = RT[type] || { skip: [], ok: {}, valued: [] };
    const self = pyName(bare('pypi', row[F.pkgId]));
    const repin = (v) => (pin && pyName(v) === self ? v.replace(/\s*(===?|@)\s*[A-Za-z0-9.*+!_-]+$/, '') + '==' + pin : v);
    const tk = tokensOf(rargs);
    for (let i = 0; i < tk.length; i++) {
      const tok = tk[i];
      if (HOLE.test(tok)) {
        out.needs.push(tok);
        continue;
      }
      if (rt.skip.includes(tok)) continue;
      const [flag, inline] = tok.startsWith('--') && tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, null];
      if (rt.ok[flag]) {
        let v = inline ?? tk[++i];
        if (v == null || HOLE.test(v)) {
          out.needs.push(`${flag} ${v ?? ''}`.trim());
          continue;
        }
        if (!rt.ok[flag].test(v)) {
          out.dropped.push(`${flag} ${v}`);
          continue;
        }
        if (type === 'pypi' && (flag === '--with' || flag === '-w' || flag === '--from')) {
          if (flag === '--from') out.viaFlag = true;
          if (flag === '--from' && pyName(v) !== self) out.unpinned = true;
          v = repin(v);
        }
        if (type === 'npm' && (flag === '-p' || flag === '--package')) {
          const same = bare('npm', v) === bare('npm', row[F.pkgId]);
          if (same) (out.viaFlag = true), pin && (v = `${bare('npm', v)}@${pin}`);
        }
        out.runtime.push(flag, v);
      } else if (tok.startsWith('-')) {
        // Not allowed: drop it, and the value it takes.
        const takes = rt.valued.includes(flag) && inline == null && tk[i + 1] != null && !String(tk[i + 1]).startsWith('-');
        out.dropped.push(takes ? `${tok} ${tk[++i]}` : tok);
      } else if (type === 'oci') out.dropped.push(tok); // before the image it would be read as the image
      else if ((type === 'pypi' ? pyName(tok) === self : tok === bare('npm', row[F.pkgId]).split('/').pop()) && !out.viaFlag) {
        // The package's own command name ("uvx basic-memory …"): npx / uvx already run it.
      } else {
        // A plain word before the package is almost always the server's subcommand ("mcp"):
        // after the package only the server sees it.
        out.moved.push(tok);
        out.pkg.push(tok);
      }
    }
    for (const [t, n0, v0, req, d] of pargs) {
      const n = String(n0 || '');
      const v = String(v0 ?? '').replace(/[\u0000-\u001f]/g, '');
      if (HOLE.test(v) || HOLE.test(n) || (!v && req && t === 'p')) {
        // An optional setting that only holds a placeholder ("--storage-path ${PATH}"): leave it at the server's default.
        if (!req && !HOLE.test(n)) continue;
        out.needs.push([n, v].filter(Boolean).join(' ') || d || 'an argument');
        continue;
      }
      if (t === 'n' && !/^-{1,2}[A-Za-z0-9][\w.-]*$/.test(n)) {
        out.dropped.push(n);
        continue;
      }
      if (t === 'n' && !v) {
        if (req) out.pkg.push(n); // a required flag
        continue; // an optional setting left at the server's default
      }
      out.pkg.push(...(t === 'n' ? [n, v] : v ? [v] : []));
    }
    return out;
  }

  /**
   * How to launch one server: { kind: 'local'|'remote'|'none', name, command, args, env, url, headers, note, needsArgs }.
   * pin: { version, wheel } pins the package (and installs PyPI wheels without building).
   */
  function launchOf(row, F, { pin } = {}) {
    const name = keyName(row[F.name]);
    const envs = (F.envs != null && row[F.envs]) || [];
    const t = row[F.pkgType];
    const pv = pin && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(pin.version || '') ? pin.version : '';
    const a = argsOf(row, F, { pin: pv });
    // Named by -p / --from: the next plain word is the command. Without one, npx goes back to the
    // usual form (drop -p) and uvx runs the package's own command.
    const cmdWord = a.pkg.length && !String(a.pkg[0]).startsWith('-');
    if (a.viaFlag && !cmdWord && t === 'npm') {
      const i = a.runtime.findIndex((x, j) => (x === '-p' || x === '--package') && bare('npm', a.runtime[j + 1]) === bare('npm', row[F.pkgId]));
      if (i >= 0) a.runtime.splice(i, 2);
      a.viaFlag = false;
    }
    const pinned = pv && !a.unpinned && (t === 'npm' || t === 'pypi') ? `${bare(t, row[F.pkgId])}@${pv}` : row[F.pkgId];
    const id = a.viaFlag ? (cmdWord ? null : bare(t, row[F.pkgId])) : pinned;
    const env = {};
    for (const [n, , , kind] of envs) if (kind !== 'h') env[n] = placeholder(n);
    const notes = [];
    if (a.needs.length) notes.push(`Fill in its arguments first: ${a.needs.join('; ')} (see its README).`);
    if (a.dropped.length) notes.push(`Left out from its registry entry, for safety: ${a.dropped.join('; ')}.`);
    const extra = { ...(notes.length ? { note: notes.join(' ') } : {}), ...(a.needs.length ? { needsArgs: a.needs } : {}) };
    const tail = [...a.pkg, ...a.needs.map((x) => `<${x}>`)];
    const idArg = id == null ? [] : [id];
    if (t === 'npm') return { kind: 'local', name, command: 'npx', args: ['-y', ...a.runtime, ...idArg, ...tail], env, ...extra };
    if (t === 'pypi') return { kind: 'local', name, command: 'uvx', args: [...(pv && pin.wheel !== false ? ['--no-build'] : []), ...a.runtime, ...idArg, ...tail], env, ...extra };
    if (t === 'oci') return { kind: 'local', name, command: 'docker', args: ['run', '-i', '--rm', ...Object.keys(env).flatMap((k) => ['-e', k]), ...a.runtime, id, ...tail], env, ...extra };
    if (t === 'nuget') return { kind: 'local', name, command: 'dnx', args: [id, '--yes', ...tail], env, ...extra };
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
    // Our own test: started for real in a throwaway machine and asked its sample question.
    const tested = F.tested != null && row[F.tested];
    if (tested) {
      const [code, day, , why] = tested;
      const w = String(why || '').replace(/[.\s]+$/, '');
      const T = {
        a: ['ok', `We asked it a sample question on ${day}: it answered.`],
        m: ['ok', `We asked it a sample question on ${day}: it answered once an AI model filled in its inputs (free mode can’t use it).`],
        s: ['info', `It started in our test on ${day} but didn’t answer the sample question${w ? ` (${w})` : ''}.`],
        n: ['warn', `It started in our test on ${day} but offered no tools.`],
        f: ['bad', `It didn’t start in our test on ${day}${w ? `: ${w}` : ''}.`],
        k: ['warn', `It needs a key or sign-in${w ? `: ${w}` : ''}.`],
        g: ['warn', `It needs startup arguments${w ? `: ${w}` : ''}.`],
      }[code];
      if (T) out.push(T);
    }
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

  window.MCPGuide = { setupFor, setupHtml, gotchas, renderGuide, handleClick, handleInput, keyName, explain, launchOf, argsOf };
})();
