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
- Streaming replies (text + collapsible thinking)
- Tool calls shown as live blocks (`read` / `bash` / `edit` / `write` …) with an
  **↔ diff** button on file edits (HEAD ↔ working tree, via the built-in git
  extension)
- Abort (■ Stop), new session (＋ New), restart (↻)
- **In-panel picker** — model, thinking level, sessions and checkpoints open as
  searchable panels inside the chat, without leaving the sidebar
- **Model switcher** — click the model name in the header (live `set_model`)
- **Thinking level** (⚡ header chip) — Codex-style reasoning effort picker
- **Editor context** — ✎ button or `pi: Add Selection/File to Chat` inserts the
  active selection / file into the input as a fenced snippet
- **Keyboard shortcuts** — `Ctrl+Shift+;` focuses the panel,
  `Ctrl+Shift+'` adds the active selection to the input (mac: `⌘` variants)
- **@-mention files** — type `@` in the input for workspace-file autocomplete;
  referenced files are inlined into the prompt on send
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
- Sessions are saved by pi as usual — reopen one with `pi --resume` in a
  terminal, or enable `pi-agent-panel.continue`

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
webview.js        Chat UI: session tabs, rendering, autocomplete, streaming
markdown.js       Minimal markdown renderer (shared with the unit tests)
webview.css       VS Code theme-aware styles
test/smoke.js      Headless protocol check (get_state only, no LLM call)
test/unit.js       Unit tests for pure functions (no pi needed)
test/checkpoints.js  Checkpoint store integration test (temp git repo)
test/webview-sessions.js  Frontend tests: scoped streams, tabs, pickers (node --test)
```
