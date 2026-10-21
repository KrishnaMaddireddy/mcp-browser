// Any OpenAI-compatible Chat Completions API: OpenAI, Groq, OpenRouter,
// Together, a local Ollama (http://localhost:11434/v1) or LM Studio.

export class OpenAIProvider {
  constructor({ apiKey, model, baseUrl, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.name = 'openai';
  }

  toApiMessages(system, messages) {
    const out = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.text || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        }
        out.push(msg);
      } else if (m.role === 'tool') {
        for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
    return out;
  }

  async chat({ system, messages, tools = [], onText, signal, maxTokens = 4096 }) {
    const body = {
      model: this.model,
      messages: this.toApiMessages(system, messages),
      stream: true,
      max_tokens: maxTokens,
    };
    if (tools.length) {
      // OpenAI-style APIs accept at most 128 tools: keep the most relevant (they come first).
      if (tools.length > 128) tools = tools.slice(0, 128);
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
      body.tool_choice = 'auto';
    }
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    let text = '';
    let stopReason = null;
    const calls = new Map(); // index -> {id, name, argsText}
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      const ch = j.choices?.[0];
      if (!ch) return;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        onText?.(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        const c = calls.get(i) || { id: '', name: '', argsText: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.argsText += tc.function.arguments;
        calls.set(i, c);
      }
      if (ch.finish_reason) stopReason = ch.finish_reason;
    };
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handle(buf);
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => {
        let args = {};
        try {
          args = c.argsText ? JSON.parse(c.argsText) : {};
        } catch {
          args = { _unparsed: c.argsText.slice(0, 2000) };
        }
        return { id: c.id || `call_${i}_${Date.now()}`, name: c.name, args };
      });
    return { text, toolCalls, stopReason };
  }
}
