// md-renderer.js - 轻量 Markdown 渲染，popup 聊天与划词面板共用。
// 暴露 window.LumenMD = { esc, render }，须先于 content_script.js / popup.js 加载。
// （manifest content_scripts 与 background 重注入的 files 数组中它都排在最前）
(() => {
  'use strict';

  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 行内元素：行内代码 / 加粗 / 斜体 / 删除线 / 链接（内容已先做 HTML 转义）
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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

  // 轻量 Markdown 渲染：标题 / 列表 / 代码块 / 引用 / 表格 / 分割线 / 行内样式。
  // 先整体转义再拼标签，模型输出里的 HTML 不会被执行。
  function render(raw) {
    const lines = esc(raw).split('\n');
    const out = [];
    let i = 0;

    const isBullet = l => /^\s*[-*+]\s+/.test(l);
    const isOrdered = l => /^\s*\d+[.、]\s+/.test(l);

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块（含流式中尚未闭合的）
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过闭合围栏
        out.push(`<pre class="md-code"><code>${buf.join('\n')}</code></pre>`);
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

      // 无序 / 有序列表（单层即可，嵌套场景按平级展示）
      if (isBullet(line) || isOrdered(line)) {
        const ordered = isOrdered(line);
        const items = [];
        while (i < lines.length && (ordered ? isOrdered(lines[i]) : isBullet(lines[i]))) {
          items.push(lines[i].replace(ordered ? /^\s*\d+[.、]\s+/ : /^\s*[-*+]\s+/, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag} class="md-list">${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
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
             !isBullet(lines[i]) && !isOrdered(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p class="md-p">${buf.map(inline).join('<br>')}</p>`);
    }

    return out.join('');
  }

  window.LumenMD = { esc, render };
})();
