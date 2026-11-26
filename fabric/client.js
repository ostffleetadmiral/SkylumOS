export const FABRIC_PROTOCOL = 1;
const PUBLIC_READS = new Set(["status", "nodes", "jobs", "journal"]);
const PRIVATE_READS = new Set(["next", "signals"]);
const MUTATION_PATHS = new Set(["/v1/register", "/v1/heartbeat", "/v1/job",
  "/v1/result", "/v1/signal"]);
const MAX_RESPONSE_BYTES = 1 << 20;

export class FabricNode extends EventTarget {
  constructor({ url = "http://127.0.0.1:8977", token = "", id = null,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.base = new URL(url);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username ||
        this.base.password || this.base.pathname !== "/" || this.base.search || this.base.hash)
      throw new Error("fabric_url_invalid");
    if (typeof fetchImpl !== "function") throw new Error("fabric_fetch_unavailable");
    this.token = token;
    this.id = id;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.timer = null;
    this.closed = true;
  }

  get(resource) {
    if (!PUBLIC_READS.has(resource)) throw new Error("fabric_resource_invalid");
    return this.request(`/v1/${resource}`);
  }

  async request(path, { method = "GET", body, signal } = {}) {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/v1/"))
      throw new Error("fabric_route_invalid");
    const route = url.pathname;
    const publicRead = PUBLIC_READS.has(route.slice(4));
    const privateRead = PRIVATE_READS.has(route.slice(4));
    const mutation = MUTATION_PATHS.has(route);
    if (!publicRead && !privateRead && !mutation) throw new Error("fabric_route_invalid");
    if ((mutation || privateRead) && !this.token) throw new Error("fabric_token_required");
    const headers = { accept: "application/json" };
    if (method === "POST" || privateRead) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetch(url, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal, cache: "no-store", redirect: "error",
    });
    if (Number(response.headers.get("content-length") || 0) > MAX_RESPONSE_BYTES)
      throw new Error("fabric_response_too_large");
    const text = response.status === 204 ? "" : await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
      throw new Error("fabric_response_too_large");
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { throw new Error("fabric_response_invalid"); }
    }
    if (!response.ok) throw new Error(data?.error || `fabric_http_${response.status}`);
    return data;
  }

  register(node) { return this.request("/v1/register", { method: "POST", body: node }); }
  heartbeat(node) { return this.request("/v1/heartbeat", { method: "POST", body: node }); }
  submitJob(job) { return this.request("/v1/job", { method: "POST", body: job }); }
  submitResult(result) { return this.request("/v1/result", { method: "POST", body: result }); }

  async connect({ id, name = id, capabilities = {}, endpoints = [], incarnation = 1,
    heartbeatMs = 5000 } = {}) {
    if (!this.token) throw new Error("fabric_token_required");
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(id))
      throw new Error("fabric_node_id_invalid");
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 250 || heartbeatMs > 60_000)
      throw new Error("fabric_heartbeat_interval_invalid");
    this.id = id;
    this.closed = false;
    let enrollment;
    try {
      enrollment = await this.register({ id, name, capabilities, endpoints, incarnation });
    } catch (error) {
      this.closed = true;
      throw error;
    }
    this.dispatchEvent(new CustomEvent("registered", { detail: enrollment }));
    const pulse = async () => {
      if (this.closed) return;
      try {
        const status = await this.heartbeat({ id, incarnation, capabilities });
        this.dispatchEvent(new CustomEvent("heartbeat", { detail: status }));
      } catch (error) {
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      }
      if (!this.closed) this.timer = setTimeout(pulse, heartbeatMs);
    };
    this.timer = setTimeout(pulse, heartbeatMs);
    return enrollment;
  }

  joinSignaling() {
    if (!this.token || !this.id) throw new Error("fabric_registration_required");
    if (!this.WebSocketImpl) throw new Error("websocket_unavailable");
    const socketUrl = new URL("/v1/signal", this.base);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("node", this.id);
    socketUrl.searchParams.set("token", this.token);
    this.socket = new this.WebSocketImpl(socketUrl);
    this.socket.addEventListener("message", event => {
      try { this.dispatchEvent(new CustomEvent("signal", { detail: JSON.parse(event.data) })); }
      catch (error) { this.dispatchEvent(new CustomEvent("error", { detail: error })); }
    });
    this.socket.addEventListener("open", () => this.dispatchEvent(new Event("signaling-open")));
    this.socket.addEventListener("close", () => this.dispatchEvent(new Event("signaling-close")));
    return this.socket;
  }

  sendSignal({ to, type, payload }) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN)
      throw new Error("signaling_not_open");
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(to) ||
        !["offer", "answer", "ice"].includes(type)) throw new Error("signal_invalid");
    const message = JSON.stringify({ to, type, payload });
    if (new TextEncoder().encode(message).byteLength > 64 * 1024)
      throw new Error("signal_payload_too_large");
    this.socket.send(message);
  }

  async disconnect() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, "client shutdown");
    this.socket = null;
  }
}
