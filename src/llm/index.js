// Provider-neutral chat interface.
//
// messages: [{role:'user', content}, {role:'assistant', text, toolCalls:[{id,name,args}]},
//            {role:'tool', results:[{id, name, content}]}]
// tools:    [{name, description, schema}]
// chat() → { text, toolCalls:[{id,name,args}], stopReason }
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { cleanSchemaText } from '../policy.js';

export function makeProvider(resolved) {
  if (!resolved || resolved.provider === 'none') return null;
  if (resolved.provider === 'anthropic') return new AnthropicProvider(resolved);
  if (resolved.provider === 'openai') return new OpenAIProvider(resolved);
  throw new Error(`unknown provider ${resolved.provider}`);
}

/** Make an MCP inputSchema acceptable to strict LLM tool APIs. */
export function toToolSchema(schema) {
  let s = schema && typeof schema === 'object' ? cleanSchemaText(JSON.parse(JSON.stringify(schema))) : {};
  delete s.$schema;
  delete s.$id;
  if (s.type !== 'object') s = { type: 'object', properties: {} };
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  if (JSON.stringify(s).length > 12000) {
    // Huge schemas eat the context window; keep only top-level names and types.
    const props = {};
    for (const [k, v] of Object.entries(s.properties).slice(0, 30)) {
      props[k] = { type: v?.type || 'string', description: String(v?.description || '').slice(0, 200) };
    }
    s = { type: 'object', properties: props, required: (s.required || []).filter((r) => r in props) };
  }
  return s;
}
