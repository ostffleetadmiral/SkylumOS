// Real interactive shell sessions for Node/Electron hosts, backed by tmux.
// tmux owns the PTY: login shell (`$SHELL -l`) gets the user's real
// environment (PATH, aliases, ollama, etc.), ANSI stream is captured
// verbatim through pipe-pane into a per-session log, and reads drain it
// by offset — the same contract a terminal emulator expects. Nothing is
// simulated: if tmux or a shell is absent the service reports it honestly.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readSync, closeSync, statSync, rmSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function run(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code: code ?? 1, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("shell_tmux_timeout"));
    }, timeoutMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => finish(e));
    child.on("close", code => finish(null, code));
  });
}

export function createShellService({ tmux = "tmux", socket = null,
    shell = null, env = process.env, root = null } = {}) {
  const sock = socket ?? `skyos-${randomBytes(4).toString("hex")}`;
  const tmuxBin = tmux;
  const termShell = shell ?? env.SHELL ?? "/bin/bash";
  const termRoot = root ?? join(tmpdir(), `skyos-terms-${process.pid}`);
  mkdirSync(termRoot, { recursive: true });
  const sessions = new Map();
  let counter = 0;

  const tmuxRun = (...args) => run(tmuxBin, ["-L", sock, ...args]);

  async function available() {
    try {
      const v = await run(tmuxBin, ["-V"], { timeoutMs: 5000 });
      return v.code === 0;
    } catch { return false; }
  }

  function clampSize(cols, rows) {
    const c = Number.isInteger(cols) ? Math.min(Math.max(cols, 1), MAX_COLS) : DEFAULT_COLS;
    const r = Number.isInteger(rows) ? Math.min(Math.max(rows, 1), MAX_ROWS) : DEFAULT_ROWS;
    return { cols: c, rows: r };
  }

  function sessionFile(id) { return join(termRoot, `term-${id}.log`); }

  function getSession(id) {
    const s = sessions.get(id);
    if (!s) throw new Error("shell_session_unknown");
    return s;
  }

  async function spawnTerm({ cols, rows, cwd } = {}) {
    if (!(await available())) throw new Error("shell_tmux_unavailable");
    const { cols: c, rows: r } = clampSize(cols, rows);
    const id = `t${++counter}-${randomBytes(3).toString("hex")}`;
    const name = `skyos-${id}`;
    const dir = typeof cwd === "string" && cwd.length > 0 && cwd.length < 4096 ? cwd : (env.HOME || ".");
    const file = sessionFile(id);
    const shellCmd = `${termShell} -l`;
    const created = await tmuxRun("new-session", "-d", "-s", name,
      "-x", String(c), "-y", String(r), "-c", dir, shellCmd);
    if (created.code !== 0)
      throw new Error(`shell_spawn_failed:${(created.stderr || created.stdout).trim().slice(0, 200)}`);
    // Capture the pane's raw byte stream into the session log.
    const cap = await tmuxRun("pipe-pane", "-o", "-t", name,
      `cat >> '${file.replaceAll("'", "'\\''")}'`);
    if (cap.code !== 0) {
      await tmuxRun("kill-session", "-t", name).catch(() => {});
      throw new Error("shell_capture_failed");
    }
    const s = { id, name, file, offset: 0, cols: c, rows: r, alive: true,
      buffer: "skyos-in-" + id };
    sessions.set(id, s);
    return { id, cols: c, rows: r };
  }

  async function write(id, data) {
    const s = getSession(id);
    if (!s.alive) throw new Error("shell_session_dead");
    if (typeof data !== "string" || data.length === 0)
      throw new Error("shell_input_invalid");
    if (Buffer.byteLength(data, "utf8") > MAX_WRITE_BYTES)
      throw new Error("shell_input_too_large");
    // load-buffer reads a file, so arbitrary bytes (dashes, UTF-8, control
    // chars) survive intact; paste-buffer (no -p) then delivers them as
    // keystrokes where newlines act as Enter — matching typed input.
    const inFile = join(termRoot, `in-${id}-${counter}.bin`);
    writeFileSync(inFile, data);
    const loaded = await tmuxRun("load-buffer", "-b", s.buffer, inFile);
    try { rmSync(inFile, { force: true }); } catch {}
    if (loaded.code !== 0) throw new Error("shell_input_failed");
    const pasted = await tmuxRun("paste-buffer", "-b", s.buffer, "-t", s.name);
    if (pasted.code !== 0) throw new Error("shell_input_failed");
    return { written: Buffer.byteLength(data, "utf8") };
  }

  async function read(id, { maxBytes = 256 * 1024 } = {}) {
    const s = getSession(id);
    const cap = Math.min(Math.max(Number(maxBytes) || 0, 1), 1024 * 1024);
    let size = 0;
    try { size = statSync(s.file).size; } catch { /* not created yet */ }
    let chunk = "";
    if (size > s.offset) {
      const fd = openSync(s.file, "r");
      try {
        const len = Math.min(size - s.offset, cap);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, s.offset);
        chunk = buf.subarray(0, n).toString("base64");
        s.offset += n;
      } finally { closeSync(fd); }
    }
    // Session liveness: tmux session gone => shell exited.
    if (s.alive) {
      const chk = await tmuxRun("has-session", "-t", s.name);
      if (chk.code !== 0) s.alive = false;
    }
    if (size > MAX_LOG_BYTES) {
      await killSession(id).catch(() => {});
      throw new Error("shell_log_overflow");
    }
    return { id, data: chunk, offset: s.offset, alive: s.alive,
      cols: s.cols, rows: s.rows };
  }

  async function resize(id, { cols, rows } = {}) {
    const s = getSession(id);
    if (!s.alive) throw new Error("shell_session_dead");
    const { cols: c, rows: r } = clampSize(cols, rows);
    const res = await tmuxRun("resize-window", "-t", s.name, "-x", String(c), "-y", String(r));
    if (res.code !== 0) throw new Error("shell_resize_failed");
    s.cols = c; s.rows = r;
    return { cols: c, rows: r };
  }

  async function killSession(id) {
    const s = sessions.get(id);
    if (!s) return { killed: false };
    await tmuxRun("kill-session", "-t", s.name).catch(() => {});
    sessions.delete(id);
    try { rmSync(s.file, { force: true }); } catch {}
    return { killed: true };
  }

  async function list() {
    const out = [];
    for (const s of sessions.values()) {
      if (s.alive) {
        const chk = await tmuxRun("has-session", "-t", s.name);
        if (chk.code !== 0) s.alive = false;
      }
      out.push({ id: s.id, alive: s.alive, cols: s.cols, rows: s.rows });
    }
    return out;
  }

  async function close() {
    for (const id of [...sessions.keys()]) await killSession(id).catch(() => {});
    try { rmSync(termRoot, { recursive: true, force: true }); } catch {}
  }

  return { spawn: spawnTerm, write, read, resize, kill: killSession,
    list, close, socket: sock, shell: termShell, root: termRoot };
}
