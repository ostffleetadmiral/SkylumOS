#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, stat, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IteronCore } from "../iteron/iteron-core.js";
import { MAX_JOB_RESULT_BYTES, MAX_WHISPER_AUDIO_BYTES } from "./core.mjs";

const MAX_RESPONSE_BYTES = 1 << 20;
const POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SKC_WASM_PATH = resolve(dirname(new URL(import.meta.url).pathname), "../vendor/skc-wasm.wasm");
const WHISPER_DEFAULT_URL = "http://127.0.0.1:8080/inference";
const iteronCores = new Map();

export function parseArgs(args) {
  const out = { id: hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    head: "http://127.0.0.1:8977", token: process.env.FABRIC_TOKEN, intervalMs: POLL_MS };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_missing:${key}`);
    if (key === "--node") out.id = value;
    else if (key === "--head") out.head = value;
    else if (key === "--token") out.token = value;
    else if (key === "--interval") out.intervalMs = Number(value);
    else throw new Error(`argument_unknown:${key}`);
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(out.id)) throw new Error("node_id_invalid");
  const head = new URL(out.head);
  if (!["http:", "https:"].includes(head.protocol) || head.username || head.password ||
      head.pathname !== "/" || head.search || head.hash) throw new Error("head_url_invalid");
  out.head = head.origin;
  if (!Number.isInteger(out.intervalMs) || out.intervalMs < 250 || out.intervalMs > 60_000)
    throw new Error("interval_invalid");
  if (typeof out.token !== "string" || Buffer.byteLength(out.token) < 24)
    throw new Error("fabric_token_required_min_24_bytes");
  return out;
}

export async function detectCapabilities({ fetchImpl = fetch, run = runCommand, fileExists = exists } = {}) {
  const [nodeVersion, bunVersion, zigVersion, lspci, devices, whisper, wasmDigest] = await Promise.all([
    Promise.resolve(process.version),
    run("bun", ["--version"]),
    run("zig", ["version"]),
    run("lspci", ["-mm"]),
    Promise.all([fileExists("/dev/dri"), fileExists("/dev/kfd")]),
    probeWhisper(fetchImpl),
    digestFile(SKC_WASM_PATH),
  ]);
  return {
    runtimes: {
      node: nodeVersion,
      bun: bunVersion?.trim() || null,
      zig: zigVersion?.trim() || null,
    },
    devices: { dri: devices[0], kfd: devices[1],
      pci: lspci ? lspci.split("\n").filter(Boolean).slice(0, 64) : [] },
    inference: { whisper: whisper ? whisperEndpoint() : null },
    skyos: { wasm_sha256: wasmDigest },
    doors: ["probe", "claim.read", "skc.roundtrip", "infer.whisper"],
  };
}

export function createAgent({ head, token, id = hostname().toLowerCase(),
  capabilities = {}, fetchImpl = fetch, execute = executeJob,
  timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = POLL_MS } = {}) {
  const base = new URL(head);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("head_url_invalid");
  if (typeof token !== "string" || Buffer.byteLength(token) < 24) throw new Error("fabric_token_invalid");
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(id))
    throw new Error("node_id_invalid");
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000)
    throw new Error("fabric_poll_interval_invalid");
  let incarnation = 1;
  let stopped = false;
  let loop = null;
  const identity = { id, name: hostname(), incarnation, capabilities };
  const resultsInFlight = new Set();

  async function request(path, { method = "GET", body, signal } = {}) {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return withTimeout((async () => {
      const response = await fetchImpl(new URL(path, base), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal, cache: "no-store", redirect: "error",
      });
      const length = Number(response.headers?.get?.("content-length") || 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error("fabric_response_too_large");
      const text = response.status === 204 ? "" : await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("fabric_response_too_large");
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(data?.error || `fabric_http_${response.status}`);
      return data;
    })(), timeoutMs, "head_request_timeout");
  }

  async function register() {
    const result = await request("/v1/register", { method: "POST", body: {
      id: identity.id, name: identity.name, incarnation, capabilities: identity.capabilities,
      endpoints: getEndpoints(),
    } });
    return result.node;
  }

  async function heartbeat() {
    const result = await request("/v1/heartbeat", {
      method: "POST", body: { id: identity.id, incarnation, capabilities: identity.capabilities },
    });
    return result.node;
  }

  async function runJob(job) {
    if (resultsInFlight.has(job.id)) return null;
    resultsInFlight.add(job.id);
    let result;
    try {
      result = await withTimeout(Promise.resolve(execute(job, { timeoutMs: job.timeout_ms, fetchImpl })),
        Math.min(job.timeout_ms || timeoutMs, timeoutMs));
    } catch (error) {
      result = { error: error.code || error.message || "job_execution_failed" };
    }
    let payload;
    try { payload = JSON.stringify(result ?? null); }
    catch {
      result = { error: "job_result_unserializable" };
      payload = JSON.stringify(result);
    }
    const digest = createHash("sha256").update(payload).digest("hex");
    try {
      return await request("/v1/result", { method: "POST", body: {
        job_id: job.id, node_id: identity.id, result: JSON.parse(payload), sha256: digest,
      } });
    } finally {
      resultsInFlight.delete(job.id);
    }
  }

  async function poll() {
    if (stopped) return;
    try { await heartbeat(); }
    catch {
      incarnation = Math.max(incarnation, identity.incarnation) + 1;
      identity.incarnation = incarnation;
      try { await register(); } catch { /* retry on the next bounded poll */ }
    }
    try {
      const response = await request(`/v1/next?node=${encodeURIComponent(identity.id)}`, { method: "GET" });
      if (response) await runJob(response);
    } catch (error) {
      if (/node_not_registered/.test(error.message)) await register().catch(() => {});
    }
    if (!stopped) loop = setTimeout(poll, intervalMs);
  }

  return Object.freeze({
    async start() {
      await register();
      loop = setTimeout(poll, 0);
      return { id: identity.id, head: base.origin, incarnation };
    },
    async stop() {
      stopped = true;
      clearTimeout(loop);
    },
    register, heartbeat, runJob,
    get identity() { return { ...identity }; },
  });
}

export async function executeJob(job, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch,
  wasmPath = SKC_WASM_PATH } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("job_timeout")), timeoutMs);
  try {
    if (job.kind === "probe") return {
      node: hostname(), at: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      runtimes: { node: process.version },
    };
    if (job.kind === "claim.read") return readClaim(job.input);
    if (job.kind === "skc.roundtrip")
      return await roundtrip(job.input, wasmPath, controller.signal, timeoutMs);
    if (job.kind === "infer.whisper") return await whisper(job.input, fetchImpl, controller.signal);
    throw new Error("job_kind_unsupported");
  } finally {
    clearTimeout(timer);
  }
}

async function readClaim(input) {
  const root = resolve(process.env.SKYOS_CLAIMS_DIR || resolve(process.cwd(), ".skyos/claims"));
  const target = resolve(root, input.name);
  if (!target.startsWith(`${root}/`)) throw new Error("claim_path_denied");
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!realTarget.startsWith(`${realRoot}/`)) throw new Error("claim_path_denied");
  const info = await stat(realTarget);
  const limit = Math.min(input.maxBytes ?? MAX_JOB_RESULT_BYTES, MAX_JOB_RESULT_BYTES);
  if (!info.isFile() || info.size > limit) throw new Error("claim_too_large_or_not_file");
  const bytes = await readFile(realTarget);
  const after = await stat(realTarget);
  if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
    throw new Error("claim_changed_during_read");
  if (bytes.length > limit) throw new Error("claim_too_large_or_not_file");
  return { name: input.name, bytes_b64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

async function iteronCore(wasmPath) {
  let pending = iteronCores.get(wasmPath);
  if (!pending) {
    pending = (async () => {
      const bytes = await readFile(wasmPath);
      return IteronCore.create(bytes);
    })();
    iteronCores.set(wasmPath, pending);
    pending.catch(() => iteronCores.delete(wasmPath));
  }
  return pending;
}

async function roundtrip(input, wasmPath, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const data = Buffer.from(input.data, "base64");
  if (data.toString("base64") !== input.data || data.length === 0 || data.length > MAX_JOB_RESULT_BYTES)
    throw new Error("roundtrip_input_invalid");
  if (signal.aborted) throw signal.reason;
  const core = await iteronCore(wasmPath);
  const blockLen = 4096;
  const sessionId = 0x5ac1;
  const frames = core.fountainEncode(data, blockLen, sessionId, 0);
  if (!frames) throw new Error("skc_roundtrip_encode_failed");
  const decoded = core.fountainDecode(frames, data.length, blockLen, sessionId);
  if (!decoded) throw new Error("skc_roundtrip_decode_failed");
  const output = Buffer.from(decoded);
  if (output.length > MAX_JOB_RESULT_BYTES) throw new Error("roundtrip_output_too_large");
  if (signal.aborted) throw signal.reason;
  return { bytes_b64: output.toString("base64"),
    sha256: createHash("sha256").update(output).digest("hex"),
    identical: output.equals(data) };
}

async function whisper(input, fetchImpl, signal) {
  const endpoint = validateInferenceEndpoint(process.env.WHISPER_URL || WHISPER_DEFAULT_URL);
  const audio = Buffer.from(input.audio_b64, "base64");
  if (audio.toString("base64") !== input.audio_b64 || audio.length === 0 ||
      audio.length > MAX_WHISPER_AUDIO_BYTES) throw new Error("whisper_audio_invalid");
  const filename = typeof input.filename === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.filename) ? input.filename : "audio.wav";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), filename);
  form.append("response_format", "json");
  form.append("response-format", "json");
  form.append("temperature", "0.0");
  const response = await fetchImpl(endpoint, {
    method: "POST", headers: { accept: "application/json" }, body: form, signal,
  });
  if (!response.ok) throw new Error(`whisper_http_${response.status}`);
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (length > 256 * 1024) throw new Error("whisper_response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("whisper_response_too_large");
  return JSON.parse(text);
}

function whisperEndpoint() {
  try {
    return validateInferenceEndpoint(process.env.WHISPER_URL || WHISPER_DEFAULT_URL);
  } catch { return null; }
}

async function probeWhisper(fetchImpl) {
  const endpoint = whisperEndpoint();
  if (!endpoint) return false;
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET", signal: AbortSignal.timeout(1500),
    });
    return response.ok || response.status < 500;
  } catch { return false; }
}

async function digestFile(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return null; }
}

async function runCommand(command, args) {
  return new Promise(resolveValue => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= 32 * 1024) chunks.push(chunk);
    });
    child.once("error", () => resolveValue(null));
    child.once("close", code => resolveValue(code === 0 ? Buffer.concat(chunks).toString() : null));
  });
}

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

function getEndpoints() {
  const port = Number(process.env.FABRIC_AGENT_PORT || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const endpoints = [];
  for (const [iface, values] of Object.entries(networkInterfaces())) {
    for (const value of values ?? []) {
      if (value.internal) continue;
      endpoints.push({
        host: value.address, port, lane: value.family === "IPv6" ? "v6" : "lan", interface: iface,
      });
      if (endpoints.length >= 8) return endpoints;
    }
  }
  return endpoints;
}

function withTimeout(promise, ms, code = "job_timeout") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function validateInferenceEndpoint(value) {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.hash)
    throw new Error("whisper_url_invalid");
  if (!endpoint.hostname) throw new Error("whisper_url_invalid");
  return endpoint.pathname === "/" && !endpoint.search ? endpoint.origin : endpoint.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
    process.argv[2] !== "--library" && process.argv[2] !== "--test") {
  const options = parseArgs(process.argv.slice(2));
  const capabilities = await detectCapabilities();
  const agent = createAgent({ ...options, capabilities });
  await agent.start();
  console.log(`Fabric node ${options.id} enrolled at ${options.head}`);
  const stop = () => agent.stop().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
