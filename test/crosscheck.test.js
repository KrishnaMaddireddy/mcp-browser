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
  assert.deepEqual(out.map((x) => [x.source, x.stance]), [['a', 'mentions'], ['b', 'mentions']]); // (differs only with a rival figure, name or denial in the quote)
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

test('review 2: numbered names, reported speech, wrong clauses and rival names', () => {
  const never = [
    ['Windows 11 was released in 2015', 'Windows 11 was released in October 2021 by Microsoft.'],
    ['The iPhone 15 was released in 2020', 'The iPhone 15 was released in September 2023.'],
    ['Apollo 11 landed on the Moon in 1970', 'Apollo 11 landed on the Moon on July 20, 1969.'],
    ['The F-35 was developed by Boeing', 'The F-35 was developed by Lockheed Martin after it beat Boeing in the competition.'],
    ['The Earth is flat', 'Flat Earth proponents say the Earth is flat.'],
    ['The Moon landing was faked', 'Conspiracy theorists say the Moon landing was faked.'],
    ['Barack Obama was born in Kenya', 'Donald Trump said Barack Obama was born in Kenya.'],
    ['Humans use 10 percent of their brains', 'In the film Lucy, humans use 10 percent of their brains.'],
    ['Lincoln was assassinated in 1863', 'Lincoln delivered the Gettysburg Address in 1863 and was assassinated in 1865.'],
    ['Lincoln was assassinated in 1863', 'Lincoln, who issued the Emancipation Proclamation in 1863, was assassinated in 1865.'],
    ['Henry Ford invented the automobile', 'Henry Ford invented the assembly line for the automobile industry.'],
    ['Galileo invented the telescope', 'Galileo invented the thermoscope and improved the telescope.'],
    ['Mount Everest is 9,000 metres tall', 'Mount Everest is nearly 9,000 metres tall.'],
    ['Humans have 46 chromosome pairs', 'Humans have 46 chromosomes, arranged in 23 pairs.'],
    ['Shakespeare wrote Don Quixote', 'Shakespeare may have written a lost play, Cardenio, based on Don Quixote.'],
    ['Einstein was born in Austria', 'Einstein was born in Germany, near the border with Austria.'],
    ['Kyoto is the capital of Japan', 'Kyōto is historically significant as the national capital of Japan from 794 to 1868.'],
    ['Kyoto is the capital of Japan', 'Kyoto, officially Kyoto City, is the capital city of Kyoto Prefecture in Japan.'],
    ['Mars has five moons', 'Mars has two small moons, Phobos and Deimos.'],
  ];
  for (const [c, s] of never) assert.notEqual(stance(c, s), 'supports', `${c} ← ${s}`);
  const backed = [
    ['Windows 11 was released in 2021', 'Windows 11 was released in October 2021 by Microsoft.'],
    ['Lincoln was assassinated in 1865', 'Lincoln was assassinated by John Wilkes Booth at Ford’s Theatre in 1865.'],
    ['The Earth orbits the Sun', 'Earth orbits the Sun once a year.'],
    ['Brasilia is the capital of Brazil', 'Brasília is the capital of Brazil and the seat of the federal government.'],
    ['Mars has two moons', 'Mars has two small moons, Phobos and Deimos.'],
    ['Einstein was born in Germany', 'Albert Einstein was born in Ulm, Germany, in 1879.'],
    ['Water boils at 100 degrees Celsius at sea level', 'At sea level, water boils at 212 degrees Fahrenheit (212°F) or 100 degrees Celsius.'],
    ['The speed of sound in air is about 343 meters per second', 'The speed of sound in air is approximately 331.5 m/s at 0 °C or around 1200 km per hour.'],
  ];
  for (const [c, s] of backed) assert.equal(stance(c, s), 'supports', `${c} ← ${s}`);
  // a name elsewhere in the sentence isn't someone else's claim
  for (const s of ['The Eiffel Tower was completed in 1889 for the World Fair in Paris.', 'Neil Armstrong and Buzz Aldrin became the first men to walk on the Moon.']) assert.notEqual(stance(s.includes('Eiffel') ? 'Paris is the capital of France' : 'Neil Armstrong was the first person to walk on the Moon', s), 'differs', s);
  assert.deepEqual(figuresOf('Windows 11, COVID-19, 5G, the S&P 500 and 14:00').length, 0);
});

test('beliefs and depictions are mentions; any n’t is a denial', () => {
  for (const s of ['Flat Earth belief denotes the assertion that the Earth is a flat, stationary plane.', 'Ancient Babylonian cosmology seems to present Earth as a flat object with four corners.']) assert.notEqual(stance('The Earth is flat', s), 'supports', s);
  assert.equal(stance('Vaccines do not cause autism', 'The research is clear: vaccines don’t cause autism in children at all.'), 'supports');
  assert.notEqual(stance('Vaccines do not cause autism', 'Studies have not ruled out the possibility that infant vaccines cause autism, the agency said.'), 'supports');
});

test('near a border, since a year, conceived of: none of them says it', () => {
  assert.notEqual(stance('Mount Kilimanjaro is in Kenya', 'Mount Kilimanjaro is located in northern Tanzania, East Africa, near the border with Kenya.'), 'supports');
  assert.equal(stance('Mount Kilimanjaro is in Tanzania', 'Mount Kilimanjaro is located in northern Tanzania, near the border with Kenya.'), 'supports');
  assert.notEqual(stance('Windows 11 was released in 2015', 'Windows 11, the first major Windows release since 2015, arrived for PCs.'), 'supports');
  assert.notEqual(stance('The Earth is flat', 'Ancient cultures in China, India and the Americas also conceived of Earth as flat.'), 'supports');
});

test('the capital of a state is not the capital of its country; "no animal has five"', () => {
  assert.equal(stance('Melbourne is the capital of Australia', 'Melbourne, the capital of Victoria, Australia, is known for its rich culture.'), 'differs');
  assert.equal(stance('Canberra is the capital of Australia', 'Canberra, the capital of Australia, is a planned city.'), 'supports');
  assert.notEqual(stance('An octopus has five hearts', 'In reality, no animal has five hearts, but some have multiple circulatory systems.'), 'supports');
});

test('fakes, the tighter of two runs, dates before the verb, a described doer', () => {
  assert.notEqual(stance('Mount Fuji is in China', 'The faux Mount Fuji, dubbed the Universe Fantasy Land, is situated in the Hebei province of northern China.'), 'supports');
  assert.equal(stance('The Sahara is the largest hot desert in the world', 'The Sahara is the third largest desert and the largest hot desert in the world.'), 'supports');
  assert.equal(stance('Amazon was founded by Jeff Bezos', 'On July 5, 1994, Amazon was officially founded under the name Cadabra by young Princeton graduate Jeff Bezos in his garage.'), 'supports');
  assert.equal(stance('Tesla was founded by Elon Musk', 'Tesla was founded in 2003 by Martin Eberhard and Marc Tarpenning; Elon Musk joined as chairman in 2004.'), 'differs');
});

test('what a figure counts: the next word, a whole name, no compounds or conditionals', () => {
  assert.notEqual(stance('Marie Curie won four Nobel Prizes', 'All four Curies earned Nobel prizes for their work.'), 'supports');
  assert.notEqual(stance('The human heart has six chambers', 'Two cases of six-chambered hearts were reported in the journal last year.'), 'supports');
  assert.notEqual(stance('A spider has six legs', 'If a creature has six legs, it is classified as an insect rather than a spider.'), 'supports');
  assert.equal(stance('A spider has eight legs', 'Spiders normally have eight walking legs, arranged as four pairs.'), 'supports');
  assert.equal(stance('The human heart has four chambers', 'The human heart has four chambers: two atria and two ventricles.'), 'supports');
});

test('places keep their preposition; a unit conversion is the same amount; "Nepal-China" is no label', () => {
  assert.notEqual(stance('The Beatles were from Manchester', 'But the Beatles were regular visitors to Manchester too, and this week marks the anniversary.'), 'supports');
  assert.equal(stance('The Colosseum is in Rome', 'The Colosseum is an elliptical amphitheatre in the centre of the city of Rome, Italy.'), 'supports');
  assert.equal(stance('A year on Mars lasts about 687 Earth days', 'A Martian year lasts about 687 Earth days, or roughly 1.88 Earth years.'), 'supports');
  assert.notEqual(stance('Mount Everest is in Nepal', 'Mount Everest sits on the Nepal-China border, with its southern slope in Nepal and its northern slope in Tibet.'), 'differs');
});

test('particular cases, possessive places and question-page titles do not back a claim', () => {
  assert.notEqual(stance('A spider has six legs', 'The one spider who has stuck around the longest only has six legs, four on one side.'), 'supports');
  assert.notEqual(stance('Barcelona is the capital of Spain', "Barcelona is the capital of Spain's stateless nation of Catalunya, where the locals speak a different language."), 'supports');
  assert.notEqual(stance('Mercury is the hottest planet in the Solar System', 'Flexi answers - Mercury is the hottest planet in our solar system.'), 'supports');
  assert.equal(stance('A spider has eight legs', 'Every spider has exactly 8 legs, arranged in 4 pairs.'), 'supports');
});
