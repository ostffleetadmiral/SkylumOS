// Fabric head proxy for the Electron main process. The renderer's
// Skyloom Fabric app talks IPC-only; this module performs the real HTTP
// fetch in the trusted main process so the head URL and bearer token stay
// in SKYOS_FABRIC_URL / SKYOS_FABRIC_TOKEN env — never in renderer JS,
// never in the quine bundle, and never blocked by the skyos:// CSP.

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 15_000;

function createFabricProxy({ baseUrl, token = "", fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username ||
      base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("fabric_url_invalid");
  if (typeof fetchImpl !== "function") throw new Error("fabric_fetch_unavailable");
  const auth = typeof token === "string" && token.length > 0
    ? `Bearer ${token}` : null;

  return async function fabricRequest({ path, method = "GET", body = null } = {}) {
    if (typeof path !== "string" || !path.startsWith("/v1/") ||
        path.length > MAX_PATH_LENGTH || /[\x00-\x20\x7f]/.test(path))
      throw new Error("fabric_path_invalid");
    if (method !== "GET" && method !== "POST")
      throw new Error("fabric_method_invalid");
    if (method === "GET" && body !== null) throw new Error("fabric_body_invalid");
    if (body !== null && (typeof body !== "string" ||
        Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES))
      throw new Error("fabric_body_invalid");
    const headers = { accept: "application/json" };
    if (auth) headers.authorization = auth;
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await fetchImpl(new URL(path, base), {
      method, headers,
      body: method === "POST" ? body : undefined,
      redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BODY_BYTES)
      throw new Error("fabric_response_too_large");
    return { status: response.status, body: text };
  };
}

module.exports = { createFabricProxy };
