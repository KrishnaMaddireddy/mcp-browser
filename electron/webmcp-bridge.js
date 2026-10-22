// WebMCP for MCP Browser's web tabs. Injected into every page before its own
// scripts (Page.addScriptToEvaluateOnNewDocument), in the page's own world.
//
// Pages offer tools to AI agents with WebMCP:
//   document.modelContext.registerTool(tool, { signal })        (current draft)
//   navigator.modelContext.provideContext / registerTool / ...  (earlier drafts)
//   <form toolname="…" tooldescription="…" [toolautosubmit]>     (declarative)
// If the browser has WebMCP natively, its registerTool is wrapped so MCP Browser
// sees the same tools; otherwise this provides the API. MCP Browser's window reads
// the tools with window.__mcpbWebMCP.list() and calls one with .call(name, args),
// only when you ask it to. Tools run in the page, as you, like the page's own
// buttons: they get no extra access from this.
(() => {
  'use strict';
  if (window.__mcpbWebMCP) return;
  const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
  const tools = new Map(); // name -> tool
  let timer = 0;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        console.debug('__mcpb_webmcp_toolchange');
      } catch {}
    }, 50);
  };
  const clip = (v, n) => String(v ?? '').slice(0, n);

  function add(tool, signal) {
    if (!tool || typeof tool !== 'object' || !NAME.test(String(tool.name || '')) || typeof tool.execute !== 'function') throw new TypeError('A WebMCP tool needs a name and an execute function');
    tools.set(tool.name, tool);
    if (signal && typeof signal.addEventListener === 'function') {
      const drop = () => tools.get(tool.name) === tool && (tools.delete(tool.name), changed());
      if (signal.aborted) drop();
      else signal.addEventListener('abort', drop, { once: true });
    }
    changed();
  }
  const remove = (name) => tools.delete(String(name)) && changed();

  // ---------- the page-facing API ----------
  const events = new EventTarget();
  const client = { requestUserInteraction: async (cb) => (typeof cb === 'function' ? cb() : undefined) };
  const docApi = {
    registerTool(tool, opts) {
      try {
        add(tool, opts && opts.signal);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
    unregisterTool(name) {
      remove(name);
    },
    async getTools() {
      return [...tools.values()].map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} }, origin: location.origin, window }));
    },
    async executeTool(tool, args) {
      const t = tools.get(typeof tool === 'string' ? tool : tool && tool.name);
      if (!t) throw new Error('no such tool');
      return t.execute(args || {}, client);
    },
    addEventListener: (...a) => events.addEventListener(...a),
    removeEventListener: (...a) => events.removeEventListener(...a),
    dispatchEvent: (e) => events.dispatchEvent(e),
  };
  const navApi = {
    provideContext(ctx) {
      for (const [n, t] of tools) if (!t.__mcpbForm) tools.delete(n);
      for (const t of (ctx && ctx.tools) || []) add(t);
      changed();
    },
    clearContext() {
      tools.clear();
      changed();
    },
    registerTool(tool) {
      add(tool);
      return { unregister: () => remove(tool.name) };
    },
    unregisterTool: remove,
  };

  function wrapNative(obj) {
    // Native WebMCP: keep it working, and record each tool for MCP Browser too.
    const orig = obj.registerTool;
    if (typeof orig !== 'function') return;
    try {
      obj.registerTool = function (tool, opts) {
        try {
          add(tool, opts && opts.signal);
        } catch {}
        return orig.call(this, tool, opts);
      };
      if (typeof obj.unregisterTool === 'function') {
        const u = obj.unregisterTool;
        obj.unregisterTool = function (name) {
          remove(name);
          return u.call(this, name);
        };
      }
      if (typeof obj.provideContext === 'function') {
        const p = obj.provideContext;
        obj.provideContext = function (ctx) {
          for (const t of (ctx && ctx.tools) || []) {
            try {
              add(t);
            } catch {}
          }
          return p.call(this, ctx);
        };
      }
    } catch {}
  }
  try {
    if (document.modelContext) wrapNative(document.modelContext);
    else Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get: () => docApi });
  } catch {}
  try {
    if (navigator.modelContext) wrapNative(navigator.modelContext);
    else Object.defineProperty(Navigator.prototype, 'modelContext', { configurable: true, get: () => navApi });
  } catch {}

  // ---------- declarative tools: <form toolname tooldescription> ----------
  const labelOf = (el) => {
    if (el.getAttribute('toolparamdescription')) return el.getAttribute('toolparamdescription');
    const l = el.labels && el.labels[0];
    if (l) return l.textContent.trim();
    return el.getAttribute('aria-description') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  };
  function formTools() {
    const out = [];
    for (const f of document.querySelectorAll('form[toolname][tooldescription]')) {
      const name = f.getAttribute('toolname');
      if (!NAME.test(name)) continue;
      const properties = {};
      const required = [];
      for (const el of f.elements) {
        if (!el.name || el.disabled || ['submit', 'button', 'reset', 'hidden', 'file', 'password', 'image'].includes(el.type)) continue;
        if (properties[el.name]) continue;
        const p = { type: el.type === 'checkbox' ? 'boolean' : el.type === 'number' || el.type === 'range' ? 'number' : 'string', description: clip(labelOf(el), 200) };
        if (el.tagName === 'SELECT') {
          const opts = [...el.options].filter((o) => o.value !== '');
          p.enum = opts.map((o) => o.value);
          p.anyOf = opts.map((o) => ({ const: o.value, title: clip(o.textContent.trim(), 80) }));
        }
        if (el.type === 'radio') {
          const radios = [...f.elements].filter((x) => x.name === el.name && x.type === 'radio');
          p.enum = radios.map((r) => r.value);
        }
        properties[el.name] = p;
        if (el.required) required.push(el.name);
      }
      out.push({ name, description: clip(f.getAttribute('tooldescription'), 600), inputSchema: { type: 'object', properties, required }, form: f, autosubmit: f.hasAttribute('toolautosubmit') });
    }
    return out;
  }
  let lastForms = '';
  const watchForms = () => {
    const sig = formTools().map((t) => t.name).join(',');
    if (sig !== lastForms) ((lastForms = sig), changed());
  };
  new MutationObserver(() => {
    clearTimeout(watchForms.t);
    watchForms.t = setTimeout(watchForms, 200);
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['toolname', 'tooldescription'] });

  async function fillAndSubmit(t, args, submit) {
    const f = t.form;
    for (const [k, v] of Object.entries(args || {})) {
      const els = [...f.elements].filter((e) => e.name === k);
      for (const el of els) {
        if (el.type === 'checkbox') el.checked = Boolean(v);
        else if (el.type === 'radio') el.checked = el.value === String(v);
        else el.value = String(v ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const ev = new Event('toolactivated');
    ev.toolName = t.name;
    events.dispatchEvent(ev);
    if (!submit) return { content: [{ type: 'text', text: 'Filled in the form on the page. Review it there and submit it yourself.' }] };
    // The page may answer instead of navigating: preventDefault() + respondWith(promise).
    let answer = null;
    const onSubmit = (e) => {
      if (e.target !== f) return;
      try {
        Object.defineProperty(e, 'agentInvoked', { value: true });
        Object.defineProperty(e, 'respondWith', { value: (p) => (answer = Promise.resolve(p)) });
      } catch {}
    };
    window.addEventListener('submit', onSubmit, { capture: true, once: true });
    f.requestSubmit();
    if (answer) return answer;
    return { content: [{ type: 'text', text: 'Submitted the form. The page is loading the result.' }] };
  }

  // ---------- what MCP Browser's window calls ----------
  const toText = (r) => {
    if (r && Array.isArray(r.content)) return r.content.map((c) => (c && c.type === 'text' ? String(c.text) : c && c.type ? `[${c.type}]` : '')).join('\n');
    if (typeof r === 'string') return r;
    try {
      return JSON.stringify(r, null, 1);
    } catch {
      return String(r);
    }
  };
  const bridge = {
    version: 1,
    list() {
      const own = [...tools.values()].map((t) => {
        let schema = t.inputSchema;
        try {
          schema = JSON.parse(JSON.stringify(schema || { type: 'object', properties: {} }));
        } catch {
          schema = { type: 'object', properties: {} };
        }
        const ann = t.annotations || {};
        return { name: t.name, title: clip(t.title, 120), description: clip(t.description, 1200), inputSchema: schema, readOnly: ann.readOnlyHint === true, kind: 'script' };
      });
      const forms = formTools().map((t) => ({ name: t.name, title: '', description: t.description, inputSchema: t.inputSchema, readOnly: false, kind: 'form', autosubmit: t.autosubmit }));
      return [...own, ...forms.filter((f) => !tools.has(f.name))].slice(0, 100);
    },
    async call(name, args, opts) {
      try {
        const t = tools.get(name);
        if (t) return { ok: true, text: clip(toText(await t.execute(args || {}, client)), 200000) };
        const f = formTools().find((x) => x.name === name);
        if (f) return { ok: true, text: clip(toText(await fillAndSubmit(f, args, Boolean(opts && opts.submit) && f.autosubmit)), 200000) };
        return { ok: false, text: 'This page no longer has that tool.' };
      } catch (e) {
        return { ok: false, text: clip((e && e.message) || e, 2000) };
      }
    },
  };
  Object.defineProperty(window, '__mcpbWebMCP', { value: Object.freeze(bridge), configurable: false, writable: false });
})();
