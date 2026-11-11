"use strict";
/* global window, document, DragEvent, DataTransfer */

// Optional integration check using a real, isolated VS Code window.
// PLAYWRIGHT_MODULE=/path/to/playwright VSCODE_EXECUTABLE=/path/to/code node test/vscode-files.js
// Playwright is test tooling only, never a runtime/package dependency. A display
// is required. The native dialog's selection is stubbed. Set PI_NATIVE_DRAG=1
// on Linux/X11 to ALSO send real OS mouse drags through test/native-drag.py.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
  assert.ok(process.env.VSCODE_EXECUTABLE, "Set VSCODE_EXECUTABLE to the Electron binary, not the code shell wrapper");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vscode-files-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, "user/User"), { recursive: true });
  fs.writeFileSync(path.join(root, "user/User/settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "window.restoreWindows": "none",
    "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true,
  }));
  const file = path.join(workspace, "中文 notes.txt");
  fs.writeFileSync(file, "context for the test; never send a prompt\n");
  fs.writeFileSync(path.join(workspace, "extra.js"), "// second file\n");
  fs.mkdirSync(path.join(workspace, "a-folder"));
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.VSCODE_EXECUTABLE,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE_|ELECTRON_)/.test(key))),
      args: ["--no-sandbox", "--disable-gpu", "--skip-welcome", "--skip-release-notes",
        `--user-data-dir=${root}/user`, `--extensions-dir=${root}/extensions`,
        `--extensionDevelopmentPath=${path.resolve(__dirname, "..")}`, workspace],
      timeout: 60000,
    });
    const page = await app.firstWindow();
    const waitFor = async (check) => {
      for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await page.waitForTimeout(100);
      }
      throw new Error("Timed out waiting for file-input result");
    };
    await page.locator('.activitybar a[aria-label="pi"]').click({ timeout: 60000 });
    let frame;
    for (let i = 0; i < 120; i++) {
      frame = page.frames().find((candidate) => candidate.url().includes("/fake.html"));
      if (frame && await frame.locator("#btn-attach").isEnabled().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    assert.ok(frame, "pi webview did not load");
    const iframe = page.locator("iframe.webview");
    await page.evaluate(() => window.dispatchEvent(new DragEvent("dragstart", { bubbles: true })));
    assert.equal(await iframe.evaluate((el) => el.style.pointerEvents), "none", "VS Code blocks ordinary drags");
    await page.evaluate(() => window.dispatchEvent(new DragEvent("dragover", { bubbles: true, shiftKey: true })));
    assert.equal(await iframe.evaluate((el) => el.style.pointerEvents), "auto", "Shift releases the VS Code drag gate");
    await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend", { bubbles: true })));

    // Exercise the real button -> webview message -> host -> native dialog ->
    // validation -> scoped reply -> composer path. Stub only the OS selection.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, file);
    await frame.locator("#input").fill("please inspect");
    await frame.locator("#btn-attach").click();
    await waitFor(async () => (await frame.locator("#input").inputValue()).includes('@"中文 notes.txt"'));
    assert.equal(await frame.locator("#input").inputValue(), 'please inspect\n@"中文 notes.txt"\n');
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await frame.locator("#btn-attach").click();
    await waitFor(() => frame.locator("#btn-attach").isEnabled());
    assert.equal(await frame.locator("#input").inputValue(), 'please inspect\n@"中文 notes.txt"\n');

    // A real native File/DataTransfer inside the browser, on the transcript,
    // also checks that VS Code's injected window handlers do not re-block it.
    await frame.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["inline test context"], "native.txt", { type: "text/plain" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        document.getElementById("session-content").dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
      }
    });
    await waitFor(async () => (await frame.locator("#input").inputValue()).includes("inline test context"));
    assert.equal(await iframe.evaluate((el) => el.style.pointerEvents), "auto");
    assert.equal(await frame.locator(".msg.user").count(), 0, "adding files must not send a prompt");
    if (process.env.PI_NATIVE_DRAG === "1") {
      await frame.locator("#input").fill("keep my draft");
      await page.locator(".part.editor").click({ position: { x: 200, y: 200 } });
      await page.keyboard.press("Control+p");
      const quickInput = page.locator(".quick-input-widget input");
      await quickInput.fill(file);
      await page.waitForTimeout(800);
      await quickInput.press("Enter");
      const source = page.locator(".tabs-container .tab").filter({ hasText: "中文 notes.txt" }).first();
      const target = page.getByText("Drop files here → current draft", { exact: true });
      await source.waitFor();
      await target.waitFor();
      const browserWindow = await app.browserWindow(page);
      const bounds = await browserWindow.evaluate((w) => { w.focus(); return w.getContentBounds(); });
      const drag = async (from, to, via = [], shift = false) => new Promise((resolve, reject) => require("node:child_process").execFile("python3", [
        path.join(__dirname, "native-drag.py"), JSON.stringify({
          from: [bounds.x + from.x + from.width / 2, bounds.y + from.y + from.height / 2],
          to: [bounds.x + to.x + to.width / 2, bounds.y + to.y + to.height / 2], shift, via,
        }),
      ], (error) => error ? reject(error) : resolve()));
      for (let count = 1; count <= 2; count++) {
        await drag(await source.boundingBox(), await target.boundingBox());
        await waitFor(async () => (await frame.locator("#input").inputValue()).split('@"中文 notes.txt"').length === count + 1);
      }
      assert.equal(await frame.locator("#input").inputValue(), 'keep my draft\n@"中文 notes.txt"\n@"中文 notes.txt"\n');
      // Explorer shares the left sidebar with pi. While dragging, hover the pi
      // activity icon to reveal the destination, just as a user can do.
      const to = await target.boundingBox();
      const icon = await page.locator('.activitybar a[aria-label="pi"]').boundingBox();
      const via = [[bounds.x + icon.x + icon.width / 2, bounds.y + icon.y + icon.height / 2, 1.5]];
      await page.locator('.activitybar a[aria-label^="Explorer"]').click();
      const first = page.locator(".explorer-folders-view .monaco-list-row").filter({ hasText: "中文 notes.txt" }).first();
      const second = page.locator(".explorer-folders-view .monaco-list-row").filter({ hasText: "extra.js" }).first();
      await first.click();
      await second.click({ modifiers: ["Control"] });
      await drag(await first.boundingBox(), to, via);
      await waitFor(async () => (await frame.locator("#input").inputValue()).includes("@extra.js"));
      assert.equal((await frame.locator("#input").inputValue()).split('@"中文 notes.txt"').length, 4);
      assert.equal(await iframe.evaluate((el) => el.style.pointerEvents), "auto", "native drop must leave the composer interactive");
      await frame.locator("#input").click({ timeout: 5000 });
      const draft = await frame.locator("#input").inputValue();
      await page.locator('.activitybar a[aria-label^="Explorer"]').click();
      const folder = page.locator(".explorer-folders-view .monaco-list-row").filter({ hasText: "a-folder" }).first();
      await drag(await folder.boundingBox(), to, via);
      await waitFor(async () => /not a regular file|directories/.test(await frame.locator("body").innerText()));
      assert.equal(await frame.locator("#input").inputValue(), draft, "folder drop must not change the draft");
      assert.equal(await frame.locator(".msg.user").count(), 0);
      if (process.env.PI_NATIVE_FILES === "1") {
        const external = path.join(root, "os-native.txt");
        fs.writeFileSync(external, "external native file content\n");
        const child = require("node:child_process").spawn("/usr/bin/python3", [path.join(__dirname, "native-file-source.py"), external]);
        child.stderr.on("data", (data) => process.stderr.write(data));
        try {
          const origin = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error("GTK source did not start")); }, 15000);
            child.on("error", (error) => { clearTimeout(timer); reject(error); });
            child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`GTK source exited: ${code}`)); });
            child.stdout.once("data", (data) => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
          });
          const from = { ...origin, x: origin.x - bounds.x, y: origin.y - bounds.y };
          // Direct OS -> iframe and OS -> native drop area are distinct routes.
          for (const [name, destination, shift] of [["native area", target, false], ["composer with Shift", frame.locator("#input"), true]]) {
            console.log(`Testing OS drag -> ${name}`);
            await frame.locator("#input").fill("external drop: ");
            await drag(from, await destination.boundingBox(), [], shift);
            await waitFor(async () => (await frame.locator("#input").inputValue()).includes("os-native.txt"));
            assert.equal(await frame.locator(".msg.user").count(), 0);
          }
          console.log("OK: REAL OS/XDND file drops: native area without Shift; composer with Shift.");
        } finally { child.kill(); }
      }
      assert.equal(fs.readFileSync(file, "utf8"), "context for the test; never send a prompt\n");
      assert.ok(fs.existsSync(path.join(workspace, "extra.js")), "dragging must not move the source file");
      if (process.env.PI_DRAG_SCREENSHOT) await page.screenshot({ path: process.env.PI_DRAG_SCREENSHOT });
      console.log("OK: REAL native drags: repeated editor-tab drops, Explorer multi-file drop, folder rejection; no Shift, no auto-send.");
    }
    console.log("OK: real VS Code drag gate, file-picker round trip/cancel, browser File drop in transcript; no prompt sent.");
  } catch (error) {
    if (app && process.env.PI_DRAG_SCREENSHOT) {
      const window = app.windows()[0];
      if (window) await window.screenshot({ path: process.env.PI_DRAG_SCREENSHOT }).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
