"use strict";

const vscode = require("vscode");
const { MAX_DROP_FILES, MAX_DROP_BYTES } = require("./file-input");

// Native workbench trees receive Explorer/editor drops even on Electron builds
// that reject same-window cross-site iframe drops (microsoft/vscode#339036).
// Use only the public TreeDragAndDropController API, never patch the workbench.
function registerFileDropView(provider) {
  const tree = vscode.window.createTreeView("piAgent.files", {
    treeDataProvider: {
      getChildren: () => ["drop"],
      getTreeItem: () => {
        const item = new vscode.TreeItem("Drop files here → current draft");
        item.iconPath = new vscode.ThemeIcon("files");
        item.tooltip = "Drag files from Explorer, editor tabs, or your file manager. No Shift needed. UTF-8 text/code only; never auto-sends.";
        return item;
      },
    },
    dragAndDropController: {
      dropMimeTypes: ["text/uri-list", "files"],
      dragMimeTypes: [],
      handleDrop: (_target, transfer, token) => provider.addNativeFiles(() => readNativeFiles(transfer, token), token),
    },
  });
  provider.fileDropView = tree;
  return tree;
}

async function readNativeFiles(transfer, token) {
  const entries = [], warnings = [], seen = new Set();
  const addUri = (uri) => {
    if (!uri || seen.has(uri) || entries.length > MAX_DROP_FILES) return;
    seen.add(uri);
    entries.push({ uri });
  };
  // VS Code normalizes Explorer/editor-tab drops to this documented MIME type.
  // Read only resource identifiers here; contents go through file-drops.js.
  const list = transfer.get("text/uri-list");
  if (list) {
    const value = await list.asString();
    if (token.isCancellationRequested) return { entries: [], warnings: [] };
    if (typeof value !== "string" || value.length > MAX_DROP_BYTES) throw new Error("File list is too large or invalid.");
    for (const line of value.split(/\r?\n/)) {
      const uri = line.trim();
      if (uri && !uri.startsWith("#")) addUri(uri);
      if (entries.length > MAX_DROP_FILES) break; // Keep one extra so validation reports the count limit.
    }
  }
  for (const [, item] of transfer) {
    if (token.isCancellationRequested || entries.length > MAX_DROP_FILES) break;
    const file = item.asFile();
    if (!file) continue;
    if (file.uri) addUri(file.uri.toString());
    else if (warnings.length < MAX_DROP_FILES) {
      // data() has no bounded-read API or size metadata. Don't load arbitrary
      // native attachments into memory just to discover that they're too big.
      warnings.push(`${file.name || "File"}: no accessible path; use Add files or drop it directly into the chat.`);
    }
  }
  if (!entries.length && !warnings.length) warnings.push("No file paths received. Drag a file from Explorer, an editor tab, or your file manager.");
  return { entries, warnings };
}

module.exports = { registerFileDropView, readNativeFiles };
