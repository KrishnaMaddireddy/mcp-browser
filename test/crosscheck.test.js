// Cross-check: reading quoted sentences against a claim, without an AI model.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { claimParts, judgeSentence, verdictOf, sourceKey, evidenceFrom, figuresOf, judgeWithModel } = await import('../src/crosscheck.js');
const stance = (claim, sentence) => judgeSentence(claimParts(claim), sentence)?.stance || null;

test('figures: same, converted, different, and the one nearest the subject', () => {
  assert.equal(stance('The Eiffel Tower is 330 meters tall', 'The Eiffel Tower is 330 metres (1,083 ft) tall, about the height of an 81-storey building.'), 'supports');
  assert.equal(stance('The Eiffel Tower is 1,083 feet tall', 'The Eiffel Tower is 330 metres (1,083 ft) tall, about the height of an 81-storey building.'), 'supports');
  assert.equal(stance('The Eiffel Tower is 450 meters tall', 'The Eiffel Tower is 330 metres (1,083 ft) tall, about the height of an 81-storey building.'), 'differs');
  assert.equal(stance('The default port for PostgreSQL is 3306', 'For instance, PostgreSQL uses port 5432, while MySQL uses port 3306.'), 'differs');
  assert.equal(stance('The default port for PostgreSQL is 5432', 'For instance, PostgreSQL uses port 5432, while MySQL uses port 3306.'), 'supports');
  assert.equal(stance('The Amazon River is about 6,400 km long', 'The Amazon River has its source high in the Peruvian Andes, at an elevation of 5,598 m.'), 'mentions');
  assert.deepEqual(figuresOf('1.2 million people, 45%, 8,849 m').map((f) => [f.value, f.unit]), [[1200000, 'people'], [45, '%'], [8849, 'm']]);
});

test('statements: who it names, qualifiers, former states, passive voice, hearsay', () => {
  assert.equal(stance('Canberra is the capital of Australia', 'Canberra is the capital city of Australia.'), 'supports');
  assert.equal(stance('Sydney is the capital of Australia', 'Canberra is the capital city of Australia and its eighth-largest city.'), 'differs');
  assert.equal(stance('Saturn is the largest planet in the Solar System', 'Saturn is the sixth planet from the Sun, and is the second largest planet in the Solar System, after Jupiter.'), 'differs');
  assert.equal(stance('Kyoto is the capital of Japan', 'Kyoto, the former capital of Japan, is famous for its many temples.'), 'differs');
  assert.equal(stance('Toronto is the capital of Canada', 'Toronto is the capital city of the Canadian province of Ontario, and a big one.'), 'mentions');
  assert.equal(stance('Thomas Edison invented the telephone', 'The telephone was invented by Alexander Graham Bell in 1876 in Boston.'), 'differs');
  assert.equal(stance('Alexander Graham Bell invented the telephone', 'In 1876, Alexander Graham Bell invented the telephone in his Boston lab.'), 'supports');
  assert.equal(stance('France won the 2022 FIFA World Cup', 'Argentina beat France 4-2 on penalties to win the 2022 World Cup after a 3-3 draw.'), 'differs');
  assert.equal(stance('The Berlin Wall fell in 1991', 'The Berlin Wall fell on 9 November 1989 during the Peaceful Revolution.'), 'differs');
  assert.equal(stance('Toronto is the capital of Canada', 'But many people do often assume Toronto is the capital of Canada.'), 'mentions');
  assert.ok(!['supports', 'differs'].includes(stance('Penicillin was discovered in 1945', 'Discovery of penicillin - Wikipedia.')));
});

test('verdicts are cautious, and copies of one page count once', () => {
  const e = (stance, source) => ({ stance, source, sentence: `${source} says so in a sentence of its own here` });
  assert.equal(verdictOf([e('supports', 'a'), e('supports', 'b'), e('supports', 'c')]).verdict, 'supported');
  assert.equal(verdictOf([e('supports', 'a'), e('supports', 'b')]).verdict, 'weak');
  assert.equal(verdictOf([e('supports', 'a'), e('differs', 'b')]).verdict, 'disputed');
  assert.equal(verdictOf([e('differs', 'a'), e('differs', 'b')]).verdict, 'contradicted');
  assert.equal(sourceKey('en.wikipedia.org'), sourceKey('wikipedia-org.zproxy.org'));
  assert.equal(sourceKey('www.britannica.com'), 'britannica.com');
  const parts = claimParts('Canberra is the capital of Australia');
  const same = 'Canberra is the capital city of Australia.';
  const ev = evidenceFrom(parts, [{ serverTitle: 'Web', view: { kind: 'items', items: [{ site: 'en.wikipedia.org', title: 'Canberra', text: same }, { site: 'wikiwand.com', title: 'Canberra', text: same }, { site: 'reddit.com', title: 'x', text: same }] } }]);
  assert.equal(ev.filter((x) => x.stance === 'supports').length, 1);
});

test('with an AI model, its labels replace the word matching', async () => {
  const provider = { chat: async () => ({ text: 'Here: [{"n":1,"stance":"differs"},{"n":2,"stance":"supports"}]' }) };
  const ev = [{ stance: 'supports', source: 'a', sentence: 'one' }, { stance: 'mentions', source: 'b', sentence: 'two' }];
  const out = await judgeWithModel(provider, 'claim', ev);
  assert.deepEqual(out.map((x) => [x.source, x.stance]), [['b', 'supports'], ['a', 'differs']]);
});
