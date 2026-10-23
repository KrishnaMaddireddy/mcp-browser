// Ready-made research prompts. Shown on the browser's home page and offered to
// Claude Desktop / Claude Code as MCP prompts. `discovery: true` lets one search
// use community servers from the registry (ad libraries, social, SEO tools)
// even when Discovery is off globally. `route` is what picks the servers (and, with no
// AI model, what the tools are asked): what the person typed plus a few fixed words, so
// the instructions in `prompt` ("Cite sources", "United States") don't pull in servers.

export const TEMPLATES = [
  {
    id: 'competitor-ads',
    group: 'Marketing',
    title: 'Competitor ad scan',
    description: 'Where a competitor advertises, what the ads say, and the offers they push.',
    fields: [
      { name: 'competitor', label: 'Competitor', placeholder: 'e.g. Notion' },
      { name: 'market', label: 'Market', placeholder: 'e.g. United States' },
    ],
    prompt:
      'Find the current advertising of {competitor} in {market}: which ad platforms and public ad libraries show their ads, the main messages, offers and calls to action, and the landing pages they send people to. Summarize the patterns, then list example ads with links.',
    route: '{competitor} ads in the ad libraries: messages and offers',
    discovery: true,
  },
  {
    id: 'seo-brief',
    group: 'Marketing',
    title: 'SEO content brief',
    description: 'Who ranks for a search, what people ask, and the gaps you can fill.',
    fields: [
      { name: 'keyword', label: 'Search phrase', placeholder: 'e.g. best CRM for dentists' },
      { name: 'audience', label: 'Audience', placeholder: 'e.g. small dental practices' },
    ],
    prompt:
      'Create an SEO content brief for the search "{keyword}" aimed at {audience}: who ranks on the first page now and why, the questions people ask, related keywords, a suggested outline (H2/H3), and gaps the current top pages miss. Cite sources.',
    route: '{keyword} SEO keyword rankings search results',
    discovery: true,
  },
  {
    id: 'social-listening',
    group: 'Marketing',
    title: 'Social listening',
    description: 'What people say about a topic across Reddit, Hacker News, Bluesky and more.',
    fields: [
      { name: 'topic', label: 'Brand or topic', placeholder: 'e.g. our product launch' },
      { name: 'timeframe', label: 'Timeframe', placeholder: 'e.g. past 2 weeks' },
    ],
    prompt:
      'What are people saying about {topic} on social platforms and forums (Reddit, Hacker News, Bluesky, X, LinkedIn) in the {timeframe}? Group by sentiment and theme, quote short representative posts with links, and flag emerging complaints or praise.',
    route: '{topic} social media posts Reddit Hacker News Bluesky',
    discovery: true,
  },
  {
    id: 'ai-visibility',
    group: 'Marketing',
    title: 'AI visibility check',
    description: 'Does your brand come up when people ask AI for the best product in your category?',
    fields: [
      { name: 'brand', label: 'Brand', placeholder: 'e.g. Acme Analytics' },
      { name: 'category', label: 'Category', placeholder: 'e.g. product analytics tools' },
    ],
    prompt:
      'When people ask AI assistants or search engines for the best {category}, does {brand} appear? Find which brands are recommended most often, where {brand} shows up or is missing, and which sources (reviews, listicles, forums) drive those recommendations.',
    route: 'which {category} do AI assistants recommend, and is {brand} one',
    discovery: true,
  },
  {
    id: 'positioning',
    group: 'Marketing',
    title: 'Positioning comparison',
    description: 'Taglines, pricing, audiences and recent launches side by side.',
    fields: [
      { name: 'brand', label: 'Your brand', placeholder: 'e.g. Linear' },
      { name: 'competitors', label: 'Competitors', placeholder: 'e.g. Jira, Asana' },
    ],
    prompt:
      'Compare the positioning of {brand} against {competitors}: taglines, pricing, target customers, key features they claim, and recent launches. Present a table, then a short summary of where {brand} is differentiated. Cite sources.',
    route: '{brand} vs {competitors} pricing features',
    discovery: false,
  },
  {
    id: 'review-mining',
    group: 'Marketing',
    title: 'Review mining',
    description: 'What customers praise and complain about, in their own words.',
    fields: [{ name: 'product', label: 'Product', placeholder: 'e.g. Calendly' }],
    prompt:
      'Collect what customers say in reviews of {product} (app stores, G2, Capterra, Trustpilot, Reddit): the most praised features, the most common complaints, and exact phrases customers use. Link the sources.',
    route: '{product} customer reviews: G2, Capterra, Trustpilot, app store, Reddit',
    discovery: true,
  },
  {
    id: 'campaign-angles',
    group: 'Marketing',
    title: 'Campaign angles',
    description: 'What is working now for similar products, turned into campaign ideas.',
    fields: [
      { name: 'product', label: 'Product', placeholder: 'e.g. a budgeting app' },
      { name: 'audience', label: 'Audience', placeholder: 'e.g. college students' },
    ],
    prompt:
      'Research what is working right now in marketing for products like {product} aimed at {audience}: recent successful campaigns, channels, hooks and formats. Then suggest 5 campaign angles, each grounded in an example you found.',
    route: 'marketing campaign examples for {product} aimed at {audience}',
    discovery: false,
  },
  {
    id: 'literature-review',
    group: 'Research',
    title: 'Literature review',
    description: 'Key papers, findings and open questions on a topic, with citations.',
    fields: [
      { name: 'topic', label: 'Topic', placeholder: 'e.g. solid-state battery electrolytes' },
      { name: 'since', label: 'Since', placeholder: 'e.g. 2023' },
    ],
    prompt:
      'Write a short literature review on {topic} covering work since {since}: the most cited and the most recent papers (with authors, year and links), what they found, where they disagree, and open questions. Prefer papers you actually found in the paper search tools.',
    route: '{topic} research papers and reviews since {since}',
    discovery: false,
  },
  {
    id: 'fact-check',
    group: 'Research',
    title: 'Fact check',
    description: 'Check a claim against several independent sources.',
    fields: [{ name: 'claim', label: 'Claim', placeholder: 'e.g. Honey never spoils' }],
    prompt:
      'Fact-check this claim: "{claim}". Search at least two independent kinds of sources (web, encyclopedia, papers). Say whether it is true, false, or partly true, show the evidence for each side with links, and note anything you could not verify.',
    route: '{claim} fact check web encyclopedia sources',
    discovery: false,
  },
  {
    id: 'repo-explainer',
    group: 'Developer',
    title: 'Explain a GitHub repo',
    description: 'How a codebase is organised and how a feature works, without cloning it.',
    fields: [
      { name: 'repo', label: 'Repository', placeholder: 'e.g. vllm-project/vllm' },
      { name: 'question', label: 'Question', placeholder: 'e.g. how are requests scheduled?' },
    ],
    prompt: 'For the GitHub repository {repo}: {question} Explain the relevant modules and files, the flow step by step, and link the files or docs you used.',
    route: 'GitHub repository {repo} {question}',
    discovery: false,
  },
  {
    id: 'library-upgrade',
    group: 'Developer',
    title: 'Library upgrade guide',
    description: 'What breaks and what to change when moving between versions.',
    fields: [
      { name: 'library', label: 'Library', placeholder: 'e.g. Next.js' },
      { name: 'from', label: 'From version', placeholder: 'e.g. 14' },
      { name: 'to', label: 'To version', placeholder: 'e.g. 15' },
    ],
    prompt:
      'Using the official documentation, list what changes when upgrading {library} from {from} to {to}: breaking changes, deprecated APIs and their replacements, and a short step-by-step upgrade checklist with code examples. Link the docs pages.',
    route: '{library} {to} official documentation upgrade migration guide',
    discovery: false,
  },
  {
    id: 'trip-planner',
    group: 'Travel',
    title: 'Trip planner',
    description: 'Flights, weather and what to see, in one answer.',
    fields: [
      { name: 'from', label: 'From', placeholder: 'e.g. San Francisco' },
      { name: 'to', label: 'To', placeholder: 'e.g. Tokyo' },
      { name: 'when', label: 'When', placeholder: 'e.g. Dec 10–18' },
    ],
    prompt:
      'Plan a trip from {from} to {to} for {when}: the cheapest reasonable flights you can find (with prices and booking links), what the weather is usually like then, and five things worth doing there. Keep it to one page.',
    route: 'cheapest flight prices {from} to {to} {when} trip booking weather',
    discovery: true,
  },
];

/** Fill a template's {placeholders}; values are trimmed and capped. */
export function fillTemplate(t, values = {}) {
  return t.prompt.replace(/\{(\w+)\}/g, (_, k) => {
    const v = String(values[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return v || `[${k}]`;
  });
}
