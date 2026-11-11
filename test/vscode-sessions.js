"use strict";

// Optional real VS Code + real pi RPC integration. Uses isolated config/session
// files and never sends a prompt, calls a model or touches the real workspace.
// PLAYWRIGHT_MODULE=/path/to/playwright VSCODE_EXECUTABLE=/path/to/code node test/vscode-sessions.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
  assert.ok(process.env.VSCODE_EXECUTABLE, "Set VSCODE_EXECUTABLE to the Electron binary");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vscode-sessions-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(agentDir, "sessions", safe);
  fs.mkdirSync(cwd);
  const workspaceFile = path.join(cwd, "keep.txt");
  fs.writeFileSync(workspaceFile, "workspace content must stay unchanged\n");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "user/User"), { recursive: true });
  fs.writeFileSync(path.join(root, "user/User/settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "window.restoreWindows": "none",
    "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true,
  }));
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const file = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "message", id: "11111111", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "Remember the previous task" }], timestamp: Date.now() } },
    { type: "message", id: "22222222", parentId: "11111111", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Previous context restored from saved pi session" }],
        api: "anthropic-messages", provider: "anthropic", model: "test-fixture", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const original = fs.readFileSync(file, "utf8");
  let app;
  try {
    for (let run = 0; run < 2; run++) {
      console.log(`Session integration: window ${run + 1}`);
      app = await electron.launch({
        executablePath: process.env.VSCODE_EXECUTABLE,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE_|ELECTRON_)/.test(key))),
          PI_CODING_AGENT_DIR: agentDir },
        args: ["--no-sandbox", "--disable-gpu", "--skip-welcome", "--skip-release-notes",
          `--user-data-dir=${root}/user`, `--extensions-dir=${root}/extensions`,
          `--extensionDevelopmentPath=${path.resolve(__dirname, "..")}`, cwd],
        timeout: 60000,
      });
      const page = await app.firstWindow();
      const waitFor = async (check) => {
        for (let n = 0; n < 200; n++) {
          if (await check()) return;
          await page.waitForTimeout(100);
        }
        console.error("Pi icon:", await page.locator('.activitybar a[aria-label="pi"]').evaluate((node) => node.parentElement.outerHTML));
        console.error("Frames:", page.frames().map((candidate) => candidate.url()));
        console.error("Window content:", (await page.locator("body").innerText()).slice(-3000));
        throw new Error("Timed out waiting for session ID action");
      };
      const piIcon = page.locator('.activitybar a[aria-label="pi"]');
      await piIcon.waitFor({ timeout: 60000 });
      let frame;
      await waitFor(async () => {
        frame = page.frames().find((candidate) => candidate.url().includes("/fake.html"));
        if (!frame && await piIcon.locator("..").getAttribute("aria-selected") !== "true") await piIcon.click();
        return frame && await frame.locator("#btn-copy-session-id").isEnabled().catch(() => false);
      });
      const action = async (button) => {
        await frame.locator("#btn-more").click();
        await frame.locator(button).click();
      };
      const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
      if (run === 0) {
        await app.evaluate(({ clipboard }) => clipboard.writeText("before-copy"));
        await frame.locator("#input").fill("keep this unsent draft");
        await action("#btn-copy-session-id");
        await waitFor(async () => (await readClipboard()) !== "before-copy");
        const newId = await readClipboard();
        assert.match(newId, /^[0-9a-f-]{36}$/i);
        assert.notEqual(newId, "s1");
        assert.notEqual(newId, id);
        await waitFor(async () => /not saved yet/.test(await frame.locator("#session-content").innerText()));
        assert.equal(await frame.locator("#input").inputValue(), "keep this unsent draft");
      }
      await action("#btn-resume-session-id");
      const nativeInput = page.locator(".quick-input-widget input");
      await nativeInput.waitFor({ state: "visible" });
      await nativeInput.fill(id);
      await nativeInput.press("Enter");
      await waitFor(async () => (await frame.locator("#session-content").innerText()).includes("Previous context restored"));
      await waitFor(() => frame.locator("#btn-copy-session-id").isEnabled());
      const beforeCopy = fs.readFileSync(file, "utf8");
      await action("#btn-copy-session-id");
      await waitFor(async () => (await readClipboard()) === id);
      assert.equal(fs.readFileSync(file, "utf8"), beforeCopy, "copy is read-only");
      assert.equal(await frame.locator(".msg.user").count(), 1, "only the saved user message, never a new prompt");
      assert.equal(await frame.locator(".msg.assistant").count(), 1);
      if (run === 0) {
        assert.equal(await frame.locator("#input").inputValue(), "keep this unsent draft");
        await action("#btn-resume-session-id");
        await nativeInput.waitFor({ state: "visible" });
        await nativeInput.fill("missing-session-id");
        await nativeInput.press("Enter");
        await waitFor(async () => (await frame.locator("#session-content").innerText()).includes("No saved session"));
        assert.equal(await frame.locator(".msg.assistant").count(), 1, "failed lookup must keep the conversation");
        await action("#btn-resume-session-id");
        await nativeInput.waitFor({ state: "visible" });
        await nativeInput.press("Escape");
        assert.equal(await frame.locator("#input").inputValue(), "keep this unsent draft");
        await frame.locator("#btn-new").click();
        await waitFor(() => frame.locator("#btn-copy-session-id").isEnabled());
        await app.evaluate(({ clipboard }) => clipboard.writeText("new-tab"));
        await action("#btn-copy-session-id");
        await waitFor(async () => (await readClipboard()) !== "new-tab");
        assert.notEqual(await readClipboard(), id, "copy must target the new tab's backend");
        await frame.locator('.session-tab[data-session-id="s1"]').click();
        await action("#btn-copy-session-id");
        await waitFor(async () => (await readClipboard()) === id);
        assert.equal(await frame.locator("#input").inputValue(), "keep this unsent draft");
      }
      const saved = fs.readFileSync(file, "utf8");
      assert.ok(saved.startsWith(original), "saved conversation entries must be preserved");
      // Pi may record its restored thinking/model settings on switch. Those
      // metadata entries are not a model call or a change to the transcript.
      for (const line of saved.slice(original.length).split("\n").filter(Boolean)) {
        assert.ok(["thinking_level_change", "model_change"].includes(JSON.parse(line).type));
      }
      assert.equal(fs.readFileSync(workspaceFile, "utf8"), "workspace content must stay unchanged\n");
      await app.close();
      app = null;
    }
    console.log("Real VS Code + pi RPC session ID copy/resume/reopen passed; no model calls.");
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
