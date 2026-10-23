// The checks from the command line, and for CI:
//   mcpb deps [path | GitHub link] [--format md|json|text] [--fail-on high] [--output report.md]
//   mcpb check "a claim"            one claim
//   mcpb check --file answer.txt    each fact in a text (or text on stdin: mcpb check -)
// Exit codes: 0 = done (and nothing crossed --fail-on), 1 = --fail-on crossed or a false claim
// with --fail-on any, 2 = couldn't run (bad input, nothing checked).
import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from '../src/app.js';
import { checkDependencies, depsMarkdown, failsOn, FAIL_LEVELS, checkClaim, claimMarkdown, checkParagraph, paragraphMarkdown } from '../src/reports.js';
import { readDependencyFile } from '../src/mcp-server.js';
import { loadCatalog } from '../src/catalog-index.js';
import { DEP_TITLES } from '../src/deps.js';

// A folder: its lockfile first (the versions installed), else its manifest.
const PREFERRED = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml'];

const HELP = `MCP Browser checks

  mcpb deps [path]            check a lockfile or manifest (default: the one in this folder)
  mcpb deps <GitHub link>     check a public repo's dependency files
      --format md|json|text   output (default: md on a pipe or file, text in a terminal)
      --fail-on LEVEL         exit 1 if a package has a known vulnerability at LEVEL or worse:
                              any, low, moderate, high, critical (default: never)
      --output FILE           also write the report to FILE
      --json FILE             also write the results as JSON to FILE
      --max N                 check up to N packages from a lockfile (default 1000; direct ones first)
      --compact               Markdown for a pull request: problems open, the clean rest folded
  mcpb check "a claim"        is it true? quotes each independent source's own sentence
  mcpb check --file F         each plain fact in a text file (- reads stdin)
      --format md|json|text

Only package names and versions are sent to the checking services (osv-advisory.caseyjhand.com,
security.datakoot.com, package.datakoot.com); a GitHub link is read through pagefetch.openkrill.app.`;

function opt(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function findDependencyFile(dir) {
  for (const f of PREFERRED) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  const req = fs.readdirSync(dir).find((f) => /^requirements[\w.-]*\.txt$/.test(f));
  return req ? path.join(dir, req) : null;
}

// Terminal text: the Markdown with its table and escapes made plain.
const plain = (m) => m.replace(/\[([^\]\n]*)\]\((https?:[^)\s]+)\)/g, '$1 ($2)').replace(/\\([\\`*_[\]<>!|#])/g, '$1').replace(/\*\*/g, '').replace(/^#+ /gm, '');

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const valued = new Set(['--format', '--fail-on', '--output', '--file', '--json', '--max']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  const format = opt(args, '--format') || (process.stdout.isTTY ? 'text' : 'md');
  if (!['md', 'json', 'text'].includes(format)) {
    console.error('--format takes md, json or text');
    return 2;
  }
  // (checked before anything runs: a typo in CI must not pass as "nothing to report")
  const failOn = opt(args, '--fail-on');
  if (failOn !== undefined && !FAIL_LEVELS.includes(String(failOn).toLowerCase())) {
    console.error('--fail-on takes any, low, moderate, high, critical or never');
    return 2;
  }
  const maxArg = opt(args, '--max');
  if (maxArg !== undefined && !(Number.isInteger(Number(maxArg)) && Number(maxArg) > 0)) {
    console.error('--max takes a whole number of packages, e.g. --max 2000');
    return 2;
  }
  const engine = createEngine({ providerOverride: null });
  const write = (report, json) => {
    const out = format === 'json' ? JSON.stringify(json, null, 1) : format === 'text' ? plain(report) : report;
    console.log(out);
    const file = opt(args, '--output');
    if (file) fs.writeFileSync(file, format === 'json' ? out : report + '\n');
    // (CI: the Markdown for people and the JSON for the next step, from one run)
    const jsonFile = opt(args, '--json');
    if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(json, null, 1));
  };
  try {
    if (cmd === 'deps') {
      const target = positional[0] || '.';
      let text = '';
      let repo = '';
      if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(target)) repo = target;
      else {
        let file = target;
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          file = findDependencyFile(target);
          if (!file) {
            console.error(`No lockfile or manifest in ${path.resolve(target)}.`);
            return 2;
          }
        }
        text = readDependencyFile(file);
        if (format === 'text') console.error(`Checking ${path.relative(process.cwd(), path.resolve(file)) || file}…`);
      }
      const res = await checkDependencies({ text, repo, max: Number(maxArg) || 1000, callTool: (id, tool, args2, o) => engine.callCatalogTool(id, tool, args2, o), titleOf: (id) => engine.catalog.get(id)?.title || loadCatalog()?.byName.get(id)?.[loadCatalog().F.title] || DEP_TITLES[id] || id });
      if (res.error) {
        console.error(res.error);
        return 2;
      }
      write(depsMarkdown(res, { limit: 1000, compact: args.includes('--compact') }), { summary: res.summary, servers: res.servers, source: res.source, packages: res.rows });
      if (!res.summary?.checked) return 2;
      return failOn && failsOn(res.rows, failOn) ? 1 : 0;
    }
    if (cmd === 'check') {
      const file = opt(args, '--file');
      if (file || positional[0] === '-') {
        const t = file && file !== '-' ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
        const res = await checkParagraph(engine.agent, t);
        if (!res.claims.some((c) => c.claim)) {
          console.error('No plain facts to check in that text.');
          return 2;
        }
        const facts = res.claims.filter((c) => c.claim);
        write(paragraphMarkdown(res), { facts: res.claims.map((c) => ({ sentence: c.sentence, claim: c.claim || null, skip: c.skip || null, verdict: c.result?.verdict || null, label: c.result?.label || null, evidence: c.result?.evidence || [] })) });
        if (!facts.some((c) => c.result)) return 2; // (every check failed: nothing was checked)
        return failOn === 'any' && res.claims.some((c) => c.result?.verdict === 'contradicted') ? 1 : 0;
      }
      const claim = positional.join(' ').trim();
      if (!claim) {
        console.error('Give a claim, e.g. mcpb check "The Eiffel Tower is 330 meters tall"');
        return 2;
      }
      const r = await checkClaim(engine.agent, claim);
      write(claimMarkdown(claim, r), { claim, verdict: r.verdict, label: r.label, supports: r.supports, differs: r.differs, mentions: r.mentions, evidence: r.evidence });
      return failOn === 'any' && r.verdict === 'contradicted' ? 1 : 0;
    }
    console.error(`Unknown command ${cmd}.\n\n${HELP}`);
    return 2;
  } catch (e) {
    console.error(String(e?.message || e));
    return 2;
  } finally {
    await engine.close?.().catch(() => {});
  }
}
