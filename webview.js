"use strict";
/* pi sidebar webview: chat UI over postMessage with the extension host. */

const vscode = acquireVsCodeApi();
const { renderMd } = window.piMarkdown;

const chat = document.getElementById("chat");
const input = document.getElementById("input");
const notice = document.getElementById("notice");
const modelEl = document.getElementById("model");
const modelLabel = document.getElementById("model-label");
const thinkingLabel = document.getElementById("thinking-label");
const btnSend = document.getElementById("btn-send");
const btnStop = document.getElementById("btn-stop");
const btnThinking = document.getElementById("btn-thinking");
const statsEl = document.getElementById("stats");
const acBox = document.getElementById("autocomplete");
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

const NEAR_BOTTOM_PX = 80; // scroll-to-bottom threshold
const MD_RENDER_THROTTLE_MS = 120; // streaming markdown re-render interval

let cur = null; // current assistant bubble: {root, think, thinkBody, thinkBuf, text, textBuf, tools, finalized}
const toolEls = new Map(); // toolCallId -> {el, body}
let mdRenderTimer = null; // throttle timer for streaming markdown

/* Slash-command / @-file autocomplete state */
let commands = []; // pi's commands: [{name, description, source}]
let filesCache = []; // workspace relative paths for @-mention
let filesAt = 0; // when filesCache was fetched
let acItems = []; // filtered, {kind:'builtin'|'command'|'file', ...}
let acIndex = 0;
let acOpen = false;
let pickerKind = null;
let pickerItems = [];
let pickerFiltered = [];
let pickerIndex = 0;
let pickerOpener = null;
let pickerPending = false;
let runBlocked = true; // session loading/switching: send is disabled

/*
 * Built-in slash commands, handled locally (Claude Code / Codex style).
 * pi's own TUI built-ins (/model, /settings, …) do not execute over RPC,
 * so the extension intercepts these names itself. Skills, prompt templates
 * and pi extension commands are still forwarded to pi as typed.
 */
const BUILTINS = [
  { name: "model", desc: "Switch the model", act: () => openPicker("model") },
  { name: "thinking", desc: "Thinking level (reasoning effort)", act: () => openPicker("thinking") },
  { name: "session", desc: "Resume a previous session of this workspace", act: () => openPicker("session") },
  { name: "new", desc: "Start a new session", act: () => vscode.postMessage({ t: "new" }) },
  { name: "compact", desc: "Compact the context now", act: () => vscode.postMessage({ t: "compact" }) },
  { name: "clear", desc: "Clear the chat display (session is kept)", act: () => clearChat() },
  { name: "rollback", desc: "Roll the working tree back to a checkpoint (git)", act: () => openPicker("checkpoint") },
  { name: "context", desc: "Attach active editor selection / file", act: () => vscode.postMessage({ t: "add_context" }) },
  { name: "stats", desc: "Show usage: tokens · context · cost", act: () => vscode.postMessage({ t: "show_stats" }) },
  { name: "stop", desc: "Abort the current run", act: () => vscode.postMessage({ t: "abort" }) },
  { name: "restart", desc: "Restart the pi process", act: () => vscode.postMessage({ t: "restart" }) },
  { name: "settings", desc: "Open extension settings", act: () => vscode.postMessage({ t: "open_settings" }) },
  { name: "help", desc: "Show built-in commands and tips", act: showHelp },
];

/* ------------------------------------------------------------------ input */

document.getElementById("btn-send").addEventListener("click", send);
document.getElementById("btn-stop").addEventListener("click", () => vscode.postMessage({ t: "abort" }));
modelEl.addEventListener("click", (e) => openPicker("model", e.currentTarget));
modelEl.title = "Switch model";
btnThinking.addEventListener("click", (e) => openPicker("thinking", e.currentTarget));
document.getElementById("btn-history").addEventListener("click", (e) => openPicker("session", e.currentTarget));
document.getElementById("btn-context").addEventListener("click", () => vscode.postMessage({ t: "add_context" }));
document.getElementById("btn-compact").addEventListener("click", () => vscode.postMessage({ t: "compact" }));
document.getElementById("btn-checkpoint").addEventListener("click", (e) => openPicker("checkpoint", e.currentTarget));
document.getElementById("btn-restart").addEventListener("click", () => {
  vscode.postMessage({ t: "restart" });
});
document.getElementById("btn-new").addEventListener("click", () => {
  // Not destructive: pi keeps the old session file on disk. The host clears
  // and replays only after new_session is confirmed.
  vscode.postMessage({ t: "new" });
});

/* Toolbar overflow menu: compact / checkpoint / restart live here so the bar
 * shows only the two primary actions plus the thinking chip. */
const btnMore = document.getElementById("btn-more");
const toolbarMenu = document.getElementById("toolbar-menu");

function toggleMenu(show) {
  const open = show !== undefined ? show : toolbarMenu.hidden;
  toolbarMenu.hidden = !open;
  btnMore.setAttribute("aria-expanded", open ? "true" : "false");
}

btnMore.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu();
});
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
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

input.addEventListener("input", () => {
  resizeInput();
  updateSendButton();
  acUpdate();
});

function resizeInput() {
  input.style.height = "0px";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}

function updateSendButton() {
  btnSend.disabled = runBlocked || !input.value.trim();
  btnSend.title = runBlocked ? "Wait for pi to be ready" : "Send message";
}

/* Links in rendered markdown: CSP blocks navigation, so route them through
 * the extension host (vscode.env.openExternal). */
chat.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  const suggestion = target.closest(".suggestion");
  if (suggestion) {
    input.value = suggestion.dataset.prompt || "";
    resizeInput();
    updateSendButton();
    input.focus();
    return;
  }

  const copy = target.closest(".code-copy");
  if (copy) {
    const code = copy.parentElement.querySelector("code");
    copyCode(code ? code.textContent : "", copy);
    return;
  }

  const a = target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ t: "open_link", url: a.getAttribute("href") });
});

function copyCode(text, button) {
  if (!text) return;
  vscode.postMessage({ t: "copy_text", text });
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
}

function send() {
  closePicker();
  const text = input.value.trim();
  if (!text || runBlocked) return;
  input.value = "";
  resizeInput();
  updateSendButton();
  acHide();

  // Built-in slash commands run locally; anything else that starts with "/"
  // (skills, templates, pi extension commands) is forwarded to pi as typed.
  const m = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
  if (m) {
    const b = BUILTINS.find((c) => c.name === m[1]);
    if (b) {
      b.act();
      return;
    }
  }

  vscode.postMessage({ t: "send", text });
  addUserMsg(text);
}

function showHelp() {
  const lines = BUILTINS.map((c) => ("  /" + c.name).padEnd(13) + c.desc);
  addInfo(
    "Built-in commands:\n" +
      lines.join("\n") +
      "\n\nAnything else starting with / (skills, prompt templates, pi\n" +
      "extension commands) is executed by pi itself.\n" +
      "Tips: @file references a workspace file · Enter sends ·\n" +
      "Shift+Enter inserts a newline.",
    true
  );
}

/* ------------------------------------------------------- slash autocomplete */

function acUpdate() {
  const v = input.value;

  // 1) Slash commands: the whole input is "/query".
  const sm = v.match(/^\/(\w[\w:.-]*)?$/);
  if (sm) {
    const q = (sm[1] || "").toLowerCase();
    const builtins = BUILTINS.filter((b) => b.name.startsWith(q))
      .slice(0, 12)
      .map((b) => ({ kind: "builtin", name: b.name, desc: b.desc }));
    const piCmds = commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 12)
      .map((c) => ({
        kind: "command",
        name: c.name,
        desc:
          "[" +
          (c.source === "skill" ? "skill" : c.source === "prompt" ? "template" : "ext") +
          "] " +
          (c.description || ""),
      }));
    acItems = builtins.concat(piCmds);
    if (!acItems.length) return acHide();
    acIndex = Math.max(0, Math.min(acIndex, acItems.length - 1));
    return acRender();
  }

  // 2) @-mention: "@query" token ending at the caret.
  const caret = input.selectionStart == null ? v.length : input.selectionStart;
  const fm = v.slice(0, caret).match(/(^|\s)@([\w./+-]{0,60})$/);
  if (fm) {
    const q = fm[2].toLowerCase();
    if (!filesCache.length || Date.now() - filesAt > FILE_CACHE_TTL_MS) {
      vscode.postMessage({ t: "list_files" });
    }
    acItems = filesCache
      .filter((p) => p.toLowerCase().includes(q))
      .sort((a, b) => scoreFile(b, q) - scoreFile(a, q))
      .slice(0, 12)
      .map((p) => ({ kind: "file", path: p }));
    if (!acItems.length) return acHide();
    acIndex = Math.max(0, Math.min(acIndex, acItems.length - 1));
    return acRender();
  }

  acHide();
}

function scoreFile(p, q) {
  if (!q) return 0;
  const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  if (base.startsWith(q)) return 2;
  if (p.toLowerCase().includes(q)) return 1;
  return 0;
}

function acRender() {
  acBox.innerHTML = "";
  acItems.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "ac-item" + (i === acIndex ? " active" : "");
    const name = document.createElement("span");
    name.className = "ac-name";
    const desc = document.createElement("span");
    desc.className = "ac-desc";
    if (item.kind === "file") {
      name.textContent = "@" + item.path;
      desc.textContent = "file";
    } else if (item.kind === "builtin") {
      name.textContent = "/" + item.name;
      desc.textContent = item.desc.slice(0, 60);
    } else {
      name.textContent = "/" + item.name;
      desc.textContent = item.desc.slice(0, 60);
    }
    row.appendChild(name);
    row.appendChild(desc);
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acIndex = i;
      acSelect();
    });
    acBox.appendChild(row);
  });
  acBox.hidden = false;
  acOpen = true;
}

function acMove(d) {
  acIndex = (acIndex + d + acItems.length) % acItems.length;
  acRender();
}

function acSelect() {
  const item = acItems[acIndex];
  if (!item) return acHide();

  if (item.kind === "file") {
    // Replace the "@query" token (ending at the caret) with "@path ".
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const before = input.value.slice(0, caret);
    const after = input.value.slice(caret);
    const fm = before.match(/@([\w./+-]*)$/);
    const atIdx = fm ? caret - fm[1].length - 1 : caret;
    const insert = "@" + item.path + " ";
    input.value = input.value.slice(0, atIdx) + insert + after;
    const pos = atIdx + insert.length;
    input.selectionStart = input.selectionEnd = pos;
  } else {
    input.value = "/" + item.name + " ";
  }
  acHide();
  input.focus();
  resizeInput();
  updateSendButton();
}

function acHide() {
  acBox.hidden = true;
  acOpen = false;
}

/* ---------------------------------------------------------- panel picker */

function openPicker(kind, opener) {
  toggleMenu(false);
  pickerKind = kind;
  pickerOpener = opener || document.activeElement;
  pickerItems = [];
  pickerFiltered = [];
  pickerIndex = 0;
  pickerPending = true;

  const config = PICKER_CONFIG[kind];
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
  pickerList.innerHTML = "";
  pickerList.appendChild(el("div", "picker-loading", "Loading…"));

  pickerOverlay.hidden = false;
  picker.style.width = kind === "thinking" ? "230px" : "";
  vscode.postMessage({ t: "list_picker", kind });
  (config.search ? pickerSearch : pickerList).focus();
}

function closePicker() {
  if (pickerOverlay.hidden) return;
  pickerOverlay.hidden = true;
  pickerKind = null;
  pickerItems = [];
  pickerFiltered = [];
  pickerPending = false;
  if (pickerOpener && pickerOpener.focus) pickerOpener.focus();
}

function filterPicker() {
  const q = pickerSearch.value.trim().toLowerCase();
  pickerFiltered = !q ? pickerItems : pickerItems.filter((item) =>
    [item.label, item.description, item.detail]
      .some((value) => String(value || "").toLowerCase().includes(q))
  );
  pickerIndex = Math.max(0, Math.min(pickerIndex, pickerFiltered.length - 1));
  renderPicker();
}

function renderPicker() {
  pickerList.innerHTML = "";
  pickerEmpty.hidden = pickerFiltered.length > 0;
  pickerFiltered.forEach((item, index) => {
    const row = el("button", "picker-item" + (index === pickerIndex ? " active" : ""));
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === pickerIndex ? "true" : "false");
    row.disabled = pickerPending && item.current;
    const main = el("span", "picker-main");
    main.appendChild(el("span", "picker-label", item.label));
    if (item.description) main.appendChild(el("span", "picker-description", item.description));
    row.appendChild(main);
    const meta = el("span", "picker-meta");
    if (item.detail) meta.appendChild(el("span", "picker-detail", item.detail));
    if (item.current) meta.appendChild(el("span", "picker-current", "Current"));
    if (!item.current && !item.detail) meta.textContent = "›";
    row.appendChild(meta);
    row.addEventListener("click", () => choosePicker(index));
    row.addEventListener("mousemove", () => {
      if (pickerIndex !== index) {
        pickerIndex = index;
        renderPicker();
      }
    });
    pickerList.appendChild(row);
  });
  const active = pickerList.children[pickerIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function choosePicker(index) {
  const item = pickerFiltered[index];
  if (!item || pickerPending) return;
  if (item.current) {
    // Selecting the active item is a no-op: close instead of re-sending it.
    closePicker();
    return;
  }
  pickerPending = true;
  pickerError.hidden = true;
  if (pickerKind === "model") {
    vscode.postMessage({ t: "choose_model", provider: item.provider, modelId: item.modelId });
  } else if (pickerKind === "thinking") {
    vscode.postMessage({ t: "choose_thinking", level: item.level });
  } else if (pickerKind === "session") {
    vscode.postMessage({ t: "choose_session", path: item.path });
  } else if (pickerKind === "checkpoint") {
    showCheckpointConfirm(item.hash, item.prompt);
  }
  if (pickerKind !== "checkpoint") {
    pickerList.innerHTML = "";
    pickerList.appendChild(el("div", "picker-loading", pickerKind === "session" ? "Resuming conversation…" : "Applying…"));
  }
}

function showCheckpointConfirm(hash, prompt) {
  pickerPending = false;
  pickerList.hidden = true;
  pickerSearchWrap.hidden = true;
  document.getElementById("picker-confirm-text").textContent = prompt || "This checkpoint";
  pickerConfirm.hidden = false;
  pickerRollback.onclick = () => {
    pickerPending = true;
    pickerError.hidden = true;
    pickerRollback.disabled = true;
    vscode.postMessage({ t: "choose_checkpoint", hash, prompt });
  };
  pickerRollback.disabled = false;
  pickerRollback.focus();
}

function showPickerError(message) {
  pickerPending = false;
  pickerError.textContent = message;
  pickerError.hidden = false;
  pickerList.hidden = false;
  pickerSearchWrap.hidden = false;
  pickerSearchWrap.style.display = PICKER_CONFIG[pickerKind].search ? "" : "none";
  pickerConfirm.hidden = true;
  filterPicker();
}

pickerSearch.addEventListener("input", filterPicker);
document.getElementById("picker-close").addEventListener("click", closePicker);
document.getElementById("picker-cancel").addEventListener("click", () => {
  pickerConfirm.hidden = true;
  pickerList.hidden = false;
  pickerSearchWrap.hidden = false;
  pickerSearchWrap.style.display = PICKER_CONFIG[pickerKind].search ? "" : "none";
  filterPicker();
});
pickerOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === pickerOverlay) closePicker();
});
document.addEventListener("keydown", (e) => {
  if (pickerOverlay.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
  if (!pickerConfirm.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); pickerIndex = (pickerIndex + 1) % Math.max(1, pickerFiltered.length); renderPicker(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pickerIndex = (pickerIndex - 1 + pickerFiltered.length) % Math.max(1, pickerFiltered.length); renderPicker(); }
  else if (e.key === "Enter") { e.preventDefault(); choosePicker(pickerIndex); }
});

/* ------------------------------------------------------------- rendering */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < NEAR_BOTTOM_PX;
}

function scrollDown(force) {
  if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
}

function ensureConversation() {
  const empty = chat.querySelector(".empty-state-panel");
  if (empty) empty.remove();
}

function renderEmptyState() {
  if (chat.children.length || chat.querySelector(".empty-state-panel")) return;
  const empty = el("div", "empty-state-panel");
  empty.appendChild(el("div", "empty-logo", ">_"));
  empty.appendChild(el("h1", null, "What are we building?"));
  empty.appendChild(el("p", null, "Your AI pair programmer, right inside your editor.\nAsk a question, squash a bug, or ship something new."));
  const suggestions = el("div", "suggestion-list");
  const prompts = [
    "Explain what this project does",
    "Find and fix a bug in the current file",
    "Write tests for my recent changes",
  ];
  for (const prompt of prompts) {
    const button = el("button", "suggestion");
    button.dataset.prompt = prompt;
    button.appendChild(el("span", null, prompt));
    button.appendChild(el("span", null, "↗"));
    suggestions.appendChild(button);
  }
  empty.appendChild(suggestions);
  chat.appendChild(empty);
}

function addUserMsg(text) {
  ensureConversation();
  const div = el("div", "msg user", text);
  chat.appendChild(div);
  scrollDown(true);
}

function startAssistantMsg() {
  ensureConversation();
  const root = el("div", "msg assistant");
  const think = document.createElement("details");
  think.className = "thinking";
  think.hidden = true;
  think.appendChild(el("summary", null, "thinking"));
  const thinkBody = el("div", "think-body");
  think.appendChild(thinkBody);
  const text = el("div", "md");
  const tools = el("div", "tools");
  root.appendChild(think);
  root.appendChild(text);
  root.appendChild(tools);
  chat.appendChild(root);
  cur = { root, think, thinkBody, thinkBuf: "", text, textBuf: "", tools, finalized: false };
  scrollDown();
}

function finalizeAssistantMsg(text, thinking) {
  if (!cur) return;
  if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; }
  if (typeof text === "string" && text.length) cur.text.innerHTML = renderMd(text);
  else if (cur.textBuf) cur.text.innerHTML = renderMd(cur.textBuf);
  if (typeof thinking === "string" && thinking.length) {
    cur.think.hidden = false;
    cur.thinkBody.textContent = thinking;
  }
  decorateCodeBlocks(cur.text);
  cur.finalized = true;
  cur = null;
  scrollDown();
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

function addInfo(text, block) {
  ensureConversation();
  const div = el("div", "info" + (block ? " block" : ""), text);
  chat.appendChild(div);
  scrollDown();
}

/* Transient status lines ("retrying…", "compacting…") update in place and
 * clear once real output resumes or the agent settles. */
const statusLines = new Map(); // kind -> HTMLElement

function setStatus(kind, text) {
  if (!text) { clearStatus(kind); return; }
  let line = statusLines.get(kind);
  if (!line) {
    ensureConversation();
    line = el("div", "info status");
    line.dataset.kind = kind;
    chat.appendChild(line);
    statusLines.set(kind, line);
  }
  line.textContent = text;
  scrollDown();
}

function clearStatus(kind) {
  if (kind) {
    const line = statusLines.get(kind);
    if (line) { line.remove(); statusLines.delete(kind); }
    return;
  }
  for (const line of statusLines.values()) line.remove();
  statusLines.clear();
}

const TOOL_LABELS = {
  read: "Read", edit: "Edit", write: "Write", bash: "Bash",
  grep: "Search", glob: "Find", task: "Task", webfetch: "Fetch",
};

function toolTarget(name, args, file) {
  if (file) return file.replace(/^.*\//, ""); // basename only, short
  if (args && typeof args === "object") {
    if (typeof args.command === "string") return args.command.split("\n")[0];
    if (typeof args.path === "string") return args.path.replace(/^.*\//, "");
    if (typeof args.file === "string") return args.file.replace(/^.*\//, "");
  }
  return "";
}

function addToolBlock(toolCallId, name, args, file, target) {
  ensureConversation();
  const block = el("div", "tool running");
  const head = el("div", "tool-head");
  head.appendChild(el("span", "tool-status", "◐"));
  head.appendChild(el("span", "tool-name", TOOL_LABELS[name] || name || "Tool"));
  const show = target || toolTarget(name, args, file);
  if (show) head.appendChild(el("span", "tool-target", show));
  if (file) {
    const diff = el("button", "diff-btn", "↔ diff");
    diff.title = "Open diff vs git HEAD";
    diff.addEventListener("click", () => vscode.postMessage({ t: "open_diff", path: file }));
    head.appendChild(diff);
  }
  const body = el("pre", "tool-body", "…");
  block.appendChild(head);
  block.appendChild(body);
  (cur ? cur.tools : chat).appendChild(block);
  toolEls.set(toolCallId, { el: block, body });
  scrollDown();
}

function setToolBlock(toolCallId, text, state) {
  const t = toolEls.get(toolCallId);
  if (!t) return;
  t.body.textContent = text || "(no output)";
  const status = t.el.querySelector(".tool-status");
  if (state === "done") {
    t.el.classList.remove("running");
    if (status) status.textContent = "✓";
  } else if (state === "error") {
    t.el.classList.remove("running");
    t.el.classList.add("error");
    if (status) status.textContent = "✗";
  }
  scrollDown();
}

function clearChat() {
  if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; }
  chat.innerHTML = "";
  statusLines.clear();
  toolEls.clear();
  cur = null;
  btnStop.hidden = true;
  hideNotice();
  renderEmptyState();
}

/** Replay a resumed session's AgentMessage[] into the chat. */
function replayMessages(messages) {
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === "user") {
      const c = m.content;
      addUserMsg(typeof c === "string" ? c : (Array.isArray(c) ? c : [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n"));
    } else if (m.role === "assistant") {
      startAssistantMsg();
      const content = Array.isArray(m.content) ? m.content : [];
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const thinking = content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n");
      for (const b of content) {
        if (b.type === "toolCall") {
          cur.tools.appendChild(el("div", "tool-chip", "⚙ " + (TOOL_LABELS[b.name] || b.name || "tool")));
        }
      }
      finalizeAssistantMsg(text, thinking);
    } else if (m.role === "toolResult") {
      const id = "replay-" + Math.random().toString(36).slice(2);
      addToolBlock(id, m.toolName, null, null);
      const text = (Array.isArray(m.content) ? m.content : [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      setToolBlock(id, text, m.isError ? "error" : "done");
      toolEls.delete(id);
    }
  }
  scrollDown(true);
}

/* --------------------------------------------------------- host messages */

window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.t) {
    case "state":
      modelLabel.textContent = m.model + (m.sessionName ? ` · ${m.sessionName}` : "");
      modelLabel.title = m.model || "";
      if (m.thinkingLevel) {
        thinkingLabel.textContent = m.thinkingLevel;
        btnThinking.hidden = false;
      } else {
        btnThinking.hidden = true;
      }
      break;

    case "thinking":
      thinkingLabel.textContent = m.level;
      btnThinking.hidden = false;
      break;

    case "run_state":
      runBlocked = !!m.blocked;
      updateSendButton();
      btnStop.hidden = !m.streaming;
      break;

    case "stats": {
      const parts = [];
      if (m.tokens) parts.push(fmtTokens(m.tokens) + " tok");
      if (m.contextPercent != null) parts.push(Math.round(m.contextPercent) + "% ctx");
      if (m.cost) parts.push("$" + m.cost.toFixed(2));
      statsEl.textContent = parts.join(" · ") || "Ready";
      break;
    }

    case "open_picker":
      openPicker(m.kind);
      break;

    case "picker_data":
      if (m.kind === pickerKind) {
        pickerItems = m.items || [];
        pickerFiltered = pickerItems;
        const currentIndex = pickerItems.findIndex((item) => item.current);
        pickerIndex = currentIndex === -1 ? 0 : currentIndex;
        pickerPending = false;
        pickerEmpty.textContent = m.empty || "Nothing to show.";
        filterPicker();
      }
      break;

    case "picker_done":
      if (m.kind === pickerKind) closePicker();
      break;

    case "picker_error":
      if (pickerOverlay.hidden) addInfo("⚠ " + m.message);
      else showPickerError(m.message);
      break;

    case "commands":
      commands = m.commands || [];
      break;

    case "files":
      filesCache = m.files || [];
      filesAt = Date.now();
      acUpdate(); // re-filter if the user is waiting on an open @-query
      break;

    case "agent_start":
      btnStop.hidden = false;
      if (!cur) startAssistantMsg();
      break;

    case "msg_start":
      clearStatus();
      if (!cur) startAssistantMsg(); // agent_start may have opened one already
      break;

    case "delta":
      clearStatus();
      if (!cur) startAssistantMsg();
      if (m.kind === "text") {
        cur.textBuf += m.delta;
        scheduleStreamRender();
      } else if (m.kind === "thinking") {
        cur.thinkBuf += m.delta;
        cur.think.hidden = false;
        cur.thinkBody.textContent = cur.thinkBuf;
      }
      scrollDown();
      break;

    case "toolcall":
      if (!cur) startAssistantMsg();
      cur.tools.appendChild(el("div", "tool-chip", "⚙ " + (TOOL_LABELS[m.name] || m.name || "tool")));
      scrollDown();
      break;

    case "tool_start":
      addToolBlock(m.toolCallId, m.name, m.args, m.file, m.target);
      setStatus("working", `Working · ${TOOL_LABELS[m.name] || m.name || "tool"}${m.target ? ` · ${m.target}` : ""}…`);
      break;

    case "tool_update":
      setToolBlock(m.toolCallId, m.text, "running");
      break;

    case "tool_end":
      setToolBlock(m.toolCallId, m.text, m.isError ? "error" : "done");
      break;

    case "msg_end":
      finalizeAssistantMsg(m.text, m.thinking);
      break;

    case "agent_settled":
      clearStatus();
      btnStop.hidden = true;
      if (cur && !cur.finalized) finalizeAssistantMsg();
      break;

    case "info":
      addInfo(m.text);
      break;

    case "status":
      setStatus(m.kind, m.text);
      break;

    case "error":
      addInfo("⚠ " + m.message);
      break;

    case "fatal":
      clearStatus();
      showNotice(m.message);
      btnStop.hidden = true;
      break;

    case "cleared":
      clearChat();
      break;

    case "replay":
      replayMessages(m.messages);
      break;

    case "insert_input":
      input.value += m.text;
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
      resizeInput();
      updateSendButton();
      acHide();
      break;
  }
});

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = false;
}

function hideNotice() {
  notice.hidden = true;
}

/* ----------------------------------------- throttled streaming md render */

function scheduleStreamRender() {
  if (mdRenderTimer || !cur) return;
  mdRenderTimer = setTimeout(() => {
    mdRenderTimer = null;
    if (cur && cur.textBuf) {
      cur.text.innerHTML = renderMd(cur.textBuf);
      decorateCodeBlocks(cur.text);
      scrollDown();
    }
  }, MD_RENDER_THROTTLE_MS);
}

/* ------------------------------------------------------------------ init */

resizeInput();
updateSendButton();
renderEmptyState();
vscode.postMessage({ t: "ready" });
