#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startBridge } from "./bridge.js";
import { createNodePersistence } from "./persist-node.js";
import { nodeHostDoors } from "./doors-node.js";
import { createHostProtocol } from "./protocol.js";
import { loadRuntime } from "./runtime.js";

function parseArgs(argv) {
  const options = { mode: "status", state: null, wasm: null, data: resolve(homedir(), ".skyos"),
    host: "127.0.0.1", port: 0, allowedOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") options.mode = needValue(argv, ++i, arg);
    else if (arg === "--state") options.state = resolve(needValue(argv, ++i, arg));
    else if (arg === "--wasm") options.wasm = resolve(needValue(argv, ++i, arg));
    else if (arg === "--data") options.data = resolve(needValue(argv, ++i, arg));
    else if (arg === "--host") options.host = needValue(argv, ++i, arg);
    else if (arg === "--port") options.port = Number(needValue(argv, ++i, arg));
    else if (arg === "--origin") options.allowedOrigins.push(needValue(argv, ++i, arg));
    else if (arg === "--help") options.mode = "help";
    else throw new Error(`argument_unknown:${arg}`);
  }
  if (!["status", "serve", "shell", "help", "services", "services-up"].includes(options.mode))
    throw new Error("mode_invalid");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("port_invalid");
  return options;
}

function needValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`argument_value_missing:${option}`);
  return value;
}

export async function runCli(argv = process.argv.slice(2), io = { stdin, stdout }) {
  const options = parseArgs(argv);
  if (options.mode === "help") {
    io.stdout.write("SkyOS host: --mode status|shell|serve|services|services-up [--state path] [--wasm path] [--data dir] [--host 127.0.0.1] [--port 0] [--origin origin]\\n");
    return 0;
  }
  if (options.mode === "services" || options.mode === "services-up") {
    // Service seeding does not need the WASM runtime — resolve, spawn, and
    // report straight from the canonical manifest. services-up leaves
    // spawned runtimes running after this process exits.
    const { createSupervisor } = await import("./services-node.mjs");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const supervisor = createSupervisor({
      roots: [resolve(here, "../../.."), process.cwd()],
      logDir: resolve(options.data, "service-logs"),
    });
    if (options.mode === "services-up") await supervisor.ensure("all");
    io.stdout.write(`${JSON.stringify(await supervisor.status())}\\n`);
    return 0;
  }
  const persist = createNodePersistence(options.data);
  const runtime = await loadRuntime({ wasmPath: options.wasm ?? undefined,
    statePath: options.state ?? undefined, persist,
    doors: { extra: nodeHostDoors() } });
  if (options.mode === "status") {
    io.stdout.write(`${JSON.stringify(await createHostProtocol(runtime).dispatch("status"))}\\n`);
    return 0;
  }
  if (options.mode === "serve") {
    const bridge = await startBridge({ runtime, host: options.host, port: options.port,
      allowedOrigins: options.allowedOrigins });
    io.stdout.write(`${JSON.stringify({ mode: "bridge", host: bridge.host, port: bridge.port,
      url: bridge.url, token: bridge.token })}\\n`);
    const shutdown = async () => { await bridge.close(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return bridge;
  }
  const protocol = createHostProtocol(runtime);
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: Boolean(io.stdin.isTTY) });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const value = await protocol.dispatch(request.command, request.args ?? {});
        io.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
      } catch (error) {
        io.stdout.write(`${JSON.stringify({ ok: false, error: error.message || "host_error" })}\n`);
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().then(result => {
    if (typeof result === "number") process.exitCode = result;
  }).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
