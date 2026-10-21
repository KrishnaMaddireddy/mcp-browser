# MCP Rank methodology

Version 2026-10-20.5. Generated from `src/rank.js`, so it always matches the code.

## What is measured

Each candidate server is connected anonymously and asked questions with known answers. A question passes when every expected pattern appears in what the **server returned** (an AI model's own words never count). Calls run with a 20 s timeout.

| Part | Weight | How |
|---|---|---|
| Accuracy | 55 | share of known-answer questions passed; servers that can't be tested get 0.35 |
| Free | 12 | 0 if a call demands payment (x402) or a key, half if a free rate limit runs out |
| Clean | 12 | 0 if results contain text aimed at the AI (ads, instructions) |
| Speed | 8 | median response: full marks ≤ 1 s, none ≥ 10 s |
| Safety | 6 | share of tools that are read-only (write/action tools are hidden from agents) |
| Metadata | 7 | tool descriptions, parameter docs and readOnly/destructive annotations |

## Candidates

Rankings use the average of each server's last 5 runs in a category (each run asks one phrasing per question, so a single run is noisy).

Up to 20 per category from the curated list and the official MCP Registry, chosen by meaning (local embeddings) with keyword matching as a fallback. Servers that declare a required key are skipped unless you added one.

## Testing tools that need structured arguments

If no tool takes a plain question, and an AI model is configured, the model gets only that server's read-only tools (up to 3 rounds) to look up the answer. Grading uses only non-error tool output, with everything the model typed into the arguments removed first. If the model typed the answer itself, or called no tool, or failed, that question is left out rather than counted against the server. A run uses at most 120 model requests and stops using the model after 3 model errors.

## Anti-gaming

The questions are public, so a response that also contains the answers to two or more other questions, or the same response to different questions, does not count. Each question has several phrasings and one is picked per run, so memorising exact strings does not work; a hosted leaderboard should still rotate private question sets.

## Question sets

### Web search (`web-search`)

Candidate topic: web search engine search the internet news

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| What is the capital city of Australia? / capital of Australia / Which city is the seat of the Australian government? | `canberra` |
| Who wrote the novel Pride and Prejudice? / Pride and Prejudice author / novelist who wrote Pride and Prejudice | `austen` |
| What is the tallest mountain in Africa? / highest peak in Africa / tallest African mountain | `kilimanjaro` |
| What is the chemical symbol for gold? / gold element symbol periodic table / chemical symbol of gold | `\bAu\b` |
| Official website of the Model Context Protocol registry / MCP registry official site / where is the official MCP server registry | `registry\.modelcontextprotocol\.io\|modelcontextprotocol\.io\/registry` |

### Encyclopedia & facts (`encyclopedia`)

Candidate topic: wikipedia encyclopedia wikidata knowledge facts

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| Ada Lovelace / Ada Lovelace biography / Augusta Ada King, Countess of Lovelace | `1815` |
| Eiffel Tower / Eiffel Tower history / Tour Eiffel | `paris` and `188[79]` |
| Python programming language / Python (programming language) / history of the Python language | `guido\|van rossum` |
| Mount Everest / Everest height / Mount Everest elevation | `8,?8[0-9]{2}` |

### Research papers (`papers`)

Candidate topic: arxiv research papers scientific academic pubmed literature

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| Attention Is All You Need / Attention Is All You Need transformer paper / the 2017 paper that introduced the Transformer architecture | `1706\.03762\|vaswani` |
| BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding / BERT pre-training deep bidirectional transformers / BERT language understanding paper | `1810\.04805\|devlin` |
| Deep Residual Learning for Image Recognition / ResNet deep residual learning paper / deep residual learning image recognition | `1512\.03385\|kaiming` |

### Web dev docs (`dev-docs`)

Candidate topic: JavaScript and web development documentation: React, MDN web APIs, Node.js, code examples

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| React useEffect cleanup function / how to clean up a React useEffect / React effect cleanup when a component unmounts | `useEffect` and `return` |
| cancel a fetch request with AbortController in JavaScript / abort a fetch call JavaScript / AbortController fetch example | `AbortController` and `abort\(\)\|signal` |
| Python list comprehension syntax / python list comprehension example / how to write a list comprehension in Python | `\[[^\]]+ for [^\]]+ in [^\]]+\]` |

### Countries & places (`geography`)

Candidate topic: countries, capitals, geography, country information, places and maps

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| What is the capital of Kenya? / Kenya capital city / capital city of Kenya | `nairobi` |
| Which country is the city of Kyoto in? / Kyoto country / Where is Kyoto located? | `japan` |
| What currency does Switzerland use? / Switzerland currency / official currency of Switzerland | `\bfrancs?\b\|\bCHF\b` |
| What is the capital of Peru? / Peru capital city / capital city of Peru | `\blima\b` |

### Currencies & markets (`money`)

Candidate topic: currency exchange rates, forex, currency codes, stock tickers, financial market data

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| Which currency has the ISO code JPY? / currency code JPY / what currency is JPY | `\byen\b` |
| Which country uses the currency INR? / INR currency country / what country is the INR currency from | `\bindia\b` |
| Which company trades under the stock ticker AAPL? / ticker AAPL company / AAPL stock company name | `\bapple\b` |
| Which company trades under the stock ticker MSFT? / ticker MSFT company / MSFT stock company name | `\bmicrosoft\b` |

### Flights & airports (`travel`)

Candidate topic: flights, airports, airlines, airport codes, travel booking search

| Question (one phrasing is picked per run) | Must contain |
|---|---|
| IATA airport code for London Heathrow / Heathrow airport code / London Heathrow IATA | `\bLHR\b` |
| Which city is airport code SFO? / SFO airport / airport SFO city | `san francisco` |
| IATA code for Tokyo Haneda airport / Haneda airport code / Tokyo Haneda IATA | `\bHND\b` |

## Known limits

- A few questions per category is a small sample; scores move by tens of points per question.
- Specialist servers are tested against general questions in their category and can score low for being narrow.
- Servers change, rate-limit, or may detect probes; each result is dated.
- About a quarter of registry endpoints need sign-in that the registry doesn't declare; they score 0 here.
