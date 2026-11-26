// ECHO external-app windows — hosted runtimes mounted as real desktop
// windows. Each window probes its standardized loopback port, mounts the
// app in an iframe when it answers, and shows the exact start command
// while it does not. Reachability is measured, never assumed; ports and
// launch candidates come from the canonical manifest in host/services.mjs
// (docs/PORTS.md). When a host supervisor is present (Electron, host CLI)
// the offline panel reflects its live state — starting, missing
// prerequisites, or a manual start action — instead of only the command.

import { EXTERNAL_SERVICES, serviceProbeUrl } from "../../host/services.mjs";

export const EMBED_TARGETS = Object.freeze(Object.fromEntries(
  Object.entries(EXTERNAL_SERVICES).map(([key, service]) => [key, Object.freeze({
    key,
    name: service.name,
    // GEV's ?embed=1 contract is intentionally view-only (HUD, welcome and
    // setup hidden, postMessage-driven) — a desktop window wants the full
    // interactive shell, so the manifest frames the plain index instead.
    url: service.page,
    probe: serviceProbeUrl(service),
    start: service.start,
    hint: service.hint,
  })]),
));

export function mountEmbed(root, ctx, key) {
  const spec = EMBED_TARGETS[key];
  const doc = root.ownerDocument;
  const startInterval = ctx.setInterval ?? globalThis.setInterval;
  const stopInterval = ctx.clearInterval ?? globalThis.clearInterval;
  const wrap = doc.createElement("div");
  wrap.className = "embed-app";
  root.append(wrap);

  const hostApi = () => ctx.os?.host ?? null;
  const serviceState = async () => {
    const api = hostApi();
    if (!api || typeof api.servicesStatus !== "function") return null;
    try {
      const status = await api.servicesStatus();
      return status?.services?.[key] ?? null;
    } catch { return null; }
  };

  const panel = async () => {
    const state = await serviceState();
    const el = doc.createElement("div");
    el.className = "embed-offline";
    const title = doc.createElement("p");
    title.className = "embed-offline-title";
    if (state?.state === "starting") title.textContent = `${spec.name} runtime is starting…`;
    else if (state?.state === "missing") title.textContent = `${spec.name} runtime is not installed on this machine`;
    else if (state?.state === "failed") title.textContent = `${spec.name} runtime failed to start`;
    else title.textContent = `${spec.name} runtime is not reachable`;
    const cmd = doc.createElement("code");
    cmd.textContent = spec.start;
    const hint = doc.createElement("p");
    hint.className = "embed-offline-hint";
    hint.textContent = spec.hint;
    el.append(title, cmd, hint);
    if (state?.detail) {
      const detail = doc.createElement("p");
      detail.className = "embed-offline-detail";
      detail.textContent = state.detail;
      el.append(detail);
    }
    const api = hostApi();
    if (api && typeof api.ensureServices === "function") {
      const button = doc.createElement("button");
      button.className = "embed-start";
      button.textContent = state?.state === "starting" ? "Starting…" : "Start runtime";
      button.disabled = state?.state === "starting";
      button.onclick = () => { api.ensureServices({ id: key }).catch(() => {}); };
      el.append(button);
    }
    return el;
  };

  let timer = null;
  const probe = async () => {
    let up = false;
    try {
      // no-cors: opaque response, we only need reachability — the iframe
      // renders the real page or the runtime's own error surface.
      await globalThis.fetch(spec.probe, { mode: "no-cors", cache: "no-store" });
      up = true;
    } catch { /* unreachable */ }
    if (!ctx.isCurrent()) return;
    if (up) {
      if (timer) { stopInterval(timer); timer = null; }
      const frame = doc.createElement("iframe");
      frame.src = spec.url;
      frame.className = "embed-frame";
      frame.title = spec.name;
      wrap.replaceChildren();
      wrap.append(frame);
    } else {
      // Rebuild each cycle so host-supervisor state (starting → up/failed)
      // stays fresh; the next successful probe still swaps to the iframe.
      const offline = await panel();
      wrap.replaceChildren();
      wrap.append(offline);
    }
  };
  probe();
  timer = startInterval(probe, 5000);
  return () => { if (timer) stopInterval(timer); };
}

export const mountGodseye = (root, ctx) => mountEmbed(root, ctx, "godseye");
export const mountSpaceagent = (root, ctx) => mountEmbed(root, ctx, "spaceagent");
