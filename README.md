# pi-agent-panel

Run the [pi coding agent](https://pi.dev) in a VS Code sidebar.

The extension spawns `pi --mode rpc` as a subprocess in your workspace and
proxies its [JSONL RPC protocol](https://github.com/badlogic/pi-mono) to a
webview chat panel. No build step, no npm dependencies — plain CommonJS.

## Install

Download the latest `pi-agent-panel-*.vsix` from
[**Releases**](https://github.com/lwssg182/pi-agent-panel/releases), then:

```bash
code --install-extension pi-agent-panel-<version>.vsix
```

Prerequisite: `pi` installed and logged in (see below).

## What you get

- Chat panel in the activity bar (icon: `>_`) with **parallel sessions** —
  up to 6 independent pi conversations as tabs, each with its own process,
  prompt queue and session file; the first prompt names the tab, a shared
  status bar aggregates progress (`$(sync~spin) pi: 2 working`), and
  checkpoint rollback waits until all sessions are idle and locks the
  workspace meanwhile
- Streaming replies (text + collapsible thinking) — incremental markdown
  rendering keeps selection stable during long replies
- Tool calls shown as live blocks (`read` / `bash` / `edit` / `write` …) with an
  **↔ diff** button on file edits — it diffs the working tree against the
  checkpoint taken just before the turn (i.e. what the turn changed),
  falling back to HEAD when no checkpoint exists
- Abort (■ Stop), new session (＋ New), restart (↻)
- **In-panel picker** — model, thinking level, sessions and checkpoints open as
  searchable panels inside the chat, without leaving the sidebar
- **Model switcher** — click the model name in the header (live `set_model`)
- **Thinking level** (⚡ header chip) — Codex-style reasoning effort picker
- **Editor context** — ✎ button or `pi: Add Selection/File to Chat` inserts the
  active selection / file into the input as a fenced snippet
- **Keyboard shortcuts** — `Ctrl+Shift+;` focuses the panel,
  `Ctrl+Shift+'` adds the active selection to the input (mac: `⌘` variants)
- **@-mention files** — type `@` in the input for workspace-file autocomplete.
  Unicode and spaces are supported (e.g. `@"docs/中文 notes.md"`);
  referenced files are inlined into the prompt on send. References inside
  fenced code blocks are treated as literal text.
- **Drag files into the draft** — drop onto **Drop files → Drop files here →
  current draft**, below Chat. This is a native VS Code drop area: Explorer,
  editor tabs and OS file drags bypass the webview's cross-site drag restriction,
  **without Shift**. If Explorer and pi share one sidebar, hover the pi activity
  icon while dragging to reveal the destination, then drop onto the row.
  The drop-area header shows the receiving task. The paperclip next to Send
  also opens a multi-file picker. Paths become `@` references;
  for direct browser drops where the path is hidden, supplied text becomes a
  fenced snippet instead. No files are copied into the workspace and nothing is
  sent automatically. Drops stay with their original session if you switch tabs.
  UTF-8 text/code only: up to 20 files, 200 KiB per file and 1 MiB per drop;
  context is limited to the first 300 lines per file. Directories, images, PDFs,
  binary/non-UTF-8 and oversized files are skipped with a visible explanation.
- **Slash commands** — type `/` for autocomplete. Built-in commands run in the
  extension (pi's own TUI built-ins don't execute over RPC):

  | Command | Action |
  |---|---|
  | `/model` | Switch the model |
  | `/thinking` | Thinking level (reasoning effort) |
  | `/session` | Resume a previous session of this workspace |
  | `/new` | Start a new parallel task (new tab) |
  | `/compact` | Compact the context now |
  | `/clear` | Clear the chat display (session is kept) |
  | `/rollback` | Roll the working tree back to a git checkpoint |
  | `/context` | Attach the active editor selection / file |
  | `/stats` | Show usage: tokens · context · cost |
  | `/stop` | Abort the current run |
  | `/restart` | Restart the pi process |
  | `/settings` | Open the extension's settings |
  | `/help` | List commands and tips |

  Skills (`/skill:…`), prompt templates and pi extension commands from
  `get_commands` are shown alongside (tagged `[skill]`/`[template]`/`[ext]`)
  and executed by pi itself.
- **Session history** — 🕘 button lists this workspace's sessions (first message
  preview, message count); resuming replays the transcript in the panel
- **Copy / resume session ID** — the `•••` menu's **Copy session ID** copies
  pi's real session ID (not the panel's tab number), with a visible confirmation.
  After reopening the same workspace, choose **Resume by session ID**, paste the
  full ID, then continue chatting with the restored context. Lookup covers all
  saved sessions, including those older than the history list's newest 30.
  This restores conversation context only, not workspace files. New sessions
  become resumable after pi saves the first assistant response; copying an
  unsaved session warns about this. A terminal can also resume with
  `pi --session <id>`. IDs locate local files; they do not transfer chats to
  another machine. `PI_CODING_AGENT_DIR` is respected for session lookup.
- **Checkpoints / rollback** — in git repos every message snapshots the
  workspace tree (tracked + untracked, via plumbing commits that never touch
  your index/stash); the ⟲ button (or `pi: Roll Back to Checkpoint`) restores
  any of the last 50 snapshots, taking a safety snapshot first. Only the
  workspace folder is ever touched. Chat history is kept.
- **Background runs** — pi keeps running when the panel is hidden: a status
  bar item shows aggregate progress across tabs, and a notification fires
  when a run finishes while hidden
- **Usage stats** — tokens / context % / cost line with a ⇲ manual-compact
  button
- pi extension dialogs (`select` / `confirm` / `input` / `editor`) mapped to
  native VS Code quick picks and input boxes

## Requirements

- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) installed
  and authenticated (run `pi` once in a terminal to log in):

  ```bash
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  ```

- The `pi` binary must be findable: from your `PATH`, or at
  `~/.npm-global/bin/pi`, `/usr/local/bin/pi`, `/opt/homebrew/bin/pi`,
  `%APPDATA%\npm\pi.cmd` (Windows) — or set `pi-agent-panel.piPath` explicitly.
- Each user authenticates with their own `pi` login (credentials are not
  shared by installing the extension).

## Run it (development)

1. Open this folder in VS Code
2. Press **F5** ("Run pi extension") — an Extension Development Host opens
3. Click the `>_` icon in the activity bar
4. Chat

## Optional VS Code integration check

With Playwright installed separately and a desktop display available:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright \
VSCODE_EXECUTABLE=/path/to/code-electron-binary node test/vscode-files.js
```

This opens an isolated Extension Development Host with temporary user data and
workspace. By default it checks the real iframe drag gate, the Add files button's
host round trip/cancellation (stubbing only the OS dialog selection), and a
browser `File` drop dispatched within the webview. It does not send a prompt.

For **real mouse drags** on Linux/X11, add `PI_NATIVE_DRAG=1` (Python 3,
libX11/libXtst required). This checks repeated editor-tab drops, multi-selection
from Explorer (including hovering the pi icon to switch views), folder rejection,
UTF-8/spaces, preserved drafts, source files and post-drop input interactivity.
Add `PI_NATIVE_FILES=1` to also use a real GTK/XDND source (`/usr/bin/python3` with
GTK 3 / PyGObject): OS files into the native area without Shift, and into the
composer with Shift. `PI_DRAG_SCREENSHOT=/tmp/pi-drop.png` saves UI evidence.
These native routes were verified on VS Code 1.143.1 / Linux X11; other platforms
still need manual validation. The default run alone is **not** an OS-drag test.

## Package and install (development)

Packaging runs automatically in CI: pushing a tag (`git tag v0.4.2 && git push
origin v0.4.2`) builds the `.vsix` and attaches it to a GitHub Release.

To do it locally instead:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension pi-agent-panel-<version>.vsix
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `pi-agent-panel.piPath` | `""` | Path to the `pi` binary (empty = auto-detect) |
| `pi-agent-panel.provider` | `""` | Provider (e.g. `anthropic`, `openai`); empty = pi default |
| `pi-agent-panel.model` | `""` | Model (e.g. `anthropic/claude-sonnet-4`); empty = pi default |
| `pi-agent-panel.continue` | `false` | Pass `--continue` to resume the previous session |
| `pi-agent-panel.notifyOnFinish` | `true` | Notify when pi finishes a run while the panel is hidden |

### Checkpoint notes

- Snapshots are dangling commits (created with `git commit-tree`); they don't
  appear in your history or stash, but unreferenced objects can eventually be
  pruned by `git gc` (default: after ~2 weeks). The picker hides pruned ones.
- Rollback discards working-tree changes made after the checkpoint, but only
  inside the workspace folder (staged changes and new files included,
  gitignored files preserved; files outside the workspace are never touched).
  A safety
  snapshot of the current state is taken first, so a rollback is itself
  reversible. Chat history is not rewound — like Codex, only files are.

## Known limitations (skeleton scope)

- **Drop files is a native companion view, not the textarea itself.** VS Code
  1.140+ / affected Electron builds reject internal file drags across the chat
  iframe even with Shift ([upstream regression #339036](https://github.com/microsoft/vscode/issues/339036),
  [proposed fix #344153](https://github.com/microsoft/vscode/pull/344153)). The
  native area bypasses this route via the public TreeDragAndDropController API;
  it does not patch VS Code, disable isolation or require a downgrade. Direct
  OS-file drops into the composer can work with Shift; internal Explorer drags
  into the textarea remain dependent on the upstream fix. Native drops without
  an accessible file path show a warning instead of loading unbounded data.
- All sessions run in the **first workspace folder** (multi-root: first only)
- Up to 6 parallel sessions, each an independent pi process in the same folder;
  their checkpoints share one store, and rollback is global (workspace-wide
  lock, all sessions must be idle)
- Messages sent while the agent is streaming are queued locally and each one
  is checkpointed right before pi receives it (Stop returns unsent messages
  to the input)
- Tool output is truncated to ~4000 chars in the panel (full output stays in
  the pi session file)
- `setStatus` / `setWidget` / `setTitle` extension UI requests are ignored
- Sessions are saved by pi as usual — reopen one from **History** or
  **••• → Resume by session ID**, or use `pi --session <id>` in a terminal

## Layout

```
extension.js      Entry point: registers the webview provider and commands
multi-provider.js Multi-session provider: session tabs, shared status bar,
                  workspace rollback lock, webview bootstrap
chat-provider.js  SessionView (one tab): pi lifecycle, event mapping, dialogs
turn-queue.js     One-prompt-at-a-time queue: checkpoint → dispatch → settle
pi-rpc.js         RPC client: spawn pi, JSONL framing, request/response
checkpoints.js    Git checkpoint snapshots + rollback (workspace-scoped)
pickers.js        QuickPicks: model / thinking level / session resume
mentions.js       @-mention expansion into prompts
file-input.js     Shared quoted-reference syntax and drag payload extraction
file-drops.js     Read-only dropped-file validation and context preparation
native-file-drop.js Native workbench drop area and URI-list extraction
webview.js        Chat UI: session tabs, rendering, autocomplete, streaming
markdown.js       Minimal markdown renderer (shared with the unit tests)
webview.css       VS Code theme-aware styles
test/smoke.js      Headless protocol check (get_state only, no LLM call)
test/unit.js       Unit tests for pure functions (no pi needed)
test/checkpoints.js  Checkpoint store integration test (temp git repo)
test/file-drops.js  Drop payloads, quoting, validation and limits (node --test)
test/sessions.js  Host tests: real session ID copy, exact lookup and resume (node --test)
test/webview-sessions.js  Frontend tests: scoped streams, tabs, pickers, drops (node --test)
test/vscode-files.js  Optional real VS Code check (external Playwright, no LLM call)
test/vscode-sessions.js  Real VS Code + pi RPC copy/resume/reopen (external Playwright, no LLM call)
test/native-drag.py   Linux/X11 mouse/keyboard driver for actual file drags
test/native-file-source.py  GTK/XDND external file source for OS-drop tests
```
