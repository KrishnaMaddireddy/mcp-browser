#!/usr/bin/env node
// Terminal front end:  mcpb "your question"   |  mcpb --sync  |  mcpb --servers weather
import { createEngine } from '../src/app.js';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--servers', '--use', '--rank', '--limit', '--rank-export', '--rank-method', '--subregistry-export', '--top-stars'].includes(args[i - 1])));

if (flag('--help') || (!positional.length && !flag('--sync') && !flag('--full-sync') && value('--servers') === undefined && value('--rank') === undefined && value('--rank-export') === undefined && value('--rank-method') === undefined && value('--subregistry-export') === undefined && !flag('--stars') && !flag('--top-stars'))) {
  console.log(`MCP Browser CLI

  mcpb "question"            search (writes the answer to stdout)
  mcpb --use exa,deepwiki "q" only use these server ids
  mcpb --free "question"     skip the AI model, show raw server results
  mcpb --sync                update the local copy of the MCP Registry
  mcpb --full-sync           download the whole registry again
  mcpb --servers "topic"     show which servers match a topic
  mcpb --rank web-search [--limit 20] [--no-ai|--ai-all]
                             MCP Rank: test servers in a category
  mcpb --rank-export labels.json   per-server labels (JSON) from the last runs
  mcpb --rank-method METHOD.md     write the methodology page
  mcpb --stars [--limit N]   refresh GitHub stars (uses GITHUB_TOKEN if set)
  mcpb --top-stars [topic]   most-starred servers, optionally on a topic
  mcpb --subregistry-export r.json ranked servers in MCP Registry API format
                             (web-search, encyclopedia, papers, dev-docs,
                              geography, money, travel)

Settings live in ~/.mcp-browser/settings.json (or set ANTHROPIC_API_KEY / OPENAI_API_KEY).`);
  process.exit(0);
}

const engine = createEngine(flag('--free') ? { providerOverride: null } : {});
const dim = (s) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

try {
  if (flag('--sync') || flag('--full-sync')) {
    process.stderr.write('Syncing the MCP Registry…\n');
    const r = await engine.syncRegistry({ full: flag('--full-sync') });
    console.log(`Done: ${r.kept} keyless remote servers (${r.seen} records read, ${r.incremental ? 'incremental' : 'full'}).`);
  } else if (value('--rank-export') !== undefined) {
    const { exportLabels } = await import('../src/rank.js');
    const fs = await import('node:fs');
    const out = value('--rank-export');
    const data = exportLabels();
    fs.writeFileSync(out, JSON.stringify(data, null, 1));
    console.log(`Wrote ${data.servers.length} server labels to ${out}`);
  } else if (value('--subregistry-export') !== undefined) {
    const { listServers } = await import('../src/subregistry.js');
    const all = [];
    let cursor = '';
    do {
      const page = listServers(engine, new URLSearchParams({ ranked_only: 'true', sort: 'rank', limit: '100', ...(cursor ? { cursor } : {}) }));
      // Servers you added yourself (often internal URLs) never go into a shareable file.
      all.push(...page.servers.filter((x) => !x.server.name.startsWith('local.mcp-browser.custom/')));
      cursor = page.metadata.nextCursor || '';
    } while (cursor);
    (await import('node:fs')).writeFileSync(value('--subregistry-export'), JSON.stringify({ servers: all, metadata: { count: all.length } }, null, 1));
    console.log(`Wrote ${all.length} ranked servers in MCP Registry format to ${value('--subregistry-export')}`);
  } else if (value('--rank-method') !== undefined) {
    const { methodologyMarkdown } = await import('../src/rank.js');
    (await import('node:fs')).writeFileSync(value('--rank-method'), methodologyMarkdown());
    console.log(`Wrote methodology to ${value('--rank-method')}`);
  } else if (value('--rank') !== undefined) {
    const cat = value('--rank');
    const r = await engine.runRank(cat, {
      limit: Number(value('--limit')) || 20,
      onProgress: undefined,
      useAi: !flag('--no-ai'),
      aiMode: flag('--ai-all') ? 'always' : 'fallback',
    });
    console.log(`MCP Rank — ${r.title} (${r.results.length} servers, ${r.tests.length} known-answer questions${r.aiAssisted ? ', AI-assisted' : ''})\n`);
    r.results.forEach((x, i) => {
      const acc = x.accuracy == null ? '  n/a' : `${Math.round(x.accuracy * 100)}%`.padStart(5);
      const ms = x.medianMs == null ? '    -' : `${(x.medianMs / 1000).toFixed(1)}s`.padStart(5);
      const avg = x.runs > 1 ? `avg ${String(x.avgScore).padStart(3)} (${x.runs} runs)` : '               ';
      console.log(`${String(i + 1).padStart(2)}. ${String(x.score).padStart(3)}  ${avg}  acc ${acc}  ${ms}  ${x.title.slice(0, 36).padEnd(36)} ${x.id}`);
      for (const issue of x.issues.slice(0, 3)) console.log(`        - ${issue}`);
    });
  } else if (flag('--stars')) {
    const before = engine.stars.size;
    engine.refreshStars({ limit: Number(value('--limit')) || undefined });
    while (engine.starsInfo().running) {
      const p = engine.starsInfo().progress;
      process.stderr.write(`\r${p?.done ?? 0}/${p?.total ?? '?'} repos`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const st = engine.starsInfo();
    console.log(`\nStars known for ${st.repos} repos (was ${before}) from ${st.source}.${st.error ? ` Stopped early: ${st.error}` : ''}`);
  } else if (flag('--top-stars')) {
    const q = value('--top-stars');
    let list = engine.catalog.all();
    if (q && !q.startsWith('--')) {
      // Same relevance cut as the servers page: clearly on-topic matches only.
      const w = (r) => r.score * (r.server.source === 'registry' ? 1 : 1.4);
      const scored = engine.catalog.score(q).sort((a, b) => w(b) - w(a));
      list = scored.filter((r) => w(r) >= 0.3 * w(scored[0])).map((r) => r.server);
    }
    const seen = new Set();
    const rows = list
      .map((s) => ({ s, g: engine.starsFor(s) }))
      .filter((x) => x.g?.stars != null)
      .sort((a, b) => b.g.stars - a.g.stars)
      .filter((x) => !seen.has(x.g.repo) && seen.add(x.g.repo)) // one row per repo
      .slice(0, Number(value('--limit')) || 25);
    for (const { s, g } of rows) {
      const rank = engine.catalog.rankScores?.get(s.id);
      console.log(`${String(g.stars).padStart(7)} ★  ${(rank != null ? `rank ${rank}` : '').padEnd(8)} ${s.id.padEnd(44)} ${g.repo}${g.sharedWith ? dim(` (+${g.sharedWith} servers)`) : ''}${g.archived ? ' [archived]' : ''}${g.otherOwner ? ' [other owner]' : ''}`);
    }
  } else if (value('--servers') !== undefined) {
    const q = value('--servers');
    for (const r of engine.catalog.score(q).sort((a, b) => b.score - a.score).slice(0, 15)) {
      console.log(`${r.score.toFixed(2).padStart(6)}  ${r.server.id.padEnd(40)} ${r.server.title}`);
    }
  } else {
    const query = positional.join(' ');
    const use = value('--use')?.split(',').map((s) => s.trim()).filter(Boolean);
    let streamed = false;
    const emit = (type, d) => {
      if (type === 'route') process.stderr.write(dim(`→ ${d.servers.map((s) => s.title).join(', ')}\n`));
      else if (type === 'server' && d.status === 'failed') process.stderr.write(dim(`  ✗ ${d.id}: ${d.error}\n`));
      else if (type === 'tool_call') process.stderr.write(dim(`  · ${d.serverTitle} ${d.tool}\n`));
      else if (type === 'step' && d.n > 1 && streamed) {
        process.stdout.write('\n');
        streamed = false;
      } else if (type === 'text') {
        process.stdout.write(d.delta);
        streamed = true;
      } else if (type === 'results') console.log(`\n## ${d.serverTitle} (${d.tool})\n${d.text.slice(0, 3000)}`);
      else if (type === 'error') process.stderr.write(`error: ${d.message}\n`);
    };
    const r = await engine.agent.search(query, { emit, servers: use });
    if (r.sources.length) {
      console.log('\n\nSources:');
      for (const s of r.sources) console.log(`[${s.n}] ${s.title} — ${s.url}`);
    }
  }
} catch (e) {
  console.error('error:', e.message);
  process.exitCode = 1;
} finally {
  await engine.close();
}
