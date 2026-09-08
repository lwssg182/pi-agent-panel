"use strict";
/* pi sidebar webview: chat UI over postMessage with the extension host. */

const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const input = document.getElementById("input");
const notice = document.getElementById("notice");
const modelEl = document.getElementById("model");
const btnStop = document.getElementById("btn-stop");
const btnThinking = document.getElementById("btn-thinking");
const statsEl = document.getElementById("stats");
const acBox = document.getElementById("autocomplete");

let streaming = false;
let cur = null; // current assistant bubble: {root, think, thinkBody, thinkBuf, text, textBuf, tools, finalized}
const toolEls = new Map(); // toolCallId -> {el, body}

/* Slash-command / @-file autocomplete state */
let commands = []; // [{name, description, source}]
let filesCache = []; // workspace relative paths for @-mention
let filesAt = 0; // when filesCache was fetched
let acItems = []; // filtered, {kind:'command'|'file', ...}
let acIndex = 0;
let acOpen = false;

/* ------------------------------------------------------------------ input */

document.getElementById("btn-send").addEventListener("click", send);
document.getElementById("btn-stop").addEventListener("click", () => vscode.postMessage({ t: "abort" }));
modelEl.addEventListener("click", () => vscode.postMessage({ t: "pick_model" }));
modelEl.title = "Click to switch model";
btnThinking.addEventListener("click", () => vscode.postMessage({ t: "pick_thinking" }));
document.getElementById("btn-history").addEventListener("click", () => vscode.postMessage({ t: "pick_session" }));
document.getElementById("btn-context").addEventListener("click", () => vscode.postMessage({ t: "add_context" }));
document.getElementById("btn-compact").addEventListener("click", () => vscode.postMessage({ t: "compact" }));
document.getElementById("btn-checkpoint").addEventListener("click", () => vscode.postMessage({ t: "pick_checkpoint" }));
document.getElementById("btn-restart").addEventListener("click", () => {
  vscode.postMessage({ t: "restart" });
});
document.getElementById("btn-new").addEventListener("click", () => {
  // Not destructive: pi keeps the old session file on disk.
  vscode.postMessage({ t: "new" });
  clearChat();
  addInfo("· new session");
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

input.addEventListener("input", () => acUpdate());

function send() {
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ t: "send", text });
  input.value = "";
  acHide();
  addUserMsg(text);
}

/* ------------------------------------------------------- slash autocomplete */

function acUpdate() {
  const v = input.value;

  // 1) Slash commands: the whole input is "/query".
  const sm = v.match(/^\/(\w[\w:.-]*)?$/);
  if (sm && commands.length) {
    const q = (sm[1] || "").toLowerCase();
    acItems = commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 12)
      .map((c) => ({ kind: "command", name: c.name, desc: c.description || "" }));
    if (!acItems.length) return acHide();
    acIndex = Math.max(0, Math.min(acIndex, acItems.length - 1));
    return acRender();
  }

  // 2) @-mention: "@query" token ending at the caret.
  const caret = input.selectionStart == null ? v.length : input.selectionStart;
  const fm = v.slice(0, caret).match(/(^|\s)@([\w./+-]{0,60})$/);
  if (fm) {
    const q = fm[2].toLowerCase();
    if (!filesCache.length || Date.now() - filesAt > 60000) {
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
}

function acHide() {
  acBox.hidden = true;
  acOpen = false;
}

/* ------------------------------------------------------------- rendering */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

function scrollDown(force) {
  if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
}

function addUserMsg(text) {
  const div = el("div", "msg user", text);
  chat.appendChild(div);
  scrollDown(true);
}

function startAssistantMsg() {
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
  if (typeof text === "string" && text.length) cur.text.innerHTML = renderMd(text);
  else if (cur.textBuf) cur.text.innerHTML = renderMd(cur.textBuf);
  if (typeof thinking === "string" && thinking.length) {
    cur.think.hidden = false;
    cur.thinkBody.textContent = thinking;
  }
  cur.finalized = true;
  cur = null;
  scrollDown();
}

function addInfo(text) {
  const div = el("div", "info", text);
  chat.appendChild(div);
  scrollDown();
}

function addToolBlock(toolCallId, name, args, file) {
  const block = el("div", "tool running");
  const head = el("div", "tool-head");
  head.appendChild(el("span", "tool-name", "⚙ " + (name || "tool")));
  if (args) {
    let s = "";
    try {
      s = JSON.stringify(args);
    } catch (_) {
      s = String(args);
    }
    if (s.length > 160) s = s.slice(0, 160) + "…";
    head.appendChild(el("code", "args", s));
  }
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
  if (state === "done") t.el.classList.remove("running");
  else if (state === "error") {
    t.el.classList.remove("running");
    t.el.classList.add("error");
  }
  scrollDown();
}

function clearChat() {
  chat.innerHTML = "";
  toolEls.clear();
  cur = null;
  streaming = false;
  btnStop.hidden = true;
  hideNotice();
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
          cur.tools.appendChild(el("div", "tool-chip", "⚙ " + (b.name || "tool")));
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
      modelEl.textContent = m.model + (m.sessionName ? ` · ${m.sessionName}` : "");
      if (m.thinkingLevel) {
        btnThinking.textContent = "⚡ " + m.thinkingLevel;
        btnThinking.hidden = false;
      }
      break;

    case "thinking":
      btnThinking.textContent = "⚡ " + m.level;
      btnThinking.hidden = false;
      break;

    case "stats": {
      const parts = [];
      if (m.tokens) parts.push(fmtTokens(m.tokens) + " tok");
      if (m.contextPercent != null) parts.push(Math.round(m.contextPercent) + "% ctx");
      if (m.cost) parts.push("$" + m.cost.toFixed(2));
      statsEl.textContent = parts.join(" · ");
      break;
    }

    case "commands":
      commands = m.commands || [];
      break;

    case "files":
      filesCache = m.files || [];
      filesAt = Date.now();
      acUpdate(); // re-filter if the user is waiting on an open @-query
      break;

    case "agent_start":
      streaming = true;
      btnStop.hidden = false;
      if (!cur) startAssistantMsg();
      break;

    case "msg_start":
      startAssistantMsg();
      break;

    case "delta":
      if (!cur) startAssistantMsg();
      if (m.kind === "text") {
        cur.textBuf += m.delta;
        cur.text.textContent = cur.textBuf; // plain while streaming; md at msg_end
      } else if (m.kind === "thinking") {
        cur.thinkBuf += m.delta;
        cur.think.hidden = false;
        cur.thinkBody.textContent = cur.thinkBuf;
      }
      scrollDown();
      break;

    case "toolcall":
      if (!cur) startAssistantMsg();
      cur.tools.appendChild(el("div", "tool-chip", "⚙ " + (m.name || "tool")));
      scrollDown();
      break;

    case "tool_start":
      addToolBlock(m.toolCallId, m.name, m.args, m.file);
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
      streaming = false;
      btnStop.hidden = true;
      if (cur && !cur.finalized) finalizeAssistantMsg();
      break;

    case "info":
      addInfo(m.text);
      break;

    case "error":
      addInfo("⚠ " + m.message);
      break;

    case "fatal":
      showNotice(m.message);
      streaming = false;
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

/* --------------------------------------------- minimal markdown renderer */

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderInline(s) {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?\-])/g, "$1<em>$2</em>");
  return out;
}

function renderBlock(block) {
  const lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
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

/* ------------------------------------------------------------------ init */

vscode.postMessage({ t: "ready" });
