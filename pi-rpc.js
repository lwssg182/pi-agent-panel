"use strict";

/**
 * Minimal client for `pi --mode rpc` (JSONL over stdin/stdout).
 *
 * Protocol reference:
 * https://github.com/badlogic/pi-mono — docs/rpc.md of @earendil-works/pi-coding-agent
 *
 * Events emitted:
 *  - "event"  (agent events: agent_start, message_update, tool_execution_start, ...)
 *  - "ui"     (extension_ui_request; answer with respondUi(id, payload))
 *  - "error"  (spawn error)
 *  - "exit"   (code, stderrTail)
 */

const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");
const { StringDecoder } = require("string_decoder");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STDERR_TAIL_LIMIT = 8 * 1024; // cap of the stderr tail kept for errors
const KILL_GRACE_MS = 2000; // SIGTERM -> SIGKILL delay
const STOP_FALLBACK_MS = 5000; // stop() resolves even if no exit event fires

class PiRpcClient extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.piPath]  Path to the pi binary (default: auto-detect).
   * @param {string[]} [options.args]  Extra CLI args (e.g. ["--provider", "anthropic"]).
   * @param {string} [options.cwd]     Working directory for the pi process.
   * @param {object} [options.env]     Environment (default: process.env).
   */
  constructor({ piPath, args = [], cwd, env } = {}) {
    super();
    this.piPath = piPath || PiRpcClient.resolvePiPath();
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = env || process.env;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.exited = false;
  }

  /**
   * Find the pi binary. Explicit setting wins, then PATH, then common
   * install locations (Linux/macOS/Windows).
   */
  static resolvePiPath(configured) {
    if (configured && configured.trim()) return configured.trim();
    const isWin = process.platform === "win32";
    const exe = isWin ? "pi.cmd" : "pi";
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const candidates = pathDirs.map((d) => path.join(d, exe));
    if (isWin) {
      // npm's global bin on Windows is %APPDATA%\npm (pi.cmd shim)
      if (process.env.APPDATA)
        candidates.push(path.join(process.env.APPDATA, "npm", "pi.cmd"));
    } else {
      candidates.push(
        path.join(os.homedir(), ".npm-global", "bin", "pi"),
        "/usr/local/bin/pi",
        "/opt/homebrew/bin/pi"
      );
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        /* ignore */
      }
    }
    return "pi";
  }

  start() {
    if (this.proc) return;
    const args = ["--mode", "rpc", ...this.args];
    const opts = { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] };
    if (process.platform === "win32") {
      // On Windows pi is a .cmd shim, which can only be executed through a
      // shell (Node refuses .cmd without one). PATH/PATEXT then resolves it.
      const cmd = /[ 	]/.test(this.piPath) ? `"${this.piPath}"` : this.piPath;
      this.proc = spawn(cmd + " " + args.join(" "), Object.assign({ shell: true }, opts));
    } else {
      this.proc = spawn(this.piPath, args, opts);
    }
    attachJsonlReader(this.proc.stdout, (line) => this._onLine(line));

    let stderrText = "";
    this.proc.stderr.on("data", (c) => {
      stderrText += c.toString();
      if (stderrText.length > STDERR_TAIL_LIMIT) stderrText = stderrText.slice(-STDERR_TAIL_LIMIT);
    });

    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.emit("exit", code, stderrText);
      const err = new Error(
        `pi exited (code ${code})${stderrText ? ":\n" + stderrText.slice(-500) : ""}`
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return; // not JSON; ignore
    }
    if (msg.type === "response") {
      const p = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (p) {
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(msg.error || `command "${msg.command}" failed`));
      }
      return;
    }
    if (msg.type === "extension_ui_request") {
      this.emit("ui", msg);
      return;
    }
    this.emit("event", msg);
  }

  /** Send a raw JSON command (one line, LF-terminated). */
  send(obj) {
    if (!this.proc || this.exited) throw new Error("pi process is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /**
   * Send a command and resolve with its response `data`.
   * @param {object} obj       Command payload.
   * @param {number} [timeoutMs=30000]  Timeout in ms (0 = no timeout).
   */
  request(obj, timeoutMs = 30000) {
    const id = `rpc-${++this.seq}`;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v); },
        reject:  (e) => { cleanup(); reject(e); },
      });
      try {
        this.send(Object.assign({ id }, obj));
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`RPC timeout after ${timeoutMs}ms for "${obj.type || 'unknown'}"`));
          }
        }, timeoutMs);
      }
    });
  }

  /** Answer an extension_ui_request. */
  respondUi(id, payload) {
    this.send(Object.assign({ type: "extension_ui_response", id }, payload));
  }

  /** Stop the pi process. Returns a Promise that resolves when the process exits. */
  stop() {
    if (!this.proc) return Promise.resolve();
    const p = this.proc;
    this.proc = null;
    // Drop the provider's listeners (its exit handler no-ops on manual stop;
    // unexpected-crash notifications only matter for the live client).
    this.removeAllListeners();
    // Already exited: the exit event has fired and won't fire again.
    if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      p.on("exit", () => resolve());
      // Safety: resolve anyway if the exit event never fires.
      const fallback = setTimeout(() => resolve(), STOP_FALLBACK_MS);
      fallback.unref();

      if (process.platform === "win32") {
        try {
          execFile("taskkill", ["/pid", String(p.pid), "/T", "/F"], () => {});
        } catch (_) {
          /* ignore */
        }
      } else {
        try {
          p.kill("SIGTERM");
        } catch (_) {
          /* ignore */
        }
        setTimeout(() => {
          try {
            p.kill("SIGKILL");
          } catch (_) {
            /* ignore */
          }
        }, KILL_GRACE_MS).unref();
      }
    });
  }
}

/**
 * JSONL reader per the pi RPC spec: split on "\n" only, tolerate "\r\n".
 * (Node's readline is NOT protocol-compliant: it also splits on U+2028/U+2029.)
 */
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const i = buffer.indexOf("\n");
      if (i === -1) break;
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

module.exports = { PiRpcClient, attachJsonlReader };
