"use strict";

/**
 * Minimal markdown renderer, shared by the webview and the unit tests.
 * Renders a safe subset: paragraphs, headings, lists, fenced code, tables,
 * links/images with a URL scheme whitelist (no javascript:, etc.).
 */
(function (root) {
  const SAFE_LINK = /^(https?:|mailto:)/i;
  const SAFE_IMG = /^(https?:|data:image\/)/i;

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function renderInline(s) {
    let out = escHtml(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    // ![alt](url) — keep only whitelisted schemes; otherwise just the alt text.
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
      SAFE_IMG.test(url) ? `<img alt="${alt}" src="${url}">` : alt);
    // [text](url) — keep only whitelisted schemes; otherwise just the text.
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
      SAFE_LINK.test(url) ? `<a href="${url}" title="${url}">${text}</a>` : text);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?\-])/g, "$1<em>$2</em>");
    return out;
  }

  function renderTable(lines) {
    const parseRow = (line) =>
      line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const headCells = parseRow(lines[0]);
    // Alignment from separator row: :--- left, :---: center, ---: right
    const aligns = parseRow(lines[1]).map((c) => {
      if (c.startsWith(":") && c.endsWith(":")) return "center";
      if (c.endsWith(":")) return "right";
      return "left";
    });
    let html = '<table><thead><tr>';
    headCells.forEach((c, i) => {
      html += `<th style="text-align:${aligns[i] || "left"}">${renderInline(c)}</th>`;
    });
    html += "</tr></thead><tbody>";
    for (let r = 2; r < lines.length; r++) {
      if (!lines[r].trim()) continue;
      const cells = parseRow(lines[r]);
      html += "<tr>";
      cells.forEach((c, i) => {
        html += `<td style="text-align:${aligns[i] || "left"}">${renderInline(c)}</td>`;
      });
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  function renderBlock(block) {
    const lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));

    // Table: lines that look like "| col | col |" with a separator row "| --- | --- |"
    if (lines.length >= 2 && lines.every((l) => l.trim().startsWith("|")) &&
        /^\|?[\s:]*-{2,}[\s:]*\|/.test(lines[1])) {
      return renderTable(lines);
    }

    if (lines.length && lines.every((l) => /^\s*(?:[-*+]|\d+\.)\s+/.test(l))) {
      const items = lines
        .map((l) => "<li>" + renderInline(l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")) + "</li>")
        .join("");
      return "<ul>" + items + "</ul>";
    }
    if (lines.length === 1) {
      const h = block.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        const lvl = h[1].length;
        return `<h${lvl}>` + renderInline(h[2]) + `</h${lvl}>`;
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(block)) return "<hr>";
    }
    return "<p>" + lines.map(renderInline).join("<br>") + "</p>";
  }

  function renderMd(src) {
    if (!src) return "";
    const parts = [];
    // Unterminated fences still render as code (mid-stream rendering).
    const re = /```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: "text", text: src.slice(last, m.index) });
      parts.push({ type: "code", lang: m[1] || "", code: m[2] || "" });
      last = re.lastIndex;
    }
    if (last < src.length) parts.push({ type: "text", text: src.slice(last) });

    return parts
      .map((p) =>
        p.type === "code"
          ? "<pre><code>" + escHtml(p.code) + "</code></pre>"
          : p.text
              .split(/\n{2,}/)
              .map((b) => b.trim())
              .filter(Boolean)
              .map(renderBlock)
              .join("")
      )
      .join("");
  }

  /**
   * Streaming boundary: the index up to which `src` is stable — blocks before
   * it can never change as more text is appended, so a stream renderer only
   * re-renders the remainder. A blank line always closes a block; a closed
   * fence is stable whole (blank lines inside it don't split); an unterminated
   * fence keeps everything from its opener live.
   */
  function streamCut(src) {
    if (!src) return 0;
    const re = /```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
    let last = 0, m, cut = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) cut = m.index; // text before an opener is fixed
      if (m[0].endsWith("```")) cut = re.lastIndex; // a closed fence is fixed
      else return cut; // unterminated: the tail starts at the opener
      last = re.lastIndex;
    }
    if (last < src.length) {
      // Final text section: stable up to the last blank-line boundary.
      const blank = /\n[ \t]*\n/g;
      const section = src.slice(last);
      let lastEnd = -1;
      while (blank.exec(section) !== null) lastEnd = blank.lastIndex;
      if (lastEnd !== -1) cut = last + lastEnd;
    }
    return cut;
  }

  const api = { renderMd, escHtml, streamCut };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.piMarkdown = api;
})(typeof window !== "undefined" ? window : globalThis);
