import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCPB_LOG = 'silent';
const { urlOf, pickQueryTool } = await import('../src/agent.js');

test('free mode fills a link input from the question', () => {
  assert.equal(urlOf('Scrape the pricing page of linear.app and summarize'), 'https://linear.app');
  assert.equal(urlOf('check https://example.com/a?b=1.'), 'https://example.com/a?b=1');
  assert.equal(urlOf('what is new in version 2.5'), null);
  const tools = [
    { name: 'scrape_url', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'whois', inputSchema: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] } },
    { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ];
  const p = pickQueryTool(tools, 'Scrape the pricing page of linear.app');
  assert.equal(p.tool.name, 'scrape_url');
  assert.equal(p.value, 'https://linear.app');
  assert.equal(pickQueryTool(tools.slice(1), 'whois for stripe.com').value, 'stripe.com', 'a domain input gets just the host');
  assert.equal(pickQueryTool(tools, 'who invented the telephone').tool.name, 'search', 'no link: the usual search tool');
});
