"use strict";

/**
 * CheckpointStore integration test: runs against a throwaway git repo in a
 * temp dir. Exercises snapshot -> modify -> rollback end to end.
 *
 * Usage: node test/checkpoints.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { CheckpointStore } = require("../checkpoints");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-test-"));
git(dir, ["init", "-q"]);
git(dir, ["config", "user.email", "test@local"]);
git(dir, ["config", "user.name", "test"]);
fs.writeFileSync(path.join(dir, "a.txt"), "one");
git(dir, ["add", "-A"]);
git(dir, ["commit", "-q", "-m", "init"]);

const state = (() => {
  let data;
  return {
    get: () => data,
    update: (_k, v) => {
      data = v;
    },
  };
})();
const log = { debug() {}, warn(e) { console.error("warn:", e.message); } };
const store = new CheckpointStore({ cwd: dir, workspaceState: state, log });

async function main() {
  // Repo detection.
  assert.strictEqual(await store.checkIsRepo(), true);

  // Two snapshots on the same unmodified tree are deduped while pending.
  await store.beforeTurn("first message");
  await store.beforeTurn("same tree");
  store.commitPending();
  const entries = await store.entries();
  assert.strictEqual(entries.length, 1, "one checkpoint for the unchanged tree");
  const hash = entries[0].hash;
  assert.ok(/^[0-9a-f]{40}$/.test(hash), "checkpoint is a commit hash");

  // Modify tracked + add untracked, then roll back.
  fs.writeFileSync(path.join(dir, "a.txt"), "two");
  fs.writeFileSync(path.join(dir, "new.txt"), "untracked");
  await store.rollback(hash);

  assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one", "tracked file restored");
  assert.ok(!fs.existsSync(path.join(dir, "new.txt")), "untracked file removed by clean");
  assert.ok(state.get().length >= 2, "safety snapshot persisted");

  // The rollback itself is reversible (safety snapshot is a valid entry).
  const after = await store.entries();
  assert.ok(after.length >= 1, "safety snapshot listed");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
