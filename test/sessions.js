"use strict";

// Session ID actions use the real host handlers; no pi process or LLM needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const mock = {
  window: { showInputBox: async () => undefined },
  env: { clipboard: { writeText: async () => {} } },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  return request === "vscode" ? "__session_vscode_mock__" : resolve.call(this, request, parent, isMain, options);
};
require.cache.__session_vscode_mock__ = { id: "__session_vscode_mock__", filename: "__session_vscode_mock__", loaded: true, exports: mock };
const pickers = require("../pickers");
const { SessionView } = require("../chat-provider");
const { PiChatProvider } = require("../multi-provider");
Module._resolveFilename = resolve;

const id = "019abcdef-1234-7000-8000-123456789abc";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-id-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const dir = pickers.projectSessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
    mock.window.showInputBox = async () => undefined;
    mock.env.clipboard.writeText = async () => {};
  });
  const save = (name, sessionId = id, workspace = cwd) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: workspace }) + "\n");
    return full;
  };
  return { root, cwd, dir, save };
}
function host(cwd, file) {
  const posted = [];
  const commands = [];
  const state = { sessionId: id, sessionFile: file, model: { id: "model" } };
  const client = { exited: false, request: async (command) => {
    commands.push(command);
    if (command.type === "get_state") return state;
    if (command.type === "get_messages") return { messages: [{ role: "user", content: "previous context" }] };
    return {};
  } };
  const session = Object.assign(Object.create(SessionView.prototype), {
    sessionId: "s1", client, view: { webview: { postMessage: (message) => posted.push(message) } },
    _cwd: cwd, shared: {}, log: { debug() {} }, _sessionRevision: 1, _activityVersion: 0,
    _stateRequest: 0, _statsRequest: 0, _sessionChanging: false, streaming: false, _compacting: false,
    turns: { pendingCount: 0, busy: false, setPaused() {}, setBusy(value) { this.busy = value; } },
    onSessionUpdate() {},
  });
  return { session, state, posted, commands };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("config override matches pi's absolute, relative and tilde session paths", (t) => {
  const f = fixture(t);
  assert.equal(pickers.projectSessionDir(f.cwd), f.dir);
  process.env.PI_CODING_AGENT_DIR = "../relative-agent";
  assert.equal(pickers.projectSessionDir(f.cwd), path.join(f.root, "relative-agent", "sessions", path.basename(f.dir)));
  process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
  assert.equal(pickers.projectSessionDir(f.cwd), path.join(os.homedir(), "custom-agent", "sessions", path.basename(f.dir)));
});

test("exact lookup finds older/renamed sessions beyond the history's 30 items without reading transcripts", async (t) => {
  const f = fixture(t);
  const old = f.save("renamed.jsonl");
  fs.appendFileSync(old, "x".repeat(2 * 1024 * 1024));
  fs.utimesSync(old, new Date(0), new Date(0));
  for (let n = 0; n < 35; n++) f.save(`${n}.jsonl`, `other-${n}`);
  assert.equal(await pickers.findSessionById(f.cwd, ` ${id} `), old);
  await assert.rejects(pickers.findSessionById(f.cwd, id.slice(0, 8)), /No saved session/);
});

test("lookup rejects invalid, missing, corrupt, oversized-header and wrong-workspace sessions", async (t) => {
  const f = fixture(t);
  for (const value of [null, "", "../session", "s".repeat(257), "pi --session abc", "."]) {
    assert.ok(pickers.sessionIdError(value));
    await assert.rejects(pickers.findSessionById(f.cwd, value), /full pi session ID/);
  }
  assert.equal(pickers.sessionIdError("custom.session-01"), null);
  f.save("other-workspace.jsonl", id, f.root);
  fs.writeFileSync(path.join(f.dir, "null.jsonl"), "null\n");
  fs.writeFileSync(path.join(f.dir, "bad.jsonl"), "{broken\n");
  fs.writeFileSync(path.join(f.dir, "huge.jsonl"), " ".repeat(65536) + JSON.stringify({ type: "session", id, cwd: f.cwd }) + "\n");
  fs.mkdirSync(path.join(f.dir, "directory.jsonl"));
  fs.symlinkSync(path.join(f.dir, "other-workspace.jsonl"), path.join(f.dir, "link.jsonl"));
  await assert.rejects(pickers.findSessionById(f.cwd, id), /No saved session/);
});

test("duplicate exact IDs never choose a file arbitrarily", async (t) => {
  const f = fixture(t);
  f.save("a.jsonl");
  f.save("b.jsonl");
  await assert.rejects(pickers.findSessionById(f.cwd, id), /More than one/);
});

test("copy action reads backend ID, works during streaming, and confirms clipboard success", async (t) => {
  const f = fixture(t);
  const h = host(f.cwd, f.save("session.jsonl"));
  const copied = [];
  mock.env.clipboard.writeText = async (text) => copied.push(text);
  h.session.streaming = true;
  await h.session._onFromWebview({ t: "copy_session_id" });
  assert.deepEqual(copied, [id]);
  assert.notEqual(copied[0], h.session.sessionId);
  assert.deepEqual(h.commands, [{ type: "get_state" }]);
  assert.match(h.posted[0].text, /Session ID copied/);
  assert.doesNotMatch(h.posted[0].text, /not saved/);
  assert.equal(h.posted[0].sessionId, "s1");
});

test("copy warns for unpersisted sessions, never falls back to a tab ID, and reports clipboard errors", async (t) => {
  const f = fixture(t);
  const h = host(f.cwd, path.join(f.dir, "not-saved.jsonl"));
  const copied = [];
  mock.env.clipboard.writeText = async (text) => copied.push(text);
  await h.session._copySessionId();
  assert.deepEqual(copied, [id]);
  assert.match(h.posted.at(-1).text, /not saved yet/);
  delete h.state.sessionId;
  await h.session._copySessionId();
  assert.equal(copied.length, 1);
  assert.match(h.posted.at(-1).text, /did not return a session ID/);
  h.state.sessionId = id;
  mock.env.clipboard.writeText = async () => { throw new Error("clipboard unavailable"); };
  await h.session._copySessionId();
  assert.match(h.posted.at(-1).text, /Could not copy.*clipboard unavailable/);
});

test("late copy responses after session change, close or view replacement cannot write the clipboard", async (t) => {
  const f = fixture(t);
  const copied = [];
  mock.env.clipboard.writeText = async (text) => copied.push(text);
  for (const change of [(s) => s._sessionRevision++, (s) => { s.client = null; }, (s) => { s.view = {}; }]) {
    const h = host(f.cwd, f.save("session.jsonl"));
    const gate = deferred();
    h.session.client.request = () => gate.promise;
    const pending = h.session._copySessionId();
    change(h.session);
    gate.resolve(h.state);
    await pending;
    assert.equal(h.posted.length, 0);
  }
  assert.deepEqual(copied, []);
});

test("resume action resolves full ID and uses confirmed switch/replay without sending a prompt or rolling back files", async (t) => {
  const f = fixture(t);
  const full = f.save("session.jsonl");
  const h = host(f.cwd, full);
  mock.window.showInputBox = async (options) => {
    assert.match(options.title, /by ID/);
    assert.equal(options.validateInput(id), null);
    return id;
  };
  await h.session._onFromWebview({ t: "resume_session_id" });
  assert.deepEqual(h.commands[0], { type: "switch_session", sessionPath: full });
  assert.ok(h.posted.some((message) => message.t === "cleared"));
  assert.ok(h.posted.some((message) => message.t === "replay" && message.messages[0].content === "previous context"));
  assert.ok(h.posted.some((message) => message.text === "Session resumed"));
  assert.ok(h.commands.every((command) => command.type !== "prompt"));
  assert.equal(h.session._sessionChanging, false);
  assert.ok(fs.existsSync(full));
});

test("resume dialog captures original owner, suppresses duplicates and ignores cancellation or a closed/restarted tab", async (t) => {
  const f = fixture(t);
  const full = f.save("session.jsonl");
  const changes = [() => {}, (s) => { s.client = null; }, (s) => s._sessionRevision++, (s) => { s.view = {}; }];
  for (const [index, change] of changes.entries()) {
    const h = host(f.cwd, full);
    const gate = deferred();
    let dialogs = 0;
    mock.window.showInputBox = () => { dialogs++; return gate.promise; };
    const pending = h.session._resumeBySessionId();
    await h.session._resumeBySessionId();
    assert.equal(dialogs, 1);
    change(h.session);
    gate.resolve(id);
    await pending;
    assert.equal(h.commands.some((command) => command.type === "switch_session"), index === 0);
    assert.ok(h.posted.every((message) => message.sessionId === "s1"));
  }
  const h = host(f.cwd, full);
  mock.window.showInputBox = async () => undefined;
  await h.session._resumeBySessionId();
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.posted, []);
});

test("busy/rollback state is rechecked after the native dialog; missing IDs and failed/cancelled switches preserve conversation", async (t) => {
  const f = fixture(t);
  const full = f.save("session.jsonl");
  for (const mode of ["busy", "lock", "missing", "error", "cancelled"]) {
    const h = host(f.cwd, full);
    mock.window.showInputBox = async () => {
      if (mode === "busy") h.session.streaming = true;
      if (mode === "lock") h.session.shared.isWorkspaceLocked = () => true;
      return mode === "missing" ? "not-found" : id;
    };
    const request = h.session.client.request;
    h.session.client.request = async (command) => {
      if (command.type === "switch_session") {
        if (mode === "error") throw new Error("switch failed");
        if (mode === "cancelled") return { cancelled: true };
      }
      return request(command);
    };
    await h.session._resumeBySessionId();
    assert.ok(!h.posted.some((message) => message.t === "cleared" || message.t === "replay"), mode);
    assert.ok(h.posted.length > 0, mode);
  }
});

test("multi-provider routes only known owners and allows copy (not resume) during workspace rollback", async (t) => {
  fixture(t);
  const calls = [];
  const view = {};
  const provider = Object.assign(Object.create(PiChatProvider.prototype), {
    sessions: new Map([["s1", { view, _onFromWebview: (message) => calls.push(message) }]]),
    view, activeId: "s1", rollbackLock: true, _post() {},
  });
  for (const sessionId of [undefined, "closed", "s1"]) {
    await provider._onMessage({ t: "copy_session_id", sessionId });
    await provider._onMessage({ t: "resume_session_id", sessionId });
  }
  assert.deepEqual(calls, [{ t: "copy_session_id", sessionId: "s1" }]);
});
