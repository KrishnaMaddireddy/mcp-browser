// Store policies asked of the store itself (Shopify stores answer at /api/mcp), and website tools
// found in the webmcp.com directory. No network: the store and the directory are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-store-'));
process.env.MCPB_LOG = 'silent';
const { detectStore, storeFor, readReply, askStore, runStoreCard, policyTypesOf } = await import('../src/store-policies.js');
const { WebMcpDirectory } = await import('../src/webmcp-dir.js');

test('a store-policy question: the store, what to ask it (without its name), and the policy kinds', () => {
  const a = detectStore('allbirds return policy');
  assert.deepEqual([a.value, a.title, a.ask, a.policyTypes], ['allbirds.com', 'Allbirds', 'return policy', ['refund']]);
  const b = detectStore('does gymshark ship to Canada?');
  assert.deepEqual([b.value, b.ask, b.policyTypes], ['gymshark.com', 'ship to Canada', ['shipping']]);
  assert.equal(detectStore('What is the kyliecosmetics.com refund policy').value, 'kyliecosmetics.com');
  assert.equal(detectStore('Kylie Cosmetics shipping policy').value, 'kyliecosmetics.com');
  assert.equal(detectStore('Gymshark customer service phone number').value, 'gymshark.com');
  assert.equal(detectStore('return policy for allbirds').value, 'allbirds.com');
  assert.deepEqual(detectStore('allbirds.com return policy').hosts, ['allbirds.com', 'www.allbirds.com']);
  // (not a policy question, not a store, or a carrier)
  for (const q of ['does Nike make running shoes', 'how do returns work', 'UPS shipping rates', 'does fedex ship to canada', 'what is your return policy', 'shipping policy', 'Allbirds']) assert.equal(detectStore(q), null, q);
  assert.deepEqual(policyTypesOf('can I return it and do you ship to Canada'), ['refund', 'shipping']);
  assert.equal(storeFor('https://www.Allbirds.com/collections', 'returns').value, 'allbirds.com');
  assert.equal(storeFor('x', 'returns'), null);
});

test('what a store says is read as data: its own links only, control characters and repeats removed', () => {
  const r = readReply(
    JSON.stringify([
      { question: 'What is the return policy?', answer: 'The store accepts returns.\nWithin 31 days days of delivery.‮' },
      { type: 'Policy', policy_type: 'refund', title: 'Refund Policy', body_summary: 'Returns within 30 days.', url: 'https://www.shop.example/policies/refund-policy' },
      { type: 'Policy', policy_type: 'shipping', title: 'Shipping', body_summary: 'x', url: 'javascript:alert(1)' },
      { type: 'Policy', policy_type: 'privacy', title: 'Privacy', body_summary: 'y', url: 'https://evil.example/p' },
    ]),
    'shop.example'
  );
  assert.equal(r.faqs[0].answer, 'The store accepts returns. Within 31 days of delivery.');
  assert.deepEqual(r.policies.map((p) => p.url), ['https://www.shop.example/policies/refund-policy', '', '']);
  assert.deepEqual(readReply('not json', 'x.com'), { faqs: [], policies: [] });
});

// A stand-in for MCP Browser's connection pool, answering as a Shopify store would.
function stubPool({ stores = {}, calls = [] } = {}) {
  return {
    calls,
    async get(server) {
      const host = new URL(server.url).hostname;
      if (!stores[host]) throw new Error('not a store');
      return { tools: [{ name: 'search_shop_policies_and_faqs' }] };
    },
    async callTool(server, tool, args) {
      const host = new URL(server.url).hostname;
      calls.push({ host, tool, args });
      return { content: [{ type: 'text', text: JSON.stringify(stores[host](args)) }] };
    },
  };
}

test('the store is asked the question without its name, then the topic alone; nothing about you is sent', async () => {
  const calls = [];
  const pool = stubPool({ calls, stores: { 'gymshark.com': (a) => (a.query === 'shipping' ? [{ question: 'What countries do you ship to?', answer: 'The store ships to the following locations: US' }] : []) } });
  const got = await askStore(pool, detectStore('does gymshark ship to Canada?'));
  assert.equal(got.faqs[0].answer, 'The store ships to the following locations: US');
  assert.deepEqual(calls.map((c) => c.args), [{ query: 'ship to Canada', policy_types: ['shipping'] }, { query: 'shipping', policy_types: ['shipping'] }]);
  assert.ok(calls.every((c) => !('context' in c.args) && c.host === 'gymshark.com'));
});

test('the card: from the store, with its policies and a note on other countries; none for a site that isn\'t a store', async () => {
  const pool = stubPool({ stores: { 'www.shop.example': () => [{ question: 'What is the return policy?', answer: 'Within 31 days.' }, { type: 'Policy', policy_type: 'refund', title: 'Refund Policy', body_summary: 'Returns within 30 days.', url: 'https://www.shop.example/policies/refund-policy' }] } });
  const ev = [];
  await runStoreCard(pool, detectStore('shop.example return policy'), { emit: (t, d) => ev.push([t, d]) });
  assert.deepEqual(ev.map(([t]) => t), ['card_start', 'card_section', 'card_section', 'card_done']);
  assert.equal(ev[0][1].asking, 'asked www.shop.example directly');
  const [answers, policies] = [ev[1][1], ev[2][1]];
  assert.deepEqual(answers.details[0].facts, [{ label: 'What is the return policy?', value: 'Within 31 days.' }]);
  assert.match(answers.details[1].text, /another country can differ/);
  assert.deepEqual(policies.links, [{ title: 'Refund Policy', url: 'https://www.shop.example/policies/refund-policy', host: 'www.shop.example' }]);
  assert.deepEqual(answers.servers, ['www.shop.example (the store itself)']);
  const none = [];
  await runStoreCard(stubPool(), detectStore('nike return policy'), { emit: (t, d) => none.push(t) });
  assert.deepEqual(none, ['card_none']);
});

test('website tools for a task, from the downloaded directory: the right tool first, reading ones before acting', async () => {
  const dir = new WebMcpDirectory({ file: path.join(process.env.MCPB_DATA_DIR, 'w.json.gz') });
  dir.data = {
    fetchedAt: new Date().toISOString(),
    sites: [
      { host: 'travelomi.com', url: 'https://travelomi.com/', type: 'live', category: 'Travel', desc: 'Flight search', tools: [{ name: 'search_flights', kind: 'answer', description: 'Search flights between two airports.', page: '/' }, { name: 'book_flight', kind: 'transact', description: 'Book a flight.', page: '/' }] },
      { host: 'demo.example', url: 'https://demo.example/', type: 'demo', category: 'Travel', desc: 'A demo', tools: [{ name: 'searchFlights', kind: 'answer', description: 'Searches for flights.', page: '/' }] },
      { host: 'quiz.example', url: 'https://quiz.example/', type: 'live', category: 'Education', desc: 'Quizzes', tools: [{ name: 'make_quiz', kind: 'act', description: 'Turn a PDF into a quiz.', page: '/app' }] },
    ],
  };
  dir._index();
  const hits = dir.findTools('search flights');
  assert.deepEqual(hits.map((h) => `${h.host}/${h.name}`).slice(0, 2), ['travelomi.com/search_flights', 'demo.example/searchFlights']);
  assert.deepEqual(dir.findTools('book a flight', { kind: 'transact' }).map((h) => h.name), ['book_flight']);
  assert.deepEqual(dir.findTools('pdf quiz').map((h) => h.name), ['make_quiz']);
  assert.deepEqual(dir.findTools('the a for'), []);
});
