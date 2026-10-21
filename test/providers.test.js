// The two LLM adapters, against local fake APIs that stream the real wire formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAIProvider } from '../src/llm/openai.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';

function fakeApi(handler) {
  const reqs = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    reqs.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    handler(req, res, reqs.at(-1));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, reqs, url: `http://127.0.0.1:${server.address().port}` })));
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(e);
  res.end();
};

const messages = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', text: 'checking', toolCalls: [{ id: 'c1', name: 's1__search', args: { q: 'x' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 's1__search', content: 'result', isError: false }] },
];
const tools = [{ name: 's1__search', description: 'Search', schema: { type: 'object', properties: { q: { type: 'string' } } } }];

test('OpenAI-compatible adapter: message mapping and streamed tool calls', async () => {
  const api = await fakeApi((req, res) =>
    sse(res, [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 's1__search', arguments: '{"q":' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"news"}' } }] } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
  );
  const p = new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: api.url + '/v1/' });
  let streamed = '';
  const r = await p.chat({ system: 'sys', messages, tools, onText: (d) => (streamed += d) });
  api.server.close();
  assert.equal(streamed, 'Hello');
  assert.equal(r.text, 'Hello');
  assert.deepEqual(r.toolCalls, [{ id: 'call_9', name: 's1__search', args: { q: 'news' } }]);
  assert.equal(r.stopReason, 'tool_calls');
  const req = api.reqs[0];
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer k');
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.messages[2].tool_calls[0].function.arguments, '{"q":"x"}');
  assert.deepEqual(req.body.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'result' });
  assert.equal(req.body.tools[0].function.name, 's1__search');
});

test('OpenAI-compatible adapter surfaces HTTP errors', async () => {
  const api = await fakeApi((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"bad key"}');
  });
  const p = new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: api.url });
  await assert.rejects(p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }] }), /LLM HTTP 401/);
  api.server.close();
});

test('Anthropic adapter: message mapping and streamed tool_use', async () => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const api = await fakeApi((req, res) =>
    sse(res, [
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Look' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ing' } }),
      ev('content_block_stop', { index: 0 }),
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 's1__search', input: {} } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"q": "ne' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'ws"}' } }),
      ev('content_block_stop', { index: 1 }),
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }),
      ev('message_stop', {}),
    ])
  );
  const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-x', baseUrl: api.url });
  let streamed = '';
  const r = await p.chat({ system: 'sys', messages, tools, onText: (d) => (streamed += d) });
  api.server.close();
  assert.equal(streamed, 'Looking');
  assert.equal(r.text, 'Looking');
  assert.deepEqual(r.toolCalls, [{ id: 'toolu_1', name: 's1__search', args: { q: 'news' } }]);
  assert.equal(r.stopReason, 'tool_use');
  const req = api.reqs[0];
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-test');
  assert.equal(req.body.system, 'sys');
  assert.equal(req.body.model, 'claude-x');
  assert.deepEqual(req.body.messages[1].content[1], { type: 'tool_use', id: 'c1', name: 's1__search', input: { q: 'x' } });
  assert.deepEqual(req.body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'c1', content: 'result', is_error: false });
  assert.equal(req.body.tools[0].input_schema.type, 'object');
});
