// Minimal, safe Markdown → HTML. Every piece of text is HTML-escaped first;
// only http(s) links are produced; no raw HTML passes through.
(function () {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function safeUrl(u) {
    try {
      const x = new URL(u);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
    } catch {
      return null;
    }
  }

  function inline(text, sources) {
    // Pull code spans out first so nothing inside them is formatted.
    const codes = [];
    let s = String(text).replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000C${codes.length - 1}\u0000`;
    });
    const links = [];
    s = s.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
      const u = safeUrl(url);
      if (!u) return m;
      links.push({ label, url: u });
      return `\u0000L${links.length - 1}\u0000`;
    });
    // Bare URLs become placeholders too, so emphasis and citations never touch them.
    const urls = [];
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (m, pre, url) => {
      const u = safeUrl(url);
      if (!u) return m;
      urls.push({ text: url, url: u });
      return `${pre}\u0000U${urls.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    // Citations [1] or [1, 3] or [1][2]
    s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, nums) => {
      const parts = nums.split(/\s*,\s*/).map((n) => {
        const src = sources && sources[Number(n) - 1];
        if (!src) return null;
        return `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title || src.url)}" data-n="${n}">${n}</a>`;
      });
      return parts.every(Boolean) ? parts.join('') : m;
    });
    s = s.replace(/\u0000U(\d+)\u0000/g, (_, i) => {
      const x = urls[Number(i)];
      return x ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.text)}</a>` : '';
    });
    s = s.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
      const l = links[Number(i)];
      return l ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>` : '';
    });
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => (codes[Number(i)] === undefined ? '' : `<code>${esc(codes[Number(i)])}</code>`));
    return s;
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function render(md, sources) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '), sources)}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\S*)/);
      if (fence) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flush();
        const lvl = Math.min(4, h[1].length + 2); // answers sit under the page's h2
        out.push(`<h${lvl}>${inline(h[2], sources)}</h${lvl}>`);
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flush();
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, sources)}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, sources)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`
        );
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
          if (m) {
            items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[3] });
            i++;
          } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
          } else break;
        }
        const tag = ordered ? 'ol' : 'ul';
        let html = `<${tag}>`;
        let open = false;
        for (const it of items) {
          if (it.depth && !open) {
            html = html.replace(/<\/li>$/, '') + '<ul>';
            open = true;
          } else if (!it.depth && open) {
            html += '</ul></li>';
            open = false;
          }
          html += `<li>${inline(it.text, sources)}</li>`;
        }
        if (open) html += '</ul></li>';
        out.push(html + `</${tag}>`);
        continue;
      }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inline(buf.join(' '), sources)}</blockquote>`);
        continue;
      }
      if (!line.trim()) {
        flush();
        i++;
        continue;
      }
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('\n');
  }

  const api = { render, inline, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.MD = api;
})();
