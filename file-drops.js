"use strict";

const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");
const { formatMention, unsupportedFile, MAX_DROP_FILES, MAX_FILE_BYTES, MAX_DROP_BYTES } = require("./file-input");
const { MAX_MENTION_LINES } = require("./mentions");

/** Validate dropped files without writing them to the workspace or sending a prompt.
 * URI decoding is supplied by the host, where remote workspace identity is known. */
async function prepareDroppedFiles(cwd, entries, uriToPath) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_DROP_FILES) {
    throw new Error(`Drop between 1 and ${MAX_DROP_FILES} files at a time.`);
  }
  const parts = [], warnings = [], seen = new Set();
  let total = 0;
  for (const entry of entries) {
    let label = "File";
    try {
      if (!entry || typeof entry !== "object") throw new Error("invalid file data");
      let file = entry.uri ? uriToPath(entry.uri) : entry.path;
      let text, size;
      if (file !== undefined) {
        if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new Error("invalid file path");
        file = path.normalize(file);
        label = path.basename(file);
        if (seen.has(file)) continue;
        seen.add(file);
        // Open non-blocking so a FIFO/device cannot hang a drop. Bound the read
        // itself as well as stat, in case the file grows while being read.
        const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("directories and special files are not supported");
          if (stat.size > MAX_FILE_BYTES) throw new Error("larger than 200 KiB");
          if (total + stat.size > MAX_DROP_BYTES) throw new Error("drop exceeds 1 MiB in total");
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          size = 0;
          while (size < buffer.length) {
            const result = await handle.read(buffer, size, buffer.length - size, null);
            if (!result.bytesRead) break;
            size += result.bytesRead;
          }
          if (size > MAX_FILE_BYTES) throw new Error("larger than 200 KiB");
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
        } finally { await handle.close(); }
      } else {
        label = typeof entry.name === "string" ? entry.name : "File";
        if (typeof entry.name !== "string" || !entry.name || entry.name.length > 4096 || typeof entry.text !== "string") throw new Error("invalid file data");
        text = entry.text;
        size = Buffer.byteLength(text, "utf8");
      }
      if (size > MAX_FILE_BYTES) throw new Error("larger than 200 KiB");
      if (total + size > MAX_DROP_BYTES) throw new Error("drop exceeds 1 MiB in total");
      if (unsupportedFile(label, text)) throw new Error("only UTF-8 text/code files are supported (not images, PDF or binary files)");
      total += size;
      if (file) {
        const relative = cwd ? path.relative(cwd, file) : "";
        const inside = relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        parts.push(formatMention(inside ? relative : file));
      } else {
        // Browser File objects don't expose absolute paths. Inline the supplied
        // content instead of guessing a workspace path from a basename.
        const lines = text.split("\n");
        const head = lines.length > MAX_MENTION_LINES ? ` (first ${MAX_MENTION_LINES} of ${lines.length} lines)` : "";
        const body = lines.slice(0, MAX_MENTION_LINES).join("\n");
        let fenceLength = 4;
        for (const match of body.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = "`".repeat(fenceLength);
        parts.push(`Dropped file ${JSON.stringify(label)}${head}:\n${fence}\n${body}\n${fence}`);
      }
    } catch (error) {
      warnings.push(`${label}: ${error.message}`);
    }
  }
  return { text: parts.join("\n\n"), warnings };
}

module.exports = { prepareDroppedFiles };
