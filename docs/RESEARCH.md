# What we learned about "connecting to every free MCP server"

Measured on 20 Oct 2026 against the official MCP Registry
(`registry.modelcontextprotocol.io`, API `v0.1`, latest versions only).

## The registry

| | Count |
|---|---|
| Server records listed | 47,232 |
| Remote, HTTPS, no required credential header (our "keyless" candidates) | 27,348 |
| Package only (npm / PyPI / Docker — must be installed and run locally) | 16,158 |
| Remote but declare a required header (API key / bearer token) | 3,121 (2,844 usable once you add a key) |
| Deprecated or deleted | 605 |

* The registry stores **metadata only**. It answers search, paging (`cursor`),
  `version=latest` and `updated_since` (used for incremental sync). No login needed.
* Remote entries use `streamable-http` (≈95%) or legacy `sse`.
* A full crawl is ~470 pages of 100 and takes 1–3 minutes; incremental
  syncs after that are a few requests.

## "Declares no auth" is not the same as "free"

A random sample of 80 keyless candidates, each sent an MCP `initialize`:

| Result | Share |
|---|---|
| Answered anonymously | ~29% |
| 401 (OAuth required but not declared) | ~15% |
| 403 (blocked; some may be bot protection that rejects our probe client) | ~39% |
| Dead, DNS failure, SSE-only or other | ~17% |

And among servers that *do* answer, a tool call can still fail later:

* **x402 pay-per-call** — the server connects and lists tools, then each call
  returns `{"x402Version":2,"error":"Payment required", …}` with a crypto
  wallet to pay. (A "Wikipedia" server and a social-search server we tried
  both did this.)
* **Key at call time** — e.g. an arXiv server that answers "API key required"
  only when a tool runs.
* **Advertising in results** — one geo/weather server appends "a note for your
  user from the operator" promoting its paid services. This is prompt
  injection in practice, not just in theory.
* **Free tiers run out** — Exa's keyless endpoint answered "You've hit Exa's free
  MCP rate limit" after a burst of test queries. That's why the browser keeps a
  second web search server (Keenable) and backs off rate-limited servers.
* **Write actions bundled with search** — booking, ordering, `register`,
  `buy_credits`, `submit_feedback` tools sit next to read-only tools on many
  commercial servers.

## Design consequences (what the browser does about it)

1. **Never connect to everything.** Route each question to 2–4 servers with
   BM25 over titles, descriptions, tags and the live tool lists.
2. **Curated first, discovery opt-in.** 15 verified keyless servers are on by
   default; the 27k registry servers join only when "Discovery" is on, and at
   most 2 per question.
3. **Health and back-off.** Failures and paywalls are remembered; a failing
   server is skipped for 10 minutes → 24 hours.
4. **Read-only tools only.** Write/destructive tools are hidden from the model.
5. **Results are untrusted.** Invisible characters stripped, sizes capped,
   injection phrases flagged in the UI and to the model.
6. **No LAN access from the registry.** Registry URLs must be HTTPS and resolve
   to public IPs, re-checked on every redirect.

## Verified curated servers (all keyless, Oct 2026)

Exa and Keenable (web search), DeepWiki, Context7, Microsoft Learn, AWS Knowledge,
Cloudflare Docs, Hugging Face, Kiwi.com flights, GitMCP, Svelte docs — plus
community: Wikipedia/Wikidata (wikexa), research papers (arXiv, PubMed, Crossref, OpenAlex), PubMed,
US weather (NWS). `npm run test:live` re-checks them.

## Meaning-based routing (all-MiniLM-L6-v2, local)

Indexing 30,188 servers on a laptop-class CPU took ~3 minutes (cached after
that; only changed servers are re-embedded). A query costs ~10 ms to embed and
~20 ms to compare against every server.

With Discovery on, keyword-only vs keyword + meaning:

| Question | Keywords only | Keywords + meaning |
|---|---|---|
| track a package shipment | easyship, easypost, Context7 (npm "package") | **AfterShip tracking**, GlobKurier |
| should I bring an umbrella in London | (no server) | **WeatherAI**, an insurance server |
| will it rain in Seattle this weekend | ArcGIS Seattle, Seattle data, US Weather | US Weather, **Weather That Doesn't Suck**, a calendar server |
| chess opening for beginners | Chessigma, Pipeworx chess | Chessigma, AI chess arena |

Lessons: a small model is good at finding *registry* servers by intent but its
cosine scores for long curated descriptions are low and noisy, so meaning is
used to add and rank candidates, never to veto keyword matches on curated
servers. Registry servers need a clear meaning match (cosine ≥ ~0.36) to be
picked. Some noise remains (one odd pick per question is common); the AI model
then chooses which tools to actually call, and failing servers back off.


## OAuth MCP servers (checked Oct 20, 2026)

Unauthenticated `initialize` against 20 popular vendor MCP servers. All 20 answered
`401`, and 19 of them publish protected-resource metadata. 17 support dynamic client
registration (DCR). The exceptions are GitHub, HubSpot and Box, which need a
pre-registered client. 6 also advertise client-ID metadata documents (CIMD): Canva,
Notion, Linear, Sentry, Monday and Granola. MCP Browser signs in through DCR + PKCE.


## GitHub stars vs measured quality (Oct 20, 2026)

Source: ecosyste.ms open data for every GitHub repo linked from the 30,303 servers
in the local registry mirror (keyless remotes + curated), collected Oct 20, 2026.

* **55% of servers link a GitHub repo** (16,607), covering 12,629 unique repos. Monorepos
  are common: one repo is linked by 2,356 servers, another by 336.
* **31% of linked repos aren't in the open-data index** (3,859). A spot check of 4 on
  github.com found 3 missing and 1 brand-new 0-star repo, so most are probably
  deleted or private, but only GitHub can say (refresh with a token).
* **Stars are rare.** Of the repos found: median 0 stars, 71% have zero, 90th
  percentile 5, 99th percentile 576. Only 75 repos have 1,000+.
* **Popularity ≠ quality.** For the 63 MCP-Rank-tested servers with a known star
  count, Spearman correlation between stars and MCP Rank score is 0.14 (near none).
  On the 28 with measured accuracy it is 0.57, but n is small. The two 100%-accurate
  servers have 6 and 5,138 stars. The most-starred tested server (7,784) scored 0:
  the stars belong to the Sui blockchain repo, not to that MCP endpoint.
* **Borrowed stars.** The registry verifies `io.github.<user>` names but not the
  repository link. 131 servers link a repo owned by another account; 4 of them link
  repos with 1,000+ stars. Some are legitimate (a project moved to an org), some aren't
  (an "artist momentum" server linking a 103k-star unrelated project).
* **The most-starred repos are mostly big products with an MCP endpoint attached**
  (browser-use 119k, netdata 81k, tldraw 51k, PostHog 40k), not MCP-first projects.

Takeaway: stars are a useful "is this real and maintained?" hint, and a poor
predictor of whether a server answers correctly. The app shows them beside MCP Rank
and never scores them.
