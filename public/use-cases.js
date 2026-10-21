// Use-case library for mcp://catalog: what people do with MCP servers, which
// kinds of server each job needs, what to ask, and multi-server workflows.
// Each `need` names servers to prefer (registry names) and a search used to
// fill the rest from the catalog, so new servers show up without editing this.
window.MCP_USE_CASES = {
  personas: [
    ['dev', 'Developers'],
    ['data', 'Data & analytics'],
    ['research', 'Research & learning'],
    ['growth', 'Marketing & sales'],
    ['finance', 'Finance & investing'],
    ['ops', 'Work & productivity'],
    ['life', 'Everyday life'],
  ],

  goals: [
    // ---------- developers ----------
    {
      id: 'current-docs', persona: 'dev', title: 'Code against current library docs',
      why: 'Models remember old APIs. A docs server pulls the version you actually use, so generated code compiles.',
      needs: [{ label: 'Library docs', q: 'documentation library docs', prefer: ['io.github.upstash/context7'] }],
      prompts: ['How do I set up middleware in Next.js 15 App Router?', 'Show the current Prisma syntax for a many-to-many relation', 'What changed in the React 19 use hook?'],
    },
    {
      id: 'understand-repo', persona: 'dev', title: 'Understand an unfamiliar codebase',
      why: 'Ask how a repo works instead of reading it file by file: architecture, entry points, where a feature lives.',
      needs: [
        { label: 'Git history', q: 'git repository history diff', prefer: ['io.github.cyanheads/git-mcp-server'] },
        { label: 'Code search in your repo', q: 'code search symbols repository', prefer: ['io.github.DeusData/codebase-memory-mcp'] },
      ],
      prompts: ['How does routing work in vercel/next.js?', 'Where is authentication handled in this repo?', 'Explain the data flow from the API to the database in facebook/react'],
    },
    {
      id: 'debug-prod', persona: 'dev', title: 'Triage production errors',
      why: 'Pull the error, stack trace and release that introduced it into the conversation, then fix it in the same place.',
      needs: [
        { label: 'Error tracking', q: 'sentry errors issues stack trace', prefer: ['io.github.getsentry/sentry-mcp'] },
        { label: 'Logs and metrics', q: 'logs metrics observability dashboards', prefer: ['io.github.grafana/mcp-grafana'] },
      ],
      prompts: ['What are the top unresolved errors in our checkout service this week?', 'Show the stack trace and first release for issue PAY-4F2', 'Did error rates spike after yesterday’s deploy?'],
    },
    {
      id: 'browser-test', persona: 'dev', title: 'Test and debug web pages',
      why: 'Let the assistant open your site, click through a flow, read the console and network, and report what broke.',
      needs: [{ label: 'Browser control', q: 'browser automation playwright devtools', prefer: ['io.github.microsoft/playwright-mcp', 'io.github.ChromeDevTools/chrome-devtools-mcp'] }],
      prompts: ['Open localhost:3000, sign up with a test email and tell me where it fails', 'Why is the hero image slow to load on our pricing page?', 'Check the console errors on https://example.com'],
    },
    {
      id: 'query-db', persona: 'data', title: 'Ask questions of your database',
      why: 'Write and run read-only SQL from a plain question, with the schema in view, instead of switching to a SQL client.',
      needs: [{ label: 'Database', q: 'postgres sql database query read-only', prefer: ['io.github.bytebase/dbhub', 'com.supabase/mcp'] }],
      prompts: ['Which 10 customers spent the most last quarter?', 'Show the schema of the orders table', 'How many signups did we get per week in September?'],
    },
    {
      id: 'infra', persona: 'dev', title: 'Inspect cloud and Kubernetes',
      why: 'Check what is running, why a pod restarts, or what a deploy changed, without memorizing CLI flags.',
      needs: [
        { label: 'Kubernetes', q: 'kubernetes pods cluster', prefer: ['io.github.containers/kubernetes-mcp-server'] },
        { label: 'Cloud provider', q: 'aws cloud infrastructure resources', cat: 'cloud' },
      ],
      prompts: ['Why is the api pod in production restarting?', 'List deployments in the staging namespace and their image tags', 'Which S3 buckets are public?'],
    },
    {
      id: 'design-to-code', persona: 'dev', title: 'Turn designs into code',
      why: 'Read the actual Figma frame (layout, tokens, spacing) so generated UI matches the design.',
      needs: [{ label: 'Design files', q: 'figma design frames', prefer: ['io.github.GLips/Figma-Context-MCP'] }],
      prompts: ['Build this Figma frame as a React component with Tailwind', 'What colors and fonts does our design system file use?', 'List the components on the Checkout page in Figma'],
    },
    {
      id: 'security-check', persona: 'dev', title: 'Check vulnerabilities and dependencies',
      why: 'Look up CVEs, check whether a package version is affected, and get the fixed version.',
      needs: [{ label: 'Vulnerability data', q: 'cve vulnerability advisories', cat: 'security' }],
      prompts: ['Is lodash 4.17.20 affected by any known CVEs?', 'Explain CVE-2024-3094 and which versions are vulnerable', 'Which of my npm dependencies have critical advisories?'],
    },

    // ---------- research ----------
    {
      id: 'web-research', persona: 'research', title: 'Research anything on the live web',
      why: 'Search the web and read the pages behind the results, so answers cite current sources instead of memory.',
      needs: [
        { label: 'Web search', q: 'web search engine', prefer: ['io.github.brave/brave-search-mcp-server', 'io.github.tavily-ai/tavily-mcp'] },
        { label: 'Read pages', q: 'scrape page markdown extract', prefer: ['io.github.firecrawl/firecrawl-mcp-server'] },
      ],
      prompts: ['What did the EU AI Act change for general-purpose models this year?', 'Compare the battery life claims of the latest Pixel and iPhone', 'Summarize this article: https://modelcontextprotocol.io/introduction'],
    },
    {
      id: 'papers', persona: 'research', title: 'Find and read research papers',
      why: 'Search arXiv and PubMed, read abstracts and full text, and compare findings with citations.',
      needs: [
        { label: 'arXiv', q: 'arxiv papers', prefer: ['io.github.blazickjp/arxiv-mcp-server'] },
        { label: 'PubMed', q: 'pubmed biomedical literature', prefer: ['io.github.cyanheads/pubmed-mcp-server'] },
      ],
      prompts: ['Find 2025 papers on retrieval-augmented generation evaluation', 'What does recent research say about GLP-1 drugs and muscle loss?', 'Summarize the methods of arXiv 1706.03762'],
    },
    {
      id: 'learn-topic', persona: 'research', title: 'Learn a topic from reliable sources',
      why: 'Encyclopedias, dictionaries and open data give grounded explanations you can check.',
      needs: [{ label: 'Reference', q: 'wikipedia encyclopedia reference', prefer: ['io.github.cyanheads/wikipedia-mcp-server'] }, { label: 'Videos and transcripts', q: 'youtube transcript', prefer: ['io.github.samson-art/transcriptor-mcp'] }],
      prompts: ['Explain how mRNA vaccines work, with sources', 'Summarize the transcript of this lecture: youtube.com/watch?v=aircAruvnKk', 'What is the history of the Hanseatic League?'],
    },
    {
      id: 'public-data', persona: 'research', title: 'Pull public statistics',
      why: 'Census, economic and government data answered from the source, with the figures and dates.',
      needs: [
        { label: 'Economic data', q: 'fred economic data series', prefer: ['io.github.stefanoamorelli/fred-mcp-server'] },
        { label: 'Census and government', q: 'census government statistics', cat: 'gov' },
      ],
      prompts: ['What was US CPI inflation for each month this year?', 'What is the median household income in Travis County, Texas?', 'Chart the US unemployment rate since 2019'],
    },

    // ---------- growth ----------
    {
      id: 'competitors', persona: 'growth', title: 'Track competitors',
      why: 'Find competitors’ launches, pricing and messaging from their own pages, and see what changed.',
      needs: [
        { label: 'Web search', q: 'web search news', prefer: ['io.github.brave/brave-search-mcp-server'] },
        { label: 'Read and compare pages', q: 'scrape website changes', prefer: ['io.github.firecrawl/firecrawl-mcp-server'] },
      ],
      prompts: ['What did Linear launch in the last 30 days?', 'Compare pricing tiers of Notion, Coda and ClickUp', 'Summarize the homepage messaging of our top 3 competitors'],
    },
    {
      id: 'social-listening', persona: 'growth', title: 'Hear what people say about a product',
      why: 'Read Reddit, Hacker News and YouTube discussions to find praise, complaints and feature requests.',
      needs: [
        { label: 'Reddit', q: 'reddit posts comments', prefer: ['io.github.karanb192/reddit-mcp-buddy'] },
        { label: 'Hacker News', q: 'hacker news stories', prefer: ['io.github.cyanheads/hn-mcp-server'] },
      ],
      prompts: ['What do people on Reddit complain about with Notion?', 'Summarize the Hacker News discussion on the latest Claude release', 'What features do users ask for most in r/ObsidianMD?'],
    },
    {
      id: 'seo', persona: 'growth', title: 'Plan SEO content',
      why: 'See who ranks for a search, what people ask, and the gaps your page could fill.',
      needs: [{ label: 'SEO and search data', q: 'seo keywords serp ranking', cat: 'commerce' }],
      prompts: ['Who ranks for "best project management tool for startups"?', 'What questions do people ask about home solar batteries?', 'Find keyword gaps between our blog and Zapier’s'],
    },
    {
      id: 'leads', persona: 'growth', title: 'Find and qualify leads',
      why: 'Research companies and people, enrich records and keep your CRM up to date.',
      needs: [
        { label: 'Company and people data', q: 'leads company enrichment b2b', cat: 'commerce' },
        { label: 'CRM', q: 'crm hubspot salesforce contacts deals', prefer: ['io.github.mindstone/mcp-server-hubspot'] },
      ],
      prompts: ['Find Series A fintech companies in Austin hiring a head of sales', 'Which deals in our pipeline have had no activity for 2 weeks?', 'Summarize what Ramp does and who their buyers are'],
    },
    {
      id: 'store', persona: 'growth', title: 'Run an online store',
      why: 'Check orders, inventory and product performance, and update listings, from one conversation.',
      needs: [{ label: 'Store platform', q: 'shopify store orders products', prefer: ['io.github.codespar/mcp-shopify'] }],
      prompts: ['Which products sold best last week?', 'List orders that haven’t shipped after 3 days', 'Which items are low on stock?'],
    },

    // ---------- finance ----------
    {
      id: 'stock-research', persona: 'finance', title: 'Research a stock',
      why: 'Quotes, fundamentals, analyst targets and filings from data sources, not from memory.',
      needs: [
        { label: 'Market data', q: 'stock quote price fundamentals', prefer: ['io.github.narumiruna/yfinance-mcp'] },
        { label: 'SEC filings', q: 'sec edgar filings 10-k', prefer: ['io.github.dgunning/edgartools', 'io.github.stefanoamorelli/sec-edgar-mcp'] },
      ],
      prompts: ['What is Nvidia’s current price, P/E and analyst consensus?', 'Summarize the risk factors in Apple’s latest 10-K', 'Compare revenue growth of AMD and Intel over 5 years'],
    },
    {
      id: 'crypto', persona: 'finance', title: 'Follow crypto markets',
      why: 'Prices, on-chain data and token details from live sources.',
      needs: [{ label: 'Crypto data', q: 'crypto prices coingecko tokens', prefer: ['io.github.cyanheads/coingecko-mcp-server'] }],
      prompts: ['What are the top 10 coins by market cap right now?', 'How has ETH moved against BTC this month?', 'Show the largest wallet holders of a token'],
    },
    {
      id: 'money-ops', persona: 'finance', title: 'Handle payments and invoices',
      why: 'Look up customers, payments, refunds and invoices in your payment and accounting tools.',
      needs: [
        { label: 'Payments', q: 'stripe payments invoices', prefer: ['io.github.codespar/mcp-stripe'] },
        { label: 'Accounting', q: 'accounting quickbooks xero bookkeeping', cat: 'finance' },
      ],
      prompts: ['Which invoices are overdue more than 30 days?', 'How much revenue did we collect in September?', 'Refund the last charge for customer jane@example.com'],
    },
    {
      id: 'fx', persona: 'finance', title: 'Convert currencies and check rates',
      why: 'Live exchange rates and conversions for travel, invoices and pricing.',
      needs: [{ label: 'Exchange rates', q: 'currency exchange rates convert', cat: 'finance' }],
      prompts: ['Convert 2,500 USD to EUR at today’s rate', 'How has the yen moved against the dollar this year?', 'What is 10,000 INR in GBP?'],
    },

    // ---------- work ----------
    {
      id: 'inbox', persona: 'ops', title: 'Get through email and calendar',
      why: 'Summarize threads, draft replies and find time for meetings, with your own accounts.',
      needs: [
        { label: 'Email', q: 'gmail email inbox', prefer: ['io.github.elie222/inbox-zero', 'io.github.ArtyMcLabin/Gmail-MCP-Server'] },
        { label: 'Calendar', q: 'google calendar events schedule', prefer: ['io.github.BuilderIO/agent-native-calendar'] },
      ],
      prompts: ['Summarize unread emails from my team today', 'Find a 30-minute slot with Priya next week', 'Draft a reply declining the vendor demo politely'],
    },
    {
      id: 'tasks', persona: 'ops', title: 'Manage projects and tasks',
      why: 'Create, update and report on tickets and tasks where your team already tracks them.',
      needs: [{ label: 'Project tracker', q: 'jira linear asana tasks issues project management', prefer: ['io.github.b1ff/atlassian-dc-mcp-jira', 'net.todoist/mcp'] }],
      prompts: ['What’s blocking the Q4 launch epic?', 'Create a task to renew the SSL certificate by Friday', 'Summarize what my team closed this sprint'],
    },
    {
      id: 'notes', persona: 'ops', title: 'Search and write your notes',
      why: 'Find what you wrote before and add to it, across Notion, Obsidian or a long-term memory.',
      needs: [
        { label: 'Notes', q: 'notion obsidian notes', prefer: ['io.github.awkoy/notion-mcp-server', 'io.github.cyanheads/obsidian-mcp-server'] },
        { label: 'Long-term memory', q: 'memory knowledge graph remember', prefer: ['io.github.basicmachines-co/basic-memory'] },
      ],
      prompts: ['What did we decide about pricing in last month’s meeting notes?', 'Add today’s standup notes to my Projects page', 'Remember that our staging database is on port 5433'],
    },
    {
      id: 'team-chat', persona: 'ops', title: 'Catch up on team chat',
      why: 'Summarize channels, find decisions and post updates without scrolling.',
      needs: [{ label: 'Chat', q: 'slack discord teams channels messages', prefer: ['io.github.jtalk22/slack-mcp-server'] }],
      prompts: ['Summarize #engineering since yesterday', 'What did we decide about the launch date in #product?', 'Post the release notes to #announcements'],
    },
    {
      id: 'documents', persona: 'ops', title: 'Read and convert documents',
      why: 'Turn PDFs, Word files and scans into text you can search, summarize or compare.',
      needs: [{ label: 'Document conversion', q: 'pdf docx convert markdown ocr', prefer: ['io.github.docling-project/docling-mcp'] }],
      prompts: ['Summarize this contract PDF and list the renewal terms', 'Extract the tables from the attached annual report', 'Compare these two versions of the policy document'],
    },

    // ---------- life ----------
    {
      id: 'weather', persona: 'life', title: 'Check the weather',
      why: 'Forecasts and current conditions from weather services, for anywhere.',
      needs: [{ label: 'Weather', q: 'weather forecast', prefer: ['io.github.isdaniel/mcp_weather_server'] }],
      prompts: ['Will it rain in Seattle this weekend?', 'What’s the 7-day forecast for Lisbon?', 'How windy will it be in Chicago tomorrow afternoon?'],
    },
    {
      id: 'trip', persona: 'life', title: 'Plan a trip',
      why: 'Flights, places, stays and directions from live sources instead of a guess.',
      needs: [
        { label: 'Maps and places', q: 'maps places directions', prefer: ['io.github.cablate/google-map'] },
        { label: 'Flights and stays', q: 'flights hotels airbnb travel booking', cat: 'places' },
      ],
      prompts: ['Find direct flights from SFO to Tokyo in early March', 'Best-rated ramen near Shibuya station', 'Plan a 3-day itinerary in Lisbon with walking times'],
    },
    {
      id: 'jobs', persona: 'life', title: 'Look for a job',
      why: 'Search listings across job boards and compare roles, salaries and companies.',
      needs: [{ label: 'Job listings', q: 'jobs listings hiring', prefer: ['io.github.speedyapply/jobspy'] }],
      prompts: ['Find remote senior data engineer jobs posted this week', 'What do product designer roles in Austin pay?', 'Which companies are hiring Rust developers in Berlin?'],
    },
    {
      id: 'health', persona: 'life', title: 'Look up health and drug information',
      why: 'Drug labels, interactions and medical literature from official sources (not medical advice).',
      needs: [{ label: 'Medical references', q: 'drug fda medical health', cat: 'science' }],
      prompts: ['What does the FDA label say about ibuprofen and blood pressure?', 'Are there interactions between sertraline and ibuprofen?', 'Summarize recent research on sleep and memory'],
    },
    {
      id: 'media', persona: 'life', title: 'Make images, audio and video',
      why: 'Generate or edit images, transcribe audio and cut clips with dedicated media tools.',
      needs: [{ label: 'Media generation', q: 'image generation video audio', cat: 'media' }],
      prompts: ['Make a poster-style image of a lighthouse at dusk', 'Transcribe this podcast episode and list the topics', 'Cut a 30-second highlight from this video'],
    },
  ],

  workflows: [
    {
      id: 'wf-competitor-brief', persona: 'growth', title: 'Weekly competitor brief',
      outcome: 'A page in your notes with each competitor’s launches, pricing changes and messaging this week.',
      steps: [
        { label: 'Find what changed', need: { q: 'web search news', prefer: ['io.github.brave/brave-search-mcp-server'] }, prompt: 'Find launches and announcements from Linear, Asana and ClickUp in the last 7 days' },
        { label: 'Read their pages', need: { q: 'scrape page markdown', prefer: ['io.github.firecrawl/firecrawl-mcp-server'] }, prompt: 'Read their pricing pages and note any changes' },
        { label: 'Save the brief', need: { q: 'notion notes pages', prefer: ['io.github.awkoy/notion-mcp-server'] }, prompt: 'Write a one-page brief and save it to my Competitors page in Notion' },
      ],
    },
    {
      id: 'wf-bug-to-fix', persona: 'dev', title: 'From error alert to fix',
      outcome: 'The failing code found, explained against current docs, and a fix ready to review.',
      steps: [
        { label: 'Get the error', need: { q: 'sentry errors', prefer: ['io.github.getsentry/sentry-mcp'] }, prompt: 'Show the newest unresolved error in the payments service with its stack trace' },
        { label: 'Find the code', need: { q: 'code search symbols repository', prefer: ['io.github.DeusData/codebase-memory-mcp'] }, prompt: 'Find the function in the stack trace and explain what it does' },
        { label: 'Check the right API', need: { q: 'documentation library docs', prefer: ['io.github.upstash/context7'] }, prompt: 'Check the current Stripe Node SDK docs for this call' },
      ],
    },
    {
      id: 'wf-stock-memo', persona: 'finance', title: 'One-page stock memo',
      outcome: 'A memo with price, valuation, recent filings and news, with sources.',
      steps: [
        { label: 'Price and valuation', need: { q: 'stock quote fundamentals', prefer: ['io.github.narumiruna/yfinance-mcp'] }, prompt: 'Get Nvidia’s price, P/E, revenue growth and analyst targets' },
        { label: 'Read the filings', need: { q: 'sec edgar filings', prefer: ['io.github.dgunning/edgartools'] }, prompt: 'Summarize the latest 10-Q: revenue by segment and new risk factors' },
        { label: 'Recent news', need: { q: 'web search news', prefer: ['io.github.brave/brave-search-mcp-server'] }, prompt: 'What news moved Nvidia’s stock in the last two weeks?' },
      ],
    },
    {
      id: 'wf-lit-review', persona: 'research', title: 'Literature review',
      outcome: 'Key papers on a question, what they found, and open questions, saved to your notes.',
      steps: [
        { label: 'Find papers', need: { q: 'arxiv papers', prefer: ['io.github.blazickjp/arxiv-mcp-server'] }, prompt: 'Find the 10 most relevant 2024–2025 papers on LLM agent evaluation' },
        { label: 'Read and compare', need: { q: 'pdf convert papers', prefer: ['io.github.docling-project/docling-mcp'] }, prompt: 'Compare their benchmarks and main findings in a table' },
        { label: 'Keep it', need: { q: 'notes memory', prefer: ['io.github.basicmachines-co/basic-memory'] }, prompt: 'Save the summary and citations as a note called Agent evals review' },
      ],
    },
    {
      id: 'wf-trip', persona: 'life', title: 'Weekend trip plan',
      outcome: 'Flights, weather, places to eat and a day-by-day plan.',
      steps: [
        { label: 'Weather', need: { q: 'weather forecast', prefer: ['io.github.isdaniel/mcp_weather_server'] }, prompt: 'What’s the weather in Lisbon next weekend?' },
        { label: 'Places', need: { q: 'maps places restaurants', prefer: ['io.github.cablate/google-map'] }, prompt: 'Find well-rated seafood restaurants in Alfama' },
        { label: 'Getting there', need: { q: 'flights travel', cat: 'places' }, prompt: 'Find flights from London to Lisbon on Friday evening' },
      ],
    },
    {
      id: 'wf-standup', persona: 'ops', title: 'Daily standup digest',
      outcome: 'What your team did yesterday and what’s blocked, posted to chat.',
      steps: [
        { label: 'Tickets', need: { q: 'jira linear tasks issues', prefer: ['io.github.b1ff/atlassian-dc-mcp-jira'] }, prompt: 'List tickets my team moved to Done or Blocked since yesterday' },
        { label: 'Code', need: { q: 'github pull requests', cat: 'dev' }, prompt: 'List pull requests merged in our main repo since yesterday' },
        { label: 'Post it', need: { q: 'slack messages channels', prefer: ['io.github.jtalk22/slack-mcp-server'] }, prompt: 'Post a short standup summary to #team-daily' },
      ],
    },
    {
      id: 'wf-db-report', persona: 'data', title: 'Metrics report from your database',
      outcome: 'A weekly KPI table computed from live data, with a chart and notes.',
      steps: [
        { label: 'Query the data', need: { q: 'postgres sql database', prefer: ['io.github.bytebase/dbhub'] }, prompt: 'Compute weekly signups, activations and revenue for the last 8 weeks' },
        { label: 'Chart it', need: { q: 'chart visualization diagram', cat: 'media' }, prompt: 'Make a line chart of the three series' },
        { label: 'Share it', need: { q: 'slack email send', cat: 'comms' }, prompt: 'Send the table and chart to #metrics with two sentences on what changed' },
      ],
    },
    {
      id: 'wf-launch-listen', persona: 'growth', title: 'Launch-day listening',
      outcome: 'What people say about your launch across Reddit, Hacker News and the web, with quotes.',
      steps: [
        { label: 'Hacker News', need: { q: 'hacker news', prefer: ['io.github.cyanheads/hn-mcp-server'] }, prompt: 'Find Hacker News threads about our launch today and summarize the comments' },
        { label: 'Reddit', need: { q: 'reddit', prefer: ['io.github.karanb192/reddit-mcp-buddy'] }, prompt: 'Search Reddit for posts mentioning our product this week' },
        { label: 'Web coverage', need: { q: 'web search news', prefer: ['io.github.tavily-ai/tavily-mcp'] }, prompt: 'Find articles and blog posts covering the launch' },
      ],
    },
  ],
};
