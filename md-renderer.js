// md-renderer.js - 轻量 Markdown 渲染 + 数学公式（KaTeX），popup 聊天与划词面板共用。
// 暴露 window.LumenMD = { esc, render }，须先于 content_script.js / popup.js 加载。
// （manifest content_scripts 与 background 重注入的 files 数组中它都排在最前，katex 又在它之前）
(() => {
  'use strict';

  const TOK = '\u0000';   // 占位符分隔符：正文里不可能出现 NUL，避免与内容冲突

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== 数学公式（KaTeX）=====
  // throwOnError=true：解析失败时由调用方退回原文，避免流式输出过程中满屏红字
  function katexHTML(tex, display) {
    const k = window.katex;
    if (!k || typeof k.renderToString !== 'function') return null;
    if (!String(tex).trim()) return null;
    try {
      return k.renderToString(tex, {
        displayMode: !!display,
        throwOnError: true,
        strict: 'ignore',
        trust: false,
        maxSize: 32,
        maxExpand: 2000,
      });
    } catch (e) {
      return null;
    }
  }

  function mathHTML(tex, display) {
    const inner = katexHTML(tex, display);
    if (inner == null) {
      // KaTeX 没加载 / 公式还没写完整（流式）：原样显示，不报错
      return display
        ? `<span class="math-display math-fallback">${esc(tex)}</span>`
        : `<code class="md-inline-code math-fallback">${esc(tex)}</code>`;
    }
    return display
      ? `<span class="math-display">${inner}</span>`
      : `<span class="math-inline">${inner}</span>`;
  }

  // ===== 预处理：先摘出代码块 / 行内代码 / 公式，避免它们的字符被 Markdown 或转义破坏 =====
  function extractFences(text, codes) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (/^\s*```/.test(lines[i])) {
        const buf = [];
        i++;   // 跳过开启围栏（语言标记不需要保留）
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;   // 跳过闭合围栏（流式中可能没有）
        codes.push(buf.join('\n'));
        out.push(`${TOK}C${codes.length - 1}${TOK}`);
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    return out.join('\n');
  }

  function extractInlineCode(text, codes) {
    return text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(code);
      return `${TOK}I${codes.length - 1}${TOK}`;
    });
  }

  // 支持 $$...$$ / \[...\] / $...$ / \(...\)
  function extractMath(text, maths) {
    let out = '';
    let i = 0;
    const n = text.length;
    const push = (tex, display) => {
      maths.push({ tex, display });
      return `${TOK}${display ? 'D' : 'M'}${maths.length - 1}${TOK}`;
    };

    while (i < n) {
      const ch = text[i];

      if (ch === '\\') {
        const nxt = text[i + 1];
        if (nxt === '[' || nxt === '(') {
          const display = nxt === '[';
          const close = display ? '\\]' : '\\)';
          const end = text.indexOf(close, i + 2);
          if (end !== -1) {
            out += push(text.slice(i + 2, end), display);
            i = end + 2;
            continue;
          }
        }
        out += ch + (nxt === undefined ? '' : nxt);
        i += 2;
        continue;
      }

      if (ch === '$') {
        const display = text[i + 1] === '$';
        const openLen = display ? 2 : 1;
        const start = i + openLen;

        // 行内公式边界：$ 后不能紧跟空白，避免把 "$ 5" 这类金额当公式
        if (display || (start < n && !/\s/.test(text[start]))) {
          let j = start;
          let end = -1;
          while (j < n) {
            const cj = text[j];
            if (cj === '\\') { j += 2; continue; }
            if (cj === '\n') {
              if (!display) break;      // 行内公式不跨行
              j++;
              continue;
            }
            if (cj === '$') {
              if (display) {
                if (text[j + 1] === '$') { end = j; break; }
                j++;
                continue;
              }
              // 闭合 $ 前不能是空白，后面不能紧跟数字（区分 $5 … $10）
              if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] || '')) { end = j; break; }
            }
            j++;
          }
          if (end !== -1) {
            out += push(text.slice(start, end), display);
            i = end + openLen;
            continue;
          }
          // 流式输出：独立公式还没等到闭合，先把已有内容渲染出来
          if (display) {
            out += push(text.slice(start), true);
            i = n;
            continue;
          }
        }
        out += ch;
        i++;
        continue;
      }

      out += ch;
      i++;
    }
    return out;
  }

  // ===== Markdown 元素 =====
  // 行内元素：加粗 / 斜体 / 删除线 / 链接（内容已先做 HTML 转义）
  function inline(s) {
    return s
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  // ===== 列表（按缩进还原层级）=====
  function parseListItem(line) {
    const m = line.match(/^([ \t]*)([-*+]|\d+[.、])\s+(.*)$/);
    return {
      indent: m[1].replace(/\t/g, '    ').length,
      ordered: /^\d/.test(m[2]),
      text: m[3],
    };
  }

  // 同层同类型的项归到一个 <ul>/<ol>，更深的缩进递归成子列表
  function buildList(entries) {
    let html = '';
    let k = 0;
    while (k < entries.length) {
      const base = entries[k].indent;
      const ordered = entries[k].ordered;
      const tag = ordered ? 'ol' : 'ul';
      let items = '';

      while (k < entries.length && entries[k].indent === base && entries[k].ordered === ordered) {
        let li = `<li>${inline(entries[k].text)}`;
        k++;
        if (k < entries.length && entries[k].indent > base) {
          const sub = [];
          while (k < entries.length && entries[k].indent > base) { sub.push(entries[k]); k++; }
          li += buildList(sub);
        }
        items += li + '</li>';
      }

      html += `<${tag} class="md-list">${items}</${tag}>`;
    }
    return html;
  }

  // 整份列表都是「**标签：**内容」时，按词条行渲染（没有圆点），子项仍按缩进挂在下面
  function buildDefs(entries) {
    const base = entries[0].indent;
    const top = entries.filter(e => e.indent === base);
    if (top.length < 2) return null;
    if (!top.every(e => /^\*\*[^*\n]{1,20}[：:]\*\*/.test(e.text))) return null;

    let html = '<div class="md-defs">';
    let k = 0;
    while (k < entries.length) {
      if (entries[k].indent !== base) { k++; continue; }
      let body = inline(entries[k].text);
      k++;
      if (k < entries.length && entries[k].indent > base) {
        const sub = [];
        while (k < entries.length && entries[k].indent > base) { sub.push(entries[k]); k++; }
        body += buildList(sub);
      }
      html += `<div class="md-def">${body}</div>`;
    }
    return html + '</div>';
  }

  function table(rows) {
    const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const header = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return '<div class="md-table-wrap"><table class="md-table">' +
      `<thead><tr>${header.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
      `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
      '</table></div>';
  }

  // 轻量 Markdown 渲染：标题 / 列表 / 代码块 / 引用 / 表格 / 分割线 / 公式 / 行内样式。
  // 先整体转义再拼标签，模型输出里的 HTML 不会被执行。
  function render(raw) {
    const codes = [];   // 围栏代码块
    const inlineCodes = [];
    const maths = [];

    let src = extractFences(String(raw == null ? '' : raw), codes);
    src = extractInlineCode(src, inlineCodes);
    src = extractMath(src, maths);

    const lines = esc(src).split('\n');
    const out = [];
    let i = 0;

    const isBullet = l => /^\s*[-*+]\s+/.test(l);
    const isOrdered = l => /^\s*\d+[.、]\s+/.test(l);
    const isBlockTok = l => /^\s*\u0000[CD]\d+\u0000\s*$/.test(l);
    const codeBlock = idx => `<pre class="md-code"><code>${esc(codes[idx] || '')}</code></pre>`;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块 / 独立公式占位符
      const tok = line.match(/^\s*\u0000([CD])(\d+)\u0000\s*$/);
      if (tok) {
        out.push(tok[1] === 'C' ? codeBlock(+tok[2]) : mathHTML(maths[+tok[2]].tex, true));
        i++;
        continue;
      }

      // 表格：当前行含 | 且下一行是分隔行
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        out.push(table(rows));
        continue;
      }

      // 标题（#~######）
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        // 气泡/面板尺寸有限，h1~h6 映射到 h2~h5，避免一级标题过大
        const lvl = Math.min(h[1].length + 1, 5);
        out.push(`<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // 引用块
      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        out.push(`<blockquote class="md-quote">${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }

      // 无序 / 有序列表：按缩进还原层级（模型常把「音标 / 词性」写成子项）
      if (isBullet(line) || isOrdered(line)) {
        const entries = [];
        while (i < lines.length && (isBullet(lines[i]) || isOrdered(lines[i]))) {
          entries.push(parseListItem(lines[i]));
          i++;
        }
        // 「**标签：**内容」全命中时按词条行渲染，避免满屏圆点
        out.push(buildDefs(entries) || buildList(entries));
        continue;
      }

      // 分割线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      // 空行 → 段落分隔
      if (!line.trim()) { i++; continue; }

      // 普通段落：连续非空非特殊行合并，行间用 <br>
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(```|#{1,6}\s|&gt;)/.test(lines[i]) &&
             !isBlockTok(lines[i]) &&
             !isBullet(lines[i]) && !isOrdered(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p class="md-p">${buf.map(inline).join('<br>')}</p>`);
    }

    let html = out.join('');
    // 还原行内占位符（此时已是 HTML 片段，不会再被 Markdown 规则改写）
    html = html.replace(/\u0000I(\d+)\u0000/g, (_m, d) => `<code class="md-inline-code">${esc(inlineCodes[+d] || '')}</code>`);
    html = html.replace(/\u0000M(\d+)\u0000/g, (_m, d) => mathHTML(maths[+d].tex, false));
    html = html.replace(/\u0000D(\d+)\u0000/g, (_m, d) => mathHTML(maths[+d].tex, true));
    html = html.replace(/\u0000C(\d+)\u0000/g, (_m, d) => codeBlock(+d));

    return html;
  }

  window.LumenMD = { esc, render };
})();
