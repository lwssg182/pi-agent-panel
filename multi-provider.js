"use strict";

const os = require("os");
const vscode = require("vscode");
const { CheckpointStore, isCheckpointHash } = require("./checkpoints");
const { SessionView } = require("./chat-provider");

const MAX_SESSIONS = 6;

class PiChatProvider {
  constructor(context, log) {
    this.context = context;
    this.log = log;
    this.view = null;
    this.sessions = new Map();
    this.activeId = null;
    this.nextId = 1;
    this.rollbackLock = false;
    this._webviewReady = false;

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.name = "pi";
    this.status.command = "piAgent.chat.focus";
    this.status.text = "$(hubot) pi";
    this.status.tooltip = "pi — click to open the chat panel";
    this.status.show();

    this.checkpoints = new CheckpointStore({
      cwd: null,
      workspaceState: context.workspaceState,
      log,
    });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.onDidReceiveMessage((m) => this._onMessage(m));
    const first = this._createSession();
    view.webview.html = first._html(view.webview);
    view.onDidDispose(() => this.dispose());
  }

  dispose() {
    for (const session of [...this.sessions.values()]) {
      session._stopClient().catch(() => {});
    }
    this.sessions.clear();
    this.activeId = null;
    this.status.dispose();
  }

  _workspaceCwd() {
    return (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || os.homedir();
  }

  _createSession() {
    const id = `s${this.nextId++}`;
    const self = this;
    const session = new SessionView(this.context, this.log, id, () => self._publishSessions(), () => {
      if (self.rollbackLock) return true;
      for (const s of self.sessions.values()) if (s !== session && s._isBusy()) return true;
      return false;
    }, {
      isParallel: true,
      isWorkspaceLocked: () => self.rollbackLock,
      status: this.status,
      checkpoints: this.checkpoints,
      onAggregate: () => self._aggregateStatus(),
    });
    session.view = this.view;
    session._webviewReady = this._webviewReady;
    this.sessions.set(id, session);
    this.activeId = id;
    return session;
  }

  _post(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  _postWorkspaceState() {
    this._post({ t: "workspace_state", locked: this.rollbackLock });
    this._publishSessions();
  }

  _publishSessions() {
    this._aggregateStatus();
    if (this.fileDropView) {
      const active = this.sessions.get(this.activeId);
      this.fileDropView.description = active ? active._title || `Task ${active.sessionId.slice(1)}` : "Open Chat first";
    }
    this._post({
      t: "sessions",
      activeId: this.activeId,
      maxSessions: MAX_SESSIONS,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.sessionId,
        label: s._title || `Task ${s.sessionId.slice(1)}`,
        busy: s._isBusy(),
        streaming: s.streaming,
        queued: s.turns.pendingCount,
      })),
    });
  }

  _aggregateStatus() {
    const list = [...this.sessions.values()];
    const working = list.filter((s) => s._isBusy()).length;
    if (working > 0) {
      this.status.text = `$(sync~spin) pi: ${working} working`;
      this.status.tooltip = `${working} pi session(s) running — click to open`;
    } else {
      this.status.text = `$(hubot) pi (${list.length})`;
      this.status.tooltip = "pi — click to open the chat panel";
    }
  }

  async _onMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "ready":
        this._webviewReady = true;
        for (const s of this.sessions.values()) {
          s.view = this.view;
          s._webviewReady = true;
          s._ensureClient();
          s._initializeClient();
        }
        this._publishSessions();
        return;

      case "new_tab": {
        if (this.sessions.size >= MAX_SESSIONS || this.rollbackLock) {
          this._post({
            t: "error",
            sessionId: this.activeId,
            message: this.rollbackLock
              ? "Workspace restore in progress — wait for it to finish."
              : `You can run up to ${MAX_SESSIONS} parallel sessions.`,
          });
          return;
        }
        const session = this._createSession();
        // Publish the roster BEFORE initializing: the session's cleared/replay
        // messages must never overtake the tab that will receive them.
        this._publishSessions();
        session._ensureClient();
        session._initializeClient();
        return;
      }

      case "switch_tab": {
        const target = this.sessions.get(message.sessionId);
        if (!target) return;
        this.activeId = message.sessionId;
        this._publishSessions();
        return;
      }

      case "close_tab": {
        const session = this.sessions.get(message.sessionId);
        if (!session) return;
        if (session._isBusy()) {
          const label = session._title || `Task ${session.sessionId.slice(1)}`;
          const choice = await vscode.window.showWarningMessage(
            `“${label}” is still running. Stop it and close this session?`,
            { modal: true },
            "Stop & close"
          );
          if (choice !== "Stop & close") return;
        }
        await session._abort();
        await session._stopClient();
        this.sessions.delete(message.sessionId);
        if (this.activeId === message.sessionId) {
          this.activeId = [...this.sessions.keys()].at(-1) || null;
        }
        if (!this.activeId && this.sessions.size < MAX_SESSIONS) {
          const replacement = this._createSession();
          this._publishSessions();
          replacement._ensureClient();
          replacement._initializeClient();
        }
        this._publishSessions();
        return;
      }

      case "choose_checkpoint": {
        const session = this.sessions.get(message.sessionId);
        if (!session) return;
        await this._rollbackWithLock(session, message.hash, message.prompt, message.requestId);
        return;
      }
    }

    const session = this.sessions.get(message.sessionId);
    if (!session) return;
    if (this.rollbackLock && !["open_settings", "open_link", "copy_text", "copy_session_id", "list_files", "drop_files", "choose_files", "switch_tab", "abort"].includes(message.t)) {
      this._post({
        t: "error",
        sessionId: message.sessionId || this.activeId,
        message: "Workspace restore in progress — wait for it to finish.",
      });
      return;
    }

    if (session.view !== this.view) session.view = this.view;
    return session._onFromWebview(message);
  }

  async _rollbackWithLock(session, hash, prompt, requestId) {
    if (this.rollbackLock) {
      session._pickerError("Another workspace restore is already running.", requestId, "checkpoint");
      return;
    }
    for (const s of this.sessions.values()) {
      if (s._isBusy()) {
        session._pickerError("Wait for all running sessions to finish before rolling back.", requestId, "checkpoint");
        return;
      }
    }
    if (!isCheckpointHash(hash)) return;
    this.rollbackLock = true;
    this._postWorkspaceState();
    try {
      await this.checkpoints.rollback(hash);
      session._post({ t: "picker_done", kind: "checkpoint", requestId });
      session._post({
        t: "info",
        text: `Workspace files restored to before “${String(prompt || "checkpoint").slice(0, 60)}”`,
      });
    } catch (err) {
      session._pickerError(`Rollback failed: ${err.message}`, requestId, "checkpoint");
    } finally {
      this.rollbackLock = false;
      this._postWorkspaceState();
    }
  }

  /** Capture the native drop's owner before awaiting the workbench transfer. */
  async addNativeFiles(readEntries, token) {
    const session = this.sessions.get(this.activeId);
    const view = this.view;
    if (token.isCancellationRequested) return;
    if (!session || !view || !this._webviewReady) {
      vscode.window.showInformationMessage("pi: open Chat before dropping files.");
      return;
    }
    const alive = () => !token.isCancellationRequested && this.view === view && this.sessions.get(session.sessionId) === session;
    try {
      const result = await readEntries();
      if (alive()) session._post({ t: "native_drop", ...result });
    } catch (error) {
      if (alive()) session._post({ t: "info", text: `Files not added: ${error.message}` });
    }
  }

  /** Extension commands act on the selected session tab. */
  addEditorContext(mode) {
    const session = this.sessions.get(this.activeId);
    if (!session) {
      vscode.window.showInformationMessage("pi: no active chat session.");
      return;
    }
    session.addEditorContext(mode);
  }

  /** Command entry point: open the checkpoint list inside the pi panel. */
  async pickCheckpoint() {
    if (this.view && typeof this.view.show === "function") this.view.show(true);
    else await vscode.commands.executeCommand("piAgent.chat.focus").catch(() => {});
    if (!this.sessions.has(this.activeId)) return;
    this._post({ t: "open_picker", kind: "checkpoint", sessionId: this.activeId });
  }
}

module.exports = { PiChatProvider };
