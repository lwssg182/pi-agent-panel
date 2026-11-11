"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { formatMention, parseMentions, collectDrop, isFileDrag, MAX_FILE_BYTES, MAX_DROP_FILES } = require("../file-input");
const { buildPrompt } = require("../mentions");
const { prepareDroppedFiles } = require("../file-drops");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-drop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const transfer = (data, files = []) => ({ types: Object.keys(data), files, getData: (type) => data[type] });

test("quoted mentions round-trip spaces, Unicode, punctuation and Windows paths", () => {
  const paths = ["src/笔记.md", "my notes.txt", 'a"b.md', "a@b(c)[d].txt", "C:\\My Files\\中文.md"];
  assert.deepEqual(parseMentions(paths.map(formatMention).join(" ")), paths);
  assert.equal(formatMention("src/a.js"), "@src/a.js");
  assert.deepEqual(parseMentions('@a.js @a.js @"a.js"'), ["a.js"]);
});

test("structured VS Code/URI drop formats and native fallback", () => {
  for (const type of ["ResourceURLs", "application/vnd.code.resources"]) {
    assert.deepEqual(collectDrop(transfer({ [type]: '["file:///tmp/a%20b.txt"]' })), [{ uri: "file:///tmp/a%20b.txt" }]);
  }
  assert.deepEqual(collectDrop(transfer({ "CodeFiles": '["/tmp/a.txt"]' })), [{ path: "/tmp/a.txt" }]);
  assert.deepEqual(collectDrop(transfer({ "CodeEditors": '[{"resource":{"scheme":"file","path":"/tmp/a"}}]' })),
    [{ uri: { scheme: "file", path: "/tmp/a" } }]);
  assert.deepEqual(collectDrop(transfer({ "text/uri-list": "# comment\r\nfile:///tmp/a\r\n\r\nfile:///tmp/b" })),
    [{ uri: "file:///tmp/a" }, { uri: "file:///tmp/b" }]);
  const file = { name: "a.txt" };
  assert.deepEqual(collectDrop(transfer({ "CodeFiles": "malformed", Files: "" }, [file])), [{ file, directory: false }]);
  assert.equal(isFileDrag(transfer({ "text/plain": "/tmp/a.txt" })), false);
  assert.equal(isFileDrag(transfer({ Files: "" })), true);
});

test("path drops are deduplicated and quoted references really expand on send", async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "中文 notes.txt");
  fs.writeFileSync(file, "sample context");
  const result = await prepareDroppedFiles(dir, [{ uri: pathToFileURL(file).href }, { path: file }], fileURLToPath);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.text, '@"中文 notes.txt"');
  assert.match(buildPrompt(dir, result.text), /sample context/);
  // Drops do not write copies or change the workspace.
  assert.deepEqual(fs.readdirSync(dir), ["中文 notes.txt"]);
});

test("inline file contents cannot recursively expand @paths inside fenced blocks", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "other.txt"), "must not include this");
  const result = await prepareDroppedFiles(dir, [{ name: "source.txt", text: "@other.txt\n```\n@other.txt\n```" }], fileURLToPath);
  assert.deepEqual(parseMentions(result.text), []);
  assert.equal(buildPrompt(dir, result.text), result.text);
  assert.deepEqual(parseMentions("@outside.txt\n~~~js\n@hidden.txt\n~~~\n@after.txt"), ["outside.txt", "after.txt"]);
});

test("outside-workspace files keep absolute paths, never a guessed basename", async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "outside.txt");
  fs.writeFileSync(file, "outside");
  const result = await prepareDroppedFiles(path.join(dir, "workspace"), [{ path: file }], fileURLToPath);
  assert.equal(result.text, formatMention(file));
});

test("pathless browser files inline supplied content and enforce the line limit", async () => {
  const result = await prepareDroppedFiles("/unused", [{ name: "notes.txt", text: "line\n".repeat(301) }], fileURLToPath);
  assert.match(result.text, /Dropped file "notes.txt" \(first 300 of 302 lines\)/);
  assert.equal(result.warnings.length, 0);
  assert.equal((result.text.match(/line/g) || []).length, 301); // includes 'lines' in header
});

test("directories, missing files, binary/PDF, non-UTF8 and oversized files are skipped with feedback", async (t) => {
  const dir = fixture(t);
  for (const [name, data] of [["a.txt", "ok"], ["binary", Buffer.from([0, 1, 2])], ["bad.txt", Buffer.from([255])],
    ["doc.pdf", "%PDF-test"], ["big.txt", "x".repeat(MAX_FILE_BYTES + 1)]]) fs.writeFileSync(path.join(dir, name), data);
  const paths = [dir, path.join(dir, "missing"), ...["a.txt", "binary", "bad.txt", "doc.pdf", "big.txt"].map((name) => path.join(dir, name))];
  const result = await prepareDroppedFiles(dir, paths.map((file) => ({ path: file })), fileURLToPath);
  assert.equal(result.text, "@a.txt");
  assert.equal(result.warnings.length, 6);
});

test("host validates native payload bytes, aggregate limits, count and URI scheme", async () => {
  const tooLarge = await prepareDroppedFiles("/unused", [{ name: "中文.txt", text: "中".repeat(MAX_FILE_BYTES / 2) }], fileURLToPath);
  assert.equal(tooLarge.text, "");
  assert.match(tooLarge.warnings[0], /200 KiB/);
  const result = await prepareDroppedFiles("/unused", Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, text: "x".repeat(MAX_FILE_BYTES) })), fileURLToPath);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /1 MiB/);
  await assert.rejects(prepareDroppedFiles("/unused", new Array(MAX_DROP_FILES + 1).fill({}), fileURLToPath), /20/);
  const invalid = await prepareDroppedFiles("/unused", [{ uri: "https://example.invalid/a.txt" }, { path: "relative.txt" }, null], fileURLToPath);
  assert.equal(invalid.text, "");
  assert.equal(invalid.warnings.length, 3);
});
