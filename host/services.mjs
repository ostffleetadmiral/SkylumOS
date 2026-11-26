// External runtime manifest — the single source for the loopback ports,
// probe paths, display hints, and launch candidates that docs/PORTS.md
// documents. Browser-safe: no node imports, no side effects. The ECHO
// embed lane renders probes and offline panels from this; node-side
// supervisors (Electron main, host CLI) resolve launch candidates against
// the local filesystem and spawn them. Nothing here starts anything by
// itself — reachability is always measured by the caller.

export const SERVICE_REPO_ROOTS = Object.freeze({
  godseye: Object.freeze({
    env: "SKYOS_GEV_DIR",
    segments: Object.freeze(["foundations", "gods-eye-view"]),
  }),
  spaceagent: Object.freeze({
    env: "SKYOS_SPACE_AGENT_DIR",
    segments: Object.freeze(["foundations", "space-agent"]),
  }),
});

export const EXTERNAL_SERVICES = Object.freeze({
  godseye: Object.freeze({
    name: "God's Eye View",
    port: 3200,
    page: "http://127.0.0.1:3200/index.html",
    probePath: "/index.html",
    start: "cd foundations/gods-eye-view && python3 -m http.server 3200 -d dist",
    hint: "static bundle serves the keyless layers; PORT=3200 bun run dev adds the API-brokering server for keyed layers",
    launches: Object.freeze([
      Object.freeze({
        cmd: "python3",
        args: Object.freeze(["-m", "http.server", "3200", "-d", "dist"]),
        requires: Object.freeze(["dist/index.html"]),
      }),
      Object.freeze({
        cmd: "bun",
        args: Object.freeze(["run", "dev"]),
        env: Object.freeze({ PORT: "3200" }),
        requires: Object.freeze(["package.json", "vite.config.js"]),
        requiresDirs: Object.freeze(["node_modules"]),
      }),
    ]),
  }),
  spaceagent: Object.freeze({
    name: "Space Agent",
    port: 3100,
    page: "http://127.0.0.1:3100/",
    probePath: "/api/health",
    start: "cd foundations/space-agent && bun space serve PORT=3100 SINGLE_USER_APP=true",
    hint: "single-user kiosk runtime — the window shows its Enter Space launcher first",
    launches: Object.freeze([
      Object.freeze({
        cmd: "bun",
        args: Object.freeze(["space", "serve"]),
        env: Object.freeze({ PORT: "3100", SINGLE_USER_APP: "true" }),
        requires: Object.freeze(["package.json"]),
        requiresDirs: Object.freeze(["node_modules"]),
      }),
    ]),
  }),
});

export function serviceProbeUrl(service) {
  return `http://127.0.0.1:${service.port}${service.probePath}`;
}
