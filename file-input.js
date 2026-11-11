"use strict";

/* Shared by the webview and extension host; no VS Code or Node dependencies. */
(function () {
  const MAX_DROP_FILES = 20;
  const MAX_FILE_BYTES = 200 * 1024;
  const MAX_DROP_BYTES = 1024 * 1024;
  const DROP_TYPES = ["resourceurls", "application/vnd.code.resources", "application/vnd.code.uri-list",
    "text/uri-list", "codeeditors", "codefiles", "files"];

  function formatMention(file) {
    return "@" + (/^[^\s@,;"'`|<>\[\]()\\]+$/.test(file) ? file : JSON.stringify(file));
  }

  function parseMentions(text) {
    const files = new Set();
    // File contents pasted/dropped as fenced blocks are context, not requests
    // to recursively include any @paths appearing inside those files.
    let fence = null;
    text = text.split("\n").map((line) => {
      if (fence) {
        const close = line.match(/^ {0,3}(`+|~+)[ \t]*\r?$/);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        return "";
      }
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) { fence = open[1]; return ""; }
      return line;
    }).join("\n");
    // Quoted references use JSON string escaping, including Windows backslashes.
    const tokens = /@("(?:\\.|[^"\\])*"|[^\s@,;"'`|<>\[\]()]+)/g;
    for (const match of text.matchAll(tokens)) {
      try { files.add(match[1][0] === '"' ? JSON.parse(match[1]) : match[1]); } catch (_) { /* malformed quote */ }
    }
    return [...files];
  }

  function isFileDrag(transfer) {
    return !!transfer && Array.from(transfer.types || []).some((type) => DROP_TYPES.includes(type.toLowerCase()));
  }

  // Capture synchronously during drop: DataTransfer is protected after the event
  // returns. Prefer structured paths over browser Files (which may lack a path).
  function collectDrop(transfer) {
    const types = Array.from(transfer.types || []);
    for (const kind of DROP_TYPES.filter((type) => type !== "files")) {
      const type = types.find((value) => value.toLowerCase() === kind);
      if (!type) continue;
      const raw = transfer.getData(type);
      if (!raw || raw.length > MAX_DROP_BYTES) continue;
      try {
        const list = kind.endsWith("uri-list")
          ? raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
          : JSON.parse(raw);
        if (!Array.isArray(list) || !list.length) continue;
        return list.map((value) => kind === "codefiles" ? { path: value }
          : { uri: kind === "codeeditors" ? value.resource : value });
      } catch (_) { /* try another representation or the native Files list */ }
    }
    const items = Array.from(transfer.items || []).filter((item) => item.kind === "file");
    return Array.from(transfer.files || []).map((file, index) => {
      const item = items[index];
      const entry = item && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      return file.path ? { path: file.path } : { file, directory: !!(entry && entry.isDirectory) };
    });
  }

  function unsupportedFile(name, text) {
    return /\.(?:pdf|png|jpe?g|gif|webp|bmp|ico|svgz|zip|gz|7z|rar|docx?|xlsx?|pptx?|exe|dll|woff2?|ttf|mp[34]|wav|ogg)$/i.test(name) ||
      /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text) || text.startsWith("%PDF-");
  }

  const api = { formatMention, parseMentions, isFileDrag, collectDrop, unsupportedFile,
    MAX_DROP_FILES, MAX_FILE_BYTES, MAX_DROP_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.piFileInput = api;
})();
