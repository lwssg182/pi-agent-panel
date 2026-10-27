"use strict";

/**
 * Git checkpoints: snapshot the exact working-tree state (tracked +
 * untracked, deletions) into dangling commits via git plumbing, so any turn
 * can be rolled back. Never touches the user's index, stash, or history.
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
  /**
   * @param {object} opts
   * @param {string|null} opts.cwd            Repo root (set via reset()).
   * @param {object} opts.workspaceState      vscode workspace state (persistence).
   * @param {object} opts.log                 OutputChannel-like { debug, warn }.
   */
  constructor({ cwd, workspaceState, log }) {
    this.cwd = cwd;
    this.workspaceState = workspaceState;
    this.log = log;
    this._isRepo = null;
    this._pending = [];
    this._saved = workspaceState.get("piCheckpoints") || [];
  }

  /** New pi process: new cwd, drop the repo probe and pending snapshots. */
  reset(cwd) {
    this.cwd = cwd;
    this._isRepo = null;
    this._pending = [];
  }

  async checkIsRepo() {
    if (this._isRepo !== null) return this._isRepo;
    try {
      await git(this.cwd, ["rev-parse", "--git-dir"]);
      this._isRepo = true;
    } catch (_) {
      this._isRepo = false;
    }
    return this._isRepo;
  }

  /**
   * Snapshot the working tree into a dangling commit via git plumbing.
   * Uses a throwaway index file; the user's index is never touched.
   */
  async snapshot() {
    const cwd = this.cwd;
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
  async beforeTurn(prompt) {
    if (!(await this.checkIsRepo())) return;
    try {
      const hash = await this.snapshot();
      const prev = this._pending[this._pending.length - 1];
      if (!prev || prev.hash !== hash) {
        this._pending.push({ hash, prompt, time: Date.now() });
      }
    } catch (err) {
      this.log.warn("Checkpoint snapshot failed: " + err.message);
    }
  }

  /** Move pending snapshots into the persisted list (capped). */
  commitPending() {
    if (this._pending.length) {
      this._saved = this._saved.concat(this._pending).slice(-MAX_CHECKPOINTS);
      this._pending = [];
    }
    this.workspaceState.update("piCheckpoints", this._saved);
  }

  /** Valid (non-gc'd) checkpoints, newest first. */
  async entries() {
    const out = [];
    for (const cp of this._saved.slice().reverse().slice(0, MAX_CHECKPOINTS)) {
      // Drop checkpoints whose commit object no longer exists (gc'd).
      try {
        await git(this.cwd, ["cat-file", "-e", `${cp.hash}^{commit}`]);
      } catch (_) {
        continue;
      }
      out.push(cp);
    }
    return out;
  }

  /** Roll the working tree back to `hash`; a safety snapshot is taken first. */
  async rollback(hash) {
    const safety = await this.snapshot();
    this._saved.push({ hash: safety, prompt: "(state before rollback)", time: Date.now() });
    this.commitPending();
    await git(this.cwd, ["read-tree", "-u", "--reset", hash]);
    await git(this.cwd, ["clean", "-fd"]);
  }
}

module.exports = { CheckpointStore, git, MAX_CHECKPOINTS };
