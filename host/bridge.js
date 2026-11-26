import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { authorizeToken, createHostProtocol, HOST_PROTOCOL_VERSION, MAX_REQUEST_BYTES } from "./protocol.js";

const HOST = "127.0.0.1";

export async function startBridge({ runtime, token = randomBytes(32).toString("hex"),
  port = 0, host = HOST, allowedOrigins = [] } = {}) {
  if (!runtime) throw new Error("bridge_runtime_required");
  if (host !== HOST && host !== "::1") throw new Error("bridge_bind_must_be_loopback");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("bridge_port_invalid");
  const protocol = createHostProtocol(runtime);
  const origins = new Set(allowedOrigins);
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return reply(res, 403, { error: "bridge_origin_denied" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": origin ?? "null",
        "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization",
        "vary": "origin" });
      return res.end();
    }
    if (req.method !== "POST" || req.url !== "/v1/command")
      return reply(res, 404, { error: "bridge_route_not_found" });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !authorizeToken(token, auth.slice(7)))
      return reply(res, 401, { error: "bridge_unauthorized" });
    const length = Number(req.headers["content-length"] ?? 0);
    if (req.headers["content-length"] === undefined || !Number.isSafeInteger(length) ||
        length < 0 || length > MAX_REQUEST_BYTES)
      return reply(res, 413, { error: "bridge_request_too_large" });
    try {
      const raw = await readBody(req, MAX_REQUEST_BYTES);
      const input = JSON.parse(raw.toString("utf8"));
      if (input.version !== HOST_PROTOCOL_VERSION || typeof input.command !== "string")
        throw new Error("bridge_request_invalid");
      const value = await protocol.dispatch(input.command, input.args ?? {});
      return reply(res, 200, { version: HOST_PROTOCOL_VERSION, value }, origin);
    } catch (error) {
      if (error.message === "bridge_request_too_large")
        return reply(res, 413, { version: HOST_PROTOCOL_VERSION, error: error.message }, origin);
      const status = error.message === "host_command_denied" ? 403 :
        400;
      return reply(res, status, { version: HOST_PROTOCOL_VERSION, error: error.message || "host_error" }, origin);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  return Object.freeze({
    host, port: address.port, token,
    url: `http://${host}:${address.port}/v1/command`,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("bridge_request_too_large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

function reply(res, status, body, origin) {
  const headers = { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
