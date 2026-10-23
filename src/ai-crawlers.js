// AI crawlers and fetchers a site owner can name in robots.txt, each with what its owner says
// about robots.txt and where it says it (the owner's own page; Bytespider has none, so a report).
// Checked against the owners' pages on 2026-10-23. Kept by hand.
// kind: training (collects pages to train models), search (indexes pages for an AI search or
// answer product), user-fetch (opens a page when a person asks an assistant), token (a robots.txt
// name that controls a use, not a crawler of its own), search-engine (a search crawler, listed so
// it isn't mistaken for an AI one, with a note on how its pages are used for AI). fallback: whose
// group it follows when it has none of its own; crawler: the crawler a token's rules ride on.
export const AI_CRAWLERS = [
  {
    "token": "GPTBot",
    "owner": "OpenAI",
    "kind": "training",
    "follows": "yes: a Disallow line opts the site out",
    "source": "https://developers.openai.com/api/docs/bots",
    "checked": "2026-10-23"
  },
  {
    "token": "OAI-SearchBot",
    "owner": "OpenAI",
    "kind": "search",
    "follows": "yes: a Disallow line keeps the site out of ChatGPT search answers",
    "source": "https://developers.openai.com/api/docs/bots",
    "checked": "2026-10-23"
  },
  {
    "token": "ChatGPT-User",
    "owner": "OpenAI",
    "kind": "user-fetch",
    "follows": "not always: OpenAI says robots.txt rules may not apply",
    "source": "https://developers.openai.com/api/docs/bots",
    "checked": "2026-10-23"
  },
  {
    "token": "ClaudeBot",
    "owner": "Anthropic",
    "kind": "training",
    "follows": "yes",
    "source": "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    "checked": "2026-10-23"
  },
  {
    "token": "Claude-SearchBot",
    "owner": "Anthropic",
    "kind": "search",
    "follows": "yes",
    "source": "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    "checked": "2026-10-23"
  },
  {
    "token": "Claude-User",
    "owner": "Anthropic",
    "kind": "user-fetch",
    "follows": "yes: no exception for user requests",
    "source": "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    "checked": "2026-10-23"
  },
  {
    "token": "PerplexityBot",
    "owner": "Perplexity",
    "kind": "search",
    "follows": "yes",
    "source": "https://docs.perplexity.ai/docs/resources/perplexity-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Perplexity-User",
    "owner": "Perplexity",
    "kind": "user-fetch",
    "follows": "no: Perplexity says it generally ignores robots.txt",
    "source": "https://docs.perplexity.ai/docs/resources/perplexity-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Google-Extended",
    "owner": "Google",
    "kind": "token",
    "follows": "yes: the line itself controls Gemini training and grounding",
    "source": "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
    "checked": "2026-10-23",
    "crawler": "Googlebot"
  },
  {
    "token": "Googlebot",
    "owner": "Google",
    "kind": "search-engine",
    "follows": "yes",
    "source": "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
    "checked": "2026-10-23",
    "note": "Google Search's crawler; pages it crawls also appear in AI Overviews, which Google-Extended doesn't control"
  },
  {
    "token": "Google-CloudVertexBot",
    "owner": "Google",
    "kind": "search",
    "follows": "yes",
    "source": "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Applebot-Extended",
    "owner": "Apple",
    "kind": "token",
    "follows": "yes: the line itself controls Apple model training",
    "source": "https://support.apple.com/en-us/119829",
    "checked": "2026-10-23",
    "crawler": "Applebot"
  },
  {
    "token": "Applebot",
    "owner": "Apple",
    "kind": "search-engine",
    "follows": "yes (follows Googlebot's rules when it has none of its own)",
    "source": "https://support.apple.com/en-us/119829",
    "checked": "2026-10-23",
    "fallback": "Googlebot",
    "note": "Apple's search crawler; pages it crawls may be used to train Apple's models unless Applebot-Extended is blocked"
  },
  {
    "token": "Amazonbot",
    "owner": "Amazon",
    "kind": "training",
    "follows": "yes",
    "source": "https://developer.amazon.com/amazonbot",
    "checked": "2026-10-23"
  },
  {
    "token": "Amzn-SearchBot",
    "owner": "Amazon",
    "kind": "search",
    "follows": "yes",
    "source": "https://developer.amazon.com/amazonbot",
    "checked": "2026-10-23",
    "noGroup": "Amazon says that with no group of its own it follows what the site tells other search bots"
  },
  {
    "token": "Amzn-User",
    "owner": "Amazon",
    "kind": "user-fetch",
    "follows": "not always: Amazon says it may not follow all directives",
    "source": "https://developer.amazon.com/amazonbot",
    "checked": "2026-10-23"
  },
  {
    "token": "CCBot",
    "owner": "Common Crawl",
    "kind": "training",
    "follows": "yes",
    "source": "https://commoncrawl.org/faq",
    "checked": "2026-10-23",
    "note": "an open web archive, widely used for training"
  },
  {
    "token": "Meta-ExternalAgent",
    "owner": "Meta",
    "kind": "training",
    "follows": "yes",
    "source": "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Meta-WebIndexer",
    "owner": "Meta",
    "kind": "search",
    "follows": "yes",
    "source": "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Meta-ExternalFetcher",
    "owner": "Meta",
    "kind": "user-fetch",
    "follows": "not always: Meta says it may bypass robots.txt",
    "source": "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
    "checked": "2026-10-23"
  },
  {
    "token": "Bytespider",
    "owner": "ByteDance",
    "kind": "training",
    "follows": "not stated by its owner; reported to ignore it",
    "checked": "2026-10-23",
    "report": "https://www.haproxy.com/blog/nearly-90-of-our-ai-crawler-traffic-is-from-tiktok-parent-bytedance-lessons-learned"
  },
  {
    "token": "DuckAssistBot",
    "owner": "DuckDuckGo",
    "kind": "search",
    "follows": "yes",
    "source": "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot",
    "checked": "2026-10-23"
  },
  {
    "token": "MistralAI-Training",
    "owner": "Mistral AI",
    "kind": "training",
    "follows": "yes",
    "source": "https://docs.mistral.ai/robots",
    "checked": "2026-10-23"
  },
  {
    "token": "MistralAI-Index",
    "owner": "Mistral AI",
    "kind": "search",
    "follows": "yes",
    "source": "https://docs.mistral.ai/robots",
    "checked": "2026-10-23"
  },
  {
    "token": "MistralAI-User",
    "owner": "Mistral AI",
    "kind": "user-fetch",
    "follows": "yes",
    "source": "https://docs.mistral.ai/robots",
    "checked": "2026-10-23"
  },
  {
    "token": "YouBot",
    "owner": "You.com",
    "kind": "search",
    "follows": "yes",
    "source": "https://you.com/docs/youbot",
    "checked": "2026-10-23"
  }
];

// Robots.txt keeps a site out of AI training and AI search indexes, but a fetcher that opens a
// page because a person asked may not follow it. [key] marks become citations.
export const FETCHER_NOTE = {
  text: "Training and search crawlers say they follow robots.txt. Fetchers that open a page because a person asked an assistant are different: OpenAI says robots.txt rules may not apply to ChatGPT-User [openai], Perplexity says Perplexity-User generally ignores them [perplexity], Google says the same of its user-triggered fetchers [google], and Amazon and Meta make similar exceptions; Anthropic makes none for Claude-User [anthropic]. So blocking in robots.txt keeps a site out of AI training and AI search indexes, but doesn't fully stop an assistant reading a page someone asks about: that takes firewall or CDN rules.",
  sources: {
    openai: { title: 'OpenAI: overview of OpenAI crawlers', url: 'https://developers.openai.com/api/docs/bots' },
    perplexity: { title: 'Perplexity crawlers', url: 'https://docs.perplexity.ai/docs/resources/perplexity-crawlers' },
    google: { title: 'Google: user-triggered fetchers', url: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers' },
    anthropic: { title: 'Anthropic: how site owners can block its crawlers', url: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler' },
  },
};
