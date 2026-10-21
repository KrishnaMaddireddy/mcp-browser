# MCP Browser: status and decisions

Last updated Oct 20, 2026.

## What it is

A local AI search browser that answers questions by routing them to the right
MCP servers: 16 curated public ones (plus 8 sign-in apps) and about 27,000 keyless remote servers mirrored
from the official MCP Registry. It works with no AI (free mode), with an API key
or local Ollama model, or inside Claude Desktop / Claude Code on your Claude
subscription.

## Features

| Area | What's there |
|---|---|
| Browser | Tabs, omnibox, streamed answers with [n] citations, sources, activity trace, the "switchboard" of servers used per question, follow-ups. Desktop app with real web tabs (Electron). |
| Routing | Keyword (BM25) + meaning (local MiniLM embeddings) + measured quality (MCP Rank). 2–4 servers per question; community registry servers only with Discovery on. |
| AI | Free mode; Anthropic; any OpenAI-compatible API (OpenAI, Groq, OpenRouter, Ollama). The model can call `find_more_servers` to pull in registry servers mid-answer. |
| Claude subscription | MCP server mode (`bin/mcp-server.js`): `route`, `call_tool`, `quick_search`, `find_servers`, plus all templates as prompts. |
| Templates | 12 in 4 groups: Marketing (7), Research (2), Developer (2), Travel (1). |
| Watches | Saved searches re-run hourly/daily/weekly; flag new sources and changed answers. |
| MCP Rank | Known-answer accuracy tests in 7 categories, plus free / clean / speed / safety / metadata. Anti-gaming checks, per-run phrasings averaged over the last 5 runs, AI-assisted testing for tools that need structured arguments. Labels export (JSON), methodology page, leaderboard, and a registry-compatible subregistry API (`/v0.1/servers` with rank in `_meta`). |
| Servers | Registry sync (incremental), health + back-off, keys per server, OAuth sign-in (PKCE, dynamic registration, quiet refresh; only when you press Sign in), 8 "Your apps" sign-in servers (Notion, Linear, Atlassian, Asana, Sentry, Granola, Intercom, monday.com), add your own server by URL (local/LAN allowed only for those). |
| GitHub stars | Stars for every linked repo (~12,600) with archived / stale / gone / other-owner flags; shown beside MCP Rank, never part of it. Snapshot ships with the app; refresh from GitHub with a token or from ecosyste.ms without. |
| Free-mode quality | Readable views (items / table / facts), empty / sales-pitch / off-topic replies folded, on-topic and time-focused ordering, two-step place → forecast calls, quoted quick answers (facts and weather). Servers are asked as each connects; a reachability snapshot of all 27,458 keyless registry servers skips the ~10,000 that can't answer. Measured each round with `scripts/e2e.js` (40 questions) and `scripts/e2e-mcp.js` (what Claude receives). |
| Packaging | `npm run dist:mac` builds an Apple-silicon .dmg. Verified with a Linux build: the packaged app runs, loads the local model, and works as an MCP server for Claude. |

## Where quality stands

Two 40-question suites, Discovery on, 12 servers per question: the tuned set used all
night, and a held-out set of 40 new questions written late in the session to check the
gains weren't overfit.

| Metric | Start of night | Tuned set now | Held-out, first ask | Held-out after the free-mode probe (no per-question memory) |
|---|---|---|---|---|
| Useful, on-topic share of servers asked | 25% | 54% | 46% | 61% |
| Empty replies | 24% | 8% | 13% | 8% |
| Skipped (needs an AI model) | 18% | 5% | 12% | 0.9% |
| Failed servers | 22% | 2% | 4% | 7.5% (servers coming and going) |
| Questions with a useful result | 40 of 40 | 40 of 40 | 40 of 40 | 40 of 40 |
| Questions answered by a specialist | 21 | 31 | 30 | 29 |
| Quick answers shown | at page end | 19, ~2.1 s | 19 | 23, ~2.3 s |
| First useful result (median / p90) | not measured | 0.6 s / 1.5 s | 0.7 s / 1.7 s | 1.1 s / 1.8 s |
| Whole page (median / p90) | 2.9 s / 11.9 s | 2.8 s / 7.7 s | 3.3 s / 5.3 s | 2.9 s / 5.3 s |

Claude's `quick_search` returned on-topic results with citable sources for 40 of 40
questions (p90 4.4–5.7 s, about 10k characters per reply).

## What changed overnight (free mode and Claude's quick_search)

- **Speed:** each server is asked the moment it connects; the page stops early once 3
  useful results are in and 4 s have passed; a failed web engine is backed up by
  another at once.
- **Relevance:** off-topic replies fold into one line and count against the server;
  generic words, time words and echoed questions don't count as matches; lists put
  on-topic, newest (for "latest") and asked-day items first; duplicate pages collapse.
- **Asking servers their way:** tickers to ticker tools; quote tools for stock prices
  ("Nvidia" → NVDA → live quote); currency pairs to exchange-rate tools; geocode →
  forecast for weather; resolve → query for Context7-style docs.
- **Quick answers:** streamed as soon as results support them; forecasts, quotes and
  rates come from the specialist's own data; unit conversions are calculated; web
  sentences must name the subject, state a value, and (for prices) agree with a second
  site; highs, ranges, market caps and crypto "tokenized" copies are never quoted as the price.
- **Learning:** per-question memory (a server that answered this question with nothing
  in the last day is asked last); a reachability snapshot skips ~9,000 dead, sign-in-only
  or paid registry servers, and a second probe pass marks servers whose tools need an AI
  model so free mode ranks them lower.
- **Weather anywhere:** a worldwide weather server joins the curated set; the place is
  taken from the question in any language; a forecast for a same-named US town (Paris,
  TX) is never quoted for Paris.
- **UI:** forecast/quote/calculated answer box, off-topic fold, phone layout (chip row
  scrolls, answer above the fold), dismissible free-mode tip, "not advice" note for
  money/health/legal questions, honest server count on the home page.
- **Inside Claude:** `quick_search` leads with the quick answer, drops off-topic
  replies, and says when a question needs a sign-in (e.g. Linear) instead of passing
  off public pages.

## Key decisions

- **Never "connect to everything."** Most keyless registry servers don't actually
  answer anonymously, some charge per call (x402), some inject ads. Route to a few.
- **Read-only only.** Write/destructive tools are hidden from models, by name
  pattern and annotations; tools with instructions in their docs are hidden too.
- **No Claude.ai login inside the app.** Anthropic's terms don't allow third-party
  apps to use subscription credentials, so the app runs *inside* Claude instead.
- **Grade servers on what they return.** MCP Rank never counts a model's own
  words; echoes of the model's arguments are stripped; canned answers don't count.
- **Independent ranking is the opportunity.** Directories grade metadata; nobody
  measures live answer accuracy per server at registry scale (see LANDSCAPE.md).

## Reviews

Eight independent code reviews (the fifth on OAuth: background calls can never register a client or start a sign-in; the sixth to eighth on free-mode quality: follow-up relevance, early stop vs. backup engines, price consensus, unit conversion edge cases, wrong-city weather, product-vs-stock questions), plus a fresh-eyes design review; every finding fixed with a regression test
(190 tests). Notable fixes: DNS-rebinding and cross-origin-redirect protections,
key redaction, Electron protocol and permission lock-down, write-tool detection
(`GITHUB_CREATE_AN_ISSUE` style names), prompt-injection in schemas, MCP Rank
gaming via echoes or canned answers, questions that contained their own answers, watch scheduler hangs.

## Next steps (suggested)

1. Specialist coverage for "top stocks to buy" style screens (no free screener tool found yet).
2. Context7: its anonymous monthly quota runs out under heavy use; add a free key with "Use own key" on the servers page (the header is pre-filled).
3. Re-run `scripts/probe-registry.js` and `scripts/probe-direct.js` monthly; servers come and go.
4. Run MCP Rank with an AI model so tools needing structured arguments get scored.
5. Host the subregistry publicly; Apple Developer ID signing for the Mac app.
