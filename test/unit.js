"use strict";

/**
 * Unit tests for pure functions. No pi binary required, no LLM calls.
 *
 * Usage: node test/unit.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const Module = require("module");

// Minimal vscode mock so extension.js can be required outside VS Code.
const vscMock = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, debug() {}, info() {}, warn() {}, error() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "", command: "" }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: { getConfiguration: () => ({ get: () => "" }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  extensions: { getExtension: () => null },
  Uri: { joinPath: () => ({ fsPath: "" }), file: (p) => ({ fsPath: p }) },
  StatusBarAlignment: { Right: 2 },
};

// Hook module resolution so "vscode" resolves to our mock.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "vscode") return "__vscode_mock__";
  return origResolve.call(this, request, parent, isMain, options);
};
require.cache["__vscode_mock__"] = {
  id: "__vscode_mock__", filename: "__vscode_mock__", loaded: true, exports: vscMock,
};

const { attachJsonlReader } = require("../pi-rpc");
const { PiChatProvider, resultText } = require("../chat-provider");
const { TurnQueue } = require("../turn-queue");
const { timeAgo, projectSessionDir } = require("../pickers");
const { buildPrompt, MAX_MENTION_BYTES } = require("../mentions");
const md = require("../markdown");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function asyncTest(name, fn) {
  return fn().then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  }).catch((err) => {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  });
}

// ---------- attachJsonlReader ----------

console.log("\nattachJsonlReader:");

const jsonlTests = [];

jsonlTests.push(asyncTest("splits lines on LF", () => {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  stream.write('{"a":1}\n{"b":2}\n');
  stream.end();
  return new Promise((resolve) => {
    stream.on("end", () => {
      assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
      resolve();
    });
  });
}));

jsonlTests.push(asyncTest("handles CRLF", () => {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  stream.write('{"a":1}\r\n{"b":2}\r\n');
  stream.end();
  return new Promise((resolve) => {
    stream.on("end", () => {
      assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
      resolve();
    });
  });
}));

jsonlTests.push(asyncTest("handles split chunks", () => {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  stream.write('{"par');
  stream.write('tial":true}\n');
  stream.end();
  return new Promise((resolve) => {
    stream.on("end", () => {
      assert.deepStrictEqual(lines, ['{"partial":true}']);
      resolve();
    });
  });
}));

jsonlTests.push(asyncTest("flushes trailing data on end", () => {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  stream.write('{"no_newline":true}');
  stream.end();
  return new Promise((resolve) => {
    stream.on("end", () => {
      assert.deepStrictEqual(lines, ['{"no_newline":true}']);
      resolve();
    });
  });
}));

// ---------- resultText ----------

console.log("\nresultText:");

test("returns empty string for null", () => {
  assert.strictEqual(resultText(null), "");
});

test("extracts text from content blocks", () => {
  const result = {
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "..." },
      { type: "text", text: "world" },
    ],
  };
  assert.strictEqual(resultText(result), "hello\n\nworld");
});

test("truncates long output", () => {
  const long = "x".repeat(5000);
  const result = { content: [{ type: "text", text: long }] };
  const out = resultText(result);
  assert.ok(out.length < 5000);
  assert.ok(out.endsWith("… (truncated)"));
});

// ---------- timeAgo ----------

console.log("\ntimeAgo:");

test("returns 'just now' for recent timestamps", () => {
  assert.strictEqual(timeAgo(Date.now() - 5000), "just now");
});

test("returns minutes", () => {
  assert.strictEqual(timeAgo(Date.now() - 300000), "5m ago");
});

test("returns hours", () => {
  assert.strictEqual(timeAgo(Date.now() - 7200000), "2h ago");
});

test("returns days", () => {
  assert.strictEqual(timeAgo(Date.now() - 172800000), "2d ago");
});

// ---------- projectSessionDir ----------

console.log("\nprojectSessionDir:");

test("converts path separators to dashes", () => {
  const dir = projectSessionDir("/home/user/project");
  assert.ok(dir.includes("--home-user-project--"));
  assert.ok(!dir.includes("//"));
});

test("handles root path", () => {
  const dir = projectSessionDir("/");
  assert.ok(dir.includes("----"));
});

// ---------- markdown renderer ----------

console.log("\nmarkdown (renderMd):");

test("escapes HTML", () => {
  const out = md.renderMd("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("renders fenced code blocks", () => {
  const out = md.renderMd("```js\nconst a = 1;\n```");
  assert.ok(out.includes("<pre><code>"));
  assert.ok(out.includes("const a = 1;"));
});

test("renders unterminated fence (mid-stream)", () => {
  const out = md.renderMd("text\n```python\nprint(1)");
  assert.ok(out.includes("<pre><code>"));
  assert.ok(out.includes("print(1)"));
});

test("renders safe links", () => {
  const out = md.renderMd("[docs](https://example.com)");
  assert.ok(out.includes('<a href="https://example.com"'));
});

test("drops javascript: links (XSS)", () => {
  const out = md.renderMd("[click](javascript:alert(1))");
  assert.ok(!out.includes("javascript:"));
  assert.ok(!out.includes("<a "));
  assert.ok(out.includes("click"));
});

test("keeps mailto links", () => {
  const out = md.renderMd("[mail](mailto:a@b.c)");
  assert.ok(out.includes('href="mailto:a@b.c"'));
});

test("renders safe images, drops unsafe", () => {
  const ok = md.renderMd("![logo](https://example.com/x.png)");
  assert.ok(ok.includes("<img"));
  const dataUri = md.renderMd("![dot](data:image/png;base64,AAAA)");
  assert.ok(dataUri.includes("<img"));
  const bad = md.renderMd("![x](javascript:alert(1))");
  assert.ok(!bad.includes("<img"));
});

test("renders tables with alignment", () => {
  const out = md.renderMd("| a | b |\n| --- | ---: |\n| 1 | 2 |");
  assert.ok(out.includes("<table>"));
  assert.ok(out.includes("<th"));
  assert.ok(out.includes('text-align:right'));
});

test("renders bold and italic", () => {
  const out = md.renderMd("**bold** and *it*");
  assert.ok(out.includes("<strong>bold</strong>"));
  assert.ok(out.includes("<em>it</em>"));
});

test("renders headings", () => {
  const out = md.renderMd("## Title");
  assert.ok(out.includes("<h2>Title</h2>"));
});

// ---------- panel picker model state ----------

console.log("\npanel picker model state:");

jsonlTests.push(asyncTest("marks only the current provider for duplicate model IDs", async () => {
  const posted = [];
  const fake = {
    client: {
      exited: false,
      request: async (cmd) => {
        if (cmd.type === "get_available_models") {
          return { models: [
            { provider: "provider-a", id: "gpt-6-astra", name: "GPT-6 Astra" },
            { provider: "provider-b", id: "gpt-6-astra", name: "GPT-6 Astra" },
            { provider: "provider-c", id: "gpt-6-astra", name: "GPT-6 Astra" },
          ] };
        }
        if (cmd.type === "get_state") return { model: { provider: "provider-b", id: "gpt-6-astra" } };
        return {};
      },
    },
    log: { debug() {}, warn() {} },
    _post: (msg) => posted.push(msg),
    _isCurrentClient: () => true,
    _sessionRevision: 1,
  };
  await PiChatProvider.prototype._listPicker.call(fake, "model", "req-1");
  const items = posted.find((msg) => msg.t === "picker_data").items;
  assert.strictEqual(items.filter((item) => item.current).length, 1);
  assert.strictEqual(items.find((item) => item.current).provider, "provider-b");
}));

// ---------- turn queue ----------

console.log("\nTurnQueue:");

async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

jsonlTests.push(asyncTest("awaits prepare before send, one turn at a time", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const q = new TurnQueue({
    prepare: async (v) => {
      order.push("prepare:" + v);
      if (v === "a") await gate;
      return v.toUpperCase();
    },
    send: async (v) => {
      order.push("send:" + v);
      // The provider releases the queue on agent_settled; simulate that here.
      q.setBusy(false);
    },
  });
  q.setPaused(false);
  const p1 = q.enqueue("a");
  const p2 = q.enqueue("b");
  await settle();
  assert.deepStrictEqual(order, ["prepare:a"], "second turn waits for the first");
  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepStrictEqual(order, ["prepare:a", "send:A", "prepare:b", "send:B"]);
}));

jsonlTests.push(asyncTest("cancel returns unsent prompts and rejects none", async () => {
  const sent = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const q = new TurnQueue({
    prepare: async (v) => (v === "a" ? await gate : v),
    send: async (v) => { sent.push(v); },
  });
  const p1 = q.enqueue("a");
  const p2 = q.enqueue("b");
  const p3 = q.enqueue("c");
  await Promise.resolve();
  const unsent = q.cancel();
  releaseFirst();
  const results = await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(results, [false, false, false], "cancelled turns resolve as not-sent");
  assert.deepStrictEqual(unsent, ["a", "b", "c"], "in-flight and queued prompts are returned");
  assert.deepStrictEqual(sent, [], "nothing was dispatched");
}));

jsonlTests.push(asyncTest("pause blocks dispatch until resumed", async () => {
  const calls = [];
  const q = new TurnQueue({
    prepare: async (v) => v,
    send: async (v) => { calls.push(v); },
  });
  q.setPaused(true);
  const p = q.enqueue("a");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(calls, [], "paused queue does not dispatch");
  q.setPaused(false);
  await p;
  assert.deepStrictEqual(calls, ["a"]);
}));

jsonlTests.push(asyncTest("send failure rejects only that turn", async () => {
  const q = new TurnQueue({
    prepare: async (v) => v,
    send: async (v) => { if (v === "bad") throw new Error("rpc down"); },
  });
  q.setPaused(false);
  await assert.rejects(q.enqueue("bad"), /rpc down/);
  await q.enqueue("good");
  assert.strictEqual(q.pendingCount, 0);
}));

// ---------- mentions ----------

console.log("\nmentions (buildPrompt):");

test("expands @file into a referenced-file block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mention-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), "hello notes");
    const out = buildPrompt(dir, "check @notes.md please");
    assert.ok(out.startsWith("check @notes.md please"), "original text kept");
    assert.ok(out.includes('Referenced file `notes.md`'), "reference block added");
    assert.ok(out.includes("hello notes"), "file content inlined");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves unknown @tokens untouched", () => {
  const text = "ping @nobody-here.ok";
  assert.strictEqual(buildPrompt(os.tmpdir(), text), text);
});

test("skips binary files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mention-"));
  try {
    fs.writeFileSync(path.join(dir, "blob.bin"), "ok\u0000binary");
    const out = buildPrompt(dir, "see @blob.bin");
    assert.strictEqual(out, "see @blob.bin");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skips oversized files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mention-"));
  try {
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(MAX_MENTION_BYTES + 1));
    const out = buildPrompt(dir, "see @big.txt");
    assert.strictEqual(out, "see @big.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- done ----------

Promise.all(jsonlTests).then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
