// The checks as plain functions with Markdown reports, for callers outside the browser page:
// the MCP server (Claude Desktop, Claude Code, Cursor), the command line and the GitHub Action.
// The page streams the same work over SSE (src/server.js); these collect it and write it up.
// Everything in a report that came from a server or a page is escaped: names, summaries and
// quotes are third-party text, so they can't add links, images or HTML of their own.
import { crossCheck, claimsIn } from './crosscheck.js';
import { parseManifest, runDeps, repoOf, fetchRepoDeps } from './deps.js';

export const SEV_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MODERATE: 'Moderate', MEDIUM: 'Medium', LOW: 'Low' };
const SEV_RANK = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Markdown-safe text: one line, no markup of its own, and no control or direction-override
 * characters (they could rewrite a terminal or reorder what a reader sees).
 */
export const md = (x) =>
  String(x ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>!|#]/g, '\\$&');
/**
 * For GitHub (a pull request comment, a job summary): third-party text can't mention people
 * ("@user", "@org/team") or become a link ("https://…"); a word joiner breaks both, invisibly.
 */
export const ghSafe = (t) => String(t).replace(/@(?=[\p{L}\p{N}_-])/gu, '@⁠').replace(/:\/\//g, ':⁠//').replace(/\bwww\./gi, 'www⁠.');
const mdText = (x) => md(x);
/** A link target that can't break out of its parentheses. */
export const mdUrl = (u) => (/^https?:\/\//i.test(u || '') ? String(u).replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : '');

// ---------- Dependency check ----------

/**
 * Check a manifest, a lockfile or a public GitHub repo link.
 * Returns { rows, summary, servers, start, source, error }. Never throws for a server that
 * didn't answer: rows say "not checked" instead.
 */
export async function checkDependencies({ text = '', repo = '', callTool, titleOf = (id) => id, signal, max } = {}) {
  const servers = {};
  const rows = [];
  let start = null;
  let source = null;
  let summary = null;
  const emit = (type, d) => {
    if (type === 'deps_row') rows.push(d);
    else if (type === 'deps_server') servers[d.key] = d;
    else if (type === 'deps_start') start = d;
    else if (type === 'deps_source') source = d;
    else if (type === 'deps_done') summary = d.summary;
  };
  const call = (id, tool, args) => callTool(id, tool, args, { signal });
  const r = repoOf(repo || (String(text).trim().split(/\s+/).length === 1 ? text : ''));
  let pkgs;
  if (r) {
    const got = await fetchRepoDeps(r, { callTool: call, emit, ...(max ? { max } : {}) });
    if (!got.pkgs) return { rows, summary: null, servers, start, source, error: got.found?.length ? `${r.owner}/${r.repo} has ${got.found.join(', ')}, but no packages could be read from it.` : `No lockfile or manifest found at the top of ${r.owner}/${r.repo}${r.dir ? `/${r.dir}` : ''}.` };
    pkgs = got.pkgs;
  } else {
    pkgs = parseManifest(text, max ? { max } : {});
    if (!pkgs.length) return { rows, summary: null, servers, start, source, error: 'No packages found. Give a package.json, requirements.txt, pyproject.toml, Cargo.toml, a lockfile, or a GitHub repo link.' };
  }
  await runDeps(pkgs, { callTool: call, titleOf, emit });
  return { rows, summary, servers, start, source, error: null };
}

/** The worst severity among packages with known advisories ('' when none). */
export function worstSeverity(rows) {
  let best = '';
  for (const r of rows) if (r.worst && (SEV_RANK[r.worst] || 0) > (SEV_RANK[best] || 0)) best = r.worst;
  return best;
}

/** How many known vulnerabilities a row has: the advisories listed, or a service's own count. */
export const vulnCount = (r) => Math.max(r.vulns?.length || 0, r.partial ? r.counts?.osv || 0 : 0, r.counts?.audit || 0);

export const FAIL_LEVELS = ['any', 'low', 'moderate', 'medium', 'high', 'critical', 'never', 'none'];

/** Does this result cross a --fail-on line (low | moderate | high | critical | any)? */
export function failsOn(rows, level) {
  const lv = String(level || '').toLowerCase();
  if (!FAIL_LEVELS.includes(lv) && lv) throw new Error('--fail-on takes any, low, moderate, high, critical or never');
  if (!lv || lv === 'never' || lv === 'none') return false;
  const vulnerable = rows.filter((r) => vulnCount(r) > 0);
  if (lv === 'any') return vulnerable.length > 0;
  const need = { low: 1, moderate: 2, medium: 2, high: 3, critical: 4 }[lv];
  // (a vulnerability with no severity label fails at every level: unknown isn't "low")
  return vulnerable.some((r) => (r.worst ? SEV_RANK[r.worst] || 0 : 4) >= need);
}

/** The report as Markdown: a verdict line, the table (problems first), the advisories. */
export function depsMarkdown({ rows, summary, servers = {}, start, source }, { title = 'Dependency check', limit = 200, compact = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  // (on GitHub, third-party text also can't mention anyone or turn into a link)
  const md = compact ? (x) => ghSafe(mdText(x)) : mdText;
  const s = summary || { checked: 0, vulnerable: 0, high: 0, deprecated: 0, unchecked: rows.length };
  const ok = Object.values(servers).filter((x) => x.ok && x.key !== 'health');
  const notChecked = rows.filter((r) => !r.checked).length;
  const head = !s.checked
    ? `Nothing was checked: no vulnerability service answered${ok.length ? ' for these packages' : ''}. This is not a clean result.`
    : s.vulnerable
      ? `${s.vulnerable} of ${s.checked} package${s.checked === 1 ? '' : 's'} ${s.vulnerable === 1 ? 'has' : 'have'} known vulnerabilities${s.high ? `, ${s.high} with high or critical ones` : ''}`
      : `No known vulnerabilities in ${s.checked} package${s.checked === 1 ? '' : 's'}`;
  // (never only the clean part: the ones nobody looked at are said in the same line)
  const out = [`## ${md(title)}: ${head}${s.checked && notChecked ? `; ${notChecked} not checked` : ''}${s.deprecated ? `; ${s.deprecated} deprecated` : ''}`, ''];
  const used = Object.values(servers).filter((x) => x.ok).map((x) => md(x.title));
  out.push(`Checked ${date} with ${used.length ? used.join(', ') : 'no service'} (OSV.dev data), by [MCP Browser](https://github.com/KrishnaMaddireddy/mcp-browser). Known means published in OSV.dev; a clean result isn't proof of safety.`);
  if (source?.files?.length) out.push('', `From ${md(source.repo)}${source.dir ? `/${md(source.dir)}` : ''}: ${source.files.map((f) => `${md(f.file.replace(/^\//, ''))}${f.truncated ? ' (first part only)' : ''}`).join(', ')}.`);
  if (start?.lockfile) out.push('', `From the lockfile: the versions installed${start.total > start.packages ? `; the first ${start.packages} of ${start.total} checked${start.directKnown ? ', direct ones first' : ''}` : ''}.`);
  // (which direct dependency brings most of the problems in)
  const bad = rows.filter((r) => vulnCount(r) > 0);
  const tally = new Map();
  for (const r of bad) for (const v of r.indirect ? r.via || [] : [r.name]) tally.set(v, (tally.get(v) || 0) + 1);
  const [topName, topN] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
  if (topName && topN > 1 && bad.length > 1) out.push('', `**${topN === bad.length ? `All ${topN}` : `${topN} of ${bad.length}`} packages with known vulnerabilities come in through ${md(topName)}.** Updating it is the place to start.`);
  // Worst first, then deprecated, then not checked, then clean (so a cut drops clean ones first).
  const rank = (r) => (vulnCount(r) ? 10 + (SEV_RANK[r.worst] ?? 5) : r.deprecated ? 3 : !r.checked ? 2 : 0);
  const sorted = [...rows].sort((a, b) => rank(b) - rank(a));
  const shown = sorted.slice(0, limit);
  const header = ['| Package | Version | Known vulnerabilities | Fixed in | Latest | Notes |', '|---|---|---|---|---|---|'];
  const line = (r) => {
    const n = vulnCount(r);
    const vul = !r.version ? 'not pinned' : !r.checked ? 'not checked' : n ? `${n}${r.worst ? ` (${SEV_LABEL[r.worst] || md(r.worst)})` : ''}` : 'none known';
    const notes = [r.deprecated ? 'deprecated' : '', r.maintained === false && !r.deprecated ? 'not maintained' : '', r.dev ? 'dev' : '', r.indirect ? (r.via?.length ? `via ${md(r.via.join(', '))}` : 'indirect') : ''].filter(Boolean).join(', ');
    return `| ${md(r.name)} (${md(r.ecosystem)}) | ${md(r.version || r.range || '—')} | ${vul} | ${r.unfixed ? 'no fix yet' : md(r.fix || '')} | ${md(r.latest || '')} | ${notes} |`;
  };
  const advLine = (r, v) => `- **${md(r.name)} ${md(r.version)}** ${SEV_LABEL[v.severity] || md(v.severity) || ''}: ${md(v.summary || v.id)} ([${md(v.id)}](https://osv.dev/vulnerability/${encodeURIComponent(v.id)})${v.aliases?.length ? `, ${md(v.aliases.join(', '))}` : ''})${v.fixedVersions?.length ? `, fixed in ${md(v.fixedVersions.join(', '))}` : ''}`;
  const adv = rows.filter((r) => r.vulns.length).sort((a, b) => rank(b) - rank(a));
  const cutNote = (left) => {
    const lc = left.filter((r) => !r.checked).length;
    const lv = left.filter((r) => vulnCount(r) > 0).length;
    return `… and ${left.length} more: ${[lv && `${lv} with known vulnerabilities`, lc && `${lc} not checked`, left.length - lv - lc && `${left.length - lv - lc} with no known vulnerabilities`].filter(Boolean).join(', ')}.`;
  };
  if (compact) {
    // A pull request comment: problems in the open, the rest folded. GitHub takes up to 65,536
    // characters, so every part has a share of about 50,000 and stops with a count.
    let room = 50000 - out.join('\n').length;
    const take = (list, toLine, share) => {
      const lines = [];
      let left = share;
      for (const x of list) {
        const l = toLine(x);
        if ((left -= l.length + 1) < 0) break;
        lines.push(l);
      }
      room -= share - Math.max(0, left);
      return lines;
    };
    const problem = shown.filter((r) => vulnCount(r) > 0 || r.deprecated);
    const unchecked = shown.filter((r) => !problem.includes(r) && !r.checked);
    const clean = shown.filter((r) => !problem.includes(r) && r.checked);
    const pl = take(problem, line, Math.floor(room * 0.45));
    if (pl.length) out.push('', ...header, ...pl, ...(pl.length < problem.length ? ['', cutNote(problem.slice(pl.length))] : []));
    const advs = adv.flatMap((r) => r.vulns.map((v) => [r, v]));
    const al = take(advs, ([r, v]) => advLine(r, v), Math.floor(room * 0.4));
    if (al.length) out.push('', '### Advisories', '', ...al, ...(al.length < advs.length ? ['', `… and ${advs.length - al.length} more advisories (see the job log).`] : []));
    const fold = (list, label) => {
      if (!list.length) return;
      const lines = take(list, line, Math.floor(room * 0.5));
      out.push('', `<details><summary>${label}</summary>`, '', ...header, ...lines, ...(lines.length < list.length ? ['', `… and ${list.length - lines.length} more.`] : []), '', '</details>');
    };
    fold(unchecked, `${unchecked.length} package${unchecked.length === 1 ? '' : 's'} not checked (no pinned version, or no service answered)`);
    fold(clean, `${problem.length || unchecked.length ? 'The other' : clean.length === 1 ? 'The' : 'All'} ${clean.length} package${clean.length === 1 ? '' : 's'}: no known vulnerabilities`);
    if (sorted.length > shown.length) out.push('', cutNote(sorted.slice(shown.length)));
    return out.join('\n');
  }
  out.push('', ...header, ...shown.map(line));
  if (sorted.length > shown.length) out.push('', cutNote(sorted.slice(shown.length)));
  if (adv.length) out.push('', '### Advisories', '', ...adv.flatMap((r) => r.vulns.map((v) => advLine(r, v))));
  return out.join('\n');
}

// ---------- Cross-check ----------

const VERDICT_WORDS = { supported: 'Backed', mostly: 'Mostly backed', disputed: 'Sources disagree', contradicted: 'Sources say something different', weak: 'One or two sources', unclear: 'Not enough said' };

/** One claim, checked: { verdict, label, supports, differs, mentions, evidence, judged }. */
export async function checkClaim(agent, claim, { signal } = {}) {
  return crossCheck(agent, String(claim || '').trim().slice(0, 300), { signal });
}

/** A claim's report as Markdown: the verdict, then each source's own sentence. */
export function claimMarkdown(claim, r, { quotes = 6 } = {}) {
  const out = [`**${md(claim)}**: ${md(r.label)}`];
  const line = (e) => `  - “${md(e.sentence)}” ${mdUrl(e.url) ? `([${md(e.source)}](${mdUrl(e.url)}))` : `(${md(e.source)})`}${e.kind === 'official' || e.kind === 'primary' ? ' — official or primary source' : ''}`;
  const sup = r.evidence.filter((e) => e.stance === 'supports');
  const dif = r.evidence.filter((e) => e.stance === 'differs');
  if (sup.length) out.push(`- Say the same (${sup.length}):`, ...sup.slice(0, quotes).map(line));
  if (dif.length) out.push(`- Say something different (${dif.length}):`, ...dif.slice(0, quotes).map(line));
  const men = r.evidence.length - sup.length - dif.length;
  if (men) out.push(`- ${men} more source${men === 1 ? '' : 's'} mention it without saying it.`);
  return out.join('\n');
}

/**
 * A paragraph, each plain fact checked on its own (two at a time, up to `max`).
 * Returns { claims: [{ ...claim, result? }] } in the paragraph's order.
 */
export async function checkParagraph(agent, text, { max = 8, signal, onFact } = {}) {
  const claims = claimsIn(String(text || '').slice(0, 4000), { max });
  const todo = claims.filter((c) => c.claim);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !signal?.aborted) {
      const c = todo[next++];
      try {
        c.result = await crossCheck(agent, c.claim, { signal, deep: false });
      } catch (e) {
        c.error = String(e?.message || e);
      }
      onFact?.(c);
    }
  };
  await Promise.all([worker(), worker()]);
  return { claims };
}

/** A paragraph's report as Markdown. */
export function paragraphMarkdown({ claims }) {
  const todo = claims.filter((c) => c.claim);
  const count = (v) => todo.filter((c) => c.result?.verdict === v).length;
  const backed = count('supported') + count('mostly');
  const against = count('contradicted');
  const out = [`**${todo.length} fact${todo.length === 1 ? '' : 's'} checked:** ${[backed && `${backed} backed`, against && `${against} where sources say something different`, todo.length - backed - against && `${todo.length - backed - against} mixed, thin or not settled`].filter(Boolean).join(', ')}.`, ''];
  todo.forEach((c, k) => {
    const r = c.result;
    out.push(`${k + 1}. ${md(c.claim)}: **${r ? md(r.label) : `not checked (${md(c.error || 'error')})`}**${c.unchecked ? ` (not checked: “${md(c.unchecked)}”)` : ''}`);
    if (!r) return;
    const q = (e, how) => `   - ${how}: “${md(e.sentence)}” ${mdUrl(e.url) ? `([${md(e.source)}](${mdUrl(e.url)}))` : `(${md(e.source)})`}`;
    for (const e of r.evidence.filter((x) => x.stance === 'differs').slice(0, 1)) out.push(q(e, 'Says otherwise'));
    for (const e of r.evidence.filter((x) => x.stance === 'supports').slice(0, 1)) out.push(q(e, 'Agrees'));
  });
  const skipped = claims.filter((c) => !c.claim);
  if (skipped.length) out.push('', `Not checked: ${skipped.map((c) => `“${md(c.sentence)}” (${md(c.skip)})`).join('; ')}`);
  return out.join('\n');
}

export { VERDICT_WORDS };
