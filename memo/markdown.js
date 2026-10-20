/*
 * Hybrid Memo — Markdown utilities
 * Obsidian 互換の Markdown（[[wikilink]]、#タグ、![[埋め込み]]、> [!callout]）を
 * 依存ライブラリなしで HTML に変換する。ブラウザ（window.Md）と Node（require）の両方で動く。
 */
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeTitle(t) {
    return String(t || '').trim().toLowerCase();
  }

  function slug(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** "Title#Heading|Alias" を分解する */
  function parseWikiTarget(raw) {
    const pipe = raw.indexOf('|');
    let target = pipe >= 0 ? raw.slice(0, pipe) : raw;
    const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : '';
    let heading = '';
    const hash = target.indexOf('#');
    if (hash >= 0) {
      heading = target.slice(hash + 1).trim();
      target = target.slice(0, hash);
    }
    return { target: target.trim(), heading, alias };
  }

  /** リンク・タグ抽出の前にコード部分を取り除く */
  function stripCode(md) {
    return String(md)
      .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
      .replace(/`[^`\n]*`/g, '');
  }

  const WIKILINK_RE = /!?\[\[([^[\]\n]+?)\]\]/g;
  const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

  function isValidTag(tag) {
    return /[^\d]/u.test(tag);
  }

  /** 本文に含まれる [[リンク]] のタイトル一覧（重複なし、出現順） */
  function extractLinks(md) {
    const seen = new Map();
    for (const m of stripCode(md).matchAll(WIKILINK_RE)) {
      const { target } = parseWikiTarget(m[1]);
      if (target && !seen.has(normalizeTitle(target))) seen.set(normalizeTitle(target), target);
    }
    return [...seen.values()];
  }

  /** 本文に含まれる #タグ 一覧（重複なし、出現順） */
  function extractTags(md) {
    const seen = new Set();
    for (const m of stripCode(md).matchAll(TAG_RE)) {
      if (isValidTag(m[2])) seen.add(m[2]);
    }
    return [...seen];
  }

  /** [[old]] / [[old|alias]] / [[old#h]] を new に書き換える（コード内も含めて素直に置換） */
  function renameLinks(md, oldTitle, newTitle) {
    const re = new RegExp('(!?\\[\\[)\\s*' + escapeRegExp(oldTitle.trim()) + '\\s*(?=[#|\\]])', 'gi');
    return md.replace(re, (_, open) => open + newTitle);
  }

  /** n 行目のタスク [ ] / [x] を反転する */
  function toggleTask(md, lineIndex) {
    const lines = md.split('\n');
    const line = lines[lineIndex];
    if (line == null) return md;
    lines[lineIndex] = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (_, pre, mark) =>
      pre + (mark === ' ' ? '[x]' : '[ ]')
    );
    return lines.join('\n');
  }

  function safeUrl(url) {
    if (/^(https?:|mailto:|#|\/|\.{1,2}\/)/i.test(url)) return true;
    return !/^[a-z][a-z0-9+.-]*:/i.test(url);
  }

  // ---------------------------------------------------------------- inline

  function renderInline(src, ctx) {
    const slots = [];
    const keep = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000';
    let s = String(src);

    s = s.replace(/`([^`\n]+)`/g, (_, code) => keep('<code>' + escapeHtml(code) + '</code>'));

    s = s.replace(WIKILINK_RE, (_, raw) => {
      const { target, heading, alias } = parseWikiTarget(raw);
      const label = alias || (heading ? (target ? target + ' › ' + heading : heading) : target);
      const exists = !target || !ctx || !ctx.resolve || ctx.resolve(target);
      return keep(
        '<a href="#" class="wikilink' + (exists ? '' : ' unresolved') + '" data-target="' +
          escapeHtml(target) + '" data-heading="' + escapeHtml(heading) + '">' + escapeHtml(label) + '</a>'
      );
    });

    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
      safeUrl(url) ? keep('<img alt="' + escapeHtml(alt) + '" src="' + escapeHtml(url) + '" loading="lazy">') : m
    );
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
      safeUrl(url)
        ? keep('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + renderInline(label, ctx) + '</a>')
        : m
    );
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) =>
      pre + keep('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>')
    );

    s = escapeHtml(s);

    s = s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
      .replace(TAG_RE, (m, pre, tag) =>
        isValidTag(tag) ? pre + '<a href="#" class="tag" data-tag="' + tag + '">#' + tag + '</a>' : m
      );

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  }

  // ---------------------------------------------------------------- blocks

  const RE = {
    blank: /^\s*$/,
    fence: /^\s*(```+|~~~+)\s*([\w+#.-]*)/,
    heading: /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/,
    hr: /^\s*([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^\s*>/,
    embed: /^\s*!\[\[([^[\]\n]+)\]\]\s*$/,
    list: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  };

  function indentOf(ws) {
    return ws.replace(/\t/g, '    ').length;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    return (
      RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) ||
      RE.list.test(line) || RE.embed.test(line) ||
      (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-'))
    );
  }

  function renderList(items, start, ctx) {
    const ordered = items[start].ordered;
    const base = items[start].indent;
    let html = ordered ? '<ol' + (items[start].num > 1 ? ' start="' + items[start].num + '"' : '') + '>' : '<ul>';
    let i = start;
    let open = false;
    while (i < items.length && items[i].indent >= base) {
      const it = items[i];
      if (it.indent > base) {
        const [sub, next] = renderList(items, i, ctx);
        html += open ? sub : '<li>' + sub + '</li>';
        i = next;
        continue;
      }
      if (open) html += '</li>';
      if (it.task) {
        html +=
          '<li class="task' + (it.checked ? ' done' : '') + '"><input type="checkbox" data-line="' + it.line + '"' +
          (it.checked ? ' checked' : '') + '> <span>' + renderInline(it.text, ctx) + '</span>';
      } else {
        html += '<li>' + renderInline(it.text, ctx);
      }
      open = true;
      i++;
    }
    if (open) html += '</li>';
    html += ordered ? '</ol>' : '</ul>';
    return [html, i];
  }

  function renderBlocks(lines, offset, ctx) {
    const out = [];
    let i = 0;
    let m;
    while (i < lines.length) {
      const line = lines[i];

      if (RE.blank.test(line)) { i++; continue; }

      if ((m = line.match(RE.fence))) {
        const fence = m[1];
        const lang = m[2];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        out.push(
          '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
            escapeHtml(buf.join('\n')) + '</code></pre>'
        );
        continue;
      }

      if ((m = line.match(RE.heading))) {
        const level = m[1].length;
        out.push('<h' + level + ' id="h-' + escapeHtml(slug(m[2])) + '">' + renderInline(m[2], ctx) + '</h' + level + '>');
        i++;
        continue;
      }

      if (RE.hr.test(line)) { out.push('<hr>'); i++; continue; }

      if ((m = line.match(RE.embed))) {
        const t = parseWikiTarget(m[1]);
        out.push(ctx && ctx.embed ? ctx.embed(t) : '<p>' + renderInline('[[' + m[1] + ']]', ctx) + '</p>');
        i++;
        continue;
      }

      if (RE.quote.test(line)) {
        const start = i;
        const inner = [];
        while (i < lines.length && RE.quote.test(lines[i])) inner.push(lines[i++].replace(/^\s*> ?/, ''));
        const callout = inner[0].match(/^\[!([\w-]+)\]([+-]?)\s*(.*)$/);
        if (callout) {
          const type = callout[1].toLowerCase();
          const title = callout[3] || type.charAt(0).toUpperCase() + type.slice(1);
          const body = renderBlocks(inner.slice(1), offset + start + 1, ctx);
          const tag = callout[2] ? 'details' : 'div';
          const open = callout[2] === '+' ? ' open' : '';
          const head = callout[2] ? 'summary' : 'div';
          out.push(
            '<' + tag + ' class="callout callout-' + escapeHtml(type) + '"' + open + '><' + head + ' class="callout-title">' +
              renderInline(title, ctx) + '</' + head + '>' + (body ? '<div class="callout-body">' + body + '</div>' : '') + '</' + tag + '>'
          );
        } else {
          out.push('<blockquote>' + renderBlocks(inner, offset + start, ctx) + '</blockquote>');
        }
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
        );
        const al = (j) => (aligns[j] ? ' style="text-align:' + aligns[j] + '"' : '');
        i += 2;
        let html = '<div class="table-wrap"><table><thead><tr>' +
          head.map((c, j) => '<th' + al(j) + '>' + renderInline(c, ctx) + '</th>').join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|') && !RE.blank.test(lines[i])) {
          const cells = splitRow(lines[i++]);
          html += '<tr>' + head.map((_, j) => '<td' + al(j) + '>' + renderInline(cells[j] || '', ctx) + '</td>').join('') + '</tr>';
        }
        out.push(html + '</tbody></table></div>');
        continue;
      }

      if (RE.list.test(line)) {
        const items = [];
        while (i < lines.length) {
          const lm = lines[i].match(RE.list);
          if (lm) {
            const task = lm[3].match(/^\[([ xX])\](?:\s+(.*))?$/);
            items.push({
              indent: indentOf(lm[1]),
              ordered: /\d/.test(lm[2]),
              num: parseInt(lm[2], 10) || 1,
              task: !!task,
              checked: !!task && task[1] !== ' ',
              text: task ? task[2] || '' : lm[3],
              line: offset + i,
            });
            i++;
          } else if (RE.blank.test(lines[i]) && i + 1 < lines.length && RE.list.test(lines[i + 1])) {
            i++;
          } else if (!RE.blank.test(lines[i]) && /^\s+\S/.test(lines[i]) && items.length) {
            items[items.length - 1].text += '\n' + lines[i].trim();
            i++;
          } else break;
        }
        let j = 0;
        while (j < items.length) {
          const [html, next] = renderList(items, j, ctx);
          out.push(html.replace(/\n/g, '<br>'));
          j = next;
        }
        continue;
      }

      const para = [];
      while (i < lines.length && !RE.blank.test(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) {
        para.push(lines[i++]);
      }
      out.push('<p>' + para.map((l) => renderInline(l, ctx)).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  /**
   * Markdown を HTML に変換する。
   * ctx.resolve(title) -> boolean : リンク先が存在するか（未作成リンクの装飾に使う）
   * ctx.embed({target, heading}) -> html : ![[埋め込み]] の描画
   */
  function render(md, ctx) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    return renderBlocks(lines, 0, ctx || {});
  }

  /** 見出し配下のセクションだけを取り出す（![[note#見出し]] 用） */
  function extractSection(md, heading) {
    const lines = String(md).split('\n');
    const target = slug(heading);
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(RE.heading);
      if (!m) continue;
      if (start < 0 && slug(m[2]) === target) { start = i; level = m[1].length; continue; }
      if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
    }
    return start >= 0 ? lines.slice(start).join('\n') : '';
  }

  // ---------------------------------------------------------------- frontmatter

  function yamlValue(v) {
    v = v.trim();
    if (/^\[.*\]$/.test(v)) {
      return v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    return unquote(v);
  }

  function unquote(v) {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  }

  /** "---\nkey: value\n---\n本文" を { meta, body } に分解する */
  function parseMarkdownFile(text) {
    text = String(text).replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    let lastKey = null;
    for (const line of m[1].split('\n')) {
      const item = line.match(/^\s+-\s+(.*)$/) || line.match(/^-\s+(.*)$/);
      if (item && lastKey) {
        if (!Array.isArray(meta[lastKey])) meta[lastKey] = [];
        meta[lastKey].push(unquote(item[1].trim()));
        continue;
      }
      const kv = line.match(/^([^:#][^:]*):\s*(.*)$/);
      if (kv) {
        lastKey = kv[1].trim();
        meta[lastKey] = kv[2].trim() === '' ? '' : yamlValue(kv[2]);
      }
    }
    return { meta, body: text.slice(m[0].length).replace(/^\n/, '') };
  }

  function yamlScalar(v) {
    const s = String(v);
    return /^[\w\p{L}\p{N} ./-]*$/u.test(s) && !/^(true|false|\s)/.test(s) && s.trim() === s ? s : JSON.stringify(s);
  }

  /** メモを frontmatter 付き Markdown に書き出す */
  function toMarkdownFile(note, schema) {
    const lines = [];
    for (const p of schema || []) {
      const v = note.props && note.props[p.key];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) lines.push(p.key + ': [' + v.map(yamlScalar).join(', ') + ']');
      else if (typeof v === 'boolean') lines.push(p.key + ': ' + v);
      else lines.push(p.key + ': ' + yamlScalar(v));
    }
    if (note.icon) lines.push('icon: ' + yamlScalar(note.icon));
    const fm = lines.length ? '---\n' + lines.join('\n') + '\n---\n\n' : '';
    return fm + (note.body || '');
  }

  const Md = {
    escapeHtml, normalizeTitle, slug, parseWikiTarget, extractLinks, extractTags, renameLinks,
    toggleTask, render, renderInline, extractSection, parseMarkdownFile, toMarkdownFile,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Md;
  else global.Md = Md;
})(typeof window !== 'undefined' ? window : globalThis);
