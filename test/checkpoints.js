"use strict";

/**
 * CheckpointStore integration tests: run against throwaway git repos in temp
 * dirs. Exercises beforeTurn -> modify -> rollback end to end, including
 * rollback scoping when the workspace is a subdirectory of a larger repo.
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

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@local"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

function makeState() {
  let data;
  return {
    get: () => data,
    update: (_k, v) => {
      data = v;
    },
  };
}
const log = { debug() {}, warn(e) { console.error("warn:", e.message); } };

async function testRootRepo() {
  const dir = makeRepo();
  const state = makeState();
  const store = new CheckpointStore({ cwd: dir, workspaceState: state, log });
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  assert.strictEqual(await store.checkIsRepo(), true);

  // Two snapshots on the same unmodified tree: the second returns the same
  // checkpoint (deduped against the previously persisted tree).
  const first = await store.beforeTurn("first message");
  assert.ok(/^[0-9a-f]{40}$/.test(first.hash), "checkpoint is a commit hash");
  const second = await store.beforeTurn("same tree");
  assert.strictEqual(second.hash, first.hash, "unchanged tree deduped");

  const entries = await store.entries();
  assert.strictEqual(entries.length, 1, "one checkpoint for the unchanged tree");
  const hash = entries[0].hash;

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
}

async function testSubdirScope() {
  const repo = makeRepo();
  const state = makeState();
  const workspace = path.join(repo, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "original\n");
  fs.writeFileSync(path.join(repo, "sibling.txt"), "original\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const store = new CheckpointStore({ cwd: workspace, workspaceState: state, log });
  const checkpoint = await store.beforeTurn("before agent edit");
  assert.ok(checkpoint, "checkpoint created for subdir workspace");

  // Agent-style change inside the workspace + user work outside it.
  fs.writeFileSync(path.join(workspace, "a.txt"), "agent edit\n");
  fs.writeFileSync(path.join(repo, "sibling.txt"), "uncommitted user work\n");

  await store.rollback(checkpoint.hash);

  assert.strictEqual(
    fs.readFileSync(path.join(workspace, "a.txt"), "utf8"),
    "original\n",
    "workspace file restored"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(repo, "sibling.txt"), "utf8"),
    "uncommitted user work\n",
    "file outside the workspace is untouched"
  );

  // The safety snapshot only ever captured the workspace scope.
  const safety = state.get().find((cp) => cp.prompt === "(state before rollback)");
  assert.ok(safety, "safety snapshot persisted");
  const safetyFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", safety.hash], {
    cwd: repo, encoding: "utf8",
  });
  assert.ok(!safetyFiles.includes("sibling.txt"), "safety snapshot is scoped to the workspace");

  fs.rmSync(repo, { recursive: true, force: true });
}

async function testIgnoreEdge() {
  const dir = makeRepo();
  const state = makeState();
  const store = new CheckpointStore({ cwd: dir, workspaceState: state, log });
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  const hash = (await store.beforeTurn("baseline")).hash;

  // Roll back to the baseline after the agent edits .gitignore and creates a
  // log file. Gitignored files are preserved by rollback (documented
  // behavior), and that holds even when the file only becomes ignored after
  // the restored .gitignore lands.
  fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
  fs.writeFileSync(path.join(dir, "run.log"), "log data\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  await store.rollback(hash);

  assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one", "tracked file restored");
  assert.ok(!fs.existsSync(path.join(dir, ".gitignore")), "file absent from checkpoint is removed");
  assert.strictEqual(fs.readFileSync(path.join(dir, "run.log"), "utf8"), "log data\n", "gitignored file preserved");
  const safety = state.get().find((cp) => cp.prompt === "(state before rollback)");
  const hasLog = execFileSync("git", ["ls-tree", "-r", "--name-only", safety.hash], { cwd: dir, encoding: "utf8" });
  assert.ok(!hasLog.includes("run.log"), "ignored file is not part of snapshots (as before)");

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  await testRootRepo();
  await testSubdirScope();
  await testIgnoreEdge();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
