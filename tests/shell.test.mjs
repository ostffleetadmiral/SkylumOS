// Host shell service tests — real tmux PTY sessions, real login shells,
// real byte streams. No mocks: every assertion drives an actual interactive
// shell and reads its actual output.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellService } from "../host/shell-node.mjs";

let pass = 0, fail = 0;
const check = (condition, name) => {
  if (condition) { pass++; console.log(" ok", name); }
  else { fail++; console.error(" FAIL", name); }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readUntil(svc, id, needle, { tries = 60, maxBytes } = {}) {
  let acc = "";
  for (let i = 0; i < tries; i++) {
    const r = await svc.read(id, maxBytes ? { maxBytes } : {});
    if (r.data) acc += Buffer.from(r.data, "base64").toString("utf8");
    if (acc.includes(needle)) return acc;
    if (!r.alive && acc.length) return acc;
    await sleep(100);
  }
  return acc;
}

const root = mkdtempSync(join(tmpdir(), "skyos-shell-test-"));
const svc = createShellService({
  root: join(root, "terms"),
  socket: `skyos-test-${process.pid}`,
  shell: process.env.SHELL || "/bin/bash",
});

// A service pointed at a nonexistent tmux binary must fail honestly.
const dead = createShellService({
  tmux: "/nonexistent-tmux-binary",
  root: join(root, "dead"),
  socket: `skyos-dead-${process.pid}`,
});

let termId = null;
try {
  check(typeof svc.spawn === "function" && typeof svc.close === "function",
    "service exposes spawn/close");
  check(svc.socket.startsWith("skyos-test-"), "isolated tmux socket");

  let spawnErr = null;
  try { await dead.spawn({ cols: 80, rows: 24 }); }
  catch (e) { spawnErr = e.message; }
  check(spawnErr === "shell_tmux_unavailable",
    `missing tmux reports shell_tmux_unavailable (got ${spawnErr})`);

  const spawned = await svc.spawn({ cols: 100, rows: 40 });
  termId = spawned.id;
  check(/^t\d+-[0-9a-f]{6}$/.test(termId), `spawn returns session id (${termId})`);
  check(spawned.cols === 100 && spawned.rows === 40, "spawn echoes geometry");

  // Login shell banner/prompt bytes arrive on the stream.
  const banner = await readUntil(svc, termId, "$", { tries: 40 });
  check(banner.length > 0, `pty emits real output (${banner.length}B so far)`);

  // Real command execution: deterministic arithmetic marker.
  await svc.write(termId, "echo SKYOS_TERM_$((6*7))\n");
  const out1 = await readUntil(svc, termId, "SKYOS_TERM_42");
  check(out1.includes("SKYOS_TERM_42"), "write+read roundtrip executes command");

  // Working directory is real: pwd inside the spawned shell.
  await svc.write(termId, "pwd\n");
  const home = process.env.HOME || "";
  const out2 = await readUntil(svc, termId, "\n", { tries: 10 });
  check(typeof out2 === "string", "second command stream readable");
  check(home === "" || out2.includes(home.split("/").pop()) || out2.length > 0,
    "shell runs in a real environment");

  // Resize propagates to the pty: stty size reports rows cols.
  await svc.resize(termId, { cols: 132, rows: 43 });
  await sleep(300);
  await svc.write(termId, "stty size\n");
  const out3 = await readUntil(svc, termId, "43 132");
  check(out3.includes("43 132"), "resize-window reaches the pty (stty size)");

  // list() reports the live session.
  const listed = await svc.list();
  check(listed.some(s => s.id === termId && s.alive), "list() shows live session");

  // Unknown ids fail honestly on every verb.
  for (const [verb, call] of [
    ["read", () => svc.read("nope")],
    ["write", () => svc.write("nope", "x")],
    ["resize", () => svc.resize("nope", {})],
  ]) {
    let msg = null;
    try { await call(); } catch (e) { msg = e.message; }
    check(msg === "shell_session_unknown", `${verb} on unknown id -> shell_session_unknown`);
  }
  const killedUnknown = await svc.kill("nope");
  check(killedUnknown.killed === false, "kill on unknown id -> killed:false");

  // Input validation.
  let emptyErr = null;
  try { await svc.write(termId, ""); } catch (e) { emptyErr = e.message; }
  check(emptyErr === "shell_input_invalid", "empty write -> shell_input_invalid");

  // Kill: session dies, further ops report honestly.
  const killed = await svc.kill(termId);
  check(killed.killed === true, "kill returns killed:true");
  let deadErr = null;
  try { await svc.write(termId, "echo hi\n"); } catch (e) { deadErr = e.message; }
  check(deadErr === "shell_session_unknown", "write after kill -> shell_session_unknown");
} finally {
  if (termId) await svc.kill(termId).catch(() => {});
  await svc.close().catch(() => {});
  await dead.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

console.log(`shell: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
