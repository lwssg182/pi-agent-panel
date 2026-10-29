"use strict";
/* pi sidebar webview: chat UI over postMessage with the extension host. */

const vscode = acquireVsCodeApi();
const { renderMd, streamCut } = window.piMarkdown;

const sessionContent = document.getElementById("session-content");
const sessionTabs = document.getElementById("session-tabs");
const input = document.getElementById("input");
const notice = document.getElementById("notice");
const modelEl = document.getElementById("model");
const modelLabel = document.getElementById("model-label");
const thinkingLabel = document.getElementById("thinking-label");
const btnSend = document.getElementById("btn-send");
const btnStop = document.getElementById("btn-stop");
const btnNew = document.getElementById("btn-new");
const btnThinking = document.getElementById("btn-thinking");
const statsEl = document.getElementById("stats");
const acBox = document.getElementById("autocomplete");
const btnMore = document.getElementById("btn-more");
const toolbarMenu = document.getElementById("toolbar-menu");
const pickerOverlay = document.getElementById("picker-overlay");
const picker = document.getElementById("picker");
const pickerTitle = document.getElementById("picker-title");
const pickerSubtitle = document.getElementById("picker-subtitle");
const pickerSearchWrap = document.getElementById("picker-search-wrap");
const pickerSearch = document.getElementById("picker-search");
const pickerList = document.getElementById("picker-list");
const pickerEmpty = document.getElementById("picker-empty");
const pickerError = document.getElementById("picker-error");
const pickerConfirm = document.getElementById("picker-confirm");
const pickerRollback = document.getElementById("picker-rollback");

const PICKER_CONFIG = {
  model: { title: "Switch model", subtitle: "Choose a model for this session", search: "Search models…" },
  thinking: { title: "Thinking level", subtitle: "How much reasoning should pi use?", search: null },
  session: { title: "Session history", subtitle: "Resume a conversation in this workspace", search: "Search sessions…" },
  checkpoint: { title: "Restore checkpoint", subtitle: "Roll files back to before a message", search: "Search checkpoints…" },
};
const FILE_CACHE_TTL_MS = 60000;
const NEAR_BOTTOM_PX = 80;
const MD_RENDER_THROTTLE_MS = 120;
const RUN_MUTATIONS = new Set([
  "send", "restart", "compact", "choose_model", "choose_thinking", "choose_session", "choose_checkpoint",
]);

const sessionViews = new Map();
let sessionOrder = [];
let activeSessionId = null;
let maxSessions = 6;
let workspaceLocked = false;
let hasRoster = false;
let viewSequence = 0;
const restoredState = typeof vscode.getState === "function" ? vscode.getState() : null;
const savedDrafts = new Map(Object.entries((restoredState && restoredState.sessionDrafts) || {}));

/* Shared controls are a projection of the selected view, not the session state.
 * Only a roster or a user tab selection may change activeSessionId. */
class SessionView {
  constructor(id) {
    this.id = id;
    this.disposed = false;
    this.label = "";
    this.firstPrompt = "";
    this.model = "Starting…";
    this.sessionName = "";
    this.thinkingLevel = null;
    this.stats = "Ready";
    this.notice = "";
    this.fatal = false;
    this.runBlocked = true;
    this.busy = false;
    this.streaming = false;
    this.queued = 0;
    this.completed = false;
    this.error = false;
    this.closing = false;
    this.cur = null;
    this.toolEls = new Map();
    this.statusLines = new Map();
    this.timers = new Set();
    this.mdRenderTimer = null;
    this.replaySequence = 0;
    this.commands = [];
    this.filesCache = [];
    this.filesAt = 0;
    this.filesPending = false;

    const saved = savedDrafts.get(id) || {};
    this.draft = typeof saved.draft === "string" ? saved.draft : "";
    this.selectionStart = clampSelection(saved.selectionStart, this.draft.length);
    this.selectionEnd = clampSelection(saved.selectionEnd, this.draft.length);
    this.selectionDirection = ["backward", "forward", "none"].includes(saved.selectionDirection) ? saved.selectionDirection : "none";
    this.inputScrollTop = Number.isFinite(saved.inputScrollTop) ? saved.inputScrollTop : 0;
    this.scrollTop = Number.isFinite(saved.scrollTop) ? saved.scrollTop : 0;
    this.followOutput = true;

    const sequence = ++viewSequence;
    this.chat = el("div", "session-transcript");
    this.chat.id = `session-panel-${sequence}`;
    this.chat.dataset.sessionId = id;
    this.chat.setAttribute("role", "tabpanel");
    this.chat.setAttribute("aria-labelledby", `session-tab-${sequence}`);
    this.chat.setAttribute("aria-live", "off");
    this.chat.tabIndex = 0;
    this.chat.hidden = true;
    sessionContent.appendChild(this.chat);
    this.chat.addEventListener("click", (event) => onTranscriptClick(this, event));
    this.chat.addEventListener("scroll", () => {
      if (!isActive(this)) return;
      this.scrollTop = this.chat.scrollTop;
      this.followOutput = nearBottom(this);
      saveDraft(this);
    });

    // The close control is a sibling button, never nested inside the tab button.
    this.tabItem = el("div", "session-tab-item");
    this.tabItem.setAttribute("role", "presentation");
    this.tabItem.dataset.sessionId = id;
    this.tab = el("button", "session-tab");
    this.tab.type = "button";
    this.tab.id = `session-tab-${sequence}`;
    this.tab.dataset.sessionId = id;
    this.tab.setAttribute("role", "tab");
    this.tab.setAttribute("aria-controls", this.chat.id);
    this.tabIndicator = el("span", "tab-indicator");
    this.tabIndicator.setAttribute("aria-hidden", "true");
    this.tabLabel = el("span", "tab-label");
    this.tab.appendChild(this.tabIndicator);
    this.tab.appendChild(this.tabLabel);
    this.tab.addEventListener("click", () => selectSession(this.id));
    this.close = el("button", "tab-close", "×");
    this.close.type = "button";
    this.close.addEventListener("click", () => post("close_tab", { sessionId: this.id }));
    this.tabItem.appendChild(this.tab);
    this.tabItem.appendChild(this.close);
    renderEmptyState(this);
  }

  destroy() {
    saveDraft(this);
    this.disposed = true;
    cancelViewTimers(this);
    this.cur = null;
    this.toolEls.clear();
    this.statusLines.clear();
    this.chat.remove();
    this.tabItem.remove();
  }
}

function activeView() { return sessionViews.get(activeSessionId); }
function isLive(view) { return !!view && !view.disposed && sessionViews.get(view.id) === view; }
function isActive(view) { return isLive(view) && view.id === activeSessionId; }
function canMutate(view) { return isLive(view) && !workspaceLocked && !view.closing && !view.fatal && !view.runBlocked; }
function canCreateSession() { return hasRoster && !workspaceLocked && sessionViews.size < maxSessions; }

/** Every scoped caller supplies its owner explicitly; never substitute the active id. */
function post(type, data = {}) {
  if (type === "new_tab") {
    if (!canCreateSession()) return false;
  } else if (type !== "ready") {
    const view = sessionViews.get(data.sessionId);
    if (!isLive(view)) return false;
    // Stop and close remain available during a workspace restore or failed run.
    if (RUN_MUTATIONS.has(type) && (workspaceLocked || view.closing)) return false;
    if (RUN_MUTATIONS.has(type) && type !== "restart" && !canMutate(view)) return false;
  }
  vscode.postMessage({ ...data, t: type });
  return true;
}

function clampSelection(value, length) {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, length)) : length;
}

function saveDraft(view) {
  if (!view) return;
  savedDrafts.set(view.id, {
    draft: view.draft, selectionStart: view.selectionStart, selectionEnd: view.selectionEnd,
    selectionDirection: view.selectionDirection, inputScrollTop: view.inputScrollTop, scrollTop: view.scrollTop,
  });
  // Retain recent closed drafts as well as live ones, without an unbounded history.
  for (const id of savedDrafts.keys()) {
    if (savedDrafts.size <= 24) break;
    if (!sessionViews.has(id)) savedDrafts.delete(id);
  }
  if (typeof vscode.setState === "function") vscode.setState({ sessionDrafts: Object.fromEntries(savedDrafts) });
}

function captureComposer(view = activeView()) {
  if (!isActive(view)) return;
  view.draft = input.value;
  view.selectionStart = input.selectionStart;
  view.selectionEnd = input.selectionEnd;
  view.selectionDirection = input.selectionDirection;
  view.inputScrollTop = input.scrollTop;
  view.scrollTop = view.chat.scrollTop;
  saveDraft(view);
}

function restoreComposer(view) {
  input.value = view ? view.draft : "";
  resizeInput();
  if (view) {
    input.setSelectionRange(view.selectionStart, view.selectionEnd, view.selectionDirection);
    input.scrollTop = view.inputScrollTop;
  }
}

function activateSessionView(id) {
  if (id !== null && !sessionViews.has(id)) return;
  if (id === activeSessionId) return;
  captureComposer();
  const transientFocus = pickerOverlay.contains(document.activeElement) || toolbarMenu.contains(document.activeElement);
  closePicker(false);
  acHide();
  toggleMenu(false);
  activeSessionId = id;
  for (const view of sessionViews.values()) {
    view.chat.hidden = view.id !== id;
    view.chat.setAttribute("aria-live", view.id === id ? "polite" : "off");
    updateTab(view);
  }
  const view = activeView();
  restoreComposer(view);
  if (view) {
    view.chat.scrollTop = view.scrollTop;
    view.followOutput = nearBottom(view);
  }
  refreshControls();
  if (transientFocus) input.focus({ preventScroll: true });
}

function selectSession(id) {
  if (!sessionViews.has(id)) return;
  activateSessionView(id);
  post("switch_tab", { sessionId: id });
}

function updateTab(view) {
  const selected = view.id === activeSessionId;
  const title = view.label || view.firstPrompt || "New task";
  const state = view.closing ? "closing" : view.error ? "error" :
    (view.busy || view.streaming) ? "busy" : view.queued ? "queued" : view.completed ? "completed" : "idle";
  const detail = state === "busy" ? "Working" : state === "queued" ? "Queued" :
    state === "closing" ? "Closing" : state === "error" ? "Error" : state === "completed" ? "Completed" : "Ready";
  view.tabItem.classList.toggle("active", selected);
  view.tabItem.dataset.state = state;
  view.tab.classList.toggle("active", selected);
  view.tab.setAttribute("aria-selected", String(selected));
  view.tab.tabIndex = selected ? 0 : -1;
  const description = `${title} · ${detail}${view.queued ? ` · ${view.queued} queued` : ""}`;
  view.tab.title = description;
  view.tab.setAttribute("aria-label", description);
  if (view.tabLabel.textContent !== title) view.tabLabel.textContent = title;
  view.tabIndicator.hidden = state === "idle";
  view.close.title = `Close ${title}`;
  view.close.setAttribute("aria-label", `Close ${title}`);
}

function applyRoster(message) {
  if (!Array.isArray(message.sessions)) return;
  captureComposer(); // A metadata refresh must never restore an old draft over current typing.
  const focused = sessionTabs.contains(document.activeElement) ? document.activeElement : null;
  const entries = message.sessions.filter((s) => s && typeof s.id === "string" && s.id);
  const ids = new Set(entries.map((s) => s.id));
  for (const [id, view] of sessionViews) {
    if (ids.has(id)) continue;
    if (pickerState && pickerState.sessionId === id) closePicker(false);
    view.destroy();
    sessionViews.delete(id);
  }
  sessionOrder = [...ids];
  for (const entry of entries) {
    let view = sessionViews.get(entry.id);
    if (!view) {
      view = new SessionView(entry.id);
      sessionViews.set(entry.id, view);
    }
    view.label = typeof entry.label === "string" ? entry.label : view.label;
    // completed/error stay view-local: the host doesn't track them, and a
    // metadata roster must never reset the tab's error/completed state.
    for (const key of ["busy", "streaming", "closing"]) {
      if (typeof entry[key] === "boolean") view[key] = entry[key];
    }
    if (typeof entry.queued === "number") view.queued = entry.queued;
    if (typeof entry.model === "string") view.model = entry.model || "Starting…";
    if (typeof entry.sessionName === "string") view.sessionName = entry.sessionName;
    updateTab(view);
  }
  // Reconcile in place. Deltas never rebuild tabs, and metadata-only rosters don't either.
  sessionOrder.forEach((id, index) => {
    const item = sessionViews.get(id).tabItem;
    if (sessionTabs.children[index] !== item) sessionTabs.insertBefore(item, sessionTabs.children[index] || null);
  });
  hasRoster = true;
  if (Number.isInteger(message.maxSessions) && message.maxSessions > 0) maxSessions = message.maxSessions;
  if (typeof message.locked === "boolean") workspaceLocked = message.locked;
  activateSessionView(sessionViews.has(message.activeId) ? message.activeId : null);
  refreshControls();
  if (focused && document.activeElement !== focused) {
    const target = focused.isConnected ? focused : (activeView() ? activeView().tab : btnNew);
    target.focus({ preventScroll: true });
  }
}

sessionTabs.addEventListener("keydown", (event) => {
  const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
  if (!tab) return;
  let index = sessionOrder.indexOf(tab.dataset.sessionId);
  if (index === -1) return;
  if (event.key === "ArrowRight") index = (index + 1) % sessionOrder.length;
  else if (event.key === "ArrowLeft") index = (index - 1 + sessionOrder.length) % sessionOrder.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = sessionOrder.length - 1;
  else return;
  event.preventDefault();
  selectSession(sessionOrder[index]);
  const selected = activeView().tab;
  selected.focus({ preventScroll: true });
  selected.scrollIntoView({ block: "nearest", inline: "nearest" });
});

/* Slash-command / @-file autocomplete and the picker are transient, explicitly
 * owned by the selected view. Switching tabs invalidates both. */
let acItems = [];
let acIndex = 0;
let acOpen = false;
let acOwnerId = null;
let pickerState = null;
let pickerSequence = 0;
const pickerEpoch = Date.now().toString(36);

const BUILTINS = [
  { name: "model", desc: "Switch the model", act: (v) => openPicker(v, "model") },
  { name: "thinking", desc: "Thinking level (reasoning effort)", act: (v) => openPicker(v, "thinking") },
  { name: "session", desc: "Resume a previous session of this workspace", act: (v) => openPicker(v, "session") },
  { name: "new", desc: "Start a new parallel task", act: () => post("new_tab") },
  { name: "compact", desc: "Compact the context now", act: (v) => post("compact", { sessionId: v.id }) },
  { name: "clear", desc: "Clear the chat display (session is kept)", act: (v) => clearChat(v) },
  { name: "rollback", desc: "Roll the working tree back to a checkpoint (git)", act: (v) => openPicker(v, "checkpoint") },
  { name: "context", desc: "Attach active editor selection / file", act: (v) => post("add_context", { sessionId: v.id }) },
  { name: "stats", desc: "Show usage: tokens · context · cost", act: (v) => post("show_stats", { sessionId: v.id }) },
  { name: "stop", desc: "Abort the current run", act: (v) => post("abort", { sessionId: v.id }) },
  { name: "restart", desc: "Restart the pi process", act: (v) => post("restart", { sessionId: v.id }) },
  { name: "settings", desc: "Open extension settings", act: (v) => post("open_settings", { sessionId: v.id }) },
  { name: "help", desc: "Show built-in commands and tips", act: showHelp },
];

/* ------------------------------------------------------------------ input */

btnSend.addEventListener("click", send);
btnStop.addEventListener("click", () => post("abort", { sessionId: activeSessionId }));
modelEl.addEventListener("click", (e) => openPicker(activeView(), "model", e.currentTarget));
modelEl.title = "Switch model";
btnThinking.addEventListener("click", (e) => openPicker(activeView(), "thinking", e.currentTarget));
document.getElementById("btn-history").addEventListener("click", (e) => openPicker(activeView(), "session", e.currentTarget));
document.getElementById("btn-context").addEventListener("click", () => post("add_context", { sessionId: activeSessionId }));
document.getElementById("btn-compact").addEventListener("click", () => post("compact", { sessionId: activeSessionId }));
document.getElementById("btn-checkpoint").addEventListener("click", (e) => openPicker(activeView(), "checkpoint", e.currentTarget));
document.getElementById("btn-restart").addEventListener("click", () => post("restart", { sessionId: activeSessionId }));
btnNew.addEventListener("click", () => post("new_tab"));
btnNew.setAttribute("aria-label", "New parallel task");

function toggleMenu(show) {
  const open = show !== undefined ? show : toolbarMenu.hidden;
  toolbarMenu.hidden = !open;
  btnMore.setAttribute("aria-expanded", String(open));
}

btnMore.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
toolbarMenu.addEventListener("click", () => toggleMenu(false));
document.addEventListener("pointerdown", (e) => {
  if (toolbarMenu.hidden) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t || (!t.closest("#toolbar-menu") && !t.closest("#btn-more"))) toggleMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (toolbarMenu.hidden || !pickerOverlay.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); toggleMenu(false); btnMore.focus(); }
});

input.addEventListener("keydown", (e) => {
  if (acOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); acMove(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acSelect(); return; }
    if (e.key === "Escape") { e.preventDefault(); acHide(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  resizeInput();
  captureComposer();
  updateSendButton();
  acUpdate();
});
for (const event of ["select", "keyup", "click", "scroll", "blur"]) {
  input.addEventListener(event, () => captureComposer());
}
window.addEventListener("pagehide", () => captureComposer());

function resizeInput() {
  input.style.height = "0px";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}

function builtinFor(text) {
  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
  return match && BUILTINS.find((command) => command.name === match[1]);
}

function canSubmit(view, text) {
  if (!text) return false;
  const builtin = builtinFor(text);
  if (builtin && builtin.name === "new") return canCreateSession();
  if (!isLive(view)) return false;
  if (builtin && ["clear", "context", "stats", "stop", "settings", "help"].includes(builtin.name)) return true;
  if (builtin && builtin.name === "restart") return !workspaceLocked && !view.closing;
  return canMutate(view);
}

function updateSendButton() {
  const view = activeView();
  btnSend.disabled = !canSubmit(view, input.value.trim());
  btnSend.title = workspaceLocked ? "Workspace restore in progress" :
    (!view || view.runBlocked || view.fatal || view.closing) ? "Wait for pi to be ready, or restart it" : "Send message";
}

function refreshControls(view = activeView()) {
  if (view && !isActive(view)) return;
  modelLabel.textContent = view ? view.model + (view.sessionName ? ` · ${view.sessionName}` : "") : "Starting…";
  modelLabel.title = view ? view.model : "";
  thinkingLabel.textContent = view ? view.thinkingLevel || "" : "";
  btnThinking.hidden = !view || !view.thinkingLevel;
  statsEl.textContent = view ? view.stats : "Ready";
  btnStop.hidden = !view || !view.streaming || view.fatal;
  btnStop.disabled = !view;
  const message = (view && view.notice) || (workspaceLocked ? "Workspace restore in progress. Sending and run changes are temporarily disabled." : "");
  notice.textContent = message;
  notice.hidden = !message;
  const disabled = !canMutate(view);
  for (const id of ["model", "btn-thinking", "btn-history", "btn-compact", "btn-checkpoint"]) {
    document.getElementById(id).disabled = disabled;
  }
  document.getElementById("btn-context").disabled = !view || view.closing;
  document.getElementById("btn-restart").disabled = !view || workspaceLocked || view.closing;
  btnNew.disabled = !canCreateSession();
  btnNew.title = workspaceLocked ? "Workspace restore in progress" :
    sessionViews.size >= maxSessions ? `Up to ${maxSessions} parallel sessions` : "New parallel task";
  if (pickerState) {
    pickerRollback.disabled = pickerState.pending || !canMutate(pickerState.view);
    for (const row of pickerList.children) row.disabled = pickerState.pending || !canMutate(pickerState.view);
  }
  updateSendButton();
}

function send() {
  const view = activeView();
  const text = input.value.trim();
  if (!canSubmit(view, text)) return;
  closePicker(false);
  input.value = "";
  input.setSelectionRange(0, 0);
  resizeInput();
  captureComposer(view);
  updateSendButton();
  acHide();
  const builtin = builtinFor(text);
  if (builtin) { builtin.act(view); return; }
  if (post("send", { sessionId: view.id, text })) addUserMsg(view, text);
}

function showHelp(view) {
  const lines = BUILTINS.map((c) => ("  /" + c.name).padEnd(13) + c.desc);
  addInfo(view, "Built-in commands:\n" + lines.join("\n") +
    "\n\nAnything else starting with / (skills, prompt templates, pi\n" +
    "extension commands) is executed by pi itself.\n" +
    "Tips: @file references a workspace file · Enter sends ·\nShift+Enter inserts a newline.", true);
}

function onTranscriptClick(view, event) {
  if (!isLive(view)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const suggestion = target.closest(".suggestion");
  if (suggestion) {
    if (!isActive(view)) return;
    input.value = suggestion.dataset.prompt || "";
    input.setSelectionRange(input.value.length, input.value.length);
    resizeInput();
    captureComposer(view);
    updateSendButton();
    input.focus();
    return;
  }
  const copy = target.closest(".code-copy");
  if (copy) {
    const code = copy.parentElement.querySelector("code");
    copyCode(view, code ? code.textContent : "", copy);
    return;
  }
  const link = target.closest("a[href]");
  if (link) {
    event.preventDefault();
    post("open_link", { sessionId: view.id, url: link.getAttribute("href") });
  }
}

function copyCode(view, text, button) {
  if (!text || !post("copy_text", { sessionId: view.id, text })) return;
  button.textContent = "Copied";
  viewTimeout(view, () => { button.textContent = "Copy"; }, 1500);
}

/* ------------------------------------------------------- slash autocomplete */

function acUpdate() {
  const view = activeView();
  if (!view || !pickerOverlay.hidden) return acHide();
  const value = input.value;
  acOwnerId = view.id;
  const slash = value.match(/^\/(\w[\w:.-]*)?$/);
  if (slash) {
    const query = (slash[1] || "").toLowerCase();
    const builtins = BUILTINS.filter((b) => b.name.startsWith(query)).slice(0, 12)
      .map((b) => ({ kind: "builtin", name: b.name, desc: b.desc }));
    const commands = view.commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 12)
      .map((c) => ({ kind: "command", name: c.name,
        desc: "[" + (c.source === "skill" ? "skill" : c.source === "prompt" ? "template" : "ext") + "] " + (c.description || "") }));
    acItems = builtins.concat(commands);
  } else {
    const caret = input.selectionStart == null ? value.length : input.selectionStart;
    const file = value.slice(0, caret).match(/(^|\s)@([\p{L}\p{N}./_+-]{0,100})$/u);
    if (!file) return acHide();
    const query = file[2].toLowerCase();
    if (!view.filesPending && (!view.filesAt || Date.now() - view.filesAt > FILE_CACHE_TTL_MS)) {
      view.filesPending = post("list_files", { sessionId: view.id });
    }
    acItems = view.filesCache.filter((path) => path.toLowerCase().includes(query))
      .sort((a, b) => scoreFile(b, query) - scoreFile(a, query)).slice(0, 12)
      .map((path) => ({ kind: "file", path }));
  }
  if (!acItems.length) return acHide();
  acIndex = Math.max(0, Math.min(acIndex, acItems.length - 1));
  acRender();
}

function scoreFile(path, query) {
  if (!query) return 0;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return base.startsWith(query) ? 2 : path.toLowerCase().includes(query) ? 1 : 0;
}

function acRender() {
  const ownerId = acOwnerId;
  acBox.innerHTML = "";
  acItems.forEach((item, index) => {
    const row = el("div", "ac-item" + (index === acIndex ? " active" : ""));
    row.appendChild(el("span", "ac-name", item.kind === "file" ? "@" + item.path : "/" + item.name));
    row.appendChild(el("span", "ac-desc", item.kind === "file" ? "file" : item.desc.slice(0, 60)));
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (!acOpen || acOwnerId !== ownerId || activeSessionId !== ownerId) return;
      acIndex = index;
      acSelect();
    });
    acBox.appendChild(row);
  });
  acBox.hidden = false;
  acOpen = true;
}

function acMove(delta) {
  acIndex = (acIndex + delta + acItems.length) % acItems.length;
  acRender();
}

function acSelect() {
  const view = activeView();
  const item = acItems[acIndex];
  if (!view || view.id !== acOwnerId || !item) return acHide();
  if (item.kind === "file") {
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const before = input.value.slice(0, caret);
    const after = input.value.slice(caret);
    const match = before.match(/@([\p{L}\p{N}./_+-]*)$/u);
    const at = match ? caret - match[1].length - 1 : caret;
    const insert = "@" + item.path + " ";
    input.value = input.value.slice(0, at) + insert + after;
    input.setSelectionRange(at + insert.length, at + insert.length);
  } else {
    input.value = "/" + item.name + " ";
    input.setSelectionRange(input.value.length, input.value.length);
  }
  acHide();
  input.focus();
  resizeInput();
  captureComposer(view);
  updateSendButton();
}

function acHide() {
  acBox.hidden = true;
  acOpen = false;
  acOwnerId = null;
  acItems = [];
  acIndex = 0;
}

/* ---------------------------------------------------------- panel picker */

function pickerIsCurrent(state) {
  return !!state && pickerState === state && isActive(state.view) && !pickerOverlay.hidden;
}

function matchingPicker(view, message) {
  const state = pickerState;
  return pickerIsCurrent(state) && state.view === view && state.kind === message.kind &&
    state.requestId === message.requestId ? state : null;
}

function openPicker(view, kind, opener) {
  const config = PICKER_CONFIG[kind];
  if (!config || !isActive(view) || !canMutate(view)) return false;
  closePicker(false);
  acHide();
  toggleMenu(false);
  const state = { view, sessionId: view.id, kind, requestId: `${pickerEpoch}-${++pickerSequence}`,
    items: [], filtered: [], index: 0, pending: true, opener: opener || document.activeElement };
  pickerState = state;
  pickerTitle.textContent = config.title;
  pickerSubtitle.textContent = config.subtitle;
  pickerList.hidden = false;
  pickerSearchWrap.hidden = false;
  pickerSearchWrap.style.display = config.search ? "" : "none";
  pickerSearch.value = "";
  pickerSearch.placeholder = config.search || "";
  pickerEmpty.hidden = true;
  pickerError.hidden = true;
  pickerConfirm.hidden = true;
  pickerRollback.onclick = null;
  pickerRollback.disabled = false;
  pickerList.innerHTML = "";
  pickerList.appendChild(el("div", "picker-loading", "Loading…"));
  pickerOverlay.hidden = false;
  picker.style.width = kind === "thinking" ? "230px" : "";
  post("list_picker", { sessionId: state.sessionId, requestId: state.requestId, kind });
  pickerList.tabIndex = -1;
  (config.search ? pickerSearch : pickerList).focus();
  return true;
}

function closePicker(restoreFocus = true) {
  const state = pickerState;
  pickerOverlay.hidden = true;
  pickerState = null;
  pickerRollback.onclick = null;
  if (restoreFocus && state && isActive(state.view) && state.opener && state.opener.isConnected) {
    state.opener.focus({ preventScroll: true });
  }
}

function filterPicker(state = pickerState) {
  if (!pickerIsCurrent(state)) return;
  const query = pickerSearch.value.trim().toLowerCase();
  state.filtered = !query ? state.items : state.items.filter((item) =>
    [item.label, item.description, item.detail].some((value) => String(value || "").toLowerCase().includes(query)));
  state.index = Math.max(0, Math.min(state.index, state.filtered.length - 1));
  renderPicker(state);
}

function highlightPicker(state) {
  if (!pickerIsCurrent(state)) return;
  for (let i = 0; i < pickerList.children.length; i++) {
    const row = pickerList.children[i];
    row.classList.toggle("active", i === state.index);
    row.setAttribute("aria-selected", String(i === state.index));
  }
  const active = pickerList.children[state.index];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderPicker(state) {
  if (!pickerIsCurrent(state)) return;
  pickerList.innerHTML = "";
  pickerEmpty.hidden = state.filtered.length > 0;
  state.filtered.forEach((item, index) => {
    const row = el("button", "picker-item");
    row.type = "button";
    row.setAttribute("role", "option");
    row.disabled = state.pending || !canMutate(state.view);
    const main = el("span", "picker-main");
    main.appendChild(el("span", "picker-label", item.label));
    if (item.description) main.appendChild(el("span", "picker-description", item.description));
    row.appendChild(main);
    const meta = el("span", "picker-meta");
    if (item.detail) meta.appendChild(el("span", "picker-detail", item.detail));
    if (item.current) meta.appendChild(el("span", "picker-current", "Current"));
    if (!item.current && !item.detail) meta.textContent = "›";
    row.appendChild(meta);
    row.addEventListener("click", () => choosePicker(state, index));
    row.addEventListener("mousemove", () => {
      if (pickerIsCurrent(state) && state.index !== index) { state.index = index; highlightPicker(state); }
    });
    pickerList.appendChild(row);
  });
  highlightPicker(state);
}

function choosePicker(state, index) {
  if (!pickerIsCurrent(state) || state.pending || !canMutate(state.view)) return;
  const item = state.filtered[index];
  if (!item) return;
  if (item.current) { closePicker(); return; }
  state.pending = true;
  pickerError.hidden = true;
  const scope = { sessionId: state.sessionId, requestId: state.requestId, kind: state.kind };
  if (state.kind === "model") post("choose_model", { ...scope, provider: item.provider, modelId: item.modelId });
  else if (state.kind === "thinking") post("choose_thinking", { ...scope, level: item.level });
  else if (state.kind === "session") post("choose_session", { ...scope, path: item.path });
  else if (state.kind === "checkpoint") { showCheckpointConfirm(state, item); return; }
  pickerList.innerHTML = "";
  pickerList.appendChild(el("div", "picker-loading", state.kind === "session" ? "Resuming conversation…" : "Applying…"));
}

function showCheckpointConfirm(state, item) {
  state.pending = false;
  pickerList.hidden = true;
  pickerEmpty.hidden = true;
  pickerSearchWrap.hidden = true;
  document.getElementById("picker-confirm-text").textContent = item.prompt || "This checkpoint";
  pickerConfirm.hidden = false;
  // Capture BOTH the owner and request. A delayed confirmation can never target a new tab/picker.
  pickerRollback.onclick = () => {
    if (!pickerIsCurrent(state) || state.pending || !canMutate(state.view)) return;
    state.pending = true;
    pickerError.hidden = true;
    pickerRollback.disabled = true;
    post("choose_checkpoint", { sessionId: state.sessionId, requestId: state.requestId,
      kind: state.kind, hash: item.hash, prompt: item.prompt });
  };
  pickerRollback.disabled = false;
  pickerRollback.focus();
}

function showPickerError(state, message) {
  state.pending = false;
  pickerError.textContent = message;
  pickerError.hidden = false;
  pickerList.hidden = false;
  pickerSearchWrap.hidden = false;
  pickerSearchWrap.style.display = PICKER_CONFIG[state.kind].search ? "" : "none";
  pickerConfirm.hidden = true;
  pickerRollback.onclick = null;
  filterPicker(state);
}

pickerSearch.addEventListener("input", () => filterPicker());
document.getElementById("picker-close").addEventListener("click", () => closePicker());
document.getElementById("picker-cancel").addEventListener("click", () => {
  const state = pickerState;
  if (!pickerIsCurrent(state)) return;
  pickerConfirm.hidden = true;
  pickerRollback.onclick = null;
  pickerList.hidden = false;
  pickerSearchWrap.hidden = false;
  pickerSearchWrap.style.display = PICKER_CONFIG[state.kind].search ? "" : "none";
  filterPicker(state);
});
pickerOverlay.addEventListener("pointerdown", (e) => { if (e.target === pickerOverlay) closePicker(); });
document.addEventListener("keydown", (e) => {
  const state = pickerState;
  if (!pickerIsCurrent(state)) return;
  if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
  if (!pickerConfirm.hidden || state.pending) return;
  if (e.key === "ArrowDown") { e.preventDefault(); state.index = (state.index + 1) % Math.max(1, state.filtered.length); highlightPicker(state); }
  else if (e.key === "ArrowUp") { e.preventDefault(); state.index = (state.index - 1 + state.filtered.length) % Math.max(1, state.filtered.length); highlightPicker(state); }
  else if (e.key === "Enter") { e.preventDefault(); choosePicker(state, state.index); }
});

/* ------------------------------------------------------------- rendering */

function el(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}

function nearBottom(view) {
  return view.chat.scrollHeight - view.chat.scrollTop - view.chat.clientHeight < NEAR_BOTTOM_PX;
}

function scrollDown(view, force) {
  // Hidden views keep their saved scroll position; background output never scrolls shared UI.
  if (!isActive(view) || (!force && !view.followOutput)) return;
  view.chat.scrollTop = view.chat.scrollHeight;
  view.scrollTop = view.chat.scrollTop;
  view.followOutput = true;
}

function ensureConversation(view) {
  const empty = view.chat.querySelector(".empty-state-panel");
  if (empty) empty.remove();
}

function renderEmptyState(view) {
  if (view.chat.children.length) return;
  const empty = el("div", "empty-state-panel");
  empty.appendChild(el("div", "empty-logo", ">_"));
  empty.appendChild(el("h1", null, "What are we building?"));
  empty.appendChild(el("p", null, "Your AI pair programmer, right inside your editor.\nAsk a question, squash a bug, or ship something new."));
  const suggestions = el("div", "suggestion-list");
  for (const prompt of ["Explain what this project does", "Find and fix a bug in the current file", "Write tests for my recent changes"]) {
    const button = el("button", "suggestion");
    button.type = "button";
    button.dataset.prompt = prompt;
    button.appendChild(el("span", null, prompt));
    button.appendChild(el("span", null, "↗"));
    suggestions.appendChild(button);
  }
  empty.appendChild(suggestions);
  view.chat.appendChild(empty);
}

function addUserMsg(view, text) {
  ensureConversation(view);
  if (!view.firstPrompt && text.trim()) { view.firstPrompt = text.trim().split("\n")[0]; updateTab(view); }
  view.chat.appendChild(el("div", "msg user", text));
  scrollDown(view, true);
}

function startAssistantMsg(view) {
  ensureConversation(view);
  const root = el("div", "msg assistant");
  const think = el("details", "thinking");
  think.hidden = true;
  think.appendChild(el("summary", null, "thinking"));
  const thinkBody = el("div", "think-body");
  think.appendChild(thinkBody);
  const text = el("div", "md");
  const tools = el("div", "tools");
  root.appendChild(think);
  root.appendChild(text);
  root.appendChild(tools);
  view.chat.appendChild(root);
  view.cur = { root, think, thinkBody, thinkBuf: "", text, textBuf: "", tools, finalized: false, renderedCut: 0 };
  scrollDown(view);
}

function finalizeAssistantMsg(view, text, thinking) {
  const message = view.cur;
  if (!message) return;
  cancelViewTimer(view, view.mdRenderTimer);
  view.mdRenderTimer = null;
  message.text.innerHTML = renderMd(typeof text === "string" && text.length ? text : message.textBuf);
  if (typeof thinking === "string" && thinking.length) {
    message.think.hidden = false;
    message.thinkBody.textContent = thinking;
  }
  decorateCodeBlocks(message.text);
  message.finalized = true;
  view.cur = null;
  scrollDown(view);
}

function decorateCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.querySelector(".code-copy")) continue;
    const button = el("button", "code-copy", "Copy");
    button.type = "button";
    button.title = "Copy code";
    pre.appendChild(button);
  }
}

function addInfo(view, text, block) {
  ensureConversation(view);
  view.chat.appendChild(el("div", "info" + (block ? " block" : ""), text));
  scrollDown(view);
}

function setStatus(view, kind, text) {
  if (!text) { clearStatus(view, kind); return; }
  let line = view.statusLines.get(kind);
  if (!line) {
    ensureConversation(view);
    line = el("div", "info status");
    line.dataset.kind = kind;
    view.chat.appendChild(line);
    view.statusLines.set(kind, line);
  }
  line.textContent = text;
  scrollDown(view);
}

function clearStatus(view, kind) {
  if (kind) {
    const line = view.statusLines.get(kind);
    if (line) { line.remove(); view.statusLines.delete(kind); }
    return;
  }
  for (const line of view.statusLines.values()) line.remove();
  view.statusLines.clear();
}

const TOOL_LABELS = {
  read: "Read", edit: "Edit", write: "Write", bash: "Bash",
  grep: "Search", glob: "Find", task: "Task", webfetch: "Fetch",
};

function toolTarget(args, file) {
  if (file) return file.replace(/^.*\//, "");
  if (args && typeof args === "object") {
    if (typeof args.command === "string") return args.command.split("\n")[0];
    const path = args.path || args.file || args.file_path;
    if (typeof path === "string") return path.replace(/^.*\//, "");
  }
  return "";
}

function addToolBlock(view, toolCallId, name, args, file, target, checkpoint) {
  ensureConversation(view);
  const block = el("div", "tool running");
  const head = el("div", "tool-head");
  const status = el("span", "tool-status", "◐");
  status.title = "Running";
  head.appendChild(status);
  head.appendChild(el("span", "tool-name", TOOL_LABELS[name] || name || "Tool"));
  const show = target || toolTarget(args, file);
  if (show) {
    const targetEl = el("span", "tool-target", show);
    targetEl.title = show;
    head.appendChild(targetEl);
  }
  if (file && (name === "edit" || name === "write")) {
    const diff = el("button", "diff-btn", "↔ diff");
    diff.type = "button";
    diff.title = checkpoint ? "Diff vs the checkpoint taken before this turn" : "Open diff vs git HEAD";
    const payload = { sessionId: view.id, path: file };
    if (checkpoint) payload.base = checkpoint;
    diff.addEventListener("click", () => post("open_diff", payload));
    head.appendChild(diff);
  }
  const body = el("pre", "tool-body", "…");
  block.appendChild(head);
  block.appendChild(body);
  // RPC ends the assistant message BEFORE tool execution starts. Both placements are supported.
  (view.cur ? view.cur.tools : view.chat).appendChild(block);
  view.toolEls.set(toolCallId, { el: block, body, status, state: "running", text: "" });
  scrollDown(view);
}

function setToolBlock(view, toolCallId, text, state) {
  const tool = view.toolEls.get(toolCallId);
  if (!tool) return;
  tool.state = state;
  tool.text = typeof text === "string" ? text : "";
  tool.body.textContent = tool.text || "(no output)";
  tool.el.classList.toggle("running", state === "running");
  tool.el.classList.toggle("error", state === "error");
  tool.el.classList.toggle("interrupted", state === "interrupted");
  tool.status.textContent = state === "done" ? "✓" : state === "error" ? "✗" : state === "interrupted" ? "!" : "◐";
  tool.status.title = state === "done" ? "Completed" : state === "error" ? "Failed" : state === "interrupted" ? "Interrupted — no final result received" : "Running";
  tool.status.setAttribute("aria-label", tool.status.title);
  scrollDown(view);
}

function interruptTools(view) {
  for (const [id, tool] of view.toolEls) {
    if (tool.state !== "running") continue;
    setToolBlock(view, id, (tool.text ? tool.text + "\n\n" : "") + "[Interrupted: no final tool result received.]", "interrupted");
  }
}

function clearChat(view) {
  cancelViewTimers(view);
  view.chat.innerHTML = "";
  view.statusLines.clear();
  view.toolEls.clear();
  view.cur = null;
  view.scrollTop = 0;
  view.followOutput = true;
  // Clearing the display is not a stop/ready event; run controls and drafts survive.
  renderEmptyState(view);
}

function replayMessages(view, messages) {
  for (const message of messages || []) {
    if (!message || !message.role) continue;
    if (message.role === "user") {
      const content = message.content;
      addUserMsg(view, typeof content === "string" ? content : (Array.isArray(content) ? content : [])
        .map((block) => block.type === "text" ? block.text : "").join("\n"));
    } else if (message.role === "assistant") {
      startAssistantMsg(view);
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const thinking = content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n");
      for (const block of content) {
        if (block.type === "toolCall") view.cur.tools.appendChild(el("div", "tool-chip", "Tool · " + (TOOL_LABELS[block.name] || block.name || "tool")));
      }
      finalizeAssistantMsg(view, text, thinking);
    } else if (message.role === "toolResult") {
      const id = "replay-" + ++view.replaySequence;
      addToolBlock(view, id, message.toolName, null, null);
      const text = (Array.isArray(message.content) ? message.content : [])
        .map((block) => block.type === "text" ? block.text : "").join("\n");
      setToolBlock(view, id, text, message.isError ? "error" : "done");
      view.toolEls.delete(id);
    }
  }
  scrollDown(view, true);
}

/* --------------------------------------------------------- host messages */

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.t === "sessions") { applyRoster(message); return; }
  if (message.t === "workspace_state") {
    if (typeof message.locked === "boolean") workspaceLocked = message.locked;
    refreshControls();
    return;
  }
  // No fallback and no lazy creation: stale/closed/unknown owners are ignored.
  const view = sessionViews.get(message.sessionId);
  if (!isLive(view)) return;
  handleSessionMessage(view, message);
});

function handleSessionMessage(view, message) {
  switch (message.t) {
    case "state":
      if (typeof message.model === "string") view.model = message.model;
      if (typeof message.sessionName === "string") view.sessionName = message.sessionName;
      if ("thinkingLevel" in message) view.thinkingLevel = message.thinkingLevel;
      refreshControls(view);
      break;
    case "thinking":
      view.thinkingLevel = message.level;
      refreshControls(view);
      break;
    case "run_state":
      view.runBlocked = !!message.blocked || message.ready === false;
      view.streaming = !!message.streaming;
      view.busy = typeof message.busy === "boolean" ? message.busy : view.streaming;
      if (typeof message.queued === "number") view.queued = message.queued;
      if (message.ready === true && !view.runBlocked) { view.fatal = false; view.notice = ""; }
      updateTab(view);
      refreshControls(view);
      break;
    case "stats": {
      const parts = [];
      if (message.tokens) parts.push(fmtTokens(message.tokens) + " tok");
      if (message.contextPercent != null) parts.push(Math.round(message.contextPercent) + "% ctx");
      if (typeof message.cost === "number" && message.cost) parts.push("$" + message.cost.toFixed(2));
      view.stats = parts.join(" · ") || "Ready";
      refreshControls(view);
      break;
    }
    case "open_picker":
      if (isActive(view)) openPicker(view, message.kind);
      break;
    case "picker_data": {
      const state = matchingPicker(view, message);
      if (!state) break;
      state.items = Array.isArray(message.items) ? message.items : [];
      const current = state.items.findIndex((item) => item.current);
      state.index = current === -1 ? 0 : current;
      state.pending = false;
      pickerEmpty.textContent = message.empty || "Nothing to show.";
      filterPicker(state);
      break;
    }
    case "picker_done":
      if (matchingPicker(view, message)) closePicker();
      break;
    case "picker_error": {
      const state = matchingPicker(view, message);
      if (state) showPickerError(state, message.message);
      break;
    }
    case "commands":
      view.commands = Array.isArray(message.commands) ? message.commands : [];
      if (isActive(view)) acUpdate();
      break;
    case "files":
      view.filesCache = Array.isArray(message.files) ? message.files : [];
      view.filesAt = Date.now();
      view.filesPending = false;
      if (isActive(view)) acUpdate();
      break;
    case "agent_start":
      view.streaming = true;
      view.busy = true;
      view.completed = false;
      view.error = false;
      if (!view.cur) startAssistantMsg(view);
      updateTab(view);
      refreshControls(view);
      break;
    case "msg_start":
      clearStatus(view);
      if (!view.cur) startAssistantMsg(view);
      break;
    case "delta":
      clearStatus(view);
      if (!view.cur) startAssistantMsg(view);
      if (message.kind === "text") {
        view.cur.textBuf += message.delta;
        scheduleStreamRender(view);
      } else if (message.kind === "thinking") {
        view.cur.thinkBuf += message.delta;
        view.cur.think.hidden = false;
        view.cur.thinkBody.textContent = view.cur.thinkBuf;
      }
      scrollDown(view);
      break;
    case "toolcall":
      if (!view.cur) startAssistantMsg(view);
      view.cur.tools.appendChild(el("div", "tool-chip", "Tool · " + (TOOL_LABELS[message.name] || message.name || "tool")));
      scrollDown(view);
      break;
    case "tool_start":
      addToolBlock(view, message.toolCallId, message.name, message.args, message.file, message.target, message.checkpoint);
      setStatus(view, "working", `Working · ${TOOL_LABELS[message.name] || message.name || "tool"}${message.target ? ` · ${message.target}` : ""}…`);
      break;
    case "tool_update":
      setToolBlock(view, message.toolCallId, message.text, "running");
      break;
    case "tool_end":
      setToolBlock(view, message.toolCallId, message.text, message.isError ? "error" : "done");
      break;
    case "msg_end":
      finalizeAssistantMsg(view, message.text, message.thinking);
      break;
    case "agent_settled":
      clearStatus(view);
      finalizeAssistantMsg(view);
      interruptTools(view);
      view.streaming = false;
      view.busy = view.queued > 0;
      view.completed = !view.error && !view.queued;
      updateTab(view);
      refreshControls(view);
      break;
    case "info":
      addInfo(view, message.text);
      break;
    case "status":
      setStatus(view, message.kind, message.text);
      break;
    case "error":
      view.error = true;
      view.completed = false;
      addInfo(view, "Error: " + message.message);
      updateTab(view);
      break;
    case "fatal":
      clearStatus(view);
      finalizeAssistantMsg(view);
      interruptTools(view);
      view.notice = message.message;
      view.fatal = true;
      view.runBlocked = true;
      view.streaming = false;
      view.busy = false;
      view.error = true;
      view.completed = false;
      updateTab(view);
      refreshControls(view);
      break;
    case "cleared":
      clearChat(view);
      view.notice = "";
      view.fatal = false;
      refreshControls(view);
      break;
    case "replay":
      replayMessages(view, message.messages);
      break;
    case "insert_input":
      if (typeof message.text !== "string") break;
      if (isActive(view)) captureComposer(view);
      view.draft += message.text;
      if (isActive(view)) {
        view.selectionStart = view.selectionEnd = view.draft.length;
        restoreComposer(view);
        input.focus();
        updateSendButton();
        acHide();
      }
      saveDraft(view);
      break;
  }
}

function fmtTokens(number) {
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return Math.round(number / 1000) + "k";
  return String(number);
}

/* ----------------------------------------- session-owned delayed rendering */

function viewTimeout(view, callback, delay) {
  const timer = setTimeout(() => {
    view.timers.delete(timer);
    if (isLive(view)) callback();
  }, delay);
  view.timers.add(timer);
  return timer;
}

function cancelViewTimer(view, timer) {
  if (timer === null) return;
  clearTimeout(timer);
  view.timers.delete(timer);
}

function cancelViewTimers(view) {
  for (const timer of view.timers) clearTimeout(timer);
  view.timers.clear();
  view.mdRenderTimer = null;
}

function scheduleStreamRender(view) {
  if (view.mdRenderTimer !== null || !view.cur) return;
  const message = view.cur;
  view.mdRenderTimer = viewTimeout(view, () => {
    view.mdRenderTimer = null;
    if (view.cur !== message || message.finalized) return;
    renderStream(view);
    scrollDown(view);
  }, MD_RENDER_THROTTLE_MS);
}

/* Incremental streaming: stable blocks (complete paragraphs and closed fences
 * — a blank line always closes a block) are rendered once and never replaced,
 * so selection in them survives; only the live tail re-renders each tick. */
function renderStream(view) {
  const message = view.cur;
  if (!message) return;
  const buffer = message.textBuf;
  const cut = streamCut(buffer);
  if (cut > message.renderedCut) {
    const frag = el("div");
    frag.innerHTML = renderMd(buffer.slice(message.renderedCut, cut));
    decorateCodeBlocks(frag);
    const tail = message.text.querySelector(".md-tail");
    for (const child of [...frag.children]) message.text.insertBefore(child, tail);
    message.renderedCut = cut;
  }
  const tailText = buffer.slice(message.renderedCut);
  let tail = message.text.querySelector(".md-tail");
  if (!tailText) {
    if (tail) tail.remove();
    return;
  }
  if (!tail) {
    tail = el("div", "md-tail");
    message.text.appendChild(tail);
  }
  tail.innerHTML = renderMd(tailText);
}

/* ------------------------------------------------------------------ init */

resizeInput();
refreshControls();
post("ready");
