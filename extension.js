"use strict";

/**
 * pi — Coding Agent, in a VS Code sidebar.
 *
 * Entry point. The webview provider lives in chat-provider.js; git
 * checkpoints, QuickPicks and @-mention expansion each have their own
 * module. No build step: plain CommonJS.
 */

const vscode = require("vscode");
const { PiChatProvider } = require("./multi-provider");
const { registerFileDropView } = require("./native-file-drop");

let provider;
let log;

function activate(context) {
  log = vscode.window.createOutputChannel("pi", { log: true });
  context.subscriptions.push(log);
  provider = new PiChatProvider(context, log);
  context.subscriptions.push(
    registerFileDropView(provider),
    vscode.window.registerWebviewViewProvider("piAgent.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pi-agent-panel.addSelection", () => provider.addEditorContext("selection")),
    vscode.commands.registerCommand("pi-agent-panel.addFile", () => provider.addEditorContext("file")),
    vscode.commands.registerCommand("pi-agent-panel.rollback", () => provider.pickCheckpoint())
  );
}

function deactivate() {
  if (provider) provider.dispose();
}

module.exports = { activate, deactivate };
