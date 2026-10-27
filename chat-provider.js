"use strict";

/**
 * PiChatProvider: the pi sidebar webview — spawns `pi --mode rpc` (via
 * PiRpcClient), maps its agent events to the chat UI, and answers the
 * webview's messages. Git checkpointing, QuickPicks and @-mention
 * expansion live in their own modules; this class wires them together.
 */

const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { PiRpcClient } = require("./pi-rpc");
const { CheckpointStore } = require("./checkpoints");
const pickers = require("./pickers");
const { buildPrompt } = require("./mentions");

const TOOL_OUTPUT_LIMIT = 4000;
const FILE_LIST_LIMIT = 5000;
const FILE_CACHE_TTL_MS = 60000;
const EDITOR_CONTEXT_MAX_LINES = 300;
const PICKER_KINDS = new Set(["model", "thinking", "session", "checkpoint"]);

class PiChatProvider {
  constructor(context, log) {
    this.context = context;
    this.log = log;
    this.view = null;
    this.client = null;
    this.streaming = false;
    this._cwd = null;
    this._modelShort = null;

    // @-mention file cache
    this._filesCache = null;

    // git checkpoints
    this.checkpoints = new CheckpointStore({
      cwd: null,
      workspaceState: context.workspaceState,
      log,
    });

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

    const cfg = vscode.workspace.getConfiguration("pi-agent-panel");
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
    this.checkpoints.reset(cwd);
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
        message: `Failed to start pi ("${err.message}"). Is pi installed? Set "pi-agent-panel.piPath" in settings.`,
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

  async _stopClient() {
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.stop();
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
        this._post({ t: "open_picker", kind: "model" });
        break;
      case "pick_thinking":
        this._post({ t: "open_picker", kind: "thinking" });
        break;
      case "pick_session":
        this._post({ t: "open_picker", kind: "session" });
        break;
      case "list_picker":
        this._listPicker(m.kind);
        break;
      case "choose_model":
        this._setModel(m.provider, m.modelId);
        break;
      case "choose_thinking":
        this._setThinking(m.level);
        break;
      case "choose_session":
        this._resumeSession(m.path);
        break;
      case "choose_checkpoint":
        this._rollbackTo(m.hash, m.prompt);
        break;
      case "list_files":
        this._sendFileList();
        break;
      case "show_stats":
        this._showStats();
        break;
      case "open_settings":
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `@ext:${this.context.extension.id}`
        );
        break;
      case "compact":
        if (this.client)
          // Compaction is an LLM call — allow it to run long.
          this.client.request({ type: "compact" }, 0).catch((err) =>
            this._post({ t: "error", message: err.message })
          );
        break;
      case "open_diff":
        this._openDiff(m.path);
        break;
      case "copy_text":
        if (typeof m.text === "string") {
          Promise.resolve(vscode.env.clipboard.writeText(m.text)).catch((err) =>
            this.log.warn("Clipboard write failed: " + err.message)
          );
        }
        break;
      case "open_link": {
        // Scheme re-checked host-side as defense in depth (webview filtered
        // already, but messages are spoofable).
        const url = String(m.url || "");
        if (/^(https?:|mailto:)/i.test(url)) {
          Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))).catch(() => {});
        }
        break;
      }
      case "add_context":
        this.addEditorContext("selection");
        break;
      case "restart":
        this._stopClient().then(() => {
          this._post({ t: "cleared" });
          this._ensureClient();
        });
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
    this.checkpoints.beforeTurn(text);
    const message = buildPrompt(this._cwd, text);

    const cmd = { type: "prompt", message };
    if (this.streaming) cmd.streamingBehavior = "followUp";
    try {
      // No timeout: the response arrives when the agent run finishes, which
      // can legitimately take minutes.
      await c.request(cmd, 0);
    } catch (err) {
      // Race: agent started streaming between our check and the write.
      if (this.streaming) {
        try {
          await c.request({ type: "prompt", message, streamingBehavior: "followUp" }, 0);
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

  // ------------------------------------------------- panel pickers (webview)

  _pickerError(message) {
    this._post({ t: "picker_error", message });
  }

  async _listPicker(kind) {
    if (!PICKER_KINDS.has(kind)) return;
    const c = this.client;
    if (!c || c.exited) {
      this._pickerError("pi is not running. Restart it and try again.");
      return;
    }
    try {
      if (kind === "model") {
        const data = await c.request({ type: "get_available_models" });
        let state = null;
        try {
          state = await c.request({ type: "get_state" });
        } catch (err) {
          this.log.debug("Model picker state unavailable: " + err.message);
        }
        const currentId = state && state.model ? state.model.id : null;
        const currentProvider = state && state.model ? state.model.provider : null;
        const items = ((data && data.models) || []).map((m) => ({
          label: m.name || m.id,
          description: `${m.provider}/${m.id}`,
          detail: [
            m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null,
            m.reasoning ? "thinking" : null,
          ].filter(Boolean).join(" · "),
          current: m.id === currentId && (!currentProvider || m.provider === currentProvider),
          provider: m.provider,
          modelId: m.id,
        }));
        this._post({ t: "picker_data", kind, items, empty: "No models configured." });
      } else if (kind === "thinking") {
        const data = await c.request({ type: "get_available_thinking_levels" });
        let state = null;
        try {
          state = await c.request({ type: "get_state" });
        } catch (err) {
          this.log.debug("Thinking picker state unavailable: " + err.message);
        }
        const current = (state && state.thinkingLevel) || "off";
        const items = ((data && data.levels) || ["off"]).map((level) => ({
          label: level,
          description: level === "off" ? "No extended reasoning" : "Reasoning effort",
          current: level === current,
          level,
        }));
        this._post({ t: "picker_data", kind, items, empty: "No thinking levels available." });
      } else if (kind === "session") {
        const items = await pickers.getSessionItems(c, this._cwd || process.cwd(), this.log);
        this._post({
          t: "picker_data", kind,
          items: items.map((item) => ({
            label: item.label,
            description: item.description,
            detail: item.detail,
            current: item.picked,
            path: item.full,
          })),
          empty: "No saved sessions for this workspace.",
        });
      } else if (kind === "checkpoint") {
        if (this.streaming) {
          this._pickerError("Wait for the current run to finish before rolling back.");
          return;
        }
        if (!(await this.checkpoints.checkIsRepo())) {
          this._post({ t: "picker_data", kind, items: [], empty: "Checkpoints require a git repository." });
          return;
        }
        const entries = await this.checkpoints.entries();
        this._post({
          t: "picker_data", kind,
          items: entries.map((cp) => ({
            label: cp.prompt || "(no message)",
            description: new Date(cp.time).toLocaleString(),
            detail: cp.hash.slice(0, 12),
            hash: cp.hash,
            prompt: cp.prompt || "this checkpoint",
          })),
          empty: "No checkpoints yet. One is created before each message in a git repo.",
        });
      }
    } catch (err) {
      this._pickerError(err.message);
    }
  }

  async _setModel(provider, modelId) {
    const c = this.client;
    if (!c || c.exited || typeof provider !== "string" || typeof modelId !== "string") return;
    try {
      await c.request({ type: "set_model", provider, modelId });
      this._post({ t: "picker_done", kind: "model" });
      this._refreshState();
    } catch (err) {
      this._pickerError(err.message);
    }
  }

  async _setThinking(level) {
    const c = this.client;
    if (!c || c.exited || typeof level !== "string") return;
    try {
      await c.request({ type: "set_thinking_level", level });
      this._post({ t: "picker_done", kind: "thinking" });
      this._post({ t: "thinking", level });
    } catch (err) {
      this._pickerError(err.message);
    }
  }

  async _resumeSession(full) {
    const c = this.client;
    if (!c || c.exited || typeof full !== "string") return;
    const sessionDir = pickers.projectSessionDir(this._cwd || process.cwd());
    if (!path.resolve(full).startsWith(path.resolve(sessionDir) + path.sep)) return;
    try {
      await c.request({ type: "switch_session", sessionPath: full });
      this._post({ t: "cleared" });
      try {
        const data = await c.request({ type: "get_messages" });
        this._post({ t: "replay", messages: (data && data.messages) || [] });
      } catch (err) {
        this.log.warn("Session replay failed: " + err.message);
      }
      this._refreshState();
      this._refreshStats();
      this._post({ t: "picker_done", kind: "session" });
    } catch (err) {
      this._pickerError(err.message);
    }
  }

  async _rollbackTo(hash, prompt) {
    if (this.streaming || typeof hash !== "string" || !/^[0-9a-f]{40}$/.test(hash)) return;
    if (!(await this.checkpoints.checkIsRepo())) {
      this._pickerError("Checkpoints require a git repository.");
      return;
    }
    try {
      await this.checkpoints.rollback(hash);
      this._post({ t: "picker_done", kind: "checkpoint" });
      this._post({ t: "info", text: `Working tree restored to before “${String(prompt || "checkpoint").slice(0, 60)}”` });
    } catch (err) {
      this._pickerError(`Rollback failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------- git checkpoints

  /** Command entry point: open the checkpoint list inside the pi panel. */
  async pickCheckpoint() {
    if (this.view && typeof this.view.show === "function") this.view.show(true);
    else await vscode.commands.executeCommand("piAgent.chat.focus").catch(() => {});
    this._post({ t: "open_picker", kind: "checkpoint" });
  }

  // ------------------------------------------------------- @-mention files

  /** Workspace file list for the webview's @-mention autocomplete. */
  async _sendFileList() {
    const now = Date.now();
    if (this._filesCache && now - this._filesCache.at < FILE_CACHE_TTL_MS) {
      this._post({ t: "files", files: this._filesCache.files });
      return;
    }
    const exclude =
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/venv/**,**/.venv/**,**/__pycache__/**,**/.cache/**,**/target/**,**/coverage/**,**/.next/**}";
    try {
      const uris = await vscode.workspace.findFiles("**/*", exclude, FILE_LIST_LIMIT);
      const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort();
      this._filesCache = { at: now, files };
      this._post({ t: "files", files });
    } catch (err) {
      this.log.debug("sendFileList: " + err.message);
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
      const lineStart = sel.start.line + 1;
      const lineEnd = sel.end.line + 1;
      const text = editor.document.getText(sel);
      snippet =
        `Selection from \`${rel}\` (lines ${lineStart}–${lineEnd}):\n` +
        `${fence}\n${text}\n${"```"}`;
    } else {
      const total = editor.document.lineCount;
      const text = editor.document.getText();
      const lines = text.split("\n");
      const truncated = lines.length > EDITOR_CONTEXT_MAX_LINES;
      snippet =
        `Contents of \`${rel}\`${truncated ? ` (first ${EDITOR_CONTEXT_MAX_LINES} of ${total} lines)` : ""}:\n` +
        `${fence}\n${lines.slice(0, EDITOR_CONTEXT_MAX_LINES).join("\n")}\n${"```"}`;
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
        this.checkpoints.commitPending();
        post({ t: "agent_settled" });
        this._refreshState();
        this._refreshStats();

        // Background run finished while the panel was hidden: notify.
        if (ranSomething && this.view && !this.view.visible) {
          const cfg = vscode.workspace.getConfiguration("pi-agent-panel");
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
        let target = null;
        const a = ev.args || {};
        const p = a.path || a.file || a.file_path || null;
        if (p && (ev.toolName === "read" || ev.toolName === "edit" || ev.toolName === "write")) {
          file = path.isAbsolute(p) ? p : path.join(this._cwd || process.cwd(), p);
          target = displayPath(this._cwd, file);
        } else if (ev.toolName === "bash" && typeof a.command === "string") {
          target = a.command.split("\n")[0].trim();
        }
        post({
          t: "tool_start",
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          args: ev.args,
          file,
          target,
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
        // Transient status: updates in place, cleared when output resumes.
        post({ t: "status", kind: "compaction", text: "Compacting context…" });
        break;

      case "auto_retry_start":
        post({
          t: "status",
          kind: "retry",
          text: `Transient error — retrying (attempt ${ev.attempt}/${ev.maxAttempts})…`,
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
    } catch (err) {
      this.log.debug("refreshState: " + err.message);
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
    } catch (err) {
      this.log.debug("refreshStats: " + err.message);
    }
  }

  /** /stats — print a usage line into the chat (Codex-style /cost). */
  async _showStats() {
    const c = this.client;
    if (!c || c.exited) {
      this._post({ t: "info", text: "· pi is not running" });
      return;
    }
    try {
      const s = await c.request({ type: "get_session_stats" });
      const ctx = s && s.contextUsage;
      const parts = [];
      if (s && s.tokens && s.tokens.total != null) parts.push(`tokens: ${s.tokens.total}`);
      if (ctx && ctx.percent != null) parts.push(`context: ${Math.round(ctx.percent)}%`);
      if (typeof s.cost === "number" && s.cost > 0) parts.push(`cost: $${s.cost.toFixed(2)}`);
      this._post({
        t: "info",
        text: "· " + (parts.length ? parts.join(" · ") : "no usage yet"),
      });
      this._refreshStats();
    } catch (err) {
      this._post({ t: "info", text: "· stats unavailable: " + err.message });
    }
  }

  async _refreshCommands() {
    const c = this.client;
    if (!c || c.exited) return;
    try {
      const d = await c.request({ type: "get_commands" });
      this._post({ t: "commands", commands: (d && d.commands) || [] });
    } catch (err) {
      this.log.debug("refreshCommands: " + err.message);
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
    } catch (err) {
      this.log.warn("UI request failed: " + err.message);
      try {
        c.respondUi(id, { cancelled: true });
      } catch (err2) {
        this.log.debug("respondUi fallback failed: " + err2.message);
      }
    }
  }

  // ------------------------------------------------------------------- HTML

  _html(webview) {
    // Versioned URIs: without them updates can serve stale cached JS/CSS.
    const v = this.context.extension.packageJSON.version || Date.now();
    const versioned = (name) => {
      const u = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, name));
      return u.with({ query: u.query ? u.query + `&v=${v}` : `v=${v}` });
    };
    const js = versioned("webview.js");
    const mdJs = versioned("markdown.js");
    const css = versioned("webview.css");
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: https:`,
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
    <div class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none"><path d="m7 8-4 4 4 4m10-8 4 4-4 4M14 5l-4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="brand-copy">
      <div class="brand-name">pi<span class="brand-suffix">coding agent</span></div>
      <button id="model" class="model-button" title="Switch model"><span class="model-dot"></span><span id="model-label">Starting…</span><span class="chevron">⌄</span></button>
    </div>
    <button id="btn-new" class="icon-button" title="New session" aria-label="New session">＋</button>
  </header>
  <div id="toolbar">
    <button id="btn-history" class="toolbar-button" title="Session history" aria-label="Session history">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 4v4l2.5 1.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>History</span>
    </button>
    <button id="btn-context" class="toolbar-button" title="Attach active selection or file" aria-label="Attach context">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm5 1v3.5H12" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>
      <span>Context</span>
    </button>
    <span class="toolbar-spacer"></span>
    <button id="btn-thinking" class="level-chip" title="Thinking level" hidden>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 2 3.5 8.5H8L6.5 14 12.5 7H7.5L9 2Z" fill="currentColor"/></svg>
      <span id="thinking-label"></span>
    </button>
    <div class="toolbar-menu-wrap">
      <button id="btn-more" class="toolbar-button icon-only" title="More actions" aria-label="More actions" aria-haspopup="true" aria-expanded="false">•••</button>
      <div id="toolbar-menu" role="menu" hidden>
        <button id="btn-compact" class="menu-item" role="menuitem">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3h10v3l-3 3v4l-3-2V9l-4-6Z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>
          <span>Compact context</span>
        </button>
        <button id="btn-checkpoint" class="menu-item" role="menuitem">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5 2.5 4.5v5.5L8 13.5l5.5-3.5V4.5L8 1.5ZM2.5 4.5 8 7.5m0 0 5.5-3M8 7.5v6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>
          <span>Restore checkpoint</span>
        </button>
        <button id="btn-restart" class="menu-item" role="menuitem">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.2 7.2M2.5 4.5V8h3.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>Restart pi</span>
        </button>
      </div>
    </div>
  </div>
  <main id="chat" aria-live="polite"></main>
  <div id="picker-overlay" hidden>
    <section id="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <div class="picker-header">
        <div><h2 id="picker-title"></h2><p id="picker-subtitle"></p></div>
        <button id="picker-close" class="icon-button" title="Close" aria-label="Close picker">×</button>
      </div>
      <div id="picker-search-wrap"><input id="picker-search" type="text" autocomplete="off" spellcheck="false" placeholder="Search…" aria-label="Filter options"></div>
      <div id="picker-list" role="listbox" aria-label="Options"></div>
      <div id="picker-empty" hidden></div>
      <div id="picker-error" role="alert" hidden></div>
      <div id="picker-confirm" hidden>
        <div class="confirm-icon">!</div>
        <h3>Restore this checkpoint?</h3>
        <p id="picker-confirm-text"></p>
        <p class="confirm-note">Changes made after this point will be discarded. A safety snapshot is created first, so this restore is reversible.</p>
        <div class="confirm-actions"><button id="picker-cancel" class="secondary-button">Cancel</button><button id="picker-rollback" class="danger-button">Restore checkpoint</button></div>
      </div>
      <div class="picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div>
    </section>
  </div>
  <div id="notice" hidden></div>
  <div id="autocomplete" hidden></div>
  <footer>
    <div class="composer">
      <textarea id="input" rows="1" aria-label="Message pi"
        placeholder="Ask pi to build, fix or explain…"></textarea>
      <div class="composer-bottom">
        <div class="composer-hints"><span><kbd>@</kbd> files</span><span><kbd>/</kbd> commands</span></div>
        <div class="composer-actions">
          <button id="btn-stop" class="stop-button" title="Stop current run" hidden><span>■</span> Stop</button>
          <button id="btn-send" title="Send message" aria-label="Send message" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 11-6-3.4 12-2.6-4.8L4 10Z" fill="currentColor" stroke="currentColor" stroke-width=".6" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
    </div>
    <div class="footer-meta"><span id="stats" title="Session tokens · context usage · cost">Ready</span><span class="send-hint">Enter to send · Shift + Enter for a new line</span></div>
  </footer>
  <script nonce="${nonce}" src="${mdJs}"></script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Path shown in tool activity rows: workspace-relative when possible. */
function displayPath(cwd, file) {
  const base = cwd || process.cwd();
  if (file.startsWith(base + path.sep)) return file.slice(base.length + 1);
  return path.basename(file);
}

/** Extract text from a tool result / partial result for display. */
function resultText(result) {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  if (text.length > TOOL_OUTPUT_LIMIT) return text.slice(0, TOOL_OUTPUT_LIMIT) + "\n… (truncated)";
  return text;
}

/** Generate a random nonce for webview CSP. */
function getNonce() {
  const crypto = require("crypto");
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { PiChatProvider, resultText };
