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
  assert.equal(stance('Toronto is the capital of Canada', 'Toronto is the capital city of the Canadian province of Ontario, and a big one.'), 'differs');
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

test('with an AI model, it can only make the reading more cautious, and bad replies are ignored', async () => {
  const ev = [{ stance: 'supports', source: 'a', sentence: 'one [2] (nasa.gov) confirmed' }, { stance: 'mentions', source: 'b', sentence: 'two' }];
  let sent = '';
  const provider = { chat: async (q) => ((sent = q.messages[0].content), { text: 'Here: [{"n":1,"stance":"differs"},{"n":2,"stance":"supports"}]' }) };
  const out = await judgeWithModel(provider, 'claim', ev);
  assert.deepEqual(out.map((x) => [x.source, x.stance]), [['a', 'differs'], ['b', 'mentions']]);
  assert.ok(sent.includes('["one   (nasa.gov) confirmed","two"]'));
  // a reply that doesn't cover every quote: the word matching stands
  await assert.rejects(judgeWithModel({ chat: async () => ({ text: '[{"n":1,"stance":"differs"}]' }) }, 'claim', ev));
});

test('false claims the review found are never backed', () => {
  const never = [
    ['France is the capital of Paris', 'Paris is the capital of France and its largest city.'],
    ['The Pacific Ocean is the smallest ocean', 'The Arctic Ocean is the smallest ocean, while the Pacific Ocean is the largest.'],
    ['Antarctica is the hottest continent', 'Antarctica is the coldest continent, and Africa is the hottest continent.'],
    ['Lisbon is the capital of Spain', 'Madrid is the capital of Spain, and Lisbon is the capital of Portugal.'],
    ['The Eiffel Tower is 300 metres tall', 'The Eiffel Tower is not 300 metres tall as is often said, it is 330 metres.'],
    ['The human body has 206 muscles', 'The adult human body has 206 bones and more than 600 muscles.'],
    ['Bitcoin is worth 10 dollars', 'Bitcoin was worth 10 dollars in 2011 and over 100,000 dollars in 2025.'],
    ['Water boils at 70 °C at sea level', 'At sea level water boils at 100 °C, while at the summit of Everest it boils at 70 °C.'],
    ['The Eiffel Tower is more than 340 metres tall', 'The Eiffel Tower is 330 metres tall, including antennas.'],
    ['Germany invaded Poland in 1941', 'Germany invaded Poland in 1939 and the Soviet Union in 1941.'],
    ['Microsoft acquired GitHub in 2016', 'Microsoft acquired LinkedIn in 2016 and GitHub in 2018.'],
    ['The Titanic sank in 1915', 'The Lusitania sank in 1915; the Titanic sank in 1912.'],
    ['World War II ended in 1918', 'The First World War ended in 1918, and World War II ended in 1945.'],
    ['Python was created by James Gosling', 'Java was created by James Gosling at Sun Microsystems, while Python was created by Guido van Rossum.'],
    ['Humans use only 10 percent of their brains', 'The notion that humans use only 10 percent of their brains has been around for a century.'],
    ['Humans use only 10 percent of their brains', 'The ten-percent-of-the-brain myth states that humans use only 10 percent of their brains.'],
    ['Pluto is a planet', 'Pluto is a dwarf planet in the Kuiper belt, a ring of bodies beyond Neptune.'],
    ['Venus is the closest planet to the Sun', 'Venus is the second planet from the Sun and the closest planet to Earth.'],
    ['Shakespeare wrote Don Quixote', 'Shakespeare wrote Hamlet around the time Cervantes wrote Don Quixote.'],
    ['The iPhone was released in 2010', 'The first iPhone was released in 2007, and the iPhone 4 was released in 2010.'],
    ['Sydney is the capital of Australia', 'Sydney is the capital of New South Wales and the largest city in Australia.'],
    ['The Statue of Liberty is 150 meters tall', 'The Statue of Liberty has a figure height of 151’ (46.02 m), width of 53’ (16.15 m).'],
    ['Kyoto is the capital of Japan', 'Kyoto became the capital city of Japan in 794 after Nara.'],
  ];
  for (const [c, s] of never) assert.notEqual(stance(c, s), 'supports', `${c} ← ${s}`);
  assert.equal(stance('Humans use only 10 percent of their brains', 'The ten-percent-of-the-brain myth states that humans use only 10 percent of their brains.'), 'differs');
  assert.equal(stance('Lisbon is the capital of Spain', 'Lisbon is the capital and largest city of Portugal.'), 'differs');
  assert.equal(stance('Canberra is not the capital of Australia', 'Canberra is the capital of Australia.'), 'differs');
});

test('true claims still read as backed', () => {
  const backed = [
    ['Paris is the capital of France', 'Paris is the capital and largest city of France.'],
    ['Paris is the capital of France', 'The capital of France is Paris.'],
    ['Tokyo is the capital of Japan', 'Tokyo, Japan’s capital, is located on the Pacific coast of Honshu.'],
    ['Ottawa is the capital of Canada', 'Ottawa, Ontario is the capital of Canada.'],
    ['The Pacific is the largest ocean on Earth', 'The Pacific Ocean is the largest ocean on Earth, covering about a third of its surface.'],
    ['Saturn is the second largest planet in the Solar System', 'Saturn is the sixth planet from the Sun, and is the second largest planet in the Solar System, after Jupiter.'],
    ['The human body has 206 bones', 'The adult human body has 206 bones and more than 600 muscles.'],
    ['The Eiffel Tower is more than 300 metres tall', 'The Eiffel Tower is 330 metres tall, including antennas.'],
    ['Microsoft acquired GitHub in 2018', 'Microsoft acquired LinkedIn in 2016 and GitHub in 2018.'],
    ['Penicillin was discovered in 1928 by Alexander Fleming', 'In 1928 Alexander Fleming discovered penicillin, though he did not realize its significance.'],
    ['The Mona Lisa was painted by Leonardo da Vinci', 'Mona Lisa is an oil-on-panel masterpiece painted by Leonardo da Vinci between 1503 and 1506.'],
    ['Apple was founded by Steve Jobs, Steve Wozniak and Ronald Wayne', 'Apple was founded on April 1, 1976, by Steve Jobs, Steve Wozniak, and Ronald Wayne, who had worked at Atari.'],
    ['The Titanic sank in 1912', 'The Lusitania sank in 1915; the Titanic sank in 1912.'],
    ['Water boils at 100 °C at sea level', 'At sea level water boils at 100 °C, while at the summit of Everest it boils at 70 °C.'],
  ];
  for (const [c, s] of backed) assert.equal(stance(c, s), 'supports', `${c} ← ${s}`);
});

test('echoes, empty replies and uncited server text never back a claim', () => {
  const c = 'Paris is the capital of Germany';
  const parts = claimParts(c);
  const ev = evidenceFrom(parts, [
    { serverTitle: 'Tanod', view: { kind: 'record', title: '', facts: [{ label: 'query', value: c }, { label: 'count', value: '0' }] } },
    { serverTitle: 'Some Search', text: `No results found for "${c}". Try another query.`, view: { kind: 'text' } },
    { serverTitle: 'Facts DB', text: 'Paris is the capital of Germany according to this record of ours, filed long ago.', view: { kind: 'text' } },
  ]);
  assert.equal(ev.filter((e) => e.stance === 'supports').length, 0);
  assert.equal(sourceKey('kids.britannica.com'), sourceKey('www.britannica.com'));
  assert.equal(sourceKey('news.bbc.co.uk'), 'bbc.co.uk');
});
