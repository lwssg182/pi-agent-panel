"use strict";

/**
 * pi — Coding Agent, in a VS Code sidebar.
 *
 * Spawns `pi --mode rpc` in the first workspace folder and proxies its JSONL
 * RPC protocol to/from a webview chat panel. No build step: plain CommonJS.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { PiRpcClient } = require("./pi-rpc");

let provider;

function activate(context) {
  provider = new PiChatProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("piAgent.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pi-vscode.addSelection", () => provider.addEditorContext("selection")),
    vscode.commands.registerCommand("pi-vscode.addFile", () => provider.addEditorContext("file")),
    vscode.commands.registerCommand("pi-vscode.rollback", () => provider.pickCheckpoint())
  );
}

function deactivate() {
  if (provider) provider.dispose();
}

/** Run a git command, promise-based. */
function git(cwd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, extraEnv || {}) },
      (err, stdout) => (err ? reject(new Error(err.message.trim())) : resolve(stdout))
    );
  });
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-checkpoint",
  GIT_AUTHOR_EMAIL: "pi@local",
  GIT_COMMITTER_NAME: "pi-checkpoint",
  GIT_COMMITTER_EMAIL: "pi@local",
};

const MAX_MENTION_LINES = 300;
const MAX_MENTION_BYTES = 200 * 1024;

/** pi's per-project session dir: ~/.pi/agent/sessions/--{cwd with / → -}-- */
function projectSessionDir(cwd) {
  const safe = `--${String(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi", "agent", "sessions", safe);
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Read a session .jsonl for a picker entry: {name, firstUser, messages}. */
function readSessionPreview(file) {
  const out = { name: "", firstUser: "", messages: 0 };
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
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
  } catch (_) {
    /* unreadable */
  }
  return out;
}

class PiChatProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.client = null;
    this.streaming = false;
    this._cwd = null;
    this._modelShort = null;

    // @-mention file cache
    this._filesCache = null;

    // git checkpoints
    this._isRepo = null;
    this._pendingCheckpoints = [];
    this._checkpoints = context.workspaceState.get("piCheckpoints") || [];

    // Status bar: background-run indicator, click opens the panel.
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.name = "pi";
    this.status.command = "piAgent.chat.focus";
    this.status.text = "$(hubot) pi";
    this.status.tooltip = "pi — click to open the chat panel";
    this.status.show();
    context.subscriptions.push(this.status, { dispose: () => this._stopClient() });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this._html(view.webview);
    view.webview.onDidReceiveMessage((m) => this._onFromWebview(m));
    view.onDidDispose(() => {
      this._stopClient();
      if (this.view === view) this.view = null;
    });
    this._ensureClient();
  }

  dispose() {
    this._stopClient();
    this.status.dispose();
  }

  // ---------------------------------------------------------------- pi process

  _ensureClient() {
    if (!this.view) return;
    if (this.client && !this.client.exited) return;

    const cfg = vscode.workspace.getConfiguration("pi-vscode");
    const cwd =
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) ||
      os.homedir();
    this._cwd = cwd;

    const args = [];
    const providerName = cfg.get("provider");
    const model = cfg.get("model");
    if (providerName) args.push("--provider", providerName);
    if (model) args.push("--model", model);
    if (cfg.get("continue")) args.push("--continue");

    this.streaming = false;
    this._isRepo = null;
    this._pendingCheckpoints = [];
    const client = new PiRpcClient({
      piPath: PiRpcClient.resolvePiPath(cfg.get("piPath")),
      args,
      cwd,
    });
    this.client = client;

    try {
      client.start();
    } catch (err) {
      this._post({ t: "fatal", message: `Failed to spawn pi: ${err.message}` });
      return;
    }

    client.on("error", (err) => {
      this._post({
        t: "fatal",
        message: `Failed to start pi ("${err.message}"). Is pi installed? Set "pi-vscode.piPath" in settings.`,
      });
    });
    client.on("exit", (code, stderr) => {
      if (this.client !== client) return;
      this.streaming = false;
      this._setStatus("$(circle-slash) pi: exited");
      this._post({
        t: "fatal",
        message: `pi exited (code ${code})${stderr ? "\n" + stderr.slice(-800) : ""}\nUse ↻ to restart.`,
      });
    });
    client.on("event", (ev) => this._onPiEvent(ev));
    client.on("ui", (req) => this._onUiRequest(req));

    this._refreshState();
    this._refreshCommands();
  }

  _stopClient() {
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    this.streaming = false;
  }

  _setStatus(text, tooltip) {
    this.status.text = text;
    if (tooltip) this.status.tooltip = tooltip;
  }

  // ------------------------------------------------------------------ webview

  _post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  _onFromWebview(m) {
    switch (m.t) {
      case "ready":
        this._refreshState();
        this._refreshCommands();
        break;
      case "send":
        this._send(m.text);
        break;
      case "abort":
        if (this.client) this.client.request({ type: "abort" }).catch(() => {});
        break;
      case "new":
        this._newSession();
        break;
      case "pick_model":
        this._pickModel();
        break;
      case "pick_thinking":
        this._pickThinking();
        break;
      case "pick_session":
        this._pickSession();
        break;
      case "pick_checkpoint":
        this.pickCheckpoint();
        break;
      case "list_files":
        this._sendFileList();
        break;
      case "compact":
        if (this.client)
          this.client.request({ type: "compact" }).catch((err) =>
            this._post({ t: "error", message: err.message })
          );
        break;
      case "open_diff":
        this._openDiff(m.path);
        break;
      case "add_context":
        this.addEditorContext("selection");
        break;
      case "restart":
        this._stopClient();
        this._post({ t: "cleared" });
        this._ensureClient();
        break;
    }
  }

  async _send(text) {
    this._ensureClient();
    const c = this.client;
    if (!c || c.exited) {
      this._post({ t: "error", message: "pi is not running. Use ↻ to restart." });
      return;
    }

    // Checkpoint the working tree before the turn (git repos only), and
    // expand @-mentions into referenced-file blocks.
    this._snapshotBeforeTurn(text);
    const message = this._buildPrompt(text);

    const cmd = { type: "prompt", message };
    if (this.streaming) cmd.streamingBehavior = "followUp";
    try {
      await c.request(cmd);
    } catch (err) {
      // Race: agent started streaming between our check and the write.
      if (this.streaming) {
        try {
          await c.request({ type: "prompt", message, streamingBehavior: "followUp" });
          return;
        } catch (_) {
          /* fall through */
        }
      }
      this._post({ t: "error", message: err.message });
    }
  }

  async _newSession() {
    const c = this.client;
    if (!c || c.exited) {
      this._ensureClient();
      return;
    }
    try {
      await c.request({ type: "new_session" });
    } catch (err) {
      this._post({ t: "error", message: err.message });
    }
    this._refreshState();
  }

  // ------------------------------------------------------------- pickers (UI)

  /** Live model switch: get_available_models -> QuickPick -> set_model. */
  async _pickModel() {
    const c = this.client;
    if (!c || c.exited) {
      vscode.window.showWarningMessage("pi is not running.");
      return;
    }

    let models;
    try {
      const data = await c.request({ type: "get_available_models" });
      models = (data && data.models) || [];
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
      return;
    }
    if (!models.length) {
      vscode.window.showInformationMessage("pi: no models configured.");
      return;
    }

    let currentId = null;
    try {
      const state = await c.request({ type: "get_state" });
      currentId = state && state.model ? state.model.id : null;
    } catch (_) {
      /* ignore */
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
    if (!pick || pick.model.id === currentId) return;

    try {
      const model = await c.request({
        type: "set_model",
        provider: pick.model.provider,
        modelId: pick.model.id,
      });
      this._post({
        t: "state",
        model: model ? model.name || model.id : pick.model.name,
        streaming: this.streaming,
        sessionName: "",
      });
      this._refreshState();
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
    }
  }

  /** Thinking level switch (Codex-style reasoning effort). */
  async _pickThinking() {
    const c = this.client;
    if (!c || c.exited) return;
    let levels = ["off"];
    let current = "off";
    try {
      const d = await c.request({ type: "get_available_thinking_levels" });
      levels = (d && d.levels) || ["off"];
      const st = await c.request({ type: "get_state" });
      current = (st && st.thinkingLevel) || "off";
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
      return;
    }
    const items = levels.map((l) => ({ label: l, picked: l === current }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Thinking level (reasoning effort)",
      ignoreFocusOut: true,
    });
    if (!pick || pick.label === current) return;
    try {
      await c.request({ type: "set_thinking_level", level: pick.label });
      this._post({ t: "thinking", level: pick.label });
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
    }
  }

  /** Resume a previous session of this workspace (Codex-style history). */
  async _pickSession() {
    const c = this.client;
    if (!c || c.exited) {
      vscode.window.showWarningMessage("pi is not running.");
      return;
    }
    const dir = projectSessionDir(this._cwd || process.cwd());
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch (_) {
      /* no sessions yet */
    }
    if (!files.length) {
      vscode.window.showInformationMessage("pi: no saved sessions for this workspace.");
      return;
    }
    files.sort(
      (a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs
    );

    let currentFile = null;
    try {
      const st = await c.request({ type: "get_state" });
      currentFile = st && st.sessionFile;
    } catch (_) {
      /* ignore */
    }

    const items = [];
    for (const f of files.slice(0, 30)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const info = readSessionPreview(full);
      items.push({
        label: info.name || (info.firstUser || "session").slice(0, 70) || "session",
        description: timeAgo(st.mtime),
        detail: `${info.messages} messages${currentFile === full ? " · current" : ""}`,
        picked: currentFile === full,
        full,
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Resume a session (this workspace)",
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!pick || pick.full === currentFile) return;

    try {
      await c.request({ type: "switch_session", sessionPath: pick.full });
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
      return;
    }
    this._post({ t: "cleared" });
    try {
      const data = await c.request({ type: "get_messages" });
      this._post({ t: "replay", messages: (data && data.messages) || [] });
    } catch (_) {
      /* ignore */
    }
    this._refreshState();
    this._refreshStats();
  }

  // ------------------------------------------------------- git checkpoints

  async _checkIsRepo() {
    if (this._isRepo !== null) return this._isRepo;
    try {
      await git(this._cwd, ["rev-parse", "--git-dir"]);
      this._isRepo = true;
    } catch (_) {
      this._isRepo = false;
    }
    return this._isRepo;
  }

  /**
   * Snapshot the exact working-tree state (tracked + untracked, deletions)
   * into a dangling commit via git plumbing. Never touches the user's index,
   * stash, or working tree.
   */
  async _snapshotWorktree() {
    const cwd = this._cwd;
    const tmpIndex = path.join(os.tmpdir(), `pi-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      try {
        await git(cwd, ["read-tree", "HEAD"], env);
      } catch (_) {
        await git(cwd, ["read-tree", "--empty"], env); // repo without commits
      }
      await git(cwd, ["add", "-A", "."], env);
      const tree = (await git(cwd, ["write-tree"], env)).trim();
      let hash;
      try {
        hash = (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "pi checkpoint"], GIT_IDENTITY)).trim();
      } catch (_) {
        hash = (await git(cwd, ["commit-tree", tree, "-m", "pi checkpoint"], GIT_IDENTITY)).trim();
      }
      return hash;
    } finally {
      try {
        fs.unlinkSync(tmpIndex);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** Before each user turn: snapshot the tree so the turn can be rolled back. */
  async _snapshotBeforeTurn(prompt) {
    if (!(await this._checkIsRepo())) return;
    try {
      const hash = await this._snapshotWorktree();
      const prev = this._pendingCheckpoints[this._pendingCheckpoints.length - 1];
      if (!prev || prev.hash !== hash) {
        this._pendingCheckpoints.push({ hash, prompt, time: Date.now() });
      }
    } catch (_) {
      /* checkpoint failure must never block the prompt */
    }
  }

  /** QuickPick of checkpoints; roll the working tree back to the chosen one. */
  async pickCheckpoint() {
    if (this.streaming) {
      vscode.window.showWarningMessage("pi: wait for the current run to finish before rolling back.");
      return;
    }
    if (!(await this._checkIsRepo())) {
      vscode.window.showInformationMessage("pi: checkpoints need a git repository.");
      return;
    }
    const items = [];
    for (const cp of this._checkpoints.slice().reverse().slice(0, 50)) {
      // Drop checkpoints whose commit object no longer exists (gc'd).
      try {
        await git(this._cwd, ["cat-file", "-e", `${cp.hash}^{commit}`]);
      } catch (_) {
        continue;
      }
      items.push({
        label: `⟲ ${new Date(cp.time).toLocaleTimeString()} · ${(cp.prompt || "").slice(0, 50)}`,
        description: "roll back to before this message",
        detail: cp.hash.slice(0, 12),
        cp,
      });
    }
    if (!items.length) {
      vscode.window.showInformationMessage(
        "pi: no checkpoints yet (one is created each time you send a message in a git repo)."
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Roll back the working tree to a checkpoint",
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!pick) return;

    const yes = await vscode.window.showWarningMessage(
      `Roll back all files to the state before "${(pick.cp.prompt || "").slice(0, 40)}…"?\n\nThis discards every working-tree change made after that point (including staged changes and new files, excluding gitignored ones). A safety snapshot of the current state is created first.`,
      { modal: true },
      "Roll back"
    );
    if (yes !== "Roll back") return;

    try {
      // Safety snapshot first, so the rollback itself is reversible.
      const safety = await this._snapshotWorktree();
      this._checkpoints.push({ hash: safety, prompt: "(state before rollback)", time: Date.now() });
      this._commitPendingCheckpoints();
      await git(this._cwd, ["read-tree", "-u", "--reset", pick.cp.hash]);
      await git(this._cwd, ["clean", "-fd"]);
      this._post({ t: "info", text: "· working tree rolled back to checkpoint" });
      vscode.window.showInformationMessage("pi: working tree rolled back.");
    } catch (err) {
      vscode.window.showErrorMessage(`pi: rollback failed — ${err.message}`);
    }
  }

  _commitPendingCheckpoints() {
    if (this._pendingCheckpoints.length) {
      this._checkpoints = this._checkpoints.concat(this._pendingCheckpoints).slice(-50);
      this._pendingCheckpoints = [];
    }
    this.context.workspaceState.update("piCheckpoints", this._checkpoints);
  }

  // ------------------------------------------------------- @-mention files

  /**
   * Expand @mentions into referenced-file blocks appended to the prompt.
   * Unknown paths are left untouched in the text.
   */
  _buildPrompt(text) {
    if (!this._cwd || text.indexOf("@") === -1) return text;
    const mentions = Array.from(new Set(text.match(/@([^\s@,;"'`|<>\[\]()]+)/g) || []));
    const blocks = [];
    for (const raw of mentions) {
      const rel = raw.slice(1);
      if (!rel || rel.length > 300) continue;
      const abs = path.isAbsolute(rel) ? rel : path.join(this._cwd, rel);
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

  /** Workspace file list for the webview's @-mention autocomplete. */
  async _sendFileList() {
    const now = Date.now();
    if (this._filesCache && now - this._filesCache.at < 60000) {
      this._post({ t: "files", files: this._filesCache.files });
      return;
    }
    const exclude =
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/venv/**,**/.venv/**,**/__pycache__/**,**/.cache/**,**/target/**,**/coverage/**,**/.next/**}";
    try {
      const uris = await vscode.workspace.findFiles("**/*", exclude, 5000);
      const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort();
      this._filesCache = { at: now, files };
      this._post({ t: "files", files });
    } catch (_) {
      this._post({ t: "files", files: [] });
    }
  }

  // ---------------------------------------------------- editor context (Codex)

  /** Attach the active selection (or whole file) into the chat input. */
  addEditorContext(mode) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("pi: no active editor.");
      return;
    }
    const file = editor.document.uri.fsPath;
    const rel = vscode.workspace.asRelativePath(file);
    const lang = editor.document.languageId || "";
    const fence = "```" + lang;

    let snippet;
    const sel = editor.selection;
    if (mode === "selection" && !sel.isEmpty) {
      const start = editor.document.positionAt(0);
      const lineStart = sel.start.line + 1;
      const lineEnd = sel.end.line + 1;
      const text = editor.document.getText(sel);
      snippet =
        `Selection from \`${rel}\` (lines ${lineStart}–${lineEnd}):\n` +
        `${fence}\n${text}\n${"```"}`;
    } else {
      const MAX_LINES = 300;
      const total = editor.document.lineCount;
      const text = editor.document.getText();
      const lines = text.split("\n");
      const truncated = lines.length > MAX_LINES;
      snippet =
        `Contents of \`${rel}\`${truncated ? ` (first ${MAX_LINES} of ${total} lines)` : ""}:\n` +
        `${fence}\n${lines.slice(0, MAX_LINES).join("\n")}\n${"```"}`;
    }

    this._post({ t: "insert_input", text: snippet + "\n\n" });
  }

  /** Open a git diff (HEAD ↔ working tree) for a file pi touched. */
  async _openDiff(file) {
    try {
      const right = vscode.Uri.file(file);
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (gitExt) {
        const git = gitExt.isActive ? gitExt.exports.getAPI(1) : await gitExt.activate().then((e) => e.getAPI(1));
        const repo = git.repositories.find(
          (r) => file === r.rootUri.fsPath || file.startsWith(r.rootUri.fsPath + path.sep)
        );
        if (repo) {
          const left = git.toGitUri(right, "HEAD");
          await vscode.commands.executeCommand(
            "vscode.diff",
            left,
            right,
            `pi: ${path.basename(file)} (HEAD ↔ working tree)`
          );
          return;
        }
      }
      await vscode.window.showTextDocument(right, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`pi: ${err.message}`);
    }
  }

  // ------------------------------------------------------------- pi -> webview

  _onPiEvent(ev) {
    const post = this._post.bind(this);
    switch (ev.type) {
      case "agent_start":
        this.streaming = true;
        this._setStatus("$(sync~spin) pi: working…", "pi is working — click to open the panel");
        post({ t: "agent_start" });
        break;

      case "agent_settled": {
        const ranSomething = this.streaming;
        this.streaming = false;
        this._commitPendingCheckpoints();
        post({ t: "agent_settled" });
        this._refreshState();
        this._refreshStats();

        // Background run finished while the panel was hidden: notify.
        if (ranSomething && this.view && !this.view.visible) {
          const cfg = vscode.workspace.getConfiguration("pi-vscode");
          if (cfg.get("notifyOnFinish", true)) {
            vscode.window
              .showInformationMessage("pi finished the current task.", "Open")
              .then((btn) => {
                if (btn === "Open") vscode.commands.executeCommand("piAgent.chat.focus");
              });
          }
        }
        break;
      }

      case "message_start":
        if (ev.message && ev.message.role === "assistant") post({ t: "msg_start" });
        break;

      case "message_update": {
        const d = ev.assistantMessageEvent;
        if (!d) break;
        if (d.type === "text_delta") post({ t: "delta", kind: "text", delta: d.delta });
        else if (d.type === "thinking_delta")
          post({ t: "delta", kind: "thinking", delta: d.delta });
        else if (d.type === "toolcall_start") post({ t: "toolcall", name: d.toolName });
        break;
      }

      case "message_end":
        if (ev.message && ev.message.role === "assistant") {
          const m = ev.message;
          const content = Array.isArray(m.content) ? m.content : [];
          const text = content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const thinking = content
            .filter((b) => b.type === "thinking")
            .map((b) => b.thinking)
            .join("\n");
          post({ t: "msg_end", text, thinking });
        }
        break;

      case "tool_execution_start": {
        let file = null;
        if (ev.toolName === "edit" || ev.toolName === "write") {
          const a = ev.args || {};
          const p = a.path || a.file || a.file_path || null;
          if (p) file = path.isAbsolute(p) ? p : path.join(this._cwd || process.cwd(), p);
        }
        post({
          t: "tool_start",
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          args: ev.args,
          file,
        });
        break;
      }

      case "tool_execution_update":
        post({
          t: "tool_update",
          toolCallId: ev.toolCallId,
          text: resultText(ev.partialResult),
        });
        break;

      case "tool_execution_end":
        post({
          t: "tool_end",
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          text: resultText(ev.result),
          isError: !!ev.isError,
        });
        break;

      case "compaction_start":
        post({ t: "info", text: "· compacting context…" });
        break;

      case "auto_retry_start":
        post({
          t: "info",
          text: `· transient error, retrying (attempt ${ev.attempt}/${ev.maxAttempts})…`,
        });
        break;

      case "queue_update": {
        const n = (ev.steering || []).length + (ev.followUp || []).length;
        if (n > 0) post({ t: "info", text: `· ${n} message(s) queued` });
        break;
      }

      default:
        break;
    }
  }

  // ------------------------------------------------------------- state/stats

  async _refreshState() {
    const c = this.client;
    if (!c || c.exited) return;
    try {
      const state = await c.request({ type: "get_state" });
      const model = state && state.model ? state.model.name || state.model.id : "no model";
      this._modelShort = model;
      if (!this.streaming) this._setStatus(`$(hubot) ${model}`, "pi — click to open the chat panel");
      this.streaming = !!(state && state.isStreaming);
      this._post({
        t: "state",
        model,
        streaming: this.streaming,
        sessionName: (state && state.sessionName) || "",
        thinkingLevel: (state && state.thinkingLevel) || null,
      });
    } catch (_) {
      /* pi not ready yet */
    }
  }

  async _refreshStats() {
    const c = this.client;
    if (!c || c.exited) return;
    try {
      const s = await c.request({ type: "get_session_stats" });
      const ctx = s && s.contextUsage;
      this._post({
        t: "stats",
        tokens: s && s.tokens ? s.tokens.total : 0,
        cost: typeof s.cost === "number" ? s.cost : 0,
        contextPercent: ctx ? ctx.percent : null,
      });
    } catch (_) {
      /* ignore */
    }
  }

  async _refreshCommands() {
    const c = this.client;
    if (!c || c.exited) return;
    try {
      const d = await c.request({ type: "get_commands" });
      this._post({ t: "commands", commands: (d && d.commands) || [] });
    } catch (_) {
      /* ignore */
    }
  }

  // ------------------------------------------- extension UI requests (dialogs)

  async _onUiRequest(req) {
    const c = this.client;
    if (!c) return;
    const { id, method } = req;
    try {
      switch (method) {
        case "select": {
          const pick = await vscode.window.showQuickPick(req.options || [], {
            placeHolder: req.title,
            ignoreFocusOut: true,
          });
          c.respondUi(id, pick === undefined ? { cancelled: true } : { value: pick });
          break;
        }
        case "confirm": {
          const yes = await vscode.window.showInformationMessage(
            req.title || "Confirm",
            { modal: true, detail: req.message },
            "Yes",
            "No"
          );
          c.respondUi(id, yes === undefined ? { cancelled: true } : { confirmed: yes === "Yes" });
          break;
        }
        case "input":
        case "editor": {
          const value = await vscode.window.showInputBox({
            prompt: req.title,
            placeHolder: req.placeholder,
            value: req.prefill || "",
            ignoreFocusOut: true,
          });
          c.respondUi(id, value === undefined ? { cancelled: true } : { value });
          break;
        }
        case "notify": {
          const msg = req.message || "";
          if (req.notifyType === "error") vscode.window.showErrorMessage(msg);
          else if (req.notifyType === "warning") vscode.window.showWarningMessage(msg);
          else vscode.window.showInformationMessage(msg);
          break;
        }
        default:
          // setStatus / setWidget / setTitle / set_editor_text: fire-and-forget.
          break;
      }
    } catch (_) {
      try {
        c.respondUi(id, { cancelled: true });
      } catch (__) {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------- HTML

  _html(webview) {
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "webview.js")
    );
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "webview.css")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${css}">
<title>pi</title>
</head>
<body>
  <header id="topbar">
    <span id="model" title="Click to switch model">starting…</span>
    <button id="btn-thinking" title="Thinking level (reasoning effort)" hidden></button>
  </header>
  <div id="toolbar">
    <span id="stats" title="Session tokens · context usage · cost"></span>
    <button id="btn-history" title="Resume a previous session of this workspace">🕘</button>
    <button id="btn-context" title="Attach active selection (or file) to the input">✎</button>
    <button id="btn-compact" title="Compact context now">⇲</button>
    <button id="btn-checkpoint" title="Roll back the working tree to a checkpoint (git)">⟲</button>
    <button id="btn-new" title="Start a new session">＋ New</button>
    <button id="btn-restart" title="Restart the pi process">↻</button>
    <button id="btn-stop" title="Abort the current run" hidden>■</button>
  </div>
  <main id="chat" aria-live="polite"></main>
  <div id="notice" hidden></div>
  <div id="autocomplete" hidden></div>
  <footer>
    <textarea id="input" rows="3"
      placeholder="Ask pi… (Enter to send, Shift+Enter for newline, / for commands, @ for files)"></textarea>
    <button id="btn-send" title="Send">Send</button>
  </footer>
  <script src="${js}"></script>
</body>
</html>`;
  }
}

/** Extract text from a tool result / partial result for display. */
function resultText(result) {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  if (text.length > 4000) return text.slice(0, 4000) + "\n… (truncated)";
  return text;
}

module.exports = { activate, deactivate };
