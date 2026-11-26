# SkylumOS — ITERON / SKYLUM / ECHO / FABRIC

Layered OS packaged inside the SkylumOS repository. SKC1 is the codec and
container substrate; this tree vendors the verified wasm runtime artifact but
not the separately maintained SKC source. Layer contract: `docs/LAYERS.md`;
port contract: `docs/PORTS.md`; cluster contract: `docs/FABRIC.md`.

```
iteron/   core engine & quine substrate — skc-wasm executor, .skcs v2
          sealed volumes, SKCF frames, digests, reemit() slot law
skylum/   OS services — VSpace claims over .skcs, OPFS persistence,
          fuel-metered seats, attested doors, multi-backend inference
          (openai/llamacpp/whisper-http/wllama), WebRTC mesh lane,
          optical transceiver, AFSK audio modem, celestial service,
          Fabric client, Skylum facade
echo/     desktop shell — window manager, terminal, claims,
          inference/mesh/globe/celestial/optical/fabric apps, hosted-app
          embed windows (God's Eye View, Space Agent — ports in
          docs/PORTS.md), self-contained desktop quine
host/     shared Node runtime, headless CLI, opt-in loopback bridge,
          service supervisor, host door adapters
          (netprobe/serialscan/netifaces/tcprelay)
fabric/   single-head cluster service — authenticated membership,
          bounded typed jobs, quorum results, hash-chained journal,
          WebRTC signaling relay
vendor/   vendored codec artifact (skc-wasm.wasm)
tools/    verification harnesses — coverage.sh measurement gate
tests/    script-style assertion suites for every layer
```

## Quick start

```bash
# 1. The tested codec runtime is vendored at vendor/skc-wasm.wasm.
#    To rebuild, build the separate prototypes/skc/zig target and set
#    SKYOS_SKC_WASM=/path/to/skc-wasm.wasm.
# 2. Build quines from a .skcs state volume
cd skyos
python3 iteron/make_quine.py skylum/seed.skcs -o iteron/iteron.html
python3 skylum/make_skylum.py skylum/seed.skcs -o skylum/skylum.html
python3 echo/make_desktop.py -o echo/desktop.html
# 3. Serve from the SkylumOS repository root:
cd .. && python3 -m http.server 8931
# 4. Open /skyos/echo/index.html (shell), /skyos/iteron/iteron.html,
#    /skyos/skylum/skylum.html, or /skyos/echo/desktop.html (quine)
```

## Native hosts

The native hosts use the same ITERON/SKYLUM core and `.skcs` volumes:

```bash
# Headless status and JSON-lines service shell
bun host/cli.js --mode status
bun host/cli.js --mode shell --data ~/.skyos

# Optional loopback bridge for browser clients; token is printed once at startup
bun host/cli.js --mode serve --port 0

# External-app service status / seed (God's Eye View :3200, Space Agent :3100)
bun host/cli.js --mode services
bun host/cli.js --mode services-up   # spawns missing runtimes, leaves them running

# Electron desktop from its isolated package directory
cd echo/electron
bun install
bun run start
```

The bridge accepts only fixed service commands, binds to `127.0.0.1` by
default, requires its per-run bearer token, checks supplied browser origins,
and limits request sizes. Do not expose its port/token remotely. Electron
uses `contextIsolation`, disables renderer Node integration, and exposes only
the named `window.skyosHost` preload methods; user-selected export paths stay
in the main process. Host doors 7–9 (`netprobe` TCP probe, `serialscan`
/dev inventory, `netifaces` interface list) run real syscalls on Node and
Electron through the same 42-byte receipt contract and `bus.recv` audit
lane; the browser registers none of them. The Electron main process also
supervises the external runtimes in `host/services.mjs`: it probes each
manifest port on startup, spawns launchable missing services (default on;
`SKYOS_AUTOSTART=0` disables), shows live state in embed windows, and reaps
only its own children on quit — the same contract `cli.js --mode services*`
exposes for plain-browser seeding (`docs/PORTS.md`).

`skylum/skylum.html` boots ITERON then constructs `window.SKYLUM`
(VSpace claims, seats, doors, inference door, WebRTC mesh, Fabric client,
OPFS persistence) via the `__EXTRA_BOOT__` slot — `reemit()` preserves it
byte-identically.

`echo/desktop.html` embeds ITERON, SKYLUM, the ECHO desktop engine, the
`DESKTOP1` manifest, and the globe renderer in a sealed `.skcs` runtime volume.
The window/session snapshot is stored in `__desktop.json` only on explicit
save or re-emission, never on drag or clock ticks.

## Skyloom Fabric

Fabric is the bounded coordination layer between SkyOS/SkyLum instantiations.
Run one head and any number of agents:

```bash
# Head (default loopback; choose LAN binding deliberately)
umask 077; mkdir -p .skyos
openssl rand -hex 32 > .skyos/fabric.token && chmod 600 .skyos/fabric.token
FABRIC_HOST=127.0.0.1 FABRIC_PORT=8977 bun fabric/server.mjs

# Worker on another Skyloom host
FABRIC_TOKEN="$(cat /secure/path/fabric.token)" \
  node fabric/agent.mjs --node ostf-digit --head http://192.168.12.210:8977
```

v1 is a **single-head LAN/IPv6 fabric**: the head owns registration,
dispatch, quorum resolution, signaling rendezvous, and a tamper-evident
hash-chained journal. It is not replicated consensus, Byzantine fault
tolerance, or a public WAN mesh; `wan_hairpin` is down. All mutation routes
require a shared bearer token (min 24 bytes). Supported job kinds are
`probe`, `claim.read`, `skc.roundtrip` (vendored wasm fountain codec), and
`infer.whisper` (bounded WAV multipart POST), each with fixed
payload/time/result bounds. Full protocol, limits, and deployment notes:
`docs/FABRIC.md`.

## Verify

```bash
cd ..   # repository root
bun skyos/tests/iteron.test.mjs    # 38 assertions: wasm ABI, .skcs
                                   # roundtrip, SKCF parse, ZIP writer,
                                   # sniff, reemit byte-identity
bun skyos/tests/skylum.test.mjs    # 174 assertions: VSpace claims, codec
                                   # asymmetry, staging, seats, inference
                                   # e2e (openai + llamacpp + whisper real
                                   # HTTP; wllama honest-unavailable), mesh
                                   # codec, doors, optical raster/session
                                   # roundtrips, astro ephemeris invariants,
                                   # AFSK modem roundtrips, persist honesty,
                                   # facade, bundle eval
bun skyos/tests/echo.test.mjs      # 70 assertions: reducer geometry,
                                   # lifecycle, terminal (incl. doors list/recv),
                                   # embed host-status panel, artifact/browser
                                   # boot, vendor safety and byte identity
bun skyos/tests/host.test.mjs      # 65 assertions: host adapters, real host
                                   # doors (TCP probe verdicts, iface/serial
                                   # inventories, tcprelay echo roundtrip),
                                   # hw.probe sysfs inventory,
                                   # IPC policy, bridge bounds,
                                   # token/origin checks, .skcs roundtrip
bun skyos/tests/services.test.mjs  # 14 assertions: service manifest,
                                   # supervisor spawn/probe/reap lifecycle
bun skyos/tests/fabric.test.mjs    # 56 assertions: auth, bounds, journal
                                   # chain, job lifecycle/quorum, signaling,
                                   # agent execution (wasm SKC + multipart
                                   # Whisper) and browser client
bun skyos/tests/electron.test.mjs  # 20 assertions static, 32 with smoke:
                                   # Electron security policy + live boot smoke
                                   # (CDP smoke runs when electron + xvfb-run
                                   # are available: boot, persistence, hw.probe,
                                   # and an optical screenshot→decode round trip;
                                   # static checks always run)
SKYOS_SKC_DIR=/path/to/prototypes/skc skyos/tools/coverage.sh
```

`cd skyos && bun run test` runs the same seven suites through `package.json`.

## Honest boundaries (docs/LAYERS.md §6–7, docs/FABRIC.md)

QR generation is Python-side (no JS encoder); wasm64 builds but only wasm32
is runtime-tested; WebSerial needs secure context + hardware;
`CompressionStream('deflate-raw')` is capability-detected with raw fallback;
EnCodec tier is lossy by design. SKYLUM adds: WebRTC mesh is browser P2P
with manual signaling (no STUN/discovery yet); OPFS needs a secure context;
InferenceDoor is a contract needing a real endpoint; seat fuel is cooperative
accounting, not preemption. Host doors exist only on Node/Electron — the
browser has no TCP-probe, serial-scan, interface inventory, or tcp-relay
capability, so doors 7–9 and 11 fail closed there with `unknown door`. The
AFSK audio lane registers only where `AudioContext` exists; wllama runs from
vendored `echo/vendor/wllama/` assets (lazy-loaded on first completion,
model weights via URL/OPFS).

Fabric adds its own honest limits: one head is a single point of failure;
the journal is tamper-evident but in-memory and resets on restart; quorum is
exact-digest agreement on bounded job kinds, not proof of independent
computation; shared-token auth is appropriate for a trusted LAN/VPN, not the
public internet; and WAN reachability depends on `wan_hairpin` returning.

The build/verification host contract (LAYERS.md §10): the harness runs with
full local root — it may install packages, `modprobe v4l2loopback`, create
PTY pairs, and run privileged verification directly. That privilege never
relaxes SKYLUM's own capability checks.

## Coverage

`tools/coverage.sh` (or `bun run coverage`) is the honest measurement gate:

- **Bun suites (437 assertions baseline, 449 with Electron live smoke, 0 fail)**
  — the JS harnesses are script-style runners with their own `ok()` counters,
  not `bun:test` cases; bun 1.4.5's `--coverage` produces no line data for
  them. JS line coverage is reported as assertion counts, not a fabricated
  percentage.
- **Python SKC (pytest-cov)** — measured by `coverage.sh` when
  `SKYOS_SKC_DIR` points to the separately maintained SKC source. Report the
  value from the current run; historical percentages are not current claims.
- **Zig** — `zig build test` green; no line-coverage tool wired.

The >=101% line-coverage target is mathematically impossible because line
coverage caps at 100%. Improve test quality through meaningful branch,
condition, and mutation checks; never claim an impossible percentage.
