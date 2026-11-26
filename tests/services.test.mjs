// Host service supervisor tests — real loopback probes and a real spawned
// python http.server; no mocks. Covers the manifest contract, repo
// candidate resolution, launch planning, and the ensure/status/close
// lifecycle used by the Electron host and `cli.js --mode services*`.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  EXTERNAL_SERVICES, SERVICE_REPO_ROOTS, serviceProbeUrl,
} from "../host/services.mjs";
import {
  createSupervisor, probeService, repoDirCandidates, resolveLaunch,
} from "../host/services-node.mjs";

let pass = 0, fail = 0;
const check = (condition, name) => {
  if (condition) { pass++; console.log(" ok", name); }
  else { fail++; console.error(" FAIL", name); }
};

const freePort = () => new Promise((resolvePromise, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolvePromise(port));
  });
});

console.log("Service manifest:");
{
  const ids = Object.keys(EXTERNAL_SERVICES);
  check(ids.length === 2 && ids.includes("godseye") && ids.includes("spaceagent"),
    "manifest covers both embedded runtimes");
  const ports = new Set();
  let consistent = true;
  for (const [id, s] of Object.entries(EXTERNAL_SERVICES)) {
    if (ports.has(s.port)) consistent = false;
    ports.add(s.port);
    if (!s.page.includes(`:${s.port}/`) || !s.probePath.startsWith("/")) consistent = false;
    if (!s.launches.length || !s.start || !s.hint) consistent = false;
    if (!SERVICE_REPO_ROOTS[id]?.env || !SERVICE_REPO_ROOTS[id]?.segments?.length) consistent = false;
  }
  check(consistent, "ports unique, page/probe/start/launch/repo-root fields consistent");
  check(serviceProbeUrl(EXTERNAL_SERVICES.spaceagent) === "http://127.0.0.1:3100/api/health" &&
    serviceProbeUrl(EXTERNAL_SERVICES.godseye) === "http://127.0.0.1:3200/index.html",
  "probe URLs match the documented endpoints");
}

console.log("Repo candidates:");
{
  const dirs = repoDirCandidates("spaceagent", {
    env: {}, roots: ["/sky", "/sky"],
  });
  check(dirs.length === 1 && dirs[0].endsWith("foundations/space-agent"),
    "derived roots dedupe to the foundations layout");
  const override = repoDirCandidates("spaceagent", {
    env: { SKYOS_SPACE_AGENT_DIR: "/opt/sa" }, roots: ["/sky"],
  });
  check(override[0] === "/opt/sa" && override.length === 2,
    "env override wins and is listed first");
}

console.log("Probe + launch resolution:");
{
  const dir = mkdtempSync(join(tmpdir(), "skc-svc-"));
  try {
    // Real HTTP server on an ephemeral port answers the probe.
    const { createServer: createHttp } = await import("node:http");
    const port = await freePort();
    const http = createHttp((req, res) => { res.writeHead(200); res.end("ok"); });
    await new Promise(r => http.listen(port, "127.0.0.1", r));
    const probeTarget = { port, probePath: "/health" };
    check(await probeService(probeTarget) === true, "probeService sees a live loopback server");
    check(await probeService({ port: await freePort(), probePath: "/" }) === false,
      "probeService reports a silent port as down");
    http.close();

    // Fake repo tree resolves the first viable launch candidate.
    const repo = join(dir, "foundations", "gods-eye-view");
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "index.html"), "<html></html>");
    const plan = await resolveLaunch("godseye", { env: process.env, roots: [dir] });
    check(plan.ok === true && plan.cwd === repo && plan.launch.cmd.includes("python3"),
      "resolveLaunch picks the static-dist candidate when dist exists");

    const missing = await resolveLaunch("godseye", {
      env: { ...process.env, SKYOS_GEV_DIR: join(dir, "nowhere") }, roots: [],
    });
    check(missing.ok === false && missing.checked.length >= 1,
      "resolveLaunch reports checked locations when nothing is launchable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("Supervisor lifecycle:");
{
  const dir = mkdtempSync(join(tmpdir(), "skc-sup-"));
  try {
    const port = await freePort();
    const foreignPort = await freePort();
    const launchFor = p => ({ cmd: "python3",
      args: ["-m", "http.server", String(p), "-d", dir],
      cwd: dir, requires: [] });
    const services = {
      testsrv: {
        name: "Test Service", port, page: `http://127.0.0.1:${port}/`,
        probePath: "/", start: "test", hint: "test",
        launches: [launchFor(port)],
      },
      foreign: {
        name: "Foreign", port: foreignPort, page: `http://127.0.0.1:${foreignPort}/`,
        probePath: "/", start: "test", hint: "test",
        launches: [launchFor(foreignPort)],
      },
      absent: {
        name: "Absent", port: await freePort(), page: "http://127.0.0.1:1/",
        probePath: "/", start: "test", hint: "test",
        launches: [{ cmd: "skc-definitely-missing-cmd", args: [], cwd: dir, requires: [] }],
      },
    };
    // A runtime already answering before the supervisor runs is external —
    // ensure must never claim or kill it.
    const { spawn } = await import("node:child_process");
    const foreignChild = spawn("python3",
      ["-m", "http.server", String(foreignPort), "-d", dir],
      { cwd: dir, stdio: "ignore" });
    try {
      for (let i = 0; i < 40 && !await probeService(services.foreign); i++)
        await new Promise(r => setTimeout(r, 100));
      const sup = createSupervisor({
        services, roots: [], logDir: join(dir, "logs"),
        readyTimeoutMs: 8000, pollMs: 100,
      });
      const ensured = await sup.ensure(["testsrv", "absent", "foreign"]);
      check(ensured.testsrv.state === "up" && ensured.absent.state === "missing" &&
        ensured.foreign.state === "external",
        "ensure spawns the real server, reports missing, adopts nothing");
      const status = await sup.status();
      check(status.services.testsrv.reachable === true &&
        status.services.testsrv.state === "up" &&
        status.services.absent.state === "missing" &&
        status.services.foreign.state === "external",
        "status reflects live probe + supervisor records");
      const again = await sup.ensure("testsrv");
      check(again.testsrv.state === "up",
        "re-ensure of our own running child keeps ownership, never double-spawns");
      await sup.close();
      await new Promise(r => setTimeout(r, 1800));
      check(await probeService(services.testsrv) === false,
        "close() reaps only the child the supervisor spawned");
      check(await probeService(services.foreign) === true,
        "close() leaves externally-owned runtimes running");
    } finally {
      foreignChild.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`SERVICES: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
