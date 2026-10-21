// Keyword rules that put each MCP server in one primary category (plus up to two
// secondary ones). Words in the title count 3x, in the name 2x, in the
// description 1x. Patterns are matched on word starts, case-insensitive.
export const CATEGORIES = [
  ['search', 'Web search & scraping', ['web search', 'search engine', 'serp', 'google search', 'bing', 'brave search', 'tavily', 'exa', 'perplexity', 'crawl', 'scrap*', 'firecrawl', 'web page', 'webpage', 'extract content', 'fetch url', 'web content', 'duckduckgo', 'searxng']],
  ['browser', 'Browser automation', ['browser', 'playwright', 'puppeteer', 'selenium', 'headless', 'chrome', 'web automation', 'screenshot']],
  ['dev', 'Developer tools', ['github', 'gitlab', 'bitbucket', 'git ', 'repository', 'pull request', 'code review', 'coding', 'codebase', 'source code', 'ide', 'vscode', 'lint', 'compiler', 'npm', 'pypi', 'package', 'sdk', 'api testing', 'openapi', 'swagger', 'graphql', 'unit test', 'testing', 'debug', 'refactor', 'typescript', 'python', 'rust', 'golang', 'java', 'shell', 'terminal', 'command line', 'cli', 'ci/cd', 'jenkins', 'figma to code', 'documentation lookup', 'library docs', 'context7']],
  ['cloud', 'Cloud & DevOps', ['aws', 'amazon web services', 'azure', 'gcp', 'google cloud', 'kubernetes', 'k8s', 'docker', 'container', 'terraform', 'pulumi', 'helm', 'devops', 'deploy*', 'vercel', 'netlify', 'cloudflare', 'heroku', 'render', 'fly.io', 'serverless', 'lambda', 'infrastructure', 'dns', 'domain', 'hosting', 'server management', 'ssh']],
  ['observe', 'Monitoring & observability', ['monitor*', 'observability', 'logging', 'logs', 'sentry', 'datadog', 'grafana', 'prometheus', 'new relic', 'opentelemetry', 'tracing', 'metrics', 'alert', 'incident', 'uptime', 'pagerduty', 'apm', 'analytic*']],
  ['data', 'Databases & data', ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'mongo', 'redis', 'supabase', 'firebase', 'snowflake', 'bigquery', 'databricks', 'clickhouse', 'duckdb', 'elasticsearch', 'neo4j', 'graph database', 'vector database', 'pinecone', 'qdrant', 'weaviate', 'data warehouse', 'etl', 'dataset', 'csv', 'spreadsheet', 'excel', 'airtable', 'query', 'dbt', 'kafka']],
  ['ai', 'AI, LLMs & agents', ['llm', 'openai', 'gpt', 'gemini', 'language model', 'ai model', 'foundation model', 'multi-agent', 'agent framework', 'agent orchestration', 'agentic workflow', 'prompt', 'embedding', 'rag', 'retrieval', 'inference', 'machine learning', 'ml ', 'hugging', 'ollama', 'reasoning', 'thinking', 'a2a', 'orchestrat*', 'image generation', 'text-to']],
  ['memory', 'Memory & knowledge', ['memory', 'knowledge base', 'knowledge graph', 'notes', 'note-taking', 'obsidian', 'notion', 'confluence', 'wiki', 'second brain', 'bookmark', 'personal knowledge', 'roam', 'logseq', 'documentation', 'docs']],
  ['productivity', 'Productivity & project management', ['calendar', 'todo', 'to-do', 'task', 'project management', 'jira', 'linear', 'asana', 'trello', 'clickup', 'monday', 'basecamp', 'todoist', 'schedul*', 'meeting', 'time tracking', 'productivity', 'workflow', 'zapier', 'n8n', 'make.com', 'automat*', 'google workspace', 'office 365', 'microsoft 365', 'onedrive', 'sharepoint', 'forms']],
  ['comms', 'Communication & email', ['email', 'gmail', 'outlook', 'smtp', 'imap', 'mail', 'slack', 'discord', 'telegram', 'whatsapp', 'sms', 'twilio', 'teams', 'chat', 'messag*', 'voice', 'phone call', 'notif*', 'push notification', 'newsletter', 'zoom']],
  ['social', 'Social media & news', ['twitter', 'tweet', 'x.com', 'reddit', 'linkedin', 'facebook', 'instagram', 'tiktok', 'youtube', 'bluesky', 'mastodon', 'social media', 'hacker news', 'news', 'rss', 'podcast', 'influencer', 'threads']],
  ['finance', 'Finance & markets', ['stock', 'finance', 'financ*', 'trading', 'market data', 'forex', 'currency', 'exchange rate', 'invest*', 'portfolio', 'sec filing', 'edgar', 'earnings', 'accounting', 'bookkeeping', 'quickbooks', 'xero', 'tax', 'bank', 'payment', 'stripe', 'paypal', 'invoice', 'billing', 'expense', 'budget', 'credit', 'loan', 'insurance']],
  ['crypto', 'Crypto & web3', ['crypto', 'blockchain', 'web3', 'bitcoin', 'ethereum', 'solana', 'defi', 'wallet', 'token', 'nft', 'onchain', 'on-chain', 'smart contract', 'dex', 'swap', 'polymarket', 'x402', 'usdc', 'base chain', 'evm', 'staking']],
  ['commerce', 'Commerce, sales & marketing', ['ecommerce', 'e-commerce', 'shopify', 'woocommerce', 'amazon seller', 'product catalog', 'shopping', 'store', 'crm', 'salesforce', 'hubspot', 'pipedrive', 'sales', 'lead', 'marketing', 'seo', 'ads', 'advertising', 'google ads', 'campaign', 'customer support', 'zendesk', 'intercom', 'helpdesk', 'review', 'affiliate', 'coupon', 'price']],
  ['media', 'Media, design & creative', ['image', 'photo', 'video', 'audio', 'music', 'spotify', 'speech', 'text-to-speech', 'tts', 'transcri*', 'figma', 'canva', 'design', 'svg', 'diagram', 'chart', 'mermaid', '3d', 'blender', 'unity', 'game', 'animation', 'font', 'icon', 'presentation', 'slides', 'ffmpeg', 'stock photo', 'art']],
  ['files', 'Files & documents', ['file', 'filesystem', 'pdf', 'docx', 'word document', 'markdown', 'document', 'ocr', 'convert', 'google drive', 'dropbox', 'box.com', 's3', 'storage', 'upload', 'zip', 'archive', 'epub']],
  ['places', 'Maps, travel & weather', ['map', 'geo', 'location', 'gps', 'places', 'address', 'weather', 'forecast', 'climate', 'travel', 'flight', 'hotel', 'airbnb', 'booking', 'trip', 'transit', 'route', 'navigation', 'real estate', 'property', 'restaurant', 'airport', 'train', 'tourism', 'events near']],
  ['science', 'Science, health & education', ['research', 'paper', 'arxiv', 'pubmed', 'scholar', 'academic', 'citation', 'science', 'scientific', 'chemistry', 'biology', 'protein', 'gene', 'clinical', 'medical', 'health', 'patient', 'fhir', 'drug', 'fda', 'nutrition', 'fitness', 'educat*', 'learning', 'course', 'student', 'math', 'physics', 'astronomy', 'nasa', 'wikipedia', 'dictionary', 'translat*', 'language']],
  ['security', 'Security & identity', ['security', 'vulnerability', 'cve', 'pentest', 'penetration', 'malware', 'threat', 'osint', 'firewall', 'secret', 'password', 'vault', 'auth', 'oauth', 'identity', 'sso', 'compliance', 'audit', 'scan', 'phishing', 'encryption', 'privacy', 'kyc', 'fraud', 'verify', 'verification']],
  ['gov', 'Government, legal & public data', ['government', 'federal', 'census', 'legal', 'law', 'court', 'patent', 'trademark', 'regulation', 'policy', 'public data', 'open data', 'election', 'congress', 'legislation', 'contract', 'procurement', 'grant', 'nonprofit', 'usaspending', 'statistics', 'economic data', 'fred', 'world bank']],
  ['util', 'Utilities & converters', ['clock', 'time zone', 'timezone', 'current time', 'date', 'calendar math', 'convert*', 'converter', 'calculat*', 'charset', 'encod*', 'decod*', 'base64', 'base58', 'hash', 'uuid', 'json', 'yaml', 'toml', 'xml', 'unit conversion', 'random', 'regex', 'format*', 'validat*', 'checksum', 'count', 'word count', 'qr code', 'url shortener', 'password generator', 'lorem', 'diff', 'parse', 'parser', 'math', 'utility', 'utilities', 'toolkit']],
  ['iot', 'Devices, IoT & smart home', ['iot', 'smart home', 'home assistant', 'device', 'sensor', 'arduino', 'raspberry', 'robot', 'drone', 'mqtt', 'bluetooth', 'hardware', 'car', 'vehicle', 'tesla', 'printer', 'android', 'ios', 'macos', 'windows']],
];

const LABEL = Object.fromEntries(CATEGORIES.map(([id, label]) => [id, label]));
export const labelOf = (id) => LABEL[id] || 'Other';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words (with an optional plural s/es); a trailing * means "starts with".
const RULES = CATEGORIES.map(([id, , words]) => [id, words.map((w) => {
  const t = w.trim();
  return t.endsWith('*') ? new RegExp(`(?:^|[^a-z0-9])${esc(t.slice(0, -1))}`, 'i') : new RegExp(`(?:^|[^a-z0-9])${esc(t)}(?:s|es)?(?![a-z0-9])`, 'i');
})]);

// A few words are so generic they shouldn't decide a category by themselves.
const WEAK = new Set(['ai', 'dev']);

// Phrases nearly every MCP description uses ("for AI agents", "Claude, Cursor")
// say who the server is for, not what it does.
const BOILER = /\b(?:ai[- ]powered|ai[- ]native|(?:ai|llm|coding|your)\s+(?:agents?|assistants?|clients?|tools?)|agents?|assistants?|claude(?: desktop| code)?|cursor|windsurf|cline|chatgpt|copilot|llms?|mcp(?: server| clients?| tools?)?|model context protocol)\b/gi;
const strip = (s) => s.toLowerCase().replace(BOILER, ' ');

export function categorize({ title = '', name = '', description = '' }) {
  const fields = [[strip(title), 3], [name.toLowerCase().split('/').pop().replace(/[._-]+/g, ' '), 2], [strip(description), 1]];
  const scores = [];
  for (const [id, res] of RULES) {
    let sc = 0;
    for (const re of res) for (const [text, w] of fields) if (text && re.test(text)) sc += w;
    if (sc) scores.push([id, WEAK.has(id) ? sc * 0.7 : sc]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  if (!scores.length) return { cat: 'other', also: [] };
  const top = scores[0][1];
  return { cat: scores[0][0], also: scores.slice(1, 3).filter((s) => s[1] >= Math.max(2, top * 0.5)).map((s) => s[0]) };
}
