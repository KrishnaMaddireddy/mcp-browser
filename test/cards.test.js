// Answer cards: which questions get one, and what it asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectEntity, cardSections } = await import('../src/cards.js');
const type = (q) => detectEntity(q)?.type || null;

test('a card only when the question is one thing', () => {
  assert.equal(type('Nvidia'), 'company');
  assert.equal(detectEntity('NVDA').value, 'NVDA');
  assert.equal(type('nvidia stock'), 'company');
  assert.equal(detectEntity('Meta').title, 'Meta');
  assert.equal(type('visa'), null, 'a lower-case word is a word first');
  assert.equal(type('apple pie recipe'), null);
  assert.equal(type('Lisbon'), 'place');
  assert.equal(type('Kyoto travel'), 'place');
  assert.equal(type('weather in Lisbon'), null);
  assert.equal(type('Japan'), null);
  assert.equal(detectEntity('what is CVE-2021-44228?').value, 'CVE-2021-44228');
  assert.equal(detectEntity('is paypal-verify-account.com safe').value, 'paypal-verify-account.com');
  assert.equal(type('example.com'), null, 'a bare address opens the site');
  assert.equal(detectEntity('Apache Struts vulnerabilities').value, 'Apache Struts');
  assert.equal(type('how to boil an egg'), null);
});

test('each card asks several named servers at once', () => {
  for (const q of ['Nvidia', 'Lisbon', 'CVE-2021-44228', 'github.com down', 'log4j exploits']) {
    const s = cardSections(detectEntity(q));
    assert.ok(s.length >= 3, q);
    assert.ok(s.every((x) => x.servers?.length && x.ask && x.label), q);
  }
});

test('"A vs B" of one kind gets two cards side by side', async () => {
  const { detectPair } = await import('../src/cards.js');
  assert.deepEqual(detectPair('Nvidia vs AMD').map((e) => e.title), ['Nvidia', 'AMD']);
  assert.deepEqual(detectPair('Lisbon or Madrid').map((e) => e.type), ['place', 'place']);
  assert.equal(detectPair('Paris vs Nvidia'), null);
  assert.equal(detectPair('iPhone vs Pixel'), null);
});

test('other languages are told apart from short English headlines', async () => {
  const { langOf } = await import('../src/quality.js');
  assert.equal(langOf('Chip stocks had a rough week'), 'en');
  assert.equal(langOf('Apple Unveils New iPhone Pro Max Today'), 'en');
  assert.equal(langOf('Nvidia despliega miles de millones en Europa: Impacto en startups del continente'), 'latin+');
  assert.equal(langOf('Nvidia Aktie: Tech-Ausverkauf drückt Kurs ins Minus, Nachfrage trifft auf knappe Mittel bei Cloudanbietern'), 'latin+');
});
