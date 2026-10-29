"use strict";

// Run with: node --test test/webview-sessions.js
// Small DOM/event/clock substitute for the APIs used by the real webview script.
// This intentionally does not model layout; tool heights/overflow need a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { renderMd, streamCut } = require("../markdown");
const source = fs.readFileSync(path.join(__dirname, "../webview.js"), "utf8");

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type, fields = {}) {
    const event = { type, target: this, bubbles: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields };
    for (let node = this; node; node = event.bubbles && !event.stopped ? node.parentNode : null) {
      event.currentTarget = node;
      for (const listener of node.listeners.get(type) || []) listener(event);
      if (typeof node["on" + type] === "function") node["on" + type](event);
    }
    return event;
  }
}

const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, code) =>
  ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[code]);

class Element extends Events {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 400;
    this.selectionStart = this.selectionEnd = 0;
    this.selectionDirection = "forward";
    this._value = this._html = "";
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes().has(name),
      toggle: (name, force) => {
        const values = classes();
        const add = force === undefined ? !values.has(name) : force;
        if (add) values.add(name); else values.delete(name);
        this.className = [...values].join(" ");
        return add;
      },
      add: (...names) => { for (const name of names) this.classList.toggle(name, true); },
      remove: (...names) => { for (const name of names) this.classList.toggle(name, false); },
    };
  }
  get children() { return this.childNodes.filter((child) => child instanceof Element); }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  get value() { return this._value; }
  set value(text) { this._value = String(text); this.selectionStart = this.selectionEnd = this._value.length; }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(text) {
    this.empty();
    this.childNodes.push({ textContent: String(text), parentNode: this });
    this._html = String(text);
  }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this.empty();
    // Only parse enough HTML to exercise rendered code/link delegation. Text remains escaped.
    const stack = [this];
    for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      const open = token.match(/^<([a-z][\w-]*)([^>]*)>/i);
      const parent = stack[stack.length - 1];
      if (open) {
        const child = new Element(open[1], this.ownerDocument);
        for (const attr of open[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1], decode(attr[2]));
        parent.appendChild(child);
        if (!["br", "hr", "img", "input"].includes(open[1])) stack.push(child);
      } else parent.childNodes.push({ textContent: decode(token), parentNode: parent });
    }
    this._html = String(html);
  }
  empty() {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this._html = "";
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === "id") this.id = String(value);
    if (key === "class") this.className = String(value);
  }
  getAttribute(key) {
    if (key === "id") return this.id || null;
    if (key === "class") return this.className;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child === before) return child;
    child.remove();
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.notEqual(index, -1);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  matches(selector) {
    const attr = selector.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
    if (attr && (attr[2] === undefined ? this.getAttribute(attr[1]) === null : this.getAttribute(attr[1]) !== attr[2])) return false;
    const plain = selector.replace(/\[[^\]]+\]/g, "");
    const id = plain.match(/#([\w-]+)/);
    if (id && this.id !== id[1]) return false;
    for (const cls of plain.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(cls[1])) return false;
    const tag = plain.match(/^[\w-]+/);
    return !tag || this.tagName.toLowerCase() === tag[0].toLowerCase();
  }
  closest(selector) {
    for (let node = this; node instanceof Element; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {
    if (!this.isConnected || this.disabled) return;
    const old = this.ownerDocument.activeElement;
    if (old !== this && old) old.fire("blur", { bubbles: false });
    this.ownerDocument.activeElement = this;
  }
  click() { if (!this.disabled) { this.focus(); this.fire("click"); } }
  setSelectionRange(start, end, direction = "forward") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  scrollIntoView() { this.scrolledIntoView = true; }
}

function boot(initialState = null) {
  const document = new Events();
  document.body = new Element("body", document);
  document.body.parentNode = document;
  document.activeElement = document.body;
  document.createElement = (tag) => new Element(tag, document);
  const elements = new Map();
  for (const [, id] of source.matchAll(/document\.getElementById\("([^"]+)"\)/g)) {
    if (elements.has(id)) continue;
    const tag = id === "input" ? "textarea" : id === "picker-search" ? "input" :
      id.startsWith("btn-") || ["model", "picker-close", "picker-cancel", "picker-rollback"].includes(id) ? "button" : "div";
    const node = document.createElement(tag);
    node.id = id;
    elements.set(id, node);
    document.body.appendChild(node);
  }
  document.getElementById = (id) => elements.get(id) || document.body.querySelector("#" + id);
  const get = (id) => document.getElementById(id);
  const nest = (parent, ids) => { for (const id of ids) get(parent).appendChild(get(id)); };
  nest("model", ["model-label"]);
  nest("btn-thinking", ["thinking-label"]);
  nest("toolbar-menu", ["btn-compact", "btn-checkpoint", "btn-restart"]);
  nest("picker-overlay", ["picker"]);
  nest("picker", ["picker-title", "picker-subtitle", "picker-search-wrap", "picker-list", "picker-empty", "picker-error", "picker-confirm", "picker-close"]);
  nest("picker-search-wrap", ["picker-search"]);
  nest("picker-confirm", ["picker-confirm-text", "picker-rollback", "picker-cancel"]);
  for (const id of ["picker-overlay", "autocomplete", "toolbar-menu", "picker-empty", "picker-error", "picker-confirm", "notice"]) get(id).hidden = true;

  const window = new Events();
  window.piMarkdown = { renderMd, streamCut };
  window.confirm = () => { throw new Error("Close confirmation belongs to the host"); };
  const outgoing = [];
  const timers = new Map();
  let state = initialState;
  let now = 100000;
  let nextTimer = 0;
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({ window, document, Element, console, Date: ClockDate,
    acquireVsCodeApi: () => ({ postMessage: (message) => outgoing.push(JSON.parse(JSON.stringify(message))),
      getState: () => state, setState: (next) => { state = JSON.parse(JSON.stringify(next)); } }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: "webview.js" });
  const host = (message) => window.fire("message", { data: message });
  const scoped = (sessionId, t, data = {}) => host({ ...data, t, sessionId });
  const panel = (id) => get("session-content").children.find((node) => node.dataset.sessionId === id);
  const tab = (id) => get("session-tabs").querySelectorAll(".session-tab").find((node) => node.dataset.sessionId === id);
  const close = (id) => tab(id).parentElement.querySelector(".tab-close");
  const roster = (activeId = "a", ids = ["a", "b"], extra = {}) => host({ t: "sessions", activeId, maxSessions: 6,
    sessions: ids.map((id) => ({ id, label: `Task ${id}`, busy: false, streaming: false, queued: 0,
      completed: false, error: false, closing: false })), ...extra });
  const ready = (id, data = {}) => scoped(id, "run_state", { ready: true, blocked: false, streaming: false, ...data });
  const type = (value, start = value.length, end = start, direction = "forward") => {
    get("input").focus();
    get("input").value = value;
    get("input").setSelectionRange(start, end, direction);
    get("input").fire("input");
  };
  function tick(delta) {
    const target = now + delta;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  return { get, document, outgoing, timers, host, scoped, panel, tab, close, roster, ready, type, tick,
    get state() { return state; }, last: () => outgoing[outgoing.length - 1] };
}

function pair() {
  const ui = boot();
  ui.roster();
  ui.ready("a");
  ui.ready("b");
  return ui;
}

function pickerReply(ui, request, items, extra = {}) {
  ui.scoped(request.sessionId, "picker_data", { kind: request.kind, requestId: request.requestId, items, ...extra });
}

test("only an authoritative roster creates/removes views; unknown/missing owners are ignored", () => {
  const ui = boot();
  assert.deepEqual(ui.outgoing, [{ t: "ready" }]);
  ui.scoped("ghost", "agent_start");
  ui.host({ t: "delta", kind: "text", delta: "unscoped" });
  assert.equal(ui.get("session-content").children.length, 0);
  ui.roster("b");
  assert.equal(ui.panel("a").hidden, true);
  assert.equal(ui.panel("b").hidden, false);
  assert.equal(ui.panel("a").getAttribute("role"), "tabpanel");
  assert.equal(ui.panel("a").getAttribute("aria-labelledby"), ui.tab("a").id);
  assert.equal(ui.tab("a").getAttribute("aria-controls"), ui.panel("a").id);
  for (const t of ["state", "stats", "run_state", "agent_start", "delta", "tool_start", "fatal", "cleared", "replay", "insert_input", "open_picker"]) {
    ui.scoped("ghost", t, { delta: "bad", model: "bad", text: "bad", message: "bad", kind: "text" });
  }
  ui.host(null);
  assert.equal(ui.get("session-content").children.length, 2);
  assert.equal(ui.panel("b").hidden, false);
  ui.roster("a", ["a"]);
  assert.equal(ui.panel("b"), undefined);
  ui.scoped("b", "delta", { kind: "text", delta: "closed" });
  assert.equal(ui.get("session-content").children.length, 1);
  assert.equal(ui.panel("a").hidden, false);
});

test("interleaved markdown/thinking streams, identical tool IDs, and timers stay with their owners", () => {
  const ui = pair();
  ui.scoped("a", "agent_start");
  ui.scoped("a", "delta", { kind: "text", delta: "A **stream**" });
  ui.scoped("b", "agent_start");
  ui.scoped("b", "delta", { kind: "text", delta: "B `stream`" });
  ui.scoped("a", "delta", { kind: "thinking", delta: "A reasoning" });
  ui.scoped("b", "delta", { kind: "thinking", delta: "B reasoning" });
  assert.equal(ui.timers.size, 2);
  ui.scoped("a", "msg_end", { text: "A final" });
  assert.equal(ui.timers.size, 1, "finalizing A must not cancel B's render");
  ui.panel("a").scrollTop = 123;
  ui.panel("a").scrollHeight = 2000;
  ui.panel("a").fire("scroll");
  ui.tick(120);
  assert.equal(ui.panel("a").querySelector(".md").innerHTML, renderMd("A final"));
  assert.equal(ui.panel("b").querySelector(".md-tail").innerHTML, renderMd("B `stream`"),
    "unfinalized streams render through the live tail");
  assert.equal(ui.panel("a").querySelector(".think-body").textContent, "A reasoning");
  assert.equal(ui.panel("b").querySelector(".think-body").textContent, "B reasoning");
  assert.equal(ui.panel("a").scrollTop, 123, "background render must not scroll A");
  assert.equal(ui.panel("a").hidden, false);
  ui.scoped("b", "msg_end", { text: "B final" });
  // Real RPC order: msg_end first, THEN tool_start. These tool cards are flex siblings.
  ui.scoped("a", "tool_start", { toolCallId: "shared", name: "edit", file: "/a.js", target: "a.js" });
  ui.scoped("b", "tool_start", { toolCallId: "shared", name: "read", file: "/b.js", target: "b.js" });
  assert.equal(ui.panel("a").querySelector(".tool").parentElement, ui.panel("a"));
  assert.equal(ui.panel("b").querySelector(".tool").parentElement, ui.panel("b"));
  ui.scoped("b", "tool_update", { toolCallId: "shared", text: "B partial" });
  ui.scoped("a", "tool_end", { toolCallId: "shared", text: "A result <not markup>" });
  ui.scoped("b", "tool_end", { toolCallId: "shared", text: "B failed", isError: true });
  assert.equal(ui.panel("a").querySelector(".tool-body").textContent, "A result <not markup>");
  assert.equal(ui.panel("b").querySelector(".tool-body").textContent, "B failed");
  assert.equal(ui.panel("a").querySelector(".tool").classList.contains("error"), false);
  assert.equal(ui.panel("b").querySelector(".tool").classList.contains("error"), true);
  assert.equal(ui.panel("b").querySelector(".diff-btn"), null, "read must not offer a diff");
  ui.scoped("b", "agent_settled");
  assert.equal(ui.get("btn-stop").hidden, false, "B settling cannot hide A's stop control");
  assert.match(ui.panel("a").querySelector(".status").textContent, /a\.js/);
  assert.equal(ui.panel("b").querySelector(".status"), null);
  ui.tab("b").click();
  ui.panel("a").querySelector(".diff-btn").click();
  assert.deepEqual(ui.last(), { t: "open_diff", sessionId: "a", path: "/a.js" });
});

test("drafts, selection, input/transcript scroll, and persisted state survive switches and rosters", () => {
  const ui = pair();
  ui.type("A draft", 1, 5, "backward");
  ui.get("input").scrollTop = 13;
  ui.panel("a").scrollTop = 87;
  ui.panel("a").fire("scroll");
  ui.tab("b").click();
  ui.type("B draft", 2, 4);
  const input = ui.get("input");
  const focused = ui.document.activeElement;
  const aPanel = ui.panel("a");
  ui.roster("b", ["a", "b", "c"]);
  assert.equal(input.value, "B draft");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  ui.scoped("a", "insert_input", { text: " + background context" });
  assert.equal(input.value, "B draft");
  assert.equal(ui.document.activeElement, focused);
  ui.tab("a").click();
  assert.equal(ui.panel("a"), aPanel, "switching keeps the actual transcript nodes");
  assert.equal(input.value, "A draft + background context");
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 5);
  assert.equal(input.selectionDirection, "backward");
  assert.equal(input.scrollTop, 13);
  assert.equal(aPanel.scrollTop, 87);
  ui.roster("b", ["b"]);
  assert.equal(ui.state.sessionDrafts.a.draft, "A draft + background context");
  assert.deepEqual(Object.keys(ui.state), ["sessionDrafts"]);
  const revived = boot(ui.state);
  assert.equal(revived.get("session-content").children.length, 0, "saved drafts do not invent host sessions");
  revived.roster("a");
  assert.equal(revived.get("input").value, "A draft + background context");
  assert.equal(revived.get("input").selectionStart, 1);
  assert.equal(revived.panel("a").querySelector(".msg"), null, "the host, not saved UI state, owns replay");
});

test("models, thinking, stats, blocked/stop controls and fatal notices are per-session", () => {
  const ui = pair();
  ui.scoped("a", "state", { model: "model A", thinkingLevel: "high", sessionName: "history A" });
  ui.scoped("a", "stats", { tokens: 2200, contextPercent: 18, cost: 0.5 });
  ui.ready("a", { streaming: true });
  ui.type("A prompt");
  ui.scoped("b", "state", { model: "model B", thinkingLevel: "low" });
  ui.scoped("b", "stats", { tokens: 950, contextPercent: 4, cost: 0.12 });
  ui.scoped("b", "fatal", { message: "B process failed" });
  assert.equal(ui.get("model-label").textContent, "model A · history A");
  assert.equal(ui.get("thinking-label").textContent, "high");
  assert.equal(ui.get("stats").textContent, "2k tok · 18% ctx · $0.50");
  assert.equal(ui.get("btn-send").disabled, false);
  assert.equal(ui.get("btn-stop").hidden, false);
  assert.equal(ui.get("notice").hidden, true);
  ui.tab("b").click();
  ui.type("B prompt");
  assert.equal(ui.get("model-label").textContent, "model B");
  assert.equal(ui.get("stats").textContent, "950 tok · 4% ctx · $0.12");
  assert.equal(ui.get("thinking-label").textContent, "low");
  assert.equal(ui.get("btn-send").disabled, true);
  assert.equal(ui.get("notice").textContent, "B process failed");
  assert.equal(ui.get("btn-restart").disabled, false);
  ui.ready("b", { streaming: true });
  assert.equal(ui.get("btn-send").disabled, false);
  assert.equal(ui.get("notice").hidden, true);
  ui.scoped("b", "cleared");
  assert.equal(ui.get("btn-stop").hidden, false, "clearing transcript is not an agent-settled event");
  ui.scoped("a", "fatal", { message: "A failed in background" });
  assert.equal(ui.get("btn-send").disabled, false);
  assert.equal(ui.get("notice").hidden, true);
  ui.get("btn-stop").click();
  assert.deepEqual(ui.last(), { t: "abort", sessionId: "b" });
  ui.ready("b", { blocked: true, streaming: false });
  assert.equal(ui.get("btn-send").disabled, true);
  ui.tab("a").click();
  assert.equal(ui.get("notice").textContent, "A failed in background");
});

test("tab nodes/focus stay stable, keyboard navigation and close use the clicked target", () => {
  const ui = pair();
  const aTab = ui.tab("a");
  const bTab = ui.tab("b");
  bTab.focus();
  ui.scoped("b", "delta", { kind: "text", delta: "background" });
  ui.roster("a");
  assert.equal(ui.tab("a"), aTab);
  assert.equal(ui.tab("b"), bTab);
  assert.equal(ui.document.activeElement, bTab);
  assert.equal(aTab.getAttribute("aria-selected"), "true");
  assert.equal(bTab.tabIndex, -1);
  assert.equal(ui.close("b").tagName, "BUTTON");
  assert.equal(ui.close("b").parentElement, bTab.parentElement);
  ui.close("b").click();
  assert.deepEqual(ui.last(), { t: "close_tab", sessionId: "b" });
  assert.equal(ui.panel("a").hidden, false, "closing background B does not select it");
  assert.ok(ui.panel("b"), "close waits for the authoritative roster");
  aTab.fire("keydown", { key: "ArrowLeft" });
  assert.deepEqual(ui.last(), { t: "switch_tab", sessionId: "b" });
  assert.equal(ui.document.activeElement, bTab);
  bTab.fire("keydown", { key: "Home" });
  assert.deepEqual(ui.last(), { t: "switch_tab", sessionId: "a" });
  aTab.fire("keydown", { key: "End" });
  assert.deepEqual(ui.last(), { t: "switch_tab", sessionId: "b" });
  bTab.fire("keydown", { key: "ArrowRight" });
  assert.deepEqual(ui.last(), { t: "switch_tab", sessionId: "a" });
  ui.close("b").focus();
  ui.roster("a", ["a"]);
  assert.equal(ui.document.activeElement, aTab);
  assert.equal(ui.panel("b"), undefined);
});

test("picker replies match owner, request and kind; stale callbacks cannot affect another picker", () => {
  const ui = pair();
  ui.get("model").click();
  const aRequest = ui.last();
  assert.equal(aRequest.t, "list_picker");
  assert.equal(aRequest.sessionId, "a");
  assert.ok(aRequest.requestId);
  pickerReply(ui, aRequest, [{ label: "A model", provider: "p", modelId: "a" }]);
  const staleRow = ui.get("picker-list").children[0];
  ui.roster("b");
  assert.equal(ui.get("picker-overlay").hidden, true);
  ui.get("model").click();
  const bRequest = ui.last();
  assert.notEqual(bRequest.requestId, aRequest.requestId);
  pickerReply(ui, aRequest, [{ label: "WRONG" }]);
  ui.scoped("a", "picker_error", { ...aRequest, message: "stale failure" });
  ui.scoped("a", "picker_done", aRequest);
  pickerReply(ui, { ...bRequest, kind: "thinking" }, [{ label: "wrong kind" }]);
  assert.equal(ui.get("picker-overlay").hidden, false);
  assert.equal(ui.get("picker-list").textContent, "Loading…");
  assert.equal(ui.get("picker-error").hidden, true);
  const count = ui.outgoing.length;
  staleRow.fire("click");
  assert.equal(ui.outgoing.length, count);
  pickerReply(ui, bRequest, [{ label: "B model", provider: "p", modelId: "b" }]);
  ui.get("picker-list").children[0].click();
  assert.deepEqual(ui.last(), { t: "choose_model", sessionId: "b", kind: "model",
    requestId: bRequest.requestId, provider: "p", modelId: "b" });
  ui.scoped("b", "picker_done", bRequest);
  assert.equal(ui.get("picker-overlay").hidden, true);
  ui.get("model").click();
  const fresh = ui.last();
  ui.scoped("b", "picker_error", { ...bRequest, message: "old B request" });
  assert.equal(ui.get("picker-error").hidden, true);
  ui.scoped("b", "picker_error", { ...fresh, message: "current failure" });
  assert.equal(ui.get("picker-error").textContent, "current failure");
  ui.scoped("a", "open_picker", { kind: "checkpoint" });
  assert.equal(ui.last(), fresh, "background open_picker cannot change selection or issue a request");
});

test("checkpoint confirmation captures its owner/request and honors workspace lock", () => {
  const ui = pair();
  ui.get("btn-checkpoint").click();
  const a = ui.last();
  pickerReply(ui, a, [{ label: "A checkpoint", hash: "aaa", prompt: "A prompt" }]);
  ui.get("picker-list").children[0].click();
  const staleConfirm = ui.get("picker-rollback").onclick;
  ui.roster("b");
  ui.get("btn-checkpoint").click();
  const b = ui.last();
  pickerReply(ui, b, [{ label: "B checkpoint", hash: "bbb", prompt: "<B prompt>" }]);
  ui.get("picker-list").children[0].click();
  assert.equal(ui.get("picker-confirm-text").textContent, "<B prompt>");
  const count = ui.outgoing.length;
  staleConfirm();
  assert.equal(ui.outgoing.length, count);
  ui.host({ t: "workspace_state", locked: true });
  assert.equal(ui.get("picker-rollback").disabled, true);
  ui.get("picker-rollback").onclick();
  assert.equal(ui.outgoing.length, count);
  ui.host({ t: "workspace_state", locked: false });
  ui.get("picker-rollback").click();
  assert.deepEqual(ui.last(), { t: "choose_checkpoint", sessionId: "b", kind: "checkpoint",
    requestId: b.requestId, hash: "bbb", prompt: "<B prompt>" });
});

test("workspace lock blocks send/new/run mutations while switching, stopping and closing remain available", () => {
  const ui = pair();
  ui.ready("a", { streaming: true });
  ui.type("keep this draft");
  ui.host({ t: "workspace_state", locked: true });
  for (const id of ["btn-send", "btn-new", "model", "btn-compact", "btn-restart", "btn-history", "btn-checkpoint"]) {
    assert.equal(ui.get(id).disabled, true, id);
  }
  const count = ui.outgoing.length;
  ui.get("input").fire("keydown", { key: "Enter" });
  assert.equal(ui.outgoing.length, count);
  assert.equal(ui.get("input").value, "keep this draft");
  ui.get("btn-stop").click();
  assert.deepEqual(ui.last(), { t: "abort", sessionId: "a" });
  ui.tab("b").click();
  assert.deepEqual(ui.last(), { t: "switch_tab", sessionId: "b" });
  ui.close("a").click();
  assert.deepEqual(ui.last(), { t: "close_tab", sessionId: "a" });
  ui.host({ t: "workspace_state", locked: false });
  ui.tab("a").click();
  assert.equal(ui.get("btn-send").disabled, false);
  ui.get("btn-send").click();
  assert.deepEqual(ui.last(), { t: "send", sessionId: "a", text: "keep this draft" });
  assert.equal(ui.panel("a").querySelector(".user").textContent, "keep this draft");
  assert.equal(ui.panel("b").querySelector(".user"), null);
});

test("/new and top-right + are global independent tasks; other slash commands are explicitly scoped", () => {
  const ui = pair();
  ui.type("/new");
  ui.get("btn-send").click();
  assert.deepEqual(ui.last(), { t: "new_tab" });
  ui.get("btn-new").click();
  assert.deepEqual(ui.last(), { t: "new_tab" });
  ui.tab("b").click();
  for (const [command, t] of [["stats", "show_stats"], ["context", "add_context"], ["settings", "open_settings"],
    ["compact", "compact"], ["restart", "restart"], ["stop", "abort"]]) {
    ui.type("/" + command);
    ui.get("btn-send").click();
    assert.deepEqual(ui.last(), { t, sessionId: "b" });
  }
  ui.scoped("b", "state", { model: "Not a task label" });
  assert.equal(ui.tab("b").querySelector(".tab-label").textContent, "Task b");
  ui.roster("b", ["a", "b", "c", "d", "e", "f"]);
  assert.equal(ui.get("btn-new").disabled, true);
  ui.type("/new");
  const count = ui.outgoing.length;
  ui.get("input").fire("keydown", { key: "Enter" });
  // An open autocomplete first inserts the builtin; sending still cannot create a seventh task.
  ui.get("input").fire("keydown", { key: "Enter" });
  assert.equal(ui.outgoing.length, count);
  assert.equal(ui.get("btn-send").disabled, true);
  ui.roster(null, []);
  ui.type("/new");
  ui.get("btn-send").click();
  assert.deepEqual(ui.last(), { t: "new_tab" }, "a global new task does not require an existing active session");
});

test("autocomplete commands and file caches are isolated, and tab switches close transient UI", () => {
  const ui = pair();
  ui.scoped("a", "commands", { commands: [{ name: "alpha", description: "A skill", source: "skill" }] });
  ui.scoped("b", "commands", { commands: [{ name: "beta", description: "B skill", source: "skill" }] });
  ui.type("/a");
  assert.match(ui.get("autocomplete").textContent, /alpha/);
  assert.doesNotMatch(ui.get("autocomplete").textContent, /beta/);
  ui.get("btn-more").click();
  ui.tab("b").click();
  assert.equal(ui.get("autocomplete").hidden, true);
  assert.equal(ui.get("toolbar-menu").hidden, true);
  ui.type("@src");
  assert.deepEqual(ui.last(), { t: "list_files", sessionId: "b" });
  ui.tab("a").click();
  ui.type("@src");
  assert.deepEqual(ui.last(), { t: "list_files", sessionId: "a" });
  ui.scoped("b", "files", { files: ["src/b.js"] });
  assert.equal(ui.get("autocomplete").hidden, true);
  ui.scoped("a", "files", { files: ["src/a.js"] });
  assert.match(ui.get("autocomplete").textContent, /src\/a\.js/);
  assert.doesNotMatch(ui.get("autocomplete").textContent, /src\/b\.js/);
  ui.get("autocomplete").children[0].fire("mousedown");
  assert.equal(ui.get("input").value, "@src/a.js ");
  ui.tab("b").click();
  ui.type("@src");
  assert.match(ui.get("autocomplete").textContent, /src\/b\.js/);
  ui.type("/beta please");
  ui.get("btn-send").click();
  assert.deepEqual(ui.last(), { t: "send", sessionId: "b", text: "/beta please" });
});

test("code/link callbacks keep captured IDs; destroying a view cancels all of its timers", () => {
  const ui = pair();
  ui.scoped("a", "agent_start");
  ui.scoped("a", "msg_end", { text: "```js\nconst a = 1;\n```\n\n[Link](https://example.com)" });
  const copy = ui.panel("a").querySelector(".code-copy");
  const link = ui.panel("a").querySelector("a[href]");
  assert.ok(copy);
  ui.tab("b").click();
  copy.click();
  assert.deepEqual(ui.last(), { t: "copy_text", sessionId: "a", text: "const a = 1;\n" });
  link.click();
  assert.deepEqual(ui.last(), { t: "open_link", sessionId: "a", url: "https://example.com" });
  ui.tick(1500);
  assert.equal(copy.textContent, "Copy");
  copy.click();
  ui.scoped("a", "delta", { kind: "text", delta: "A pending" });
  ui.scoped("b", "delta", { kind: "text", delta: "B pending" });
  const cancelled = [...ui.timers.values()].slice(0, 2);
  assert.equal(ui.timers.size, 3);
  const removed = ui.panel("a");
  const oldText = removed.textContent;
  ui.roster("b", ["b"]);
  assert.equal(ui.timers.size, 1);
  for (const timer of cancelled) timer.callback();
  assert.equal(removed.textContent, oldText, "already-queued callbacks also guard a disposed owner");
  ui.tick(1500);
  assert.equal(ui.panel("b").querySelector(".md-tail").innerHTML, renderMd("B pending"),
    "unfinalized streams render through the live tail");
  assert.equal(ui.timers.size, 0);
  assert.equal(copy.textContent, "Copied", "destroyed DOM is not mutated by an old copy timer");
});

test("edit diffs target the pre-turn checkpoint when the host provides one", () => {
  const ui = pair();
  ui.scoped("a", "tool_start", { toolCallId: "t1", name: "edit", file: "/x.js", checkpoint: "a".repeat(40) });
  ui.panel("a").querySelector(".diff-btn").click();
  assert.deepEqual(ui.last(), { t: "open_diff", sessionId: "a", path: "/x.js", base: "a".repeat(40) });
  ui.scoped("a", "tool_start", { toolCallId: "t2", name: "edit", file: "/y.js" });
  const buttons = ui.panel("a").querySelectorAll(".diff-btn");
  assert.equal(buttons.length, 2);
  buttons[1].click();
  assert.deepEqual(ui.last(), { t: "open_diff", sessionId: "a", path: "/y.js" },
    "no checkpoint: falls back to HEAD");
});

test("@-completion handles unicode filenames", () => {
  const ui = pair();
  ui.type("@笔记");
  assert.deepEqual(ui.last(), { t: "list_files", sessionId: "a" });
  ui.scoped("a", "files", { files: ["docs/笔记.md", "docs/other.md"] });
  assert.match(ui.get("autocomplete").textContent, /docs\/笔记\.md/);
  assert.doesNotMatch(ui.get("autocomplete").textContent, /other\.md/);
  ui.get("autocomplete").children[0].fire("mousedown");
  assert.equal(ui.get("input").value, "@docs/笔记.md ");
});

test("settling/fatal marks unfinished tools interrupted, never successful; replay/clear stay local", () => {
  const ui = pair();
  ui.scoped("a", "tool_start", { toolCallId: "shared", name: "bash" });
  ui.scoped("a", "tool_update", { toolCallId: "shared", text: "partial output" });
  ui.scoped("b", "tool_start", { toolCallId: "shared", name: "bash" });
  ui.scoped("a", "agent_settled");
  assert.equal(ui.panel("a").querySelector(".tool").classList.contains("interrupted"), true);
  assert.match(ui.panel("a").querySelector(".tool-body").textContent, /partial output[\s\S]*Interrupted/);
  assert.notEqual(ui.panel("a").querySelector(".tool-status").textContent, "✓");
  assert.equal(ui.panel("b").querySelector(".tool").classList.contains("running"), true);
  ui.scoped("b", "fatal", { message: "process stopped" });
  assert.equal(ui.panel("b").querySelector(".tool").classList.contains("interrupted"), true);
  ui.scoped("a", "cleared");
  ui.scoped("a", "replay", { messages: [
    { role: "user", content: "old A prompt" },
    { role: "assistant", content: [{ type: "text", text: "old A answer" }, { type: "thinking", thinking: "old reasoning" }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "old tool result" }] },
  ] });
  assert.match(ui.panel("a").textContent, /old A prompt/);
  assert.match(ui.panel("a").textContent, /old A answer/);
  assert.match(ui.panel("a").textContent, /old tool result/);
  assert.doesNotMatch(ui.panel("b").textContent, /old A/);
  ui.scoped("b", "cleared");
  assert.match(ui.panel("a").textContent, /old tool result/);
  assert.ok(ui.panel("b").querySelector(".empty-state-panel"));
});

test("CSS contract prevents transcript/tool flex shrink and contains narrow overflow (not a layout test)", () => {
  const css = fs.readFileSync(path.join(__dirname, "../webview.css"), "utf8");
  assert.match(css, /\.session-transcript\s*>\s*\*,\s*\.tools\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /\.session-transcript\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.tool\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /#session-tabs\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /@media\s*\(max-width:\s*320px\)/);
});
