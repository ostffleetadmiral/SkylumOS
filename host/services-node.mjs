// Node-side supervisor for EXTERNAL_SERVICES (host/services.mjs).
// Probes each runtime's loopback port, resolves the first launch candidate
// whose repo directory and prerequisites exist on this machine, spawns it
// with output captured to a log file, and waits for the probe to answer.
// A service that is already answering is reported "external" and is never
// killed — only children this supervisor spawned are reaped on close().

import { spawn } from "node:child_process";
import { access, mkdir, open, stat, constants as fsConstants } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { EXTERNAL_SERVICES, SERVICE_REPO_ROOTS, serviceProbeUrl } from "./services.mjs";

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function dirExists(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function findOnPath(cmd, env) {
  if (cmd.includes("/") || cmd.includes("\\")) return (await pathExists(cmd)) ? cmd : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

export async function probeService(service, { timeoutMs = 1500 } = {}) {
  try {
    await fetch(serviceProbeUrl(service), { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export function repoDirCandidates(id, { env = {}, roots = [] } = {}) {
  const spec = SERVICE_REPO_ROOTS[id];
  if (!spec) return [];
  const dirs = [];
  const push = dir => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  const override = env[spec.env];
  if (override) push(resolve(override));
  for (const root of roots) push(join(resolve(root), ...spec.segments));
  return dirs;
}

async function launchMissing(launch, cwd) {
  const missing = [];
  for (const file of launch.requires ?? [])
    if (!await pathExists(join(cwd, file))) missing.push(file);
  for (const dir of launch.requiresDirs ?? [])
    if (!await dirExists(join(cwd, dir))) missing.push(`${dir}/`);
  return missing;
}

// Resolves the first launch candidate that can actually run here. Returns
// { ok, cwd, launch } or { ok:false, checked } where checked records every
// directory/command combination that was ruled out and why.
export async function resolveLaunch(id, { env = process.env, roots = [],
    services = EXTERNAL_SERVICES } = {}) {
  const service = services[id];
  if (!service) return { ok: false, checked: [], error: `service_unknown:${id}` };
  const dirs = repoDirCandidates(id, { env, roots });
  const checked = [];
  for (const launch of service.launches) {
    const cwds = launch.cwd ? [resolve(launch.cwd)] : dirs;
    const cmdPath = await findOnPath(launch.cmd, env);
    for (const cwd of cwds) {
      if (!await dirExists(cwd)) {
        checked.push({ cwd, cmd: launch.cmd, missing: "repo_dir" });
        continue;
      }
      const missing = await launchMissing(launch, cwd);
      checked.push({ cwd, cmd: launch.cmd, missing, ...(cmdPath ? { cmdPath } : {}) });
      if (!missing.length && cmdPath)
        return { ok: true, cwd, launch: { ...launch, cmd: cmdPath } };
    }
  }
  return { ok: false, checked };
}

function describeMissing(checked) {
  if (!checked.length) return "no repository location found (set the documented env override)";
  const parts = checked.map(entry => {
    if (entry.missing === "repo_dir") return `${entry.cwd}: repo absent`;
    const why = [...entry.missing];
    if (!entry.cmdPath) why.push(`${entry.cmd} not on PATH`);
    return `${entry.cwd}: ${why.join(", ") || "ok"}`;
  });
  return `no launchable runtime — ${parts.join("; ")}`;
}

export function createSupervisor({
  services = EXTERNAL_SERVICES,
  env = process.env,
  roots = [],
  logDir = null,
  probe = probeService,
  spawnImpl = spawn,
  readyTimeoutMs = 20000,
  pollMs = 400,
} = {}) {
  const records = new Map();
  const set = (id, patch) => records.set(id, { ...(records.get(id) ?? {}), ...patch });
  const entry = id => {
    const service = services[id];
    const rec = records.get(id) ?? {};
    return { id, name: service?.name, port: service?.port,
      state: rec.state ?? "down", ...(rec.pid ? { pid: rec.pid } : {}),
      ...(rec.detail ? { detail: rec.detail } : {}) };
  };

  async function ensureOne(id) {
    const service = services[id];
    if (!service) return { id, state: "unknown" };
    if (await probe(service)) {
      // Already answering. If the live child is one we spawned, keep
      // ownership so close() still reaps it; otherwise it's external.
      const prior = records.get(id) ?? {};
      const ours = prior.owned === true && prior.child &&
        prior.child.exitCode === null && !prior.child.killed;
      set(id, ours
        ? { state: "up" }
        : { state: "external", owned: false, pid: undefined, child: undefined });
      return entry(id);
    }
    const plan = await resolveLaunch(id, { env, roots, services });
    if (!plan.ok) {
      const detail = plan.error ?? describeMissing(plan.checked);
      set(id, { state: "missing", detail });
      return entry(id);
    }
    let logHandle = null;
    try {
      if (logDir) {
        await mkdir(logDir, { recursive: true });
        logHandle = await open(join(logDir, `${id}.log`), "a");
      }
      const stdio = logHandle ? ["ignore", logHandle.fd, logHandle.fd] : "ignore";
      const child = spawnImpl(plan.launch.cmd, [...plan.launch.args], {
        cwd: plan.cwd,
        env: { ...env, ...(plan.launch.env ?? {}) },
        stdio,
        detached: false,
      });
      set(id, { state: "starting", owned: true, pid: child.pid, child,
        detail: `${plan.launch.cmd} ${plan.launch.args.join(" ")} @ ${plan.cwd}` });
      child.on("error", () => {});
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          set(id, { state: "failed", owned: true, pid: child.pid,
            detail: `exited ${child.exitCode ?? child.signalCode} — see ${logDir ? join(logDir, `${id}.log`) : "service log"}` });
          return entry(id);
        }
        if (await probe(service)) {
          set(id, { state: "up", owned: true, pid: child.pid });
          return entry(id);
        }
        await sleep(pollMs);
      }
      child.kill("SIGTERM");
      set(id, { state: "failed", owned: true, pid: child.pid, detail: "ready_timeout" });
      return entry(id);
    } catch (error) {
      set(id, { state: "failed", detail: error.message });
      return entry(id);
    } finally {
      await logHandle?.close().catch(() => {});
    }
  }

  async function ensure(requested = "all") {
    const ids = requested === "all" ? Object.keys(services)
      : Array.isArray(requested) ? requested : [requested];
    const results = {};
    await Promise.all(ids.map(async id => { results[id] = await ensureOne(id); }));
    return results;
  }

  async function status() {
    const out = {};
    await Promise.all(Object.entries(services).map(async ([id, service]) => {
      const rec = records.get(id) ?? {};
      const reachable = await probe(service);
      const ours = rec.owned === true && rec.child &&
        rec.child.exitCode === null && !rec.child.killed;
      out[id] = {
        name: service.name, port: service.port, reachable,
        state: reachable ? (ours ? "up" : "external") : (rec.state ?? "down"),
        ...(rec.pid ? { pid: rec.pid } : {}),
        ...(rec.detail ? { detail: rec.detail } : {}),
      };
    }));
    return { services: out };
  }

  async function close() {
    const owned = [...records.values()].filter(rec => rec.owned === true);
    for (const rec of owned) {
      try { rec.child ? rec.child.kill("SIGTERM") : process.kill(rec.pid, "SIGTERM"); }
      catch { /* already gone */ }
    }
    await sleep(1500);
    for (const rec of owned) {
      try { rec.child ? rec.child.kill("SIGKILL") : process.kill(rec.pid, "SIGKILL"); }
      catch { /* already gone */ }
    }
    for (const [id, rec] of records)
      if (rec.owned) set(id, { state: rec.state === "up" ? "stopped" : rec.state });
  }

  return { ensure, ensureAll: () => ensure("all"), status, close };
}
