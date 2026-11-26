const DEFAULT_BASE = "http://127.0.0.1:8977";
const MAX_RESPONSE_BYTES = 1 << 20;
const MUTATION_PATHS = new Set(["/v1/register", "/v1/heartbeat", "/v1/job",
  "/v1/result", "/v1/signal"]);

export class FabricClient {
  constructor({ baseUrl = DEFAULT_BASE, token = "", fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = new URL(baseUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username ||
        this.baseUrl.password || this.baseUrl.pathname !== "/" || this.baseUrl.search || this.baseUrl.hash)
      throw new Error("fabric_url_invalid");
    if (typeof fetchImpl !== "function") throw new Error("fabric_fetch_unavailable");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async get(path, { signal } = {}) {
    return this.request(path, { method: "GET", signal });
  }

  async post(path, body, { signal } = {}) {
    return this.request(path, { method: "POST", body: JSON.stringify(body), signal });
  }

  async request(path, options) {
    const route = path.split("?", 1)[0];
    const publicRead = /^\/v1\/(status|nodes|jobs|journal)$/.test(route);
    const privateRead = /^\/v1\/(next|signals)$/.test(route);
    if (!publicRead && !privateRead && !MUTATION_PATHS.has(route))
      throw new Error("fabric_route_invalid");
    if ((MUTATION_PATHS.has(route) || privateRead) && !this.token)
      throw new Error("fabric_token_required");
    const headers = { accept: "application/json" };
    if (options.method === "POST" || privateRead) {
      headers["content-type"] = "application/json";
      headers.authorization = `Bearer ${this.token}`;
    }
    if (options.method === "GET" && (path.startsWith("/v1/next") || path.startsWith("/v1/signals"))) {
      if (this.token) headers.authorization = `Bearer ${this.token}`;
    }
    const response = await this.fetch(new URL(path, this.baseUrl), {
      ...options, headers, cache: "no-store", redirect: "error",
    });
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_RESPONSE_BYTES) throw new Error("fabric_response_too_large");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
      throw new Error("fabric_response_too_large");
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { throw new Error("fabric_response_invalid"); }
    }
    if (!response.ok) throw new Error(data?.error || `fabric_http_${response.status}`);
    return data;
  }

  status(options) { return this.get("/v1/status", options); }
  nodes(options) { return this.get("/v1/nodes", options); }
  jobs(options) { return this.get("/v1/jobs", options); }
  journal(options) { return this.get("/v1/journal?limit=50", options); }
  submitJob(job, options) { return this.post("/v1/job", job, options); }
}

export function createFabricClient(options = {}) {
  return new FabricClient({
    baseUrl: options.baseUrl || (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FABRIC_URL) || DEFAULT_BASE,
    token: options.token || (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FABRIC_TOKEN) || "",
    ...options,
  });
}
