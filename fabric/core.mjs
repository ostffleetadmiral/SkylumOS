import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 1 << 20;
export const MAX_NODES = 256;
export const MAX_JOBS = 1000;
export const MAX_JOURNAL_RECORDS = 100_000;
export const MAX_SIGNAL_BYTES = 64 * 1024;
export const MAX_JOB_INPUT_BYTES = 256 * 1024;
export const MAX_JOB_RESULT_BYTES = 512 * 1024;
export const MAX_WHISPER_AUDIO_BYTES = 160 * 1024;
export const GENESIS_HASH = "0".repeat(64);
export const JOB_KINDS = Object.freeze(["probe", "claim.read", "skc.roundtrip", "infer.whisper"]);

const base64LengthLimit = bytes => 4 * Math.ceil(bytes / 3);

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function constantTimeEqual(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateNodeId(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new FabricError("node_id_invalid");
  return value;
}

export function validateJobId(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new FabricError("job_id_invalid");
  return value;
}

export function validateCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FabricError("capabilities_invalid");
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new FabricError("capabilities_invalid"); }
  if (Buffer.byteLength(encoded) > 16 * 1024) throw new FabricError("capabilities_too_large", 413);
  const copy = JSON.parse(encoded);
  for (const key of Object.keys(copy))
    if (FORBIDDEN_KEYS.has(key)) throw new FabricError("capabilities_invalid");
  return copy;
}

function containsCapability(caps, key, required) {
  let value = caps;
  for (const segment of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return false;
    value = value[segment];
  }
  return value === required;
}

export function validateJobInput(kind, input) {
  if (!JOB_KINDS.includes(kind)) throw new FabricError("job_kind_unsupported");
  let encoded;
  try { encoded = Buffer.from(JSON.stringify(input ?? null)); }
  catch { throw new FabricError("job_input_invalid"); }
  if (encoded.length > MAX_JOB_INPUT_BYTES) throw new FabricError("job_input_too_large", 413);
  if (kind === "probe" && input !== null && input !== undefined &&
      (typeof input !== "object" || Array.isArray(input))) throw new FabricError("job_input_invalid");
  if (kind === "claim.read") {
    if (!input || typeof input.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(input.name) || input.name.includes(".."))
      throw new FabricError("claim_name_invalid");
    if (input.maxBytes !== undefined &&
        (!Number.isInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes > MAX_JOB_RESULT_BYTES))
      throw new FabricError("claim_limit_invalid");
  }
  if (kind === "infer.whisper") {
    if (!input || typeof input.audio_b64 !== "string" ||
        Buffer.byteLength(input.audio_b64) > base64LengthLimit(MAX_WHISPER_AUDIO_BYTES))
      throw new FabricError("whisper_audio_invalid");
    const audio = Buffer.from(input.audio_b64, "base64");
    if (audio.toString("base64") !== input.audio_b64 || audio.length === 0 ||
        audio.length > MAX_WHISPER_AUDIO_BYTES) throw new FabricError("whisper_audio_invalid");
    if (input.filename !== undefined && (typeof input.filename !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.filename)))
      throw new FabricError("whisper_filename_invalid");
  }
  if (kind === "skc.roundtrip") {
    if (!input || typeof input.data !== "string" ||
        Buffer.byteLength(input.data) > base64LengthLimit(MAX_JOB_RESULT_BYTES))
      throw new FabricError("roundtrip_data_invalid");
    const decoded = Buffer.from(input.data, "base64");
    if (decoded.length === 0 || decoded.length > MAX_JOB_RESULT_BYTES ||
        decoded.toString("base64") !== input.data) throw new FabricError("roundtrip_data_invalid");
  }
  return JSON.parse(encoded.toString("utf8"));
}

export class FabricError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class FabricState {
  constructor({ now = Date.now, nodeTtlMs = 30_000, suspectAfterMs = 10_000,
    jobTimeoutMs = 15_000, maxNodes = MAX_NODES, journal = [] } = {}) {
    this.now = now;
    this.nodeTtlMs = nodeTtlMs;
    this.suspectAfterMs = suspectAfterMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.maxNodes = maxNodes;
    this.nodes = new Map();
    this.jobs = new Map();
    this.journal = [];
    this.rooms = new Map();
    this.sequence = 0;
    this.previousHash = GENESIS_HASH;
    for (const entry of journal) this.append(entry.type, entry.payload, entry.at);
  }

  append(type, payload, at = this.now()) {
    if (this.journal.length >= MAX_JOURNAL_RECORDS)
      throw new FabricError("journal_limit_reached", 507);
    let safePayload;
    try { safePayload = JSON.parse(JSON.stringify(payload)); }
    catch { throw new FabricError("journal_payload_invalid"); }
    const base = { seq: this.sequence + 1, prev_sha256: this.previousHash, type, payload: safePayload, at };
    const hash = sha256(canonicalJson(base));
    const entry = Object.freeze({ ...base, sha256: hash });
    this.journal.push(entry);
    this.sequence = entry.seq;
    this.previousHash = hash;
    return entry;
  }

  verifyJournal() { return verifyJournal(this.journal); }

  register(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FabricError("registration_invalid");
    const id = validateNodeId(input.id);
    const name = typeof input.name === "string" && input.name.trim().length <= 80
      ? input.name.trim() : id;
    const capabilities = validateCapabilities(input.capabilities);
    const incarnation = input.incarnation ?? 1;
    if (!Number.isSafeInteger(incarnation) || incarnation < 1)
      throw new FabricError("incarnation_invalid");
    const existing = this.nodes.get(id);
    if (existing && incarnation < existing.incarnation)
      throw new FabricError("incarnation_stale", 409);
    if (!existing && this.nodes.size >= this.maxNodes)
      throw new FabricError("node_limit_reached", 429);
    const endpoints = sanitizeEndpoints(input.endpoints);
    const created = this.now();
    const node = {
      id, name, capabilities, endpoints, incarnation,
      registered_at: existing?.registered_at ?? created,
      last_seen: created, status: "alive",
      pending_jobs: existing?.pending_jobs ?? 0,
      jobs: existing?.jobs ?? [],
    };
    this.append(existing ? "node.update" : "node.join", { id, incarnation, capabilities, endpoints });
    this.nodes.set(id, node);
    return publicNode(node, created);
  }

  heartbeat(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FabricError("heartbeat_invalid");
    const node = this.nodes.get(validateNodeId(input.id));
    if (!node) throw new FabricError("node_not_registered", 404);
    if (!Number.isSafeInteger(input.incarnation) || input.incarnation < node.incarnation)
      throw new FabricError("incarnation_stale", 409);
    const capabilities = input.capabilities === undefined
      ? node.capabilities : validateCapabilities(input.capabilities);
    const now = this.now();
    node.incarnation = input.incarnation;
    node.capabilities = capabilities;
    node.last_seen = now;
    node.status = "alive";
    return publicNode(node, now);
  }

  refreshLiveness() {
    const now = this.now();
    for (const node of this.nodes.values()) {
      const age = now - node.last_seen;
      const status = age >= this.nodeTtlMs ? "dead" :
        age >= this.suspectAfterMs ? "suspect" : "alive";
      if (status !== node.status) {
        this.append("node.liveness", { id: node.id, status });
        node.status = status;
      }
    }
  }

  createJob(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FabricError("job_invalid");
    const id = validateJobId(input.id);
    const kind = input.kind;
    const jobInput = validateJobInput(kind, input.input);
    const requirements = validateRequirements(input.capabilities_required);
    if (this.jobs.has(id)) {
      const existing = this.jobs.get(id);
      if (existing.kind !== kind || canonicalJson(existing.input) !== canonicalJson(jobInput) ||
          canonicalJson(existing.capabilities_required) !== canonicalJson(requirements))
        throw new FabricError("job_id_conflict", 409);
      return { job: publicJob(existing), duplicate: true };
    }
    if (this.jobs.size >= MAX_JOBS) throw new FabricError("job_limit_reached", 429);
    const replicas = input.replicas ?? 1;
    const quorum = input.quorum ?? 1;
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 16 ||
        !Number.isInteger(quorum) || quorum < 1 || quorum > replicas)
      throw new FabricError("job_quorum_invalid");
    const timeout = input.timeout_ms ?? this.jobTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000)
      throw new FabricError("job_timeout_invalid");
    const eligible = [...this.nodes.values()].filter(node =>
      node.status === "alive" && meetsRequirements(node.capabilities, requirements));
    if (!eligible.length) throw new FabricError("no_eligible_nodes", 503);
    if (eligible.length < replicas || eligible.length < quorum)
      throw new FabricError("job_nodes_insufficient", 503);
    const selected = chooseNodes(eligible, replicas);
    const created = this.now();
    const job = {
      id, kind, input: jobInput, state: "running", created_at: created,
      deadline: created + timeout, timeout_ms: timeout,
      replicas, required: quorum, selected: selected.map(node => node.id),
      results: new Map(), canonical: null, error: null,
      capabilities_required: requirements,
    };
    this.append("job.submit", { id, kind, replicas, quorum, nodes: job.selected });
    this.jobs.set(id, job);
    for (const node of selected) {
      node.pending_jobs++;
      node.jobs.push(id);
    }
    return { job: publicJob(job), duplicate: false };
  }

  claimJob(nodeId) {
    const node = this.nodes.get(validateNodeId(nodeId));
    if (!node || node.status !== "alive") return null;
    for (const job of this.jobs.values()) {
      if (job.state !== "running" || !job.selected.includes(node.id)) continue;
      const previous = job.results.get(node.id);
      const now = this.now();
      if (now >= job.deadline) {
        this.failJob(job, "timeout", "job_deadline_exceeded");
        continue;
      }
      if (previous?.state === "claimed" && now - previous.claimed_at < previous.timeout_ms)
        continue;
      if (previous?.state === "claimed") {
        this.append("job.worker_timeout", { id: job.id, node_id: node.id });
        job.results.set(node.id, { state: "failed", error: "worker_timeout" });
        this.reassign(job, node.id);
        continue;
      }
      if (previous) continue;
      const lease = Math.max(1, Math.min(job.timeout_ms, job.deadline - now));
      job.results.set(node.id, { state: "claimed", claimed_at: now, timeout_ms: lease });
      return { id: job.id, kind: job.kind, input: structuredClone(job.input), timeout_ms: lease };
    }
    return null;
  }

  submitResult(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FabricError("result_invalid");
    const nodeId = validateNodeId(input.node_id);
    const job = this.jobs.get(validateJobId(input.job_id));
    if (!job) throw new FabricError("job_not_found", 404);
    if (!job.selected.includes(nodeId)) throw new FabricError("job_node_not_selected", 403);
    if (job.state !== "running") return { job: publicJob(job), duplicate: true };
    if (this.now() >= job.deadline) {
      this.failJob(job, "timeout", "job_deadline_exceeded");
      return { job: publicJob(job), duplicate: false };
    }
    const previous = job.results.get(nodeId);
    if (previous?.state !== "claimed") {
      if (previous) return { job: publicJob(job), duplicate: true };
      throw new FabricError("job_not_claimed", 409);
    }
    let resultBytes;
    try { resultBytes = Buffer.from(JSON.stringify(input.result ?? null)); }
    catch { throw new FabricError("job_result_invalid"); }
    if (resultBytes.length > MAX_JOB_RESULT_BYTES)
      throw new FabricError("job_result_too_large", 413);
    const digest = sha256(resultBytes);
    if (input.sha256 !== digest) throw new FabricError("job_result_digest_mismatch", 422);
    const resultRecord = {
      state: "complete", result: JSON.parse(resultBytes.toString("utf8")),
      sha256: digest, completed_at: this.now(),
    };
    this.append("job.result", { id: job.id, node_id: nodeId, sha256: digest });
    job.results.set(nodeId, resultRecord);
    this.resolveJob(job);
    return { job: publicJob(job), duplicate: false };
  }

  resolveJob(job) {
    const votes = new Map();
    for (const result of job.results.values()) {
      if (result.state !== "complete") continue;
      const group = votes.get(result.sha256) ?? [];
      group.push(result);
      votes.set(result.sha256, group);
    }
    const winner = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (winner && winner[1].length >= job.required) {
      const canonical = { result: winner[1][0].result, sha256: winner[0], votes: winner[1].length };
      this.append("job.finish", { id: job.id, state: "complete", canonical_sha256: winner[0], error: null });
      job.state = "complete";
      job.canonical = canonical;
      this.releaseJobNodes(job);
      return;
    }
    const unresolved = job.selected.filter(id => !["complete", "failed"].includes(job.results.get(id)?.state));
    if ([...job.results.values()].filter(result => result.state === "complete").length + unresolved.length < job.required)
      this.failJob(job, "quorum_failed", "job_quorum_unavailable");
  }

  expireJobs() {
    for (const job of this.jobs.values()) {
      if (job.state !== "running") continue;
      for (const [nodeId, result] of job.results) {
        if (result.state !== "claimed" || this.now() - result.claimed_at < result.timeout_ms) continue;
        this.append("job.worker_timeout", { id: job.id, node_id: nodeId });
        job.results.set(nodeId, { state: "failed", error: "worker_timeout" });
        this.reassign(job, nodeId);
        break;
      }
      if (job.state === "running" && this.now() >= job.deadline)
        this.failJob(job, "timeout", "job_deadline_exceeded");
    }
  }

  reassign(job, from) {
    const eligible = [...this.nodes.values()].filter(node =>
      node.status === "alive" && !job.selected.includes(node.id) &&
      meetsRequirements(node.capabilities, job.capabilities_required));
    if (!eligible.length) {
      this.resolveJob(job);
      return;
    }
    const node = chooseNodes(eligible, 1)[0];
    this.append("job.reassign", { id: job.id, from, to: node.id });
    job.selected.push(node.id);
    node.pending_jobs++;
    node.jobs.push(job.id);
  }

  failJob(job, state, error) {
    if (job.state !== "running") return;
    this.append("job.finish", { id: job.id, state, canonical_sha256: null, error });
    job.state = state;
    job.error = error;
    this.releaseJobNodes(job);
  }

  releaseJobNodes(job) {
    for (const id of new Set(job.selected)) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const index = node.jobs.indexOf(job.id);
      if (index >= 0) {
        node.jobs.splice(index, 1);
        node.pending_jobs = Math.max(0, node.pending_jobs - 1);
      }
    }
  }

  validateSignal(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FabricError("signal_invalid");
    const from = validateNodeId(input.from);
    const to = validateNodeId(input.to);
    if (!["offer", "answer", "ice"].includes(input.type))
      throw new FabricError("signal_type_invalid");
    if (!this.nodes.has(from) || !this.nodes.has(to))
      throw new FabricError("signal_peer_unknown", 404);
    let payloadBytes;
    try { payloadBytes = Buffer.byteLength(JSON.stringify(input.payload ?? null)); }
    catch { throw new FabricError("signal_payload_invalid"); }
    if (payloadBytes > MAX_SIGNAL_BYTES) throw new FabricError("signal_payload_too_large", 413);
    return { from, to, type: input.type, payload: structuredClone(input.payload ?? null) };
  }

  sendSignal(input) {
    const packet = this.validateSignal(input);
    const room = this.rooms.get(packet.to) ?? [];
    room.push({ ...packet, at: this.now() });
    while (room.length > 128) room.shift();
    this.rooms.set(packet.to, room);
    return { queued: true };
  }

  takeSignals(nodeId) {
    const id = validateNodeId(nodeId);
    const queue = this.rooms.get(id) ?? [];
    this.rooms.set(id, []);
    return queue;
  }

  snapshot() {
    this.refreshLiveness();
    this.expireJobs();
    return {
      nodes: [...this.nodes.values()].map(node => publicNode(node, this.now())),
      jobs: [...this.jobs.values()].map(publicJob),
      journal: this.journal,
    };
  }
}

export function verifyJournal(entries) {
  let previous = GENESIS_HASH;
  let sequence = 0;
  for (const entry of entries) {
    const { sha256: actual, ...base } = entry;
    if (base.seq !== ++sequence || base.prev_sha256 !== previous ||
        !HASH_RE.test(actual) || sha256(canonicalJson(base)) !== actual)
      return { valid: false, sequence, expected_prev: previous };
    previous = actual;
  }
  return { valid: true, sequence, head: previous };
}

function meetsRequirements(capabilities, requirements) {
  for (const [key, expected] of Object.entries(requirements)) {
    if (!containsCapability(capabilities, key, expected)) return false;
  }
  return true;
}

function validateRequirements(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FabricError("job_capabilities_invalid");
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new FabricError("job_capabilities_invalid"); }
  if (Buffer.byteLength(encoded) > 4096) throw new FabricError("job_capabilities_invalid");
  const copy = JSON.parse(encoded);
  for (const [key, expected] of Object.entries(copy)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || FORBIDDEN_KEYS.has(key) ||
        !["string", "number", "boolean"].includes(typeof expected))
      throw new FabricError("job_capabilities_invalid");
  }
  return copy;
}

function sanitizeEndpoints(endpoints) {
  if (endpoints !== undefined && !Array.isArray(endpoints))
    throw new FabricError("endpoints_invalid");
  const result = [];
  for (const endpoint of endpoints ?? []) {
    if (!endpoint || typeof endpoint !== "object" || typeof endpoint.host !== "string" ||
        endpoint.host.length < 1 || endpoint.host.length > 128 || !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 || endpoint.port > 65535 ||
        !["lan", "v6", "loopback"].includes(endpoint.lane))
      throw new FabricError("endpoint_invalid");
    result.push({ host: endpoint.host, port: endpoint.port, lane: endpoint.lane });
    if (result.length > 8) throw new FabricError("endpoints_limit");
  }
  return result;
}

function chooseNodes(nodes, count) {
  return [...nodes].sort((a, b) =>
    a.pending_jobs - b.pending_jobs || a.last_seen - b.last_seen || a.id.localeCompare(b.id)).slice(0, count);
}

function publicNode(node, now) {
  return {
    id: node.id, name: node.name, capabilities: structuredClone(node.capabilities),
    endpoints: structuredClone(node.endpoints), incarnation: node.incarnation,
    registered_at: node.registered_at, last_seen: node.last_seen,
    age_ms: Math.max(0, now - node.last_seen), status: node.status,
    pending_jobs: node.pending_jobs,
  };
}

export { publicNode };

function publicJob(job) {
  return {
    id: job.id, kind: job.kind, state: job.state,
    created_at: job.created_at, deadline: job.deadline, timeout_ms: job.timeout_ms,
    replicas: job.selected.length, quorum: job.required, nodes: [...job.selected],
    results: [...job.results.entries()].map(([node_id, result]) => ({
      node_id, state: result.state, sha256: result.sha256 ?? null,
    })),
    canonical: job.canonical ? { sha256: job.canonical.sha256, votes: job.canonical.votes } : null,
    error: job.error,
  };
}

export { publicJob };
