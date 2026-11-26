#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  FabricError, FabricState, MAX_BODY_BYTES, MAX_SIGNAL_BYTES,
  constantTimeEqual, sha256, verifyJournal, publicNode as nodeView, publicJob as jobView,
} from "./core.mjs";

export const FABRIC_PORT = Number(process.env.FABRIC_PORT || 8977);
const DEFAULT_TOKEN_PATH = process.env.FABRIC_TOKEN_FILE || resolve(".skyos/fabric.token");
const HEADER_LIMIT = 16 * 1024;
const HEARTBEAT_POLL_MS = 1000;
const MAX_REQUEST_TIMEOUT_MS = 15_000;
const MAX_SIGNAL_FRAME_BYTES = MAX_SIGNAL_BYTES + 4096;
const PRIVATE_READ_ROUTES = new Set(["GET /v1/next", "GET /v1/signals"]);
const PUBLIC_ROUTES = new Set(["GET /v1/status", "GET /v1/nodes", "GET /v1/jobs", "GET /v1/journal"]);
const MUTATION_ROUTES = new Set([
  "POST /v1/register", "POST /v1/heartbeat", "POST /v1/job", "POST /v1/result",
  "POST /v1/signal",
]);

export function createFabricServer({ token = process.env.FABRIC_TOKEN, host = process.env.FABRIC_HOST || "127.0.0.1",
  port = FABRIC_PORT, state = new FabricState(), now = Date.now, maxBodyBytes = MAX_BODY_BYTES,
  allowOrigin = "" } = {}) {
  if (typeof token !== "string" || Buffer.byteLength(token) < 24)
    throw new Error("fabric_token_required_min_24_bytes");
  if (!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(host))
    throw new Error("fabric_bind_invalid");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("fabric_port_invalid");
  const clients = new Map();
  let stopping = false;

  const server = createServer({ maxHeaderSize: HEADER_LIMIT }, async (req, res) => {
    setHeaders(res, allowOrigin);
    const url = new URL(req.url || "/", "http://fabric.local");
    const key = `${req.method} ${url.pathname}`;
    const privateRead = PRIVATE_READ_ROUTES.has(key);
    const knownPath = [...PUBLIC_ROUTES, ...PRIVATE_READ_ROUTES, ...MUTATION_ROUTES]
      .some(route => route.endsWith(` ${url.pathname}`));
    const preflight = req.method === "OPTIONS" && knownPath;
    if (!PUBLIC_ROUTES.has(key) && !MUTATION_ROUTES.has(key) && !privateRead && !preflight)
      return send(res, 404, { error: "route_not_found" });
    if (MUTATION_ROUTES.has(key) && !authorize(req, token))
      return send(res, 401, { error: "unauthorized" });
    try {
      if (req.method === "OPTIONS") {
        const origin = req.headers.origin || "";
        if (origin && allowOrigin && allowOrigin !== "*" && origin !== allowOrigin)
          return send(res, 403, { error: "origin_denied" });
        if (origin && allowOrigin) res.setHeader("access-control-allow-origin", allowOrigin === "*" ? "*" : origin);
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        res.setHeader("access-control-max-age", "600");
        return send(res, 204);
      }
      if (privateRead) {
        const nodeId = url.searchParams.get("node");
        const queryToken = url.searchParams.get("token") || "";
        const headerAuthorized = authorize(req, token);
        if (!state.nodes.has(nodeId) || (!headerAuthorized && !constantTimeEqual(token, queryToken)))
          return send(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET") return await handleGet(req, res, url, key, state, clients);
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const body = await readJson(req, maxBodyBytes);
      return await handlePost(req, res, key, body, state, clients, now);
    } catch (error) {
      if (error.code === "ERR_HTTP_REQUEST_TIMEOUT" || error.code === "fabric_request_timeout")
        return res.destroy();
      if (res.headersSent) return res.destroy();
      const status = error instanceof FabricError ? error.status :
        error.code === "fabric_body_too_large" ? 413 :
        error.code === "fabric_json_invalid" ? 400 : 400;
      send(res, status, { error: error.code || error.message || "fabric_error" });
    }
  });
  server.requestTimeout = MAX_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://fabric.local");
    if (url.pathname !== "/v1/signal") return rejectUpgrade(socket, 401);
    const nodeId = url.searchParams.get("node");
    const bearer = req.headers.authorization || "";
    if (!nodeId || !state.nodes.has(nodeId)) return rejectUpgrade(socket, 403);
    const queryToken = url.searchParams.get("token") || "";
    if (bearer.startsWith("Bearer ") ? !authorize(req, token) : !constantTimeEqual(token, queryToken))
      return rejectUpgrade(socket, 401);
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" ||
        req.headers["sec-websocket-version"] !== "13")
      return rejectUpgrade(socket, 400);
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const peer = { socket, nodeId, buffer: Buffer.alloc(0), alive: true };
    clients.set(nodeId, peer);
    const queued = state.takeSignals(nodeId);
    for (const signal of queued) sendWebSocket(peer, JSON.stringify(signal));
    socket.on("data", chunk => {
      peer.buffer = Buffer.concat([peer.buffer, chunk]);
      try { drainFrames(peer, state, clients); } catch { socket.destroy(); }
    });
    socket.on("close", () => { if (clients.get(nodeId) === peer) clients.delete(nodeId); });
    socket.on("error", () => { if (clients.get(nodeId) === peer) clients.delete(nodeId); });
  });

  const sweep = setInterval(() => {
    if (stopping) return;
    state.refreshLiveness();
    state.expireJobs();
    for (const [id, peer] of clients) {
      const node = state.nodes.get(id);
      if (!node || node.status === "dead") {
        peer.socket.destroy();
        clients.delete(id);
      }
    }
  }, HEARTBEAT_POLL_MS);
  sweep.unref?.();

  return Object.freeze({
    server, state,
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolveListen(); });
      });
      const address = server.address();
      return { host, port: address.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
    },
    async close() {
      stopping = true;
      clearInterval(sweep);
      for (const peer of clients.values()) peer.socket.destroy();
      clients.clear();
      await new Promise((resolveClose, reject) =>
        server.close(error => error ? reject(error) : resolveClose()));
    },
  });
}

async function handleGet(req, res, url, key, state, clients) {
  state.refreshLiveness();
  state.expireJobs();
  if (key === "GET /v1/status") {
    return send(res, 200, {
      version: 1, service: "Skyloom Fabric", mode: "single-head",
      node: process.env.FABRIC_HEAD_ID || "head", bind: serverAddress(req),
      lanes: { lan: true, ipv6: true, public_wan: false, wan_hairpin: "down" },
      counts: { nodes: state.nodes.size, online: [...state.nodes.values()].filter(n => n.status === "alive").length,
        jobs: state.jobs.size, journal: state.journal.length },
      head: { id: process.env.FABRIC_HEAD_ID || "head", journal_authority: true },
    });
  }
  if (key === "GET /v1/nodes") return send(res, 200, { nodes: [...state.nodes.values()].map(n => nodeView(n, Date.now())) });
  if (key === "GET /v1/jobs") return send(res, 200, { jobs: [...state.jobs.values()].map(jobView) });
  if (key === "GET /v1/journal") {
    const verified = verifyJournal(state.journal);
    const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
    const entries = state.journal.slice(-limit);
    return send(res, 200, { entries, verification: verified,
      authority: "single-head, tamper-evident sequencer; not Byzantine fault tolerant" });
  }
  if (key === "GET /v1/next") {
    const id = url.searchParams.get("node");
    const job = id ? state.claimJob(id) : null;
    return send(res, job ? 200 : 204, job || undefined);
  }
  if (key === "GET /v1/signals") {
    const id = url.searchParams.get("node");
    if (!id || !state.nodes.has(id)) throw new FabricError("node_not_registered", 404);
    const peer = clients.get(id);
    return send(res, 200, { signals: peer ? [] : state.takeSignals(id) });
  }
}

async function handlePost(req, res, key, body, state, clients, now) {
  if (key === "POST /v1/register") {
    const result = state.register(body);
    return send(res, 201, { node: result, head: "single-authority" });
  }
  if (key === "POST /v1/heartbeat") {
    const result = state.heartbeat(body);
    return send(res, 200, { node: result });
  }
  if (key === "POST /v1/job") {
    const id = body.id || randomUUID();
    const result = state.createJob({ ...body, id });
    return send(res, result.duplicate ? 200 : 202, result);
  }
  if (key === "POST /v1/result") {
    const result = state.submitResult(body);
    return send(res, 200, result);
  }
  if (key === "POST /v1/signal") {
    const packet = state.validateSignal(body);
    if (!clients.has(packet.to)) {
      state.sendSignal(body);
    } else {
      const wsPacket = { ...packet, at: now() };
      if (Buffer.byteLength(JSON.stringify(wsPacket)) > MAX_SIGNAL_FRAME_BYTES)
        throw new FabricError("signal_payload_too_large", 413);
      sendWebSocket(clients.get(packet.to), JSON.stringify(wsPacket));
    }
    return send(res, 202, { queued: true });
  }
  if (key === "OPTIONS") return send(res, 404, { error: "route_not_found" });
}

async function readJson(req, limit) {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    req.resume();
    throw Object.assign(new Error("fabric_body_too_large"), { code: "fabric_body_too_large" });
  }
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), MAX_REQUEST_TIMEOUT_MS);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        req.resume();
        throw Object.assign(new Error("fabric_body_too_large"), { code: "fabric_body_too_large" });
      }
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("json_object_required");
      return value;
    } catch {
      throw Object.assign(new Error("fabric_json_invalid"), { code: "fabric_json_invalid" });
    }
  } finally {
    clearTimeout(timer);
  }
}

function authorize(req, token) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") && constantTimeEqual(token, auth.slice(7));
}

function setHeaders(res, allowOrigin) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  const origin = res.req?.headers?.origin || "";
  if (origin && allowOrigin && (allowOrigin === "*" || origin === allowOrigin)) {
    res.setHeader("access-control-allow-origin", allowOrigin === "*" ? "*" : origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    if (allowOrigin !== "*") res.setHeader("vary", "origin");
  } else if (origin && allowOrigin && origin !== allowOrigin) {
    res.setHeader("vary", "origin");
  }
}

function send(res, status, body) {
  res.statusCode = status;
  if (body === undefined || status === 204) return res.end();
  res.end(JSON.stringify(body));
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function serverAddress(req) {
  return req.headers.host || "";
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
}

function drainFrames(peer, state, clients) {
  while (peer.buffer.length >= 2) {
    const first = peer.buffer[0], second = peer.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (!masked) throw new Error("websocket_client_frame_unmasked");
    if (length === 126) {
      if (peer.buffer.length < 4) return;
      length = peer.buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) throw new Error("websocket_frame_too_large");
    if (length > MAX_SIGNAL_FRAME_BYTES) throw new Error("websocket_frame_too_large");
    if (peer.buffer.length < offset + 4 + length) return;
    const mask = peer.buffer.subarray(offset, offset + 4);
    offset += 4;
    const data = Buffer.from(peer.buffer.subarray(offset, offset + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    peer.buffer = peer.buffer.subarray(offset + length);
    if (opcode === 8) { peer.socket.end(websocketFrame(Buffer.alloc(0), 8)); return; }
    if (opcode !== 1) continue;
    const message = JSON.parse(data.toString("utf8"));
    const packet = { ...message, from: peer.nodeId };
    const recipient = clients.get(packet.to);
    if (!state.nodes.has(packet.to) || !["offer", "answer", "ice"].includes(packet.type)) continue;
    if (recipient) sendWebSocket(recipient, JSON.stringify(packet));
    else state.sendSignal(packet);
  }
}

function sendWebSocket(peer, text) {
  if (peer?.socket.destroyed) return;
  peer.socket.write(websocketFrame(Buffer.from(text)));
}

function websocketFrame(data, opcode = 1) {
  if (data.length > MAX_SIGNAL_FRAME_BYTES) throw new Error("websocket_frame_too_large");
  if (data.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
  const head = Buffer.alloc(4);
  head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

export function resultDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value ?? null)));
}

export function readBearerToken(path = DEFAULT_TOKEN_PATH) {
  return import("node:fs/promises").then(({ readFile }) =>
    readFile(path, "utf8").then(value => value.trim()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
    process.argv[2] !== "--library" && process.argv[2] !== "--test") {
  let token = process.env.FABRIC_TOKEN;
  if (!token) {
    try { token = await readBearerToken(); }
    catch {
      console.error(`Set FABRIC_TOKEN or create a 0600 token file at ${DEFAULT_TOKEN_PATH}.`);
      process.exit(1);
    }
  }
  const fabric = createFabricServer({ token });
  const address = await fabric.listen();
  console.log(`Skyloom Fabric listening on ${address.url}`);
  console.log("Single-head authority; LAN/IPv6 only; WAN hairpin is not available.");
  const stop = async () => { await fabric.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
