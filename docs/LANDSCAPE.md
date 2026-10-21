# MCP Browser + MCP Rank: Competitive Landscape (as of Oct 20, 2026)

Researched by an AI research agent; the Arcade–Smithery acquisition, Atlas retirement and Edge Copilot Mode retirement were re-checked against the primary sources listed below.

## TL;DR
- **Aggregators route; they don't verify.** Composio, Pipedream, Zapier, Docker, Cloudflare, and MetaMCP offer "one endpoint, many tools" over curated, auth-managed (mostly SaaS action) catalogs. None publishes per-server answer accuracy.
- **Quality scores are static or LLM-judged.** ToolBench, Glama, and MCPBundles grade definitions and metadata. Academic benchmarks test *models* on 5–70 servers. **I found no one measuring live known-answer accuracy per server at registry scale.**
- **AI browsers are moving away from being MCP clients.** Atlas and Edge Copilot Mode are retired. Opera Neon exposes the browser *as* an MCP server, and Chrome is pushing WebMCP.
- **Consolidation is underway.** Arcade acquired Smithery (Aug 5, 2026), uniting a grader and a catalog under one owner. Workday agreed to buy Pipedream (Nov 2025).

## 1. Aggregators, gateways, and meta-servers

| Product | What it does | Pricing | Dynamic routing across many servers? | Measures server quality/accuracy? |
|---|---|---|---|---|
| **Smithery** (now Arcade) | Registry ("27,365+ MCPs"), Connect (shared OAuth), CLI | Hobby free (50k RPC/mo); $10/mo PAYG (100k RPC); $0.10/1k overage; Custom | Per-server connect, no question router. Site banner says the "MCP Proxy and managed identity shut down on October 31" | Usage counts only. Arcade's ToolBench is separate |
| **Composio** | Managed auth plus "1000+ apps" via session meta tools (`SEARCH_TOOLS`, `MULTI_EXECUTE` up to 50 in parallel, remote workbench) | Hobby $0 (100k calls/mo); Pro $29 plus $0.0003/call; Enterprise custom | Yes, within its own toolkits (search, then load schema, then execute) | No. Logs only |
| **Pipedream MCP** (Workday) | "3,000+ APIs, 10,000+ tools", remote endpoint, per-user auth | Not stated in docs | Its own catalog | No |
| **Zapier MCP** | 9,000+ apps; 30k–66k actions (the page's two figures conflict) | Included in all plans; **each tool call = 2 tasks** | Its own catalog | No |
| **Docker MCP Toolkit / Dynamic MCP** | `mcp-find` / `mcp-add` search the Docker catalog mid-session; experimental `code-mode` | Requires Docker Desktop 4.50 or later; no MCP pricing stated | Yes, session-scoped and experimental (docs dated Sep 25, 2026) | Signed, containerized images, but no accuracy measurement |
| **Cloudflare MCP Server Portals** | Access-managed portal aggregating upstream servers; Code Mode (default since Mar 26, 2026) collapses them into one `code` tool | Not stated | Aggregates servers the admin configures | No |
| **MetaMCP** (OSS) | Self-hosted aggregator, namespaces, middleware, tool cherry-picking | Free/OSS | Static aggregation | No |
| **Glama** | Registry (107,805 servers), gateway, hosting | Freemium (gateway pricing could not be fetched) | Gateway, but not per-question | Letter grades A–D (license/quality/maintenance) |
| **mcp.so / PulseMCP** | Directories; mcp.so has "Top" and "Trending" lists plus an "Advertise" link | Free | No | Stars or popularity only (PulseMCP blocked fetching) |

There are also OSS "semantic MCP routers" (mcpadvisor, mcp-router, mcp-mux), which route by description similarity rather than measured quality. **Takeaway:** every commercial router is a closed-catalog, auth-first, action-oriented gateway with a call quota. None federates the ~27k keyless open-registry remotes for read-only Q&A.

## 2. Quality and ranking directories, and benchmarks

**Directory and grader scores**
- **Arcade ToolBench** (launched Mar 18, 2026): 41,902 servers and 218,422 tools. Weights: Definition Quality 50/30%, Protocol Readiness 20/30%, Security (hosted only) 20%, Supportability 30/20%. Hosted endpoints get a live handshake plus auth/PKCE checks. Arcade states explicitly that ToolBench does **not** test whether tools return correct results, latency, or agent outcomes. Only 0.5% of servers scored A or better, and 77% of tools received an F.
- **Glama**: license, quality, and maintenance grades. The methodology is not published on the listing pages.
- **MCPBundles** (Apr 19, 2026): Claude Haiku 4.5 LLM-as-judge on purpose clarity, parameters, disambiguation, and annotations. It reads descriptions and does not execute tools. It also sells a $129/mo banner sponsorship.
- **MCP Vitals** (OSS CLI): static checks, behavioral (read-only auto-tests for success, errors, latency), and an agent-usability layer. It is run per server; published grades cover only 4 reference servers.
- **Registry handshake census** (dev.to, Jul 29–Aug 24, 2026): 10,716 remote endpoints, one anonymous `initialize` each. 43–46% completed a handshake, 24.7% required auth, and about a quarter were unusable. It made no `tools/list` or tool calls.

**Academic benchmarks** (they evaluate *models*, not servers)
- **LiveMCPBench** (Aug 3, 2025): 70 servers, 527 tools, 95 tasks. Claude Sonnet 4 scored 78.95%, and retrieval errors caused about half of failures.
- **MCP-Universe** (Salesforce, Aug 20, 2025): 11 servers across 6 domains. GPT-5 scored 43.72%.
- **MCPMark** (Sep 28, 2025): 127 tasks across 5 environments. gpt-5-medium scored 52.56% pass@1.
- **MCP-Atlas** (Scale, Jan 31, 2026): 36 servers, 220 tools, 1,000 tasks, scored by claim coverage. The best of 20 models reached 82.2%.

**Answer to Q2:** I found no public system measuring *live answer accuracy per server* at registry scale. ToolBench has the scale but excludes correctness; benchmarks have the depth but cover only tens of servers. MCP Rank's mix of known-answer accuracy, free-ness/x402, injection, and write-tool checks appears novel. *An unpublished internal effort (e.g., at Arcade) can't be ruled out.*

## 3. AI browsers

| Browser | MCP / tool routing | Positioning and pricing |
|---|---|---|
| **Perplexity Comet** | Remote MCPs exist; local MCP was spotted in dev builds (2025). Custom connectors are Pro+ only (third-party report, Aug 2026). The Perplexity Mac app supports local MCP (Jul 2025) | Free since Oct 6, 2025; Comet Plus $5/mo (publishers); Max $200/mo |
| **OpenAI ChatGPT Atlas** | **Retired** (Help Center confirms; a third party dates the deprecation to Jul 9 and shutdown to Aug 9, 2026). The Help Center names no replacement; it advises users to move to a supported browser. ChatGPT apps/connectors live in ChatGPT, not the browser | Was in all plans; agent mode on Plus and up |
| **Dia** (Atlassian, $610M, closed Oct 21, 2025) | No MCP found. "Skills" plus first-party integrations (Slack, Notion, Gmail, Calendar, Amplitude; Mar 2026) | Free plus Dia Pro $20/mo; macOS only |
| **Opera Neon** | **MCP Connector (Apr 1, 2026)**: Neon is exposed *as* an MCP endpoint that Claude/ChatGPT drive | From $19.90/mo |
| **Genspark AI Browser** | "MCP Store" with ~700 MCP tools to install (Oct 2025 video) | Not verified |
| **Fellou** | No MCP mention found | Free / $19 / $39.90 / $199.90 per month (aggregator, Mar 2026) |
| **Edge** | **Copilot Mode retired** (May 13, 2026). "Browse with Copilot" requires M365 Premium (US); Journeys is free. No MCP | Bundled with M365 |
| **Chrome / Gemini** | Auto browse (Jan 28, 2026) for AI Pro/Ultra US users. **WebMCP** (`navigator.modelContext`) early preview Feb 2026, W3C CG with Microsoft. Sites publish tools client-side | Bundled with Google AI subscriptions |
| **Polar** (Recursive Intelligence; $5.7M seed led by Madrona, Jul 29, 2026) | No MCP. A Chromium browser agent that clicks and types in your logged-in sites for long tasks, plus scheduled workflows | Free (credits); $20/mo; Teams $50/seat/mo |

**Takeaway:** none routes a question across many third-party MCP servers. Genspark's curated, install-based store is closest. The trend is the browser *as* a tool (Neon, WebMCP).

## 4. Monetization patterns
- **x402 pay-per-call.** Cloudflare's Agents SDK has `paidTool(name, desc, priceUSD, …)` that returns HTTP 402. Cloudflare's **Monetization Gateway** entered closed beta on Oct 1, 2026: USDC on Base, $0.001–$100, `exact`/`upto` schemes, with seller discoverability "planned". Coinbase cites 160M+ agentic payments in the last year (Jun 2026) and 100M+ through Q1 2026 per Chainalysis. Organic versus test/speculative share is **unverified**.
- **Quota or usage metering on gateways.** Zapier (2 tasks per call), Composio ($0.0003/call overage), Smithery ($0.10 per 1k RPC).
- **Marketplaces and sponsorship.** MCPBundles banner at $129/mo; mcp.so has an "Advertise" link; MCP Market lists paid servers. No one discloses how sponsorship interacts with ranking.
- **Enterprise private registries.** GitHub Copilot and VS Code registry/allowlist controls (preview Sep 2025, stable public preview Nov 2025), private registries on Azure API Center, Zapier enterprise per-app/action controls, and Composio Enterprise (SSO/SCIM, CMK).
- **Platform M&A.** Arcade + Smithery and Workday + Pipedream are consolidating catalog, execution, and grading. Commentators have flagged the neutrality problem of Arcade grading a catalog it owns.

## 5. Synthesis

### Gaps and opportunities
1. **The neutral "answer-accuracy" layer for MCP.** Everyone grades schemas; nobody grades answers. Publish MCP Rank as an open, reproducible leaderboard with a methodology page, known-answer sets, and dated runs. Arcade owning Smithery and ToolBench makes an *independent* grader newly valuable.
2. **A trust signal for the paid-tool era.** As x402 and Cloudflare's gateway make 402 responses common, agents need to know beforehand what is free, what is metered, what injects ads, and what has write tools. MCP Rank's free-ness and prompt-injection checks are a natural "nutrition label." It could be offered as a feed or API that gateways (Composio, Docker `mcp-find`, MetaMCP middleware) or registry sub-registries consume.
3. **Open-registry, read-only Q&A routing.** Commercial routers cover closed, auth-first SaaS action catalogs. The ~27k keyless remotes (gov data, finance, docs, search) are unserved for cited Q&A. Routing by *measured* quality, not just BM25 or embedding similarity, directly targets the main failure mode benchmarks found (LiveMCPBench: about half of failures were retrieval errors).
4. **"Bring your Claude subscription" distribution.** AI browsers are retreating from being MCP clients (Atlas and Copilot Mode retired). Shipping as an MCP server inside Claude Desktop and Claude Code, plus free mode and Ollama, avoids competing on browser share and on per-call quotas.
5. **Vertical research templates on live data.** Marketing templates (competitor ads, SEO, social listening, AI visibility) built on ranked open servers are a wedge that generic gateways don't package.

### Main risks
1. **Platform absorption.** Arcade/Smithery, Docker Dynamic MCP, Composio Tool Router, Cloudflare Code Mode, and model-side tool search (Anthropic's defer-loading tool search) could add "quality-weighted routing" quickly. Arcade already holds the scale index.
2. **Measurement validity and liability at scale.** Known-answer sets go stale, servers change behavior or detect probes, and auth-gated servers (about 25%) can't be scored. Low scores for named servers invite disputes, probing ~27k servers repeatedly is costly, and about a quarter of remote endpoints were unusable in Aug 2026.
3. **Security and trust exposure.** Auto-calling thousands of unvetted third-party servers is a prompt-injection and data-exfiltration surface. Detection must be robust, and one high-profile incident would hurt credibility more than it would for curated catalogs. Monetization is also unproven: x402 volumes are vendor-reported, and directory sponsorship conflicts with a neutral-ranking brand.

### Unverified or flagged
Smithery's shutdown banner gives no year. Atlas dates and Perplexity connector tiers come from third-party articles. Genspark's details are from an Oct 2025 video note. The PulseMCP and Glama gateway pages could not be fetched. Docker's catalog size isn't stated, and x402's organic volume is unknown. A third-party count put the official registry at 30,375 unique servers (99,114 version records) on Sep 10, 2026, versus your 47k figure; the gap is likely counting method.

## Sources
- https://smithery.ai/ ; https://smithery.ai/pricing ; https://rywalker.com/research/smithery
- https://www.arcade.dev/blog/smithery-joins-arcade/ ; https://runtimewire.com/article/arcade-acquires-smithery-agent-tool-supply-chain ; https://www.neura.market/news/arcade-acquires-smithery-mcp-registry-execution-layer
- https://docs.composio.dev/tool-router/overview ; https://docs.composio.dev/toolkits/meta-tools ; https://composio.dev/pricing
- https://pipedream.com/docs/connect/mcp/developers ; https://pipedream.com/blog/pipedream-to-be-acquired-by-workday/
- https://zapier.com/mcp
- https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/
- https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/
- https://docs.metamcp.com/en/index.md
- https://glama.ai/mcp/servers ; https://mcp.so/
- https://toolbench.arcade.dev/methodology ; https://www.arcade.dev/blog/introducing-toolbench-quality-benchmark-mcp-servers/
- https://mcpbundles.com/blog/rating-mcp-server-quality ; https://www.mcpbundles.com/sponsorship
- https://contra.com/p/UcobNU22-mcp-vitals-reliability-grades-a-f-for-mcp-servers
- https://dev.to/theopslog/i-checked-every-mcp-server-in-the-official-registry-about-1-in-10-is-broken-1ehj
- https://dev.to/amareswer/the-mcp-registry-by-the-numbers-38nc ; https://dev.to/skillselion/mcp-registries-in-2026-compared-one-is-canonical-one-is-huge-and-almost-none-can-tell-you-what-147l
- https://arxiv.org/abs/2508.01780v1 (LiveMCPBench) ; https://arxiv.org/abs/2508.14704v1 (MCP-Universe) ; https://arxiv.org/html/2509.24002v1 (MCPMark) ; https://arxiv.org/abs/2602.00933v1 (MCP-Atlas)
- https://www.techrepublic.com/article/news-perplexity-comet-ai-browser-free/ ; https://geekflare.com/news/local-mcp-support-coming-soon-to-perplexity-comet-browser ; https://hjarni.com/mcp-fix/perplexity-mcp-connector-not-showing
- https://help.openai.com/en/articles/20001371-chatgpt-atlas-retirement ; https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026
- https://en.wikipedia.org/wiki/Dia_(web_browser)
- https://betanews.com/article/opera-neon-now-lets-ai-tools-control-your-browser-in-real-time/
- https://lilys.ai/notes/vi/gensparkai-20260114/genspark-ai-browser-mcp-store
- https://aitoolsatlas.ai/tools/fellou/pricing
- https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/
- https://polarbrowser.com/ ; https://polarbrowser.com/pricing ; https://www.01net.it/polar-the-ai-browser-that-does-real-work-raises-5-7m/
- https://9to5google.com/2026/01/28/chrome-gemini-auto-browse/ ; https://www.eweek.com/news/google-webmcp-chrome-ai-web-standard-preview/
- https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/ ; https://thenewstack.io/cloudflare-x402-agent-spending/ ; https://www.kucoin.com/news/flash/coinbase-processes-1t-in-stablecoin-payments-annually-x402-hits-160m-transactions
- https://github.blog/changelog/2025-11-18-internal-mcp-registry-and-allowlist-controls-for-vs-code-stable-in-public-preview/ ; https://devblogs.microsoft.com/all-things-azure/locking-down-mcp-create-a-private-registry-on-azure-api-center-and-enforce-it-in-github-copilot-and-vs-code/
