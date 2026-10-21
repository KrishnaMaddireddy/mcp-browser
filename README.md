# MCP Browser

An AI search browser that answers questions by routing them to the right
**MCP servers** — picked from a curated set plus the 27,000+ keyless servers in
the official MCP Registry — instead of a single search index.

```
 your question
      │
      ▼
  ┌────────┐  BM25 over titles, tags,      ┌───────────────┐
  │ Router │──descriptions & live tools───▶│ 2–4 servers   │  e.g. Exa web search,
  └────────┘                               │ (lazy pool)   │  Context7, PubMed …
      │                                    └──────┬────────┘
      ▼                                           │ read-only tools only
  ┌──────────────┐  tool calls (parallel)  ┌──────▼────────┐
  │ AI model     │◀───────────────────────▶│ MCP tools     │
  │ (optional)   │  results = untrusted    └───────────────┘
  └──────┬───────┘
         ▼
  streamed answer with [n] citations + sources + activity trace
```

## Quick start

Requires Node.js 20.10+.

```bash
npm install
npm start            # → http://127.0.0.1:7777
```

On first run it downloads the MCP Registry in the background (2–3 minutes).
The 19 curated public servers (four web search engines, docs, papers, encyclopedia, US and worldwide weather, flights, stock market data) work immediately.

### Desktop app (real browser tabs)

```bash
npm run desktop      # Electron: answers + normal web pages in tabs
```

### A real Mac app

On your Mac, in this folder:

```bash
npm install
npm run dist:mac        # → dist/MCP Browser-0.2.0-arm64.dmg
```

Open the `.dmg` and drag **MCP Browser** to Applications. The build isn't signed
with an Apple Developer ID, so the first time, right-click the app → **Open**.
The Mac build is for Apple silicon (M1 and later); on an Intel Mac, run from
source with `npm run desktop` (meaning-based routing isn't available there, so
routing uses keywords). `npm run dist` builds for whatever system you're on.

The app's first-run card shows the exact Claude Desktop / Claude Code setup for
wherever it's installed (from source it runs `node bin/mcp-server.js`; the
packaged app runs itself in Node mode with `ELECTRON_RUN_AS_NODE=1`).

### Terminal

```bash
node bin/cli.js "What is the max timeout for AWS Lambda?"
node bin/cli.js --free "solid-state battery research"   # no AI model
node bin/cli.js --use exa,deepwiki "how does vLLM schedule requests"
node bin/cli.js --servers weather                        # which servers match
node bin/cli.js --sync                                   # update registry
```

If `npm install` fails on the optional embedding runtime, run
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install` (skips the GPU download).

## Dev mode (auto-restart)

```bash
npm run dev            # server at http://localhost:7777, restarts on code changes
npm run desktop:dev    # desktop app that relaunches on code changes
```

In both, open pages reload themselves when the UI files change.

## Use your Claude subscription (MCP server mode)

Anthropic doesn't allow third-party apps to sign in with a Claude.ai account or
spend Pro/Max subscription usage. So instead of putting Claude inside this app,
put this app inside Claude: MCP Browser also runs as an MCP server, and the
Claude app you're signed in to does the thinking.

**Claude Code**

```bash
claude mcp add mcp-browser -- node /full/path/to/mcp-browser/bin/mcp-server.js
```

**Claude Desktop** → Settings → Developer → Edit config, then add:

```json
{
  "mcpServers": {
    "mcp-browser": { "command": "node", "args": ["/full/path/to/mcp-browser/bin/mcp-server.js"] }
  }
}
```

Claude then gets four read-only tools:

| Tool | What it does |
|---|---|
| `route` | picks the best servers for a question, connects, lists their tools |
| `call_tool` | calls one read-only tool (results wrapped as untrusted, with sources) |
| `quick_search` | one-shot search across the routed servers |
| `find_servers` | searches the curated list + registry by topic |

All the browser's rules still apply: write tools hidden, paywalls and rate limits
detected, registry servers only when Discovery is on, keys from the servers page.

## Two modes

| | Free mode (default) | AI mode |
|---|---|---|
| Needs | nothing | an API key, or a local model |
| What you get | a quick answer (one quoted sentence + source) and a readable digest per server | one written answer, citations, follow-ups |
| Server tools used | tools that take a query, a place or a name | any read-only tool (the model fills arguments) |

**Free mode, in detail.** Each server's reply is turned into readable items (title,
link, site, date, short summary, key facts), a table, or a fact list; the raw reply
is one click away. Replies that are empty (no results, or just the question echoed
back) or are a sales pitch (price list + checkout, pay-per-query offers) fold into
one line each, and results are ordered by how well they answer the question. For
factual questions a **quick answer** quotes the one sentence that answers it, with
its source; nothing is generated, so nothing is made up. When a tool returns nothing
for the whole sentence, it's asked again with keywords, then just the place or name
("weather Seattle", then "Seattle"). Each server is asked the moment it connects, so
the first results usually show in under a second, and a page budget (9 s by default,
`freeModeBudgetMs`) keeps one slow server from holding the page.

* **On-topic first.** A reply that never mentions the question's topic (a stock-research
  server answering a battery question) folds into one line, "N servers replied about
  something else", and counts against that server in routing. Generic words ("latest",
  "research", "best") and time words ("this weekend") don't count as a match, and a
  reply that only echoes the question back doesn't either.
* **Lists read in the right order.** Items about the question come first; for "latest" or
  "recent" questions, newest first; for "this weekend", "tomorrow" or a named day, the
  matching days first.
* **Two-step lookups.** When a server's only free-text tool is a place lookup (geocode)
  and it has a tool that takes coordinates and fits the question (a forecast), the
  coordinates are passed on and that reply is shown instead.
* **Structured answers rank high.** A specialist's forecast, quote or table outranks web
  pages about the same thing. Weather questions get the asked days as the quick answer.
* **Quick answers are careful.** The quoted sentence must name what was asked about and
  state a value (not just years or dates). Price and rate answers are shown only when a
  second site agrees within 15%; all-time highs, ranges, targets and crypto "tokenized"
  copies of a stock don't count as the price. Opinions and roundups ("what people say",
  "best …") get results, not one quote. Unit conversions ("convert 5 miles to km",
  "72 F to C") are calculated exactly, before any server answers.
* **"Search wider" really widens**: lower relevance bars, up to 20 servers and 15 s,
  and no early stop.
* **Faster when it can be.** Once three useful results are in and 4 s have passed,
  servers still working are let go, so pages (and Claude's `quick_search`) finish sooner.
  If a web engine errors or comes back empty, one other web engine is asked right away.
* **Stock quotes from the source.** "Nvidia stock price" (or "AAPL share price") asks a
  market-data server's quote tool for the ticker and leads with its price, daily change
  and extended-hours price, named as that server's data.
* **Weather anywhere.** Weather questions go to a weather tool with the place taken from
  the question, in any language ("ベルリンの天気" → Berlin, "clima en Ciudad de México" →
  Mexico City). The answer names the place it used; a US-only forecast for a same-named
  town (Paris, TX for "Paris weather") is folded away, never quoted.
* **Currency and docs recipes.** A question naming two currencies ("USD to JPY",
  "convert 100 dollars to yen") fills exchange-rate tools' base/quote (and amount) and
  leads with the specialist's rate. Docs servers that resolve a name to an ID first
  (Context7: `resolve-library-id` → `query-docs`) are called in that order with the
  library named in the question. Context7 works without a key until its anonymous
  monthly limit; add a free key with **Use own key** on the servers page (the
  `CONTEXT7_API_KEY` header is pre-filled).
* **Ticker tools get tickers.** A tool that only takes a stock symbol is asked with the
  ticker or company named in the question ("NVDA", "Nvidia"), and skipped otherwise.
* **Money, health and legal questions** carry a one-line reminder that results are
  third-party sources, not advice.

Turn on AI mode in **Settings** (gear icon) or with environment variables:

* **Claude** – provider *Anthropic*, paste a key (or set `ANTHROPIC_API_KEY`). Default model `claude-sonnet-5-5`.
* **OpenAI / Groq / OpenRouter / Together** – provider *OpenAI-compatible*, key + base URL.
* **Fully free and local** – run [Ollama](https://ollama.com), then provider *OpenAI-compatible*,
  base URL `http://localhost:11434/v1`, model e.g. `qwen3:8b` (pick one with tool calling). No key needed.

Settings and the key are stored only in `~/.mcp-browser/settings.json` (mode 600).

## Templates

The new-tab page has ready-made research prompts with fill-in fields. They also
appear in Claude Desktop / Claude Code as prompts (slash commands) in MCP server mode.

| Template | What it finds |
|---|---|
| Competitor ad scan | where a competitor advertises, messages, offers, landing pages |
| SEO content brief | who ranks, what people ask, related keywords, outline, gaps |
| Social listening | Reddit / HN / Bluesky / X sentiment and themes, with links |
| AI visibility check | whether your brand is recommended when people ask AI |
| Positioning comparison | taglines, pricing, audiences, launches in a table |
| Review mining | praise and complaints in customers' own words |
| Campaign angles | what's working now for similar products → 5 angles |

Marketing templates switch on Discovery for that one search, so community servers
(ad libraries, social, SEO tools) can be used. Add your own in `src/templates.js`.

## Watches

Press **Watch** next to any question to re-run it every hour, day or week while
MCP Browser is open. The first run saves a baseline; later runs flag new sources
and answers that changed (by wording), and the eye icon in the toolbar shows a
dot when something is new. Manage them at `mcp://watches`. Watches are stored in
`~/.mcp-browser/watches.json`.

## MCP Rank

Directories score MCP servers on their metadata. MCP Rank scores them on what
they actually do. Open the bar-chart icon (or `mcp://rank`), pick a category,
and press **Run tests**, or from a terminal:

```bash
node bin/cli.js --rank web-search      # also: encyclopedia, papers, dev-docs, geography, money, travel
```

Each candidate server (picked by meaning from the curated list + registry) is
asked questions with known answers. The 0–100 score weighs:

| | Weight |
|---|---|
| Accuracy on known-answer questions | 55 |
| Free (no paywall / key demand / rate limit at call time) | 12 |
| Clean (no ads or instructions injected into results) | 12 |
| Speed (median response) | 8 |
| Safety (share of read-only tools) | 6 |
| Metadata (tool & parameter docs, safety annotations) | 7 |

Each run asks one of several phrasings per question, so single runs are noisy;
rankings use the average of each server's last 5 runs (`avg` in the CLI, the score
ring in the app; hover it for the last run).

Every server gets a report card explaining its score: the "SEO for MCP" view
for server authors. Scores also nudge routing (0.7× for 0 … 1.3× for 100).
The full method, question sets and weights are in [docs/MCP-RANK.md](docs/MCP-RANK.md)
(regenerate with `--rank-method`). `node bin/cli.js --rank-export labels.json` or
`GET /api/rank/labels` gives one JSON "label" per server (free?, injects text?,
write tools, accuracy and speed per category, dated) for other tools to consume;
the last run's labels are in `docs/mcp-rank-labels.json`. In Claude, `route` and
`find_servers` show each server's MCP Rank score.

**Use MCP Rank from any MCP client.** While the app runs, it also serves the
official MCP Registry API (`GET /v0.1/servers`, `/v0.1/servers/{name}/versions/latest`)
as a *subregistry*: the same server entries, with MCP Rank results added under
`_meta["local.mcp-browser/rank"]` as the registry spec recommends. Extensions:
`ranked_only=true` and `sort=rank`. `--subregistry-export ranked.json` writes the
ranked servers to one file you can publish (servers you added yourself are left out);
the last export is in `docs/mcp-rank-subregistry.json`.

With an AI model set, servers whose tools need structured arguments (an id
from one tool, then a query with it, as in Context7) are tested too: the model
fills the arguments, but only what the **server returned** is graded, so the
model's own knowledge can't lift a bad server. Without a model those servers get
a neutral accuracy prior (`--ai-all` uses the model for every server, `--no-ai`
never). Because the questions are public, a response that also contains the answers to
other questions, or the same response to different questions, doesn't count, and
a question the AI model answered by typing the answer into the arguments is left
out. A run uses at most 120 model requests and stops using the model after 3 model
errors (those are never held against a server). A few questions per category is
a small sample; add categories in `src/rank.js`.

## GitHub stars

Every server that links a GitHub repo shows its stars (★ 5.1k) on the servers
page and in MCP Rank, with flags for **archived**, **stale** (no commits for a
year), **repo gone** (GitHub confirms it's deleted or private: needs a refresh with a token; the open-data snapshot only says "unknown") and **other owner** (an
`io.github.<user>` server linking a repo owned by a different account; often a
company org, sometimes borrowed popularity). A `*` means one repo is shared by
several servers (monorepos). Sort the servers page by **Most GitHub stars**.

Stars are shown, never scored: they don't change MCP Rank or routing. Among the
servers MCP Rank has tested, stars barely predict the score (see docs/RESEARCH.md).

* A snapshot for all ~12,600 linked repos ships with the app (`src/data/github-stars.json`,
  from ecosyste.ms open data).
* **Refresh stars** in Settings: with a GitHub token (a fine-grained one with no
  permissions is enough) every repo is refreshed straight from GitHub in about
  250 GraphQL queries; without one, 1,000 repos per refresh from ecosyste.ms.
* CLI: `mcpb --stars` refreshes; `mcpb --top-stars [topic]` lists the most-starred
  servers (one row per repo) with their MCP Rank score.
* The labels export and the subregistry API carry stars too
  (`_meta["local.mcp-browser/github"]`).

## Routing

Each question is matched against every server by **keywords** (BM25 over titles,
descriptions, tags and live tool lists) and, when available, by **meaning**: a
small local embedding model (all-MiniLM-L6-v2, ~23 MB, CPU) so "should I bring an
umbrella?" finds weather servers. It downloads on first start and indexes the
registry in the background (a minute or two); vectors are cached in
`~/.mcp-browser/embeddings.bin`. If the optional `@huggingface/transformers`
package didn't install, routing simply stays keyword-only. Turn it off in Settings.

Then the shortlist is cleaned up:

* **Measured quality first**: MCP Rank scores and what each server's replies turned
  out to be on this machine (useful / empty / off-topic / sales pitch) raise or lower it.
* **One publisher can't fill the list**: at most 2 servers per publisher per question,
  1 for "farms" with 300+ near-identical registry servers.
* **Vetted servers are compared with each other**, so a crowd of similarly named
  registry servers can't push a curated one out.
* **Known-dead servers are skipped**: `src/data/reachability.json` records which
  registry servers answered an anonymous connect when probed (about half need a
  sign-in despite declaring none). Live health on your machine always overrides it;
  refresh it with `node scripts/probe-registry.js`. A second pass,
  `node scripts/probe-direct.js`, marks answering servers whose tools all need an AI
  model to fill; free mode ranks those lower so first questions aren't spent on them.
* **Free mode skips servers whose tools all need an AI model** (learned on first contact).
* **Time phrases and short numbers are ignored for matching** ("next week" doesn't
  mean Next.js; the "14" in "Next.js 14" doesn't pick a server).
* **Per-question memory**: a server that answered this very question (in any word order)
  with nothing or off-topic in the last day is asked last; off-topic replies also count
  against a server in general.

## Servers

Open the **servers** page (network icon, or type `mcp://servers`):

* **Curated** (on by default): Exa and Keenable web search, DeepWiki, Context7, Microsoft Learn,
  AWS Knowledge, Cloudflare Docs, Hugging Face, Kiwi.com flights, GitMCP, Svelte,
  plus community Wikipedia/Wikidata, research papers (arXiv, PubMed, Crossref, OpenAlex — the #1 papers server in MCP Rank), PubMed and US weather.
* **Registry**: every remote, HTTPS server in the official registry that doesn't
  declare a required key. Switch on **Discovery** to let up to 2 of them join each
  question, or switch individual servers on.
* **Add a server by URL** — your company's own MCP server, or one running on
  this computer (`http://localhost:…` is allowed only for servers you add).
  Give it a short "what it's for" so routing picks it for the right questions.
* **Check** connects to a server and lists its tools; results are remembered.
* **Add key** — about 2,800 registry servers need an API key. Paste it (as the
  header the server asks for, or a full URL containing it) and the server turns on.
  The same works for curated servers, e.g. your own Exa key to lift its free rate limit:
  URL `https://mcp.exa.ai/mcp?exaApiKey=YOUR_KEY`.
* **Sign in** — servers that use OAuth (Linear, Notion, Atlassian and many more)
  answer `401`; the row then says *Needs sign-in*. Press **Sign in**, approve in
  your browser, and you're sent back to the app. Add the server by URL first if it
  isn't listed (e.g. `https://mcp.linear.app/mcp`). The app registers itself with
  the server only when you press the button, uses PKCE, refreshes tokens quietly,
  and keeps them in `~/.mcp-browser/oauth.json` (mode 600). **Sign out** forgets them.
  Signing in in the app also works for MCP server mode (same data folder).
* **Your apps** — 8 sign-in servers are listed and switched off until you sign in:
  Notion, Linear, Atlassian (Jira & Confluence), Asana, Sentry, Granola, Intercom
  and monday.com. All 8 were checked to answer 401 and to support dynamic client
  registration. Then questions like "what did we decide about pricing" or "my open
  Linear bugs" can draw on them. Write tools stay hidden, MCP Rank never tests
  them, and their results go to your AI provider like any other source. (GitHub,
  HubSpot and Box use OAuth without dynamic registration, so they aren't supported yet.)

With **Discovery** on and an AI model set, the model also gets a
`find_more_servers` tool: when none of the connected tools fit, it searches the
registry, connects up to two more servers, and uses their tools on its next turn.

See [docs/RESEARCH.md](docs/RESEARCH.md) for what we measured (most "keyless"
registry servers still need OAuth, block bots, or charge per call) and
[docs/LANDSCAPE.md](docs/LANDSCAPE.md) for how this compares with MCP gateways,
quality directories and AI browsers.

## Safety model

Every MCP server is a stranger. The browser assumes so:

* **Read-only.** Tools that look like writes (create, send, order, book, pay,
  delete, merge, register…, including combos like `get_and_delete`) or are
  marked destructive are never shown to the model. Tools whose description *or
  parameter docs* contain instructions to the model are hidden too.
* **Untrusted results.** Tool output is stripped of invisible/bidi characters,
  size-capped, wrapped in `<untrusted_tool_result>` and checked for injection
  phrases ("ignore previous instructions", "note for your user"…). Flagged
  results are marked in the activity trace. Tools whose *descriptions* contain
  instructions to the model are hidden.
* **Paywalls and rate limits.** x402 "payment required", "API key required" and
  "rate limit" results are treated as failures; the server is backed off (24h for
  paywalls, 10 min for rate limits) and the second web search engine takes over.
* **No LAN access.** Registry servers must be HTTPS and resolve to public IPs.
  The address is checked again at connect time (closes DNS rebinding), and
  redirects to a different site are refused, so a saved key never follows a
  redirect elsewhere. (Behind an HTTP proxy, only the pre-check applies.)
* **Local API lock-down.** The server binds to 127.0.0.1, checks the `Host`
  header (DNS rebinding), and requires a custom header + JSON + same-origin
  for every write. The UI ships with a strict CSP and renders Markdown
  without raw HTML.
* **Electron.** Context isolation, sandbox, no Node in pages; `<webview>` tags
  are forced to the same. Pages can't launch OS protocol handlers (only
  `mailto:`/`tel:` open externally) and never get camera, mic, location or
  notification permissions.

Remaining risk: a model can still be misled by false *facts* in a result. Treat
community-server answers (dashed outline in the switchboard) with care.

## Project layout

```
src/
  server.js     HTTP API + SSE + static UI         app.js    wires the engine
  mcp-server.js MCP server mode (for Claude apps)   embeddings.js meaning-based routing
  rank.js       MCP Rank (accuracy testing)         templates.js research templates
  watches.js    scheduled saved searches          subregistry.js registry-format API with rank metadata
  agent.js      route → connect → tool loop        catalog.js  routing (BM25)
  pool.js       MCP connection pool                registry.js registry mirror
  oauth.js      OAuth sign-in (PKCE, token store)  github.js   GitHub stars
  policy.js     tool/result safety                 netguard.js SSRF guard
  health.js     reachability + back-off            sources.js  citation links
  curated.js    starter servers                    llm/        Anthropic + OpenAI-compatible
public/         browser UI (no build step)
electron/       desktop shell
bin/cli.js      terminal client
bin/mcp-server.js  stdio MCP server
test/           node:test suites with local mock MCP servers
```

## Quality runs

`node scripts/e2e.js out.json [default|mid|wide]` asks 40 real questions (markets,
weather, travel, papers, health, developer docs, facts, sports, shopping, marketing,
three languages) through the HTTP API and records, per question, how many servers
were asked, how many replies were useful / empty / sales pitches / failures, sources
found, whether a quick answer was given, and timings (whole page and first useful
result). `MCPB_QUESTIONS=scripts/e2e-questions-holdout.json node scripts/e2e.js …` runs a second,
held-out set of 40 different questions, to check that improvements aren't tuned to the
first set. `node scripts/e2e-mcp.js out.json` asks the same questions through
`quick_search` the way Claude does and records whether each reply carries on-topic
results with a citable sources list. `node scripts/try-mcp.js "question"` shows one
such reply in full (`FULL=1` for all of it).

## Tests

```bash
npm test                 # 190 tests, offline: mock MCP servers + mock LLM + fake APIs
npm run test:live        # also hits the real curated servers
```

## API (local)

| Method | Path | |
|---|---|---|
| POST | `/api/search` | `{query, history?, servers?}` → `text/event-stream` (`route`, `server`, `step`, `tool_call`, `tool_result`, `text`, `results`, `sources`, `answer`, `done`, `error`) |
| GET | `/api/status` | provider, registry, health |
| GET/POST | `/api/settings` | |
| GET | `/api/servers?q=&source=&limit=&offset=` | |
| POST | `/api/servers/toggle` · `/api/servers/probe` · `/api/registry/sync` | |
| GET | `/api/route?q=` | which servers a question would use |
| GET | `/api/templates` · `/api/rank` · `/api/rank/labels` | templates; rankings + run state; per-server labels |
| GET | `/v0.1/servers` · `/v0.1/servers/{name}/versions[/{v}]` | MCP Registry–compatible subregistry with rank metadata |
| POST | `/api/rank/run` | `{category, limit?}` start a ranking run |
| GET/POST | `/api/watches` · `/api/watches/update` · `/run` · `/delete` | saved searches |
| POST | `/api/servers/custom` · `/api/servers/custom/delete` | `{url, title?, description?}` add your own server |
| POST | `/api/servers/auth` | `{id, header?, value?, url?, clear?}` save a server key |
| POST | `/api/servers/oauth/start` · `/api/servers/oauth/signout` | `{id}` → `{url}` to open for sign-in; forget tokens |
| GET | `/oauth/callback` | where the sign-in page sends the browser back |
| POST | `/api/stars/refresh` | refresh GitHub stars in the background (`/api/status` → `stars` shows progress) |
| GET | `/api/servers?sort=stars` | most-starred first; every server row has `github: {repo, stars, pushedAt, archived, sharedWith, otherOwner}` |

POST requests need `content-type: application/json` and `x-mcpb: 1`.

## Not done yet

* OAuth: tested against a spec-following mock server and checked that real servers
  (Linear, Notion) are detected as needing sign-in; a full live sign-in hasn't been
  run against a real provider yet. Servers that don't support dynamic client
  registration can't be signed in to yet.
* Running package-only servers locally (needs sandboxing).
* An LLM re-rank of the routing shortlist (keywords + local embeddings + MCP Rank today).
