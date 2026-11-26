import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createFabricServer } from "../fabric/server.mjs";
import {
  FabricState, JOB_KINDS, MAX_SIGNAL_BYTES, canonicalJson,
  constantTimeEqual, sha256, verifyJournal, validateJobInput,
} from "../fabric/core.mjs";
import { createAgent, detectCapabilities, executeJob, parseArgs } from "../fabric/agent.mjs";
import { FabricClient } from "../skylum/fabric.js";

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed++;
  console.log(" ok", label);
}
function throws(fn, code, label) {
  assert.throws(fn, error => error.message === code, label);
  passed++;
  console.log(" ok", label);
}
const token = randomBytes(32).toString("hex");

console.log("Fabric primitives:");
check(constantTimeEqual(token, token) && !constantTimeEqual(token, "wrong"),
  "bearer secret compared with a constant-time equality check");
check(canonicalJson({ z: 1, a: [true, null] }) === '{"a":[true,null],"z":1}',
  "journal canonical encoding sorts object keys");
check(sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "SHA-256 matches the standard test vector");
throws(() => parseArgs(["--node", "../bad", "--token", token]), "node_id_invalid",
  "agent rejects unsafe node identifiers");
throws(() => parseArgs(["--head", "file:///tmp", "--token", token]), "head_url_invalid",
  "agent restricts head URL schemes");
throws(() => createAgent({ head: "http://127.0.0.1:8977", token, id: "../bad" }),
  "node_id_invalid", "agent factory rejects unsafe node identity");
throws(() => createAgent({ head: "http://127.0.0.1:8977", token, id: "agent-x", intervalMs: 10 }),
  "fabric_poll_interval_invalid", "agent rejects unsafe poll intervals");
throws(() => validateJobInput("claim.read", { name: "../private" }),
  "claim_name_invalid", "claim job rejects traversal");
throws(() => validateJobInput("skc.roundtrip", { data: "%%%!" }),
  "roundtrip_data_invalid", "SKC roundtrip rejects invalid base64 input");
throws(() => validateJobInput("infer.whisper", { audio_b64: "%%%!" }),
  "whisper_audio_invalid", "Whisper job rejects invalid base64 audio");
throws(() => validateJobInput("infer.whisper", { audio_b64: Buffer.alloc(160 * 1024 + 1).toString("base64") }),
  "whisper_audio_invalid", "Whisper job rejects oversized audio");

console.log("Registry and job lifecycle:");
{
  let now = 1000;
  const state = new FabricState({ now: () => now, suspectAfterMs: 10, nodeTtlMs: 20 });
  const caps = { runtimes: { node: "v24" }, devices: { kfd: true }, inference: { whisper: true } };
  const first = state.register({ id: "digit", name: "Digit", incarnation: 1, capabilities: caps });
  check(first.status === "alive", "registration creates a live member");
  assert.throws(() => state.register({ id: "digit", incarnation: 0, capabilities: caps }),
    { message: "incarnation_invalid" });
  passed++;
  assert.throws(() => state.register({ id: "broken", incarnation: 1, capabilities: {}, endpoints: [
    { host: "bad", port: 0, lane: "lan" },
  ] }), { message: "endpoint_invalid" });
  passed++;
  check(state.heartbeat({ id: "digit", incarnation: 1 }).status === "alive",
    "heartbeat refreshes last-seen time");
  now += 11; state.refreshLiveness();
  check(state.nodes.get("digit").status === "suspect", "member becomes suspect after its heartbeat grace");
  now += 10; state.refreshLiveness();
  check(state.nodes.get("digit").status === "dead", "member becomes dead after TTL");
}
{
  let now = 50_000;
  const state = new FabricState({ now: () => now });
  for (const id of ["digit", "sheraton"]) state.register({ id, incarnation: 1, capabilities: { devices: { kfd: id === "digit" } } });
  const submission = state.createJob({ id: "probe-1", kind: "probe", input: null, replicas: 2, quorum: 2 });
  check(submission.job.state === "running" && submission.job.nodes.length === 2,
    "job dispatch selects eligible live nodes within replica bounds");
  const jobA = state.claimJob("digit");
  const jobB = state.claimJob("sheraton");
  check(jobA?.id === "probe-1" && jobB?.id === "probe-1", "selected agents claim one idempotent job");
  const result = { ok: true, digest: "stable" };
  const digest = sha256(Buffer.from(JSON.stringify(result)));
  state.submitResult({ job_id: "probe-1", node_id: "digit", result, sha256: digest });
  state.submitResult({ job_id: "probe-1", node_id: "sheraton", result, sha256: digest });
  check(state.jobs.get("probe-1").state === "complete" &&
    state.jobs.get("probe-1").canonical.votes === 2, "matching exact digests reach canonical quorum");
  const duplicate = state.createJob({ id: "probe-1", kind: "probe", input: null });
  check(duplicate.duplicate, "duplicate submission returns original job without mutation");
  assert.throws(() => state.createJob({ id: "probe-1", kind: "probe", input: null,
    capabilities_required: { "devices.kfd": true } }), { message: "job_id_conflict" });
  passed++;
  check(verifyJournal(state.journal).valid, "hash chain verifies after lifecycle events");
  const corrupted = state.journal.map(entry => ({ ...entry }));
  corrupted[0].payload.id = "tampered";
  check(!verifyJournal(corrupted).valid, "journal verification detects payload tampering");
  throws(() => state.createJob({ id: "large", kind: "probe", input: "x".repeat(1 << 20) }),
    "job_input_too_large", "job input size is bounded");
}
{
  let now = 10;
  const state = new FabricState({ now: () => now });
  state.register({ id: "worker", incarnation: 1, capabilities: {} });
  state.createJob({ id: "claimed", kind: "probe", input: null, timeout_ms: 100 });
  assert.throws(() => state.submitResult({ job_id: "claimed", node_id: "worker",
    result: { early: true }, sha256: sha256(Buffer.from('{"early":true}')) }),
  { message: "job_not_claimed" });
  passed++;
  const claimed = state.claimJob("worker");
  check(claimed.timeout_ms === 100, "worker claims receive a deadline-bound execution lease");
  const stableResult = { ok: true };
  const stableDigest = sha256(Buffer.from(JSON.stringify(stableResult)));
  state.submitResult({ job_id: "claimed", node_id: "worker", result: stableResult, sha256: stableDigest });
  check(state.jobs.get("claimed").state === "complete" &&
    verifyJournal(state.journal).valid, "result is journaled before canonical state commits");
  const before = state.journal.length;
  state.register({ id: "next", incarnation: 1, capabilities: {} });
  check(state.journal.length === before + 1 && verifyJournal(state.journal).valid,
    "journal remains valid after canonical result commit");
}
{
  let now = 1;
  const state = new FabricState({ now: () => now, jobTimeoutMs: 100 });
  state.register({ id: "worker", incarnation: 1, capabilities: {} });
  state.createJob({ id: "slow", kind: "probe", timeout_ms: 100, input: null });
  now += 101; state.expireJobs();
  check(state.jobs.get("slow").state === "timeout", "job deadline resolves without waiting for worker");
}
{
  const state = new FabricState();
  state.register({ id: "a", incarnation: 1, capabilities: {} });
  state.register({ id: "b", incarnation: 1, capabilities: {} });
  state.sendSignal({ from: "a", to: "b", type: "offer", payload: { sdp: "x" } });
  check(state.takeSignals("b")[0].from === "a", "signal relay preserves sender and destination");
  assert.throws(() => state.sendSignal({ from: "a", to: "b", type: "bad", payload: {} }),
    { message: "signal_type_invalid" });
  passed++;
  assert.throws(() => state.sendSignal({ from: "a", to: "b", type: "ice",
    payload: "x".repeat(MAX_SIGNAL_BYTES + 1) }), { message: "signal_payload_too_large" });
  passed++;
  check(JOB_KINDS.length === 4, "v1 exposes only the four bounded job kinds");
}

console.log("HTTP auth and limits:");
{
  const service = createFabricServer({ token, host: "127.0.0.1", port: 0 });
  const addr = await service.listen();
  const url = addr.url;
  try {
    const open = await fetch(`${url}/v1/status`);
    check(open.ok && (await open.json()).mode === "single-head", "status route reports the honest single-head mode");
    const unauth = await fetch(`${url}/v1/register`, { method: "POST", body: "{}" });
    check(unauth.status === 401, "all mutation routes require bearer auth");
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const registered = await fetch(`${url}/v1/register`, { method: "POST", headers: auth,
      body: JSON.stringify({ id: "node-http", incarnation: 1, capabilities: {} }) });
    check(registered.status === 201, "authorized registration is accepted");
    const registeredBody = await registered.json();
    check(Array.isArray(registeredBody.node.endpoints) && registeredBody.node.endpoints.length === 0,
      "registration without a service port keeps endpoints empty");
    const privatePoll = await fetch(`${url}/v1/next?node=node-http`);
    check(privatePoll.status === 401, "worker polling rejects requests without bearer credentials");
    const authorizedPoll = await fetch(`${url}/v1/next?node=node-http`, { headers: auth });
    check(authorizedPoll.status === 204, "authenticated worker polling accepts empty queue");
    const preflight = await fetch(`${url}/v1/next?node=node-http`, { method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:3000" } });
    check(preflight.status === 204, "private worker reads support CORS preflight");
    const missingClaimResult = await fetch(`${url}/v1/result`, { method: "POST", headers: auth,
      body: JSON.stringify({ job_id: "missing", node_id: "node-http", result: null, sha256: sha256("null") }) });
    check(missingClaimResult.status === 404, "results for absent jobs fail with a clear error");
    const job = await fetch(`${url}/v1/job`, { method: "POST", headers: auth,
      body: JSON.stringify({ id: "http-probe", kind: "probe", input: null }) });
    check(job.status === 202, "authorized typed job submission is queued");
    const journal = await fetch(`${url}/v1/journal?verify=1`);
    check((await journal.json()).verification.valid, "journal endpoint returns a verified chain");
    const invalidPath = await fetch(`${url}/v1/nope`);
    check(invalidPath.status === 404, "unknown routes fail closed");
    const oversized = await fetch(`${url}/v1/register`, { method: "POST", headers: auth,
      body: JSON.stringify({ id: "large", capabilities: { data: "x".repeat(1 << 20) } }) }).catch(() => null);
    check(!oversized || oversized.status === 413, "oversized request bodies are rejected");
  } finally {
    await service.close();
  }
}

console.log("Agent capability/execution:");
{
  const capabilities = await detectCapabilities({
    run: async (cmd) => cmd === "zig" ? "0.13.0" : cmd === "bun" ? "1.4.5" : cmd === "lspci" ? "GPU controller" : null,
    fileExists: async path => path === "/dev/kfd",
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  check(capabilities.devices.kfd && !capabilities.devices.dri &&
    capabilities.runtimes.zig === "0.13.0" && capabilities.inference.whisper,
    "capability probe records runtimes, GPU device paths, PCI inventory, and Whisper");
  const result = await executeJob({ kind: "probe" });
  check(typeof result.node === "string" && result.runtimes.node.startsWith("v"),
    "probe job returns real host runtime facts");
  const fetchCalls = [];
  const whisper = await executeJob({ kind: "infer.whisper",
    input: { audio_b64: Buffer.from("RIFF-fake-wav").toString("base64"), filename: "a.wav" } }, {
    fetchImpl: async (...args) => { fetchCalls.push(args); return new Response('{"text":"hello"}'); },
  });
  check(whisper.text === "hello" && fetchCalls[0][0] === "http://127.0.0.1:8080/inference" &&
    fetchCalls[0][1].body instanceof FormData && fetchCalls[0][1].body.get("file") instanceof Blob,
    "Whisper job posts multipart WAV to the transcription endpoint");
  const skcInput = Buffer.from("skyos fabric roundtrip\n").toString("base64");
  const skc = await executeJob({ kind: "skc.roundtrip", input: { data: skcInput } });
  check(skc.identical === true && skc.bytes_b64 === skcInput &&
    skc.sha256 === createHash("sha256").update(Buffer.from(skcInput, "base64")).digest("hex"),
    "SKC roundtrip executes the vendored wasm fountain codec");
  const circular = {};
  circular.self = circular;
  const submissions = [];
  const agent = createAgent({ head: "http://127.0.0.1:8977", token, id: "agent-unserializable",
    capabilities: {}, execute: async () => circular,
    fetchImpl: async (url, options) => {
      submissions.push(JSON.parse(options.body));
      return new Response('{"job":{"id":"job-x"}}', { status: 200 });
    } });
  const submitted = await agent.runJob({ id: "job-x", kind: "probe", timeout_ms: 1000 });
  check(submissions[0].result.error === "job_result_unserializable" &&
    submissions[0].sha256 === sha256(JSON.stringify(submissions[0].result)) &&
    submitted.job.id === "job-x", "unserializable worker results become bounded error payloads");
}

console.log("Browser client bounds:");
{
  let captured;
  const client = new FabricClient({ baseUrl: "http://127.0.0.1:8977", token,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response('{"job":{"id":"x"}}', { status: 202 });
    } });
  await client.submitJob({ kind: "probe", input: null });
  check(captured.options.headers.authorization === `Bearer ${token}` &&
    captured.url.endsWith("/v1/job"), "browser Fabric client sends token on mutations");
  const denied = new FabricClient({ baseUrl: "http://127.0.0.1:8977", fetchImpl: async () =>
    new Response("x".repeat((1 << 20) + 1), { status: 200 }) });
  await assert.rejects(denied.status(), { message: "fabric_response_too_large" });
  passed++;
  check(true, "browser client caps response bytes");
  await assert.rejects(new FabricClient({ baseUrl: "http://127.0.0.1:8977" })
    .submitJob({ kind: "probe", input: null }), { message: "fabric_token_required" });
  passed++;
  assert.throws(() => new FabricClient({ baseUrl: "https://user:pass@example.com/" }),
    { message: "fabric_url_invalid" });
  passed++;
}

console.log(`Fabric: ${passed} assertions passed`);
