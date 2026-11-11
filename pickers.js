"use strict";

/**
 * QuickPick flows: model / thinking level / session resume.
 * Each picker asks pi for its data and returns the user's choice; applying
 * the choice (set_model, switch_session, …) stays with the caller.
 */

const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const MAX_SESSIONS = 30;

const SESSION_HEADER_BYTES = 64 * 1024;

/** pi's per-project session dir, respecting the pi process's config override. */
function projectSessionDir(cwd) {
  const base = path.resolve(cwd);
  const safe = `--${base.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured
    ? path.resolve(base, configured.replace(/^~(?=$|[/\\])/, os.homedir()))
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions", safe);
}

function sessionIdError(value) {
  return typeof value === "string" && value.trim().length <= 256 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value.trim())
    ? null : "Paste the full pi session ID (not a file path or panel tab number).";
}

/** Exact ID lookup across all saved sessions, not only the history's newest 30.
 * Read only a bounded header; never load transcripts just to locate an ID. */
async function findSessionById(cwd, value) {
  const invalid = sessionIdError(value);
  if (invalid) throw new Error(invalid);
  const id = value.trim();
  const dir = projectSessionDir(cwd);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entries = [];
  }
  let found = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry.name);
    let file;
    let header;
    try {
      file = await fsp.open(full, "r");
      if (!(await file.stat()).isFile()) continue;
      const buffer = Buffer.alloc(SESSION_HEADER_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const end = buffer.indexOf(10, 0);
      if (end < 0 || end >= bytesRead) continue;
      header = JSON.parse(buffer.toString("utf8", 0, end));
    } catch (_) {
      continue; // A corrupt/deleted session must not prevent finding other IDs.
    } finally {
      if (file) await file.close();
    }
    if (!header || header.type !== "session" || header.id !== id || typeof header.cwd !== "string" ||
        path.resolve(header.cwd) !== path.resolve(cwd)) continue;
    if (found) throw new Error("More than one saved session has this ID. Choose the file from History instead.");
    found = full;
  }
  if (!found) throw new Error("No saved session with this ID in this workspace. Check the workspace and ID; a new session is saved after its first assistant response.");
  return found;
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Read a session .jsonl for a picker entry: {name, firstUser, messages}. */
async function readSessionPreview(file, log) {
  const out = { name: "", firstUser: "", messages: 0 };
  try {
    const text = await fsp.readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (e.type === "session") {
        out.name = e.name || e.sessionName || "";
      } else if (e.type === "message" && e.message) {
        out.messages++;
        const m = e.message;
        if (!out.firstUser && m.role === "user") {
          const c = m.content;
          out.firstUser = typeof c === "string" ? c : (Array.isArray(c) ? c : [])
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
            .trim();
        }
      }
    }
  } catch (err) {
    if (log) log.debug("readSessionPreview: " + err.message);
  }
  return out;
}

/** QuickPick a model; returns the chosen model object, or null. */
async function pickModel(client, log) {
  let models;
  try {
    const data = await client.request({ type: "get_available_models" });
    models = (data && data.models) || [];
  } catch (err) {
    vscode.window.showErrorMessage(`pi: ${err.message}`);
    return null;
  }
  if (!models.length) {
    vscode.window.showInformationMessage("pi: no models configured.");
    return null;
  }

  let currentId = null;
  try {
    const state = await client.request({ type: "get_state" });
    currentId = state && state.model ? state.model.id : null;
  } catch (err) {
    log.debug("pickModel get_state: " + err.message);
  }

  const items = models.map((m) => ({
    label: m.name || m.id,
    description: `${m.provider}/${m.id}`,
    detail: [
      m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null,
      m.reasoning ? "thinking" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    picked: m.id === currentId,
    model: m,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Switch model",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!pick || pick.model.id === currentId) return null;
  return pick.model;
}

/** QuickPick a thinking level; returns the level string, or null. */
async function pickThinking(client, _log) {
  let levels = ["off"];
  let current = "off";
  try {
    const d = await client.request({ type: "get_available_thinking_levels" });
    levels = (d && d.levels) || ["off"];
    const st = await client.request({ type: "get_state" });
    current = (st && st.thinkingLevel) || "off";
  } catch (err) {
    vscode.window.showErrorMessage(`pi: ${err.message}`);
    return null;
  }
  const items = levels.map((l) => ({ label: l, picked: l === current }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Thinking level (reasoning effort)",
    ignoreFocusOut: true,
  });
  if (!pick || pick.label === current) return null;
  return pick.label;
}

/** Read this workspace's saved sessions as picker entries, newest first. */
async function getSessionItems(client, cwd, log) {
  const dir = projectSessionDir(cwd);
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch (_) {
    /* no sessions yet */
  }

  // Stat each file once, then sort by mtime (newest first).
  const stats = await Promise.all(
    names.map((f) => fsp.stat(path.join(dir, f)).catch(() => null))
  );
  const byMtime = names
    .map((f, i) => ({ f, st: stats[i] }))
    .filter((e) => e.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  let currentFile = null;
  try {
    const st = await client.request({ type: "get_state" });
    currentFile = st && st.sessionFile;
  } catch (err) {
    log.debug("pickSession get_state: " + err.message);
  }

  return Promise.all(
    byMtime.slice(0, MAX_SESSIONS).map(async ({ f, st }) => {
      const full = path.join(dir, f);
      const info = await readSessionPreview(full, log);
      return {
        label: info.name || (info.firstUser || "session").slice(0, 70) || "session",
        description: timeAgo(st.mtimeMs),
        detail: `${info.messages} messages${currentFile === full ? " · current" : ""}`,
        picked: currentFile === full,
        full,
      };
    })
  );
}

/**
 * QuickPick a saved session of this workspace; returns the session file's
 * full path, or null. Async I/O throughout (one stat per file, previews
 * read in parallel) — never blocks the extension host.
 */
async function pickSessionFile(client, cwd, log) {
  const items = await getSessionItems(client, cwd, log);
  if (!items.length) {
    vscode.window.showInformationMessage("pi: no saved sessions for this workspace.");
    return null;
  }
  const current = items.find((item) => item.picked);
  const currentFile = current ? current.full : null;

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Resume a session (this workspace)",
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!pick || pick.full === currentFile) return null;
  return pick.full;
}

module.exports = {
  pickModel,
  pickThinking,
  pickSessionFile,
  getSessionItems,
  projectSessionDir,
  sessionIdError,
  findSessionById,
  timeAgo,
  readSessionPreview,
  MAX_SESSIONS,
};
