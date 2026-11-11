"use strict";

/** @-mention expansion: inline referenced workspace files into the prompt. */

const fs = require("fs");
const path = require("path");
const { parseMentions } = require("./file-input");

const MAX_MENTION_LINES = 300;
const MAX_MENTION_BYTES = 200 * 1024;

/**
 * Expand @mentions into referenced-file blocks appended to the prompt.
 * Unknown paths are left untouched in the text.
 */
function buildPrompt(cwd, text) {
  if (!cwd || text.indexOf("@") === -1) return text;
  const mentions = parseMentions(text);
  const blocks = [];
  for (const rel of mentions) {
    if (!rel || rel.length > 4096) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    let content;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_MENTION_BYTES) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch (_) {
      continue; // not a file: leave the @token as-is
    }
    if (/\u0000/.test(content)) continue; // binary-ish
    const lines = content.split("\n");
    const head =
      lines.length > MAX_MENTION_LINES
        ? ` (first ${MAX_MENTION_LINES} of ${lines.length} lines)`
        : "";
    blocks.push(
      `Referenced file \`${rel}\`${head}:\n\`\`\`\`\n${lines.slice(0, MAX_MENTION_LINES).join("\n")}\n\`\`\`\``
    );
  }
  return blocks.length ? text + "\n\n" + blocks.join("\n\n") : text;
}

module.exports = { buildPrompt, MAX_MENTION_LINES, MAX_MENTION_BYTES };
