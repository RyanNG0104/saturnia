/* =========================================================
   Markdown mínimo e seguro para as respostas da SaturnIA.
   Todo texto é escapado antes de virar HTML.
   ========================================================= */

(function () {
  function escapeHTML(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Formatação dentro de uma linha (recebe texto já escapado)
  function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function renderBlocks(text) {
    const lines = text.split('\n');
    let html = '';
    let list = null;
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      html += `<p>${inline(escapeHTML(para.join('\n'))).replace(/\n/g, '<br>')}</p>`;
      para = [];
    };
    const closeList = () => {
      if (list) { html += `</${list}>`; list = null; }
    };

    for (const line of lines) {
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }

      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushPara(); closeList();
        const level = Math.min(m[1].length + 2, 6);
        html += `<h${level}>${inline(escapeHTML(m[2]))}</h${level}>`;
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inline(escapeHTML(m[1]))}</li>`;
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inline(escapeHTML(m[1]))}</li>`;
        continue;
      }
      if ((m = line.match(/^>\s?(.*)$/))) {
        flushPara(); closeList();
        html += `<blockquote>${inline(escapeHTML(m[1]))}</blockquote>`;
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara();
    closeList();
    return html;
  }

  // Blocos de código ``` são separados primeiro; o resto vira parágrafos/listas
  function renderMarkdown(src) {
    const parts = src.split('```');
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const code = nl >= 0 ? part.slice(nl + 1) : '';
        html += `<pre><code>${escapeHTML(code.replace(/\n$/, ''))}</code></pre>`;
      } else {
        html += renderBlocks(part);
      }
    });
    return html;
  }

  window.renderMarkdown = renderMarkdown;
})();
