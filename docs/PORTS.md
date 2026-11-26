# Port map — standardized loopback endpoints

Every hosted runtime that a SkylumOS desktop window embeds owns one loopback
port. Embeds (Next rewrites, ECHO iframe windows, terminal probes) reference
the port, never a hardcoded PID or ephemeral bind. `HOST` stays loopback-only
unless a runtime documents a deliberate LAN opt-in.

| Port  | Surface                          | Repo                                   | Start command                                                        |
|-------|----------------------------------|----------------------------------------|---------------------------------------------------------------------|
| 3000  | Skylum web desktop (Next dev)    | SkylumOS repository root               | `bun run dev`                                                       |
| 3100  | Space Agent runtime              | `foundations/space-agent`              | `bun space serve PORT=3100 SINGLE_USER_APP=true`                    |
| 3200  | God's Eye View                   | `foundations/gods-eye-view`            | `python3 -m http.server 3200 -d dist` (static, keyless layers) or `PORT=3200 bun run dev` (full API-brokering server) |
| 8931  | SkyOS quine artifacts (dev)      | `skyos/`                               | `python3 -m http.server 8931` from the repository root                |
| 8977  | Skyloom Fabric head (HTTP/WS)    | `skyos/fabric/`                        | `FABRIC_HOST=127.0.0.1 FABRIC_PORT=8977 bun skyos/fabric/server.mjs` (LAN opt-in: `FABRIC_HOST=0.0.0.0`; see `docs/FABRIC.md`) |
| 19000–20999 | Electron CDP debug (tests) | `skyos/tests`                          | allocated per-run by the electron test harness                       |

## Rules

- One app, one port. Never remap a runtime's canonical port to resolve a
  conflict; fix the conflicting squatter.
- `SINGLE_USER_APP=true` is the standard kiosk principal for the embedded
  Space Agent window — same contract the packaged Electron host uses.
- Overrides ride environment variables, not edits: `SPACE_AGENT_URL`
  (Next rewrite target), `PORT` (space-agent, GEV).
- The Skylum Next desktop presents Space Agent at its own same-origin
  `/space-agent` and proxies that runtime's route families; ECHO/Electron
  frames the loopback service directly at `127.0.0.1:3100`.
- A window embeds by probing reachability first, then iframing; when the
  port is silent it shows the exact start command above — it never fakes
  availability.
- GEV's `?embed=1` flag is its remote-controlled view contract: the globe
  only — HUD, welcome, and setup prompts all hidden, driven by
  `gev:view` postMessages. Desktop windows therefore frame the plain
  `index.html` so the full interactive shell (controls, layers, welcome
  flow) is present. Static `python3` serve sends no frame-ancestors
  headers, so framing works; keyed layers show "KEY REQUIRED" honestly
  until `.env` tokens are set (see `foundations/gods-eye-view/.env.example`).
- `skyos://` CSP permits `frame-src http://127.0.0.1:* http://localhost:*`
  — loopback embeds only, no remote framing.

## Auto-start / machine seeding

`host/services.mjs` is the canonical manifest for embeddable runtimes —
ports, probe paths, start commands, and ordered launch candidates. It is
the single source `embed.js` renders from and node-side supervisors spawn
from; `docs/PORTS.md` and the manifest must stay in agreement.

- **Electron host** (`echo/electron/main.cjs`): on startup the service
  supervisor probes each manifest port. A runtime already answering is
  reported `external` and is never adopted or killed. A silent port with
  launchable prerequisites (repo dir + required files + command on PATH)
  is spawned with logs under `<userData>/service-logs/`; the embed
  window's 5-second re-probe attaches the iframe as soon as it answers.
  `SKYOS_AUTOSTART=0` disables auto-start; `SKYOS_AUTOSTART=godseye,...`
  limits it. Only supervisor-spawned children are reaped on quit.
  `SKYOS_GEV_DIR` / `SKYOS_SPACE_AGENT_DIR` override repo locations.
- **Host CLI**: `bun host/cli.js --mode services` prints live status;
  `--mode services-up` ensures every manifest service and leaves spawned
  runtimes running after exit — the seed path for plain-browser use.
- **Embed panels**: when `os.host.servicesStatus` exists (Electron), the
  offline panel shows supervisor state (`starting`, `missing` with the
  exact unmet prerequisite, `failed`) plus a Start action; in a plain
  browser it falls back to the documented start command.
- A machine without the repositories or toolchains gets an honest
  `missing` state naming what was checked — nothing is faked.

## Verified on this host

- Space Agent under bun: `/api/health` 200, `/api/user_self_info` resolves
  the implicit `_admin` `user`, `/api/file_list` walks the layered file
  index, `/enter` + `/mod/...` chain serve — the runtime is fully
  operational, no node binary required.
- God's Eye View: `vite build --base=./` dist serves index, hashed assets,
  Cesium — core map and keyless layers operational.
- God's Eye View's full shell was loaded in headless Chromium: 31 controls,
  8 canvases, 0 page errors; the same check inside the Next desktop iframe
  counted 258 buttons, 31 inputs, 8 canvases, 0 page errors.
- Space Agent's `/enter` shell was loaded in headless Chromium without page
  errors; API and module routes were independently checked over HTTP. The
  same-origin Next proxy path was driven end-to-end: `/enter?next=/space-agent`
  → Enter → `#/dashboard` workspace with 0 page exceptions.
