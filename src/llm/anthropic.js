import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor({ apiKey, model, baseUrl }) {
    // baseURL is only taken from the user's own settings, never the environment,
    // so a stray ANTHROPIC_BASE_URL can't silently reroute their key.
    this.client = new Anthropic({ apiKey, baseURL: baseUrl || 'https://api.anthropic.com' });
    this.model = model;
    this.name = 'anthropic';
  }

  toApiMessages(messages) {
    const out = [];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
        if (content.length) out.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        out.push({
          role: 'user',
          content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: Boolean(r.isError) })),
        });
      }
    }
    return out;
  }

  async chat({ system, messages, tools = [], onText, signal, maxTokens = 4096 }) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: this.toApiMessages(messages),
    };
    if (tools.length) params.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    const stream = this.client.messages.stream(params, { signal });
    if (onText) stream.on('text', (d) => onText(d));
    const msg = await stream.finalMessage();
    let text = '';
    const toolCalls = [];
    for (const b of msg.content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
    }
    return { text, toolCalls, stopReason: msg.stop_reason };
  }
}
