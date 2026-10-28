"use strict";

/**
 * Git checkpoints: snapshot workspace files into dangling commits. Snapshot
 * creation never touches the user's index, stash, or history. Restoration is
 * explicitly scoped to cwd, which may be a subdirectory of a larger repo.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_CHECKPOINTS = 50;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-checkpoint",
  GIT_AUTHOR_EMAIL: "pi@local",
  GIT_COMMITTER_NAME: "pi-checkpoint",
  GIT_COMMITTER_EMAIL: "pi@local",
};

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

class CheckpointStore {
  constructor({ cwd, workspaceState, log }) {
    this.cwd = cwd;
    this.workspaceState = workspaceState;
    this.log = log;
    this._isRepo = null;
    this._operations = Promise.resolve();
    const saved = workspaceState.get("piCheckpoints");
    this._saved = Array.isArray(saved) ? saved.slice(-MAX_CHECKPOINTS) : [];
  }

  reset(cwd) {
    this.cwd = cwd;
    this._isRepo = null;
  }

  /** Serialize snapshots, persistence, listing and restores; never reuse an index. */
  _run(operation) {
    const cwd = this.cwd;
    const result = this._operations.then(() => operation(cwd));
    this._operations = result.catch(() => {});
    return result;
  }

  async checkIsRepo(cwd = this.cwd) {
    if (!cwd) return false;
    if (this._isRepo && this._isRepo.cwd === cwd) return this._isRepo.value;
    let value = false;
    try {
      value = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    } catch (_) {
      /* not a working tree, or git unavailable */
    }
    if (cwd === this.cwd) this._isRepo = { cwd, value };
    return value;
  }

  /** Internal, called only while holding the operation queue. */
  async _snapshot(cwd) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-index-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    try {
      // Empty seed: the snapshot tree contains exactly the paths under cwd
      // (index paths are repo-root-relative, pathspec "." is cwd-scoped), so
      // the tree hash is a precise fingerprint of the workspace content and
      // nothing outside it leaks into checkpoints.
      await git(cwd, ["read-tree", "--empty"], env);
      await git(cwd, ["add", "-A", "--", "."], env);
      const tree = (await git(cwd, ["write-tree"], env)).trim();
      let hash;
      try {
        hash = (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "pi checkpoint"], GIT_IDENTITY)).trim();
      } catch (_) {
        hash = (await git(cwd, ["commit-tree", tree, "-m", "pi checkpoint"], GIT_IDENTITY)).trim();
      }
      return { hash, tree };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  snapshot() {
    return this._run(async (cwd) => (await this._snapshot(cwd)).hash);
  }

  _inScope(cp, cwd) {
    // Entries from older versions have no cwd; workspaceState already scopes
    // them to this VS Code workspace. All new entries record their exact scope.
    return cp && isCheckpointHash(cp.hash) && (!cp.cwd || cp.cwd === path.resolve(cwd));
  }

  async _save(cwd, snapshot, prompt) {
    const entry = { ...snapshot, cwd: path.resolve(cwd), prompt, time: Date.now() };
    const saved = this._saved.concat(entry).slice(-MAX_CHECKPOINTS);
    // A safety snapshot must be discoverable after a crash BEFORE changing files.
    await this.workspaceState.update("piCheckpoints", saved);
    this._saved = saved;
    return entry;
  }

  /** Persist before dispatching a prompt, not at agent_settled. Fail closed. */
  beforeTurn(prompt) {
    return this._run(async (cwd) => {
      if (!(await this.checkIsRepo(cwd))) return null;
      const snapshot = await this._snapshot(cwd);
      const prev = this._saved.slice().reverse().find((cp) => this._inScope(cp, cwd));
      if (prev) {
        try {
          const tree = (await git(cwd, ["rev-parse", `${prev.hash}^{tree}`])).trim();
          if (tree === snapshot.tree) return prev;
        } catch (_) {
          /* old snapshot was pruned; persist the newly created one */
        }
      }
      return this._save(cwd, snapshot, prompt);
    });
  }

  /** Valid (non-gc'd) checkpoints for this workspace, newest first. */
  entries() {
    return this._run(async (cwd) => {
      if (!cwd) return [];
      const out = [];
      for (const cp of this._saved.slice().reverse()) {
        if (!this._inScope(cp, cwd)) continue;
        try {
          await git(cwd, ["cat-file", "-e", `${cp.hash}^{commit}`]);
          out.push(cp);
        } catch (_) {
          /* pruned by git gc */
        }
      }
      return out;
    });
  }

  /** Restore only cwd, leaving siblings' files AND staged changes untouched. */
  rollback(hash) {
    return this._run(async (cwd) => {
      if (!this._saved.some((cp) => this._inScope(cp, cwd) && cp.hash === hash)) {
        throw new Error("Checkpoint is not available for this workspace.");
      }
      await git(cwd, ["cat-file", "-e", `${hash}^{commit}`]);

      // Capture the cleanup candidates BEFORE restoring .gitignore. Otherwise
      // files that were ignored before the restore could be deleted without
      // ever having been included in the safety snapshot.
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))
        .split("\0").filter(Boolean);
      const safety = await this._snapshot(cwd);
      await this._save(cwd, safety, "(state before rollback)");

      const tracked = await git(cwd, ["ls-files", "-z", "--", "."]);
      const target = await git(cwd, ["ls-tree", "-r", "--name-only", "-z", hash, "--", "."]);
      // An empty workspace/empty checkpoint has no pathspec for git restore.
      if (tracked || target) {
        await git(cwd, ["restore", `--source=${hash}`, "--staged", "--worktree", "--", "."]);
      }
      for (let i = 0; i < untracked.length; i += 50) {
        await git(cwd, ["clean", "-fd", "--", ...untracked.slice(i, i + 50)], { GIT_LITERAL_PATHSPECS: "1" });
      }
      return safety.hash;
    });
  }
}

function isCheckpointHash(hash) {
  return typeof hash === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash);
}

module.exports = { CheckpointStore, git, MAX_CHECKPOINTS, isCheckpointHash };
