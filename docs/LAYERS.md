# SkyOS — SKC1 → ITERON / SKYLUM / ECHO Layer Contract

SKC1 (`prototypes/skc/`) is the codec and container substrate. This document
assigns every SKC1 artifact to exactly one owning layer of the three-layer
architecture described in `prototypes/covo.md`.

```
        ┌─────────────────────────────────────────────┐
        │ ECHO — desktop shell, apps, inspectors       │  actions via SKYLUM
        ├─────────────────────────────────────────────┤
        │ SKYLUM — OS services: doors, transports,     │  services
        │          persistence, pipeline policy        │
        ├─────────────────────────────────────────────┤
        │ ITERON — core engine & quine substrate:      │  silicon
        │          formats, wasm executors, digests,   │
        │          reemit() slot law                  │
        └─────────────────────────────────────────────┘
```

Rule of thumb: **ITERON owns bytes and bytes-in/bytes-out execution.
SKYLUM owns policy and movement of bytes across boundaries. ECHO owns
presentation and user intent.** ECHO reads state for display; state-changing
actions go through explicit SKYLUM APIs and never mutate ITERON internals.

## 1. Artifact ownership matrix

| Artifact | Magic / marker | Owning layer | Notes |
|---|---|---|---|
| `.skcs` v2 sealed volume | `SKC1` | ITERON | RAM/VRAM container; per-member codec raw/zlib/auto, raw_len, sha256-of-raw. The ITERON-native memory image. |
| `.skc` interchange archive | ZIP (`PK\x03\x04`) | SKYLUM | Storage-role archive; ZIP is an interchange envelope, not a core format. |
| `LEML` tape-blocks | `LEML` | ITERON | Lemonade tape-block container (audio-cassette-backup spec). Byte 0 = `L`. |
| `RIFF`/WAV + FSK | `RIFF` | ITERON | Audio carrier format; synth/demod is core codec work. |
| `OCS1` EnCodec tokens | `OCS1` | ITERON | Neural-codec token envelope (lossy tier; documented). |
| `SKCF` frames | `SK` + ver `0x01` (frame.zig MAGIC0/1/VERSION) | ITERON | Self-describing fountain frames; header parse/pack is core. |
| Fountain code policy | — | SKYLUM | k/block_len/session/frame-count choices, carrier selection, autotune. |
| Transports (TCP/UART/QR/audio/stego/polyglot) | — | SKYLUM | Door adapters; SKC1 provides codecs, SKYLUM provides lanes. |
| QR *generation* (segno) | — | SKYLUM (Python side) | No JS QR encoder exists; honest boundary — see §5. |
| QR/frame *display*, member inspectors, quine host | — | ECHO | Views only. |
| Digests: FNV-1a32, FNV-1a64, SHA-256, CRC16/32 | — | ITERON | `skc_fnv1a`, `skc_fnv1a64`, `skc_sha256`, `bits.crc*`. |
| Quine `reemit()` slot law | `{{SLOT}}` markers | ITERON | Self-reemitting HTML artifact; see §4. |

## 2. wasm ABI (ITERON execution surface)

`zig build wasm wasm64` → `skc-wasm.wasm` (wasm32) / `skc-wasm64.wasm`.
Zero imports, freestanding, buffer-in/buffer-out. All functions return a
pointer into linear memory; result length via `skc_last_len()` (or fixed
size for scalar returns). **Memory-detach rule:** `memory.grow` detaches
the old `ArrayBuffer` — re-fetch `new Uint8Array(e.memory.buffer)` after
every call that allocates. Never cache the view.

| Export | Signature (JS view) | Purpose |
|---|---|---|
| `skc_alloc(size)` | → ptr | allocate in wasm memory |
| `skc_free(ptr,len)` | — | free |
| `skc_last_len()` | → len | length of last ptr result |
| `lemonade_pack(mf,mfl,fl,fl)` | → ptr | manifest JSON + file table → LEML blob |
| `lemonade_unpack(ptr,len)` | → ptr | LEML blob → serialized manifest+entries |
| `fsk_encode(ptr,len,baud)` | → ptr | data → RIFF/WAV FSK audio |
| `fsk_decode(ptr,len,baud)` | → ptr | WAV → data (0 on failure) |
| `fountain_encode(ptr,len,blen,sid,count)` | → ptr | payload → `{u32 n, per-frame {u32 len, frame}}` blob |
| `fountain_decode(ptr,len,total,blen,sid)` | → ptr | frames blob → payload (0 until complete) |
| `skcs_pack(members_ptr,len,flags)` | → ptr | member table → `.skcs` v2 bytes |
| `skcs_parse(ptr,len)` | → ptr | `.skcs` bytes → serialized catalog+members (member `data` = STORED bytes; inflate codec=1 via `DecompressionStream('deflate-raw')` or `inflateMember()`) |
| `skcf_parse(ptr,len)` | → ptr | one SKCF frame → verdict+header fields |
| `skc_sha256(ptr,len)` | → ptr | 32-byte digest |
| `skc_fnv1a(ptr,len)` | → u32 | FNV-1a 32 |
| `skc_fnv1a64(ptr,len)` | → i64 | FNV-1a 64 — **JS: `BigInt.asUintN(64, ret)`** |

`skcs_pack` member-table input format (wasm.zig): `u32 count | per member
{u8 kind, u8 codec, u16 name_len, name, [32]sha256, u32 data_len, data,
u16 media_len, media, u32 meta_len, meta}`.

`skcs_parse` output format: `u8 magic_ok, u8 flags, u32 count | per member
{u8 kind, u8 codec, u16 name_len, name, u64 size, u64 raw_size, u64
offset, u16 media_len, media, u32 meta_len, meta, u32 data_len, data}`.

`skcf_parse` output: `u8 verdict (0=ok,1=foreign,2=bad_version,3=malformed)
| if ok: u16 session_id, u32 seq, u16 k, u16 block_len, u32 total_len,
u32 fnv1a, u8 codec_id, u8 carrier_id, u8 flags, u32 payload_len`.

Kind IDs (`catalog.zig`): 0=file, 1=ramdump, 2=vram, 3=manifest.
Codec IDs: 0=raw, 1=zlib(raw-deflate).
Carrier IDs (`frame.zig`): 0=qr, 1=blocks, 2=rgba, 3=tcp, 4=serial.
Codec IDs (`frame.zig`): 0=raw, 1=encraw, 2=lemonade, 3=polyglot.

## 3. Door / seal convention (SKYLUM ↔ ITERON boundary)

Every SKYLUM door produces a **receipt** — a small sealed record proving
what crossed the boundary:

```
door receipt (LE):
  door_id    u8     registry index
  verdict    u8     0=ok, nonzero=door-specific error
  fnv1a64    u64    FNV-1a 64 of payload bytes (seal-width digest)
  sha256     [32]u8 SHA-256 of payload bytes
```

42 bytes total. `.skcs` members already carry per-member sha256 seals;
door receipts extend that seal across transport boundaries, matching the
covo "attested doors / 40-byte LE seal" convention with SKC1's real
digests (fnv1a64 + sha256). Door registry (`skylum/doors.js` `DOOR`):
0=file, 1=download, 2=websocket, 3=webserial, 4=qr-display, 5=skcs-volume,
6=mesh, 7=netprobe, 8=serialscan, 9=netifaces, 10=audiofsk, 11=tcprelay.
Doors 7–9 and 11 exist only on Node/Electron hosts (`host/doors-node.js`);
door 10 registers only where `AudioContext` exists. Browser runtimes do
not register the host doors, so `send`/`recv` there fails closed with
`unknown door`.
`bus.recv(id)` reads a receive-capable door and logs an `rx` audit entry;
send-only doors fail closed with `door N has no recv`.

## 4. Quine `reemit()` slot law (ITERON)

The ITERON quine artifact is a single HTML file containing:

```
<script type="application/octet-stream" id="iteron-wasm">{{WASM_B64}}</script>
<script type="application/octet-stream" id="iteron-state">{{STATE_B64}}</script>
<script type="application/json" id="iteron-manifest">{{MANIFEST}}</script>
<script type="application/octet-stream" id="iteron-tmpl">{{TEMPLATE_B64}}</script>
<script type="application/octet-stream" id="iteron-engine-src">{{ENGINE}}</script>
<script>/* engine bundle — runs the substrate */</script>
<script id="iteron-extra-boot">{{EXTRA_BOOT}}</script>
<script>/* boot harness — template tail */</script>
```

`reemit()` regenerates the HTML from `{wasm_b64, state_b64, manifest,
template, extra_boot_src, engine_src}`. Slot law: substitution markers
inside the template are literal text (`__WASM_B64__`, `__STATE_B64__`,
`__MANIFEST__`, `__TEMPLATE_B64__`, `__EXTRA_BOOT__`, `__ENGINE__`) and are
never themselves rewritten; re-emission is byte-identical iff inputs are
unchanged. `__EXTRA_BOOT__` carries layer-extension boot code (SKYLUM
injects `window.SKYLUM` init here); its value round-trips through the
`iteron-extra-boot` script's `textContent`, which is exactly the
substituted string — the marker sits inline with no surrounding
whitespace so content↔marker substitution is symmetric. The byte-identity
gate: `emit(parse(html)) === html`.

Substitution order in both `make_quine.py` and `Iteron.reemit()`:
`__WASM_B64__` → `__STATE_B64__` → `__MANIFEST__` → `__TEMPLATE_B64__` →
`__EXTRA_BOOT__` → `__ENGINE__` (last, because the engine source contains
the literal marker strings inside its own `replaceAll` calls).

## 5. Format sniff order (extends pipeline.decode's byte-0 law)

When ITERON/SKYLUM receives an unlabeled buffer, sniff in this order —
first match wins, all are byte-0 anchored:

1. `PK\x03\x04` → `.skc` ZIP archive (SKYLUM storage role)
2. `SKCS` → `.skcs` v2 volume (ITERON)
3. `LEML` → lemonade tape-blocks (ITERON)
4. `RIFF` → WAV (FSK carrier if FSK-encoded, else raw PCM)
5. `OCS1` → EnCodec token stream (ITERON, lossy tier)
6. `SK` + `0x01` → single SKCF fountain frame (ITERON; CRC16-verified by skcf_parse)
7. `<!DOCTYPE`/`<html` → quine/polyglot HTML carrier
8. else → raw member data

Wrappers must never prepend bytes ahead of these magics on the inspected
buffer (the LEML/RIFF lesson — verified in `pipeline.decode`).

## 6. SKYLUM services (OS layer on ITERON)

`skylum/` modules — all DOM-free except where a browser capability is
explicitly required; every service degrades to an honest error, never a
stub.

| Module | Service | Contract |
|---|---|---|
| `memory.js` `VSpace` | claim/memory management | Claims are `.skcs` members with `{base,size,perms}` meta. `__staging` member = 1 MiB arena; `stage()` writes land there, `commit(name)` promotes staged bytes (high-water `stagedLen`, not the full arena) into a claim. `load()` is async and normalizes stored→raw so `skcsPack` never sees compressed input. |
| `state.js` `ClaimSpace` | claim table → members | `claimMember()` builds skcsPack-shaped records (codec `"auto"`). `save()` normalizes parsed members through `inflateMember` before packing — the stored/raw asymmetry is handled in exactly one place per loader. |
| `persist.js` | OPFS persistence | `navigator.storage.getDirectory()/skyos/` volumes. `opfsSupported()` capability-checks; `saveVolume/loadVolume/listVolumes/deleteVolume` + `saveIteron/loadIteron` (stateBlob round-trip). Secure-context only — reports honest unavailability. `Skylum` accepts an injected persistence adapter for non-browser hosts without changing the `.skcs` format. |
| `seats.js` `Scheduler`/`Seat` | fuel-metered task lanes | Cooperative generator tasks; one quantum per `tick()`, deterministic insertion-order round-robin, no wall-clock in the core path. `fuelMax` = budget at `seat()`; `run(maxTicks)` bounds ticks *this* run. `receipt()` audits steps/fuel — call it deliberately, not from status polls. |
| `doors.js` `DoorBus` | attested transports | Registry + adapters (file/download/websocket/webserial/qr-display/audio-fsk plus host-injected doors via `opts.doors.extra`: netprobe/serialscan/netifaces/tcprelay on Node/Electron). Every `send()` emits the 42-byte receipt; `recv(id)` returns door bytes and both directions append tx/rx entries to the bus audit log; disabled doors return verdict 2 without touching the wire. |
| `infer.js` `InferenceDoor` | inference contract | Backend-kinded: `openai` (chat-completions POST), `llamacpp` (native `POST {endpoint}/completion`, llama-shaped usage), `whisper-http` (multipart transcription → `transcribe()`), `wllama` (vendored `@wllama/wllama` ESM + single-thread wasm, OPFS-cached GGUF via its own CacheManager). All return `{text, usage, seal:{fnv1a64,sha256}}`. No endpoint/model → honest throw. |
| `astro.js` | celestial service | Pure UTC astronomy: `solarState`/`lunarState` (J2000 + truncated Meeus series), `gmst`, `altAz` (compass az), `STARS` bright-star catalog, `observerSky` dome snapshot. Powers globe.js terminator + the Celestial Sky app; ~0.01° solar / ~1° lunar precision, stated honestly. |
| `audio.js` | AFSK modem + door | BFSK codec: `afskEncode`/`afskDecode` over real PCM (preamble 4×0x55 + 0xD5 start + `SKAF` magic + u16 len + payload + FNV-1a16 crc; Bell-202-like 2200/1200 Hz @ 600 baud, Goertzel windows, 4-phase resync). `audioFskDoor` plays via `AudioContext` (send) and captures mic via `getUserMedia`+ScriptProcessor (recv); unsupported → verdict 3 / honest throw. |
| `mesh.js` `MeshNode` | WebRTC overlay lane | Manual-signaling P2P data channels (`offer/answer/acceptAnswer`, base64 JSON signals ride any door). `binaryType="arraybuffer"`, per-peer `send()` receipts on door 6, `broadcast()` isolates per-peer failures. No STUN by default → LAN/same-host honest path. |
| `fabric.js` `FabricClient` | Fabric head client | Bounded route allowlist for `status/nodes/jobs/journal` plus authenticated `next/signals` reads and `register/heartbeat/job/result/signal` mutations. Bearer token is required for private reads and mutations; responses are byte-capped. Public build variables must never carry the cluster token. |
| `index.js` `Skylum` | facade | Wires all services onto an `Iteron` instance; `loadState()/save()/restore()/status()`. Accepts explicit `persist` and `host` adapters. `status()` is read-only — it never mutates scheduler receipts or claim state. |

`skylum/make_skylum.py` emits `skylum.html` — same slot law as ITERON
plus the SKYLUM module bundle and `EXTRA_BOOT` that constructs
`window.SKYLUM` after ITERON boots.

## 7. Honest boundaries

- **QR generation is Python-side only** (segno). No JS QR encoder is
  ported. ECHO renders SKCF frames as hex/block rasters; QR *scanning*
  stays Python/cv2-side. QR *display of pre-rendered PNGs* is ECHO.
- **The optical lane is a half-duplex transceiver** (`skylum/optical.js`):
  a DOM-free raster codec (n×n luminance cells, self-describing `SK`
  header + fletcher16) plus an `OpticalLink` session machine that carousels
  a payload's SKCF fountain frames (TX) and pools/decodes them (RX) over
  one light channel. Any byte string rides it — including the running
  machine's own `reemit()` output ("Beam this machine" streams the quine
  source live). ECHO's Optical app renders the carousel on 2D canvas
  always, or a WebGL2 instanced-quad path when the context is real — and
  reports the `UNMASKED_RENDERER` string rather than assuming one. RX
  sources are honest: in-canvas loopback (full codec chain, no hardware),
  `getUserMedia` camera when present, and `getDisplayMedia`/compositor
  capture — under Electron the session handler resolves display media to
  the app's own window, so a machine can receive its own beam through a
  real screen-capture pipeline. `skcfParse` and `fountainDecode` verify
  headers and checksums; no frame is fabricated on ingest.
- **Host doors** (netprobe/serialscan/netifaces/tcprelay) execute real
  syscalls — TCP connect probes, `/dev` scans, `os.networkInterfaces()`,
  real `node:net` socket writes/drains — only on Node and Electron
  runtimes. They are never registered in the browser, so the capability
  gap is visible rather than simulated.
- **The audio lane is real AFSK** (`skylum/audio.js`): speaker→mic BFSK
  with preamble sync and a crc gate — silence decodes to null, corrupted
  energy is rejected, and a phase/sign flip is *not* corruption to a
  non-coherent detector (verified). Environments without
  `AudioContext`/`getUserMedia` report unsupported rather than playing
  dead air.
- **wllama inference is vendored, not assumed**: the ESM + single-thread
  wasm live under `echo/vendor/wllama/` and are fetched lazily on first
  completion; model weights load by URL (OPFS-cached by wllama's own
  CacheManager) or byte-blob. No model → honest `no model loaded`.
- **wasm64** builds and exports verify structurally; bun lacks memory64,
  so only wasm32 is runtime-tested (same as `skc/quine.py` today).
- **WebSerial** requires secure context + hardware; the door adapter
  reports honest availability and disables itself — never a stub.
- **`CompressionStream('deflate-raw')`** is not universal; `.skcs` codec
  selection capability-detects and falls back to `codec=raw` (the format
  already supports it).
- **EnCodec is lossy** — `OCS1` tier never claims bit-exactness; the
  lossless path is LEML→FSK→SKCF→carrier + stego bypass.
- **Scope**: this connects SKC1 as container/transfer substrate. It does
  not rebuild inference (wllama), God's Eye, freenet/IPv6, or space-agent.
- **WebRTC mesh** is browser P2P only — no raw sockets, no STUN by
  default (host candidates: LAN/same-host). Signaling is manual by
  design so it can ride any door; there is no discovery layer yet.
- **OPFS persistence** requires a secure context (https/localhost);
  elsewhere `opfsSupported()` is false and `save/loadVolume` throw
  honest errors — volumes are not silently dropped to localStorage.
- **InferenceDoor** is a contract, not a model — it needs a real
  OpenAI-compatible endpoint (loopback bridge or remote). With none
  configured `available` is false and `complete()` throws.
- **`Scheduler` fuel** is cooperative accounting, not preemption — a
  task that never yields still holds its seat until fuel or completion.
- **Skyloom Fabric** (`fabric/`, `docs/FABRIC.md`) is the cluster
  coordination plane, not part of the quine substrate: one authenticated
  head owns membership, bounded typed jobs, quorum results, signaling
  rendezvous, and a tamper-evident in-memory journal. v1 is LAN/IPv6-only
  while `wan_hairpin` is down, has no Byzantine fault tolerance, and the
  head is a single point of failure.

## 8. ECHO desktop

`echo/index.html` is the development shell. `echo/desktop.html`, generated by
`echo/make_desktop.py`, is the third quine tier: a single HTML artifact
containing the ITERON+SKYLUM+ECHO engine, CSS, wasm, a sealed state volume,
and the vendored globe renderer. Its manifest is `DESKTOP1`.

The shell ports the pure reducer and validated application-registry pattern
from the qsc-v1 desktop donor. `echo/wm.js` owns bounded window state
(eight windows maximum, 280×180 minimum, 4096×4096 maximum), clamped geometry,
focus/z order, maximize/restore, and session snapshots. Pre-maximize geometry
is clamped to the *current* viewport when restored or when the viewport changes.
The terminal mounts in two honest layers: when the host exposes `term*`
capabilities (Electron preload or Node bridge) the Terminal app runs a real
xterm.js frontend bound to a tmux-owned PTY login shell via
`host/shell-node.mjs` — genuine commands, job control, and ANSI stream.
Otherwise it falls back to the SkyOS console, whose commands route through
`ctx.os` to SKYLUM/ITERON services. There is no direct core mutation path.

`__desktop.json` is a `manifest`-kind member containing the last explicitly
saved window snapshot. Dragging, clocks, and polling do not persist state;
OPFS save/download/re-emit actions do. Updates replace the member in place
without relocating its claim or accumulating heap space. `vendor/globe.gl.min.js` is embedded
through the dedicated base64 vendor slot and also committed as a `.skcs`
`file` member at runtime. The generator rejects `</script` in executable
engine/CSS/vendor content and the artifact is gated for byte-identical
consecutive `reemit()` calls. The canonical embedded template has an
executable engine slot and a boot invocation after the bundled engine;
development-only slot wrappers are not emitted into the `DESKTOP1` page.
Because every module is concatenated into one script scope, the generator
rejects duplicate top-level declarations across modules (`const`/`let`/
`var`/`function`/`class`) — a collision is a `SyntaxError` that leaves the
artifact stuck at the boot screen, so it fails the build instead.

Every app view uses a generation/lifecycle guard: close invokes cleanup and
invalidates pending results; late mount cleanup is disposed immediately, and
async completion checks the view is still current before rendering. Missing browser capabilities (OPFS, WebRTC, inference
endpoint) remain visible as honest errors rather than simulated success.

`echo/apps/embed.js` owns the external-app window lane (`skylum.bridge`
capability): God's Eye View and Space Agent mount as real desktop windows
over standardized loopback ports (`docs/PORTS.md`, manifest in
`host/services.mjs`). Each window probes its runtime's port, iframes the
app when it answers, and shows the exact start command while it does not —
reachability is measured, never assumed. When a host supervisor is present
(`os.host.servicesStatus`), the panel instead reflects live supervisor
state — `starting`, `missing` prerequisites, `failed` — with a Start
action; plain browsers keep the command-only fallback. God's Eye View
uses the plain `index.html`: `?embed=1` intentionally hides
the HUD and controls for a different host-driven `gev:view` postMessage
contract. The `skyos://` CSP permits `frame-src` for
`http://127.0.0.1:*` and `http://localhost:*` only. The existing native
`globe` app is named **SkyOS Globe** to distinguish it from the full
external God's Eye View application.

## 9. Node and Electron hosts

The browser/Quine edition remains the portable baseline. `host/runtime.js`
constructs the same `Iteron` and `Skylum` facade in Node or a browser renderer,
using the same WASM, `.skcs` format, digest implementation, and claims. Host
adapters are injected at the SKYLUM persistence boundary; a host cannot change
ITERON's state/member rules.

| Entry point | Role | Security/behavior contract |
|---|---|---|
| `host/cli.js --mode status` | Headless inspection | Loads shared WASM and seed volume and emits a status snapshot. |
| `host/cli.js --mode shell` | Headless line protocol | Accepts JSON-lines from stdin and only the fixed `HOST_COMMANDS` service allowlist, which now includes `term.spawn/write/read/resize/kill/list` backed by `host/shell-node.mjs` tmux PTYs (real login shells, `tmux` required). |
| `host/cli.js --mode serve` | Optional browser bridge | Binds loopback only, requires a random bearer token, checks browser origins, caps request bodies, and supports clean shutdown. The bridge is an explicit local service, not started by the normal headless status mode. `serve` and `shell` modes attach `host/shell-node.mjs` so `term.*` commands yield real PTYs. |
| `echo/electron/` | Desktop and local host | Renderer is sandboxed, context-isolated, and has no Node integration. A frozen preload surface maps named APIs to fixed IPC channels; main checks the sender webContents and exact `skyos://app/...` frame URL. Volume IPC is a base64 byte-shuttle — the renderer's own Skylum serializes state and main only moves bytes, so the desktop runtime and the bridge/host runtime never diverge on disk. Filesystem ops take validated volume names or dialog-selected paths, never renderer paths. Main also supervises the external-app runtimes from `host/services.mjs`: probes each manifest port, spawns launchable missing services (logs under `userData/service-logs`), exposes `skyos:services:status`/`skyos:services:ensure`, reaps only its own children on quit, and honors `SKYOS_AUTOSTART`/`SKYOS_*_DIR` (contract in `docs/PORTS.md`). The Fabric app reaches the cluster head through `skyos:fabric:request`: main proxies `/v1/*` GET/POST to `SKYOS_FABRIC_URL` (default `http://127.0.0.1:8977`) and attaches `SKYOS_FABRIC_TOKEN` itself, so the renderer never holds the head credential and no CSP exception is needed (`docs/FABRIC.md`). `skyos:term:*` channels expose `host/shell-node.mjs` tmux PTY sessions (spawn/write/read/resize/kill/list) so the Terminal app's Shell view is a real login shell; xterm.js + FitAddon are vendored under `echo/vendor/xterm/` and fetched lazily. |

Node/Electron volumes use a filesystem persistence adapter with validated
single-component volume names and atomic temp-file replacement. Electron's
local bridge is enabled for its app session and can be stopped/restarted
explicitly; it binds only `127.0.0.1` and the per-run token must be treated as
a local capability secret. Do not forward the listener or token to remote
interfaces. Host doors expose real syscalls behind the same contract:
`netprobe` (send-only TCP connect probe of a caller-supplied `host:port`),
`serialscan` and `netifaces` (recv-only `/dev` scan and interface inventory,
both JSON — honest empty results where the host has none). The Electron
renderer reaches them through `skyos:door:send`/`skyos:door:recv` IPC into
main's runtime; browser runtimes register no such doors at all. WebRTC and
WebSerial hardware remain honestly unavailable in host modes.

`hw.probe` (`host/hw-probe.js`, `skyos:hw:probe` IPC) measures real
hardware reach instead of assuming it — sysfs PCI display devices with
bound drivers, `/dev/dri` nodes with live `R_OK|W_OK` access checks,
`/dev/video*` and serial node scans, group membership (`render`, `video`,
`dialout`, `plugdev`, `input`), and `vulkaninfo` enumeration when the
tool exists. Absent hardware reports absent; nothing is fabricated.

| Reach | Browser | Node/Electron host | Note |
|---|---|---|---|
| GPU render nodes | — | `/dev/dri/renderD*` openable when process is in `render` group | measured by `hw.probe` |
| Vulkan device list | — | `vulkaninfo --summary` parse (e.g. RADV + RX 580) | tool optional |
| WebGL raster TX | 2D always; WebGL2 instanced when context is real | same | renderer string reported |
| Camera RX | `getUserMedia` when hardware exists | same; virtualizable via `v4l2loopback` + ffmpeg frame feed | module present needs `sudo modprobe` |
| Screen-capture RX | OS picker | Electron resolves display media to own window; Xvfb+`x11grab`/compositor screenshot for pure headless | real compositor pixels |
| Serial | WebSerial (secure ctx + device) | `/dev` node scan via `serialscan` + `dialout` group | honest empty without hardware |
| Audio speaker/mic | `AudioContext`+`getUserMedia` | same + Electron `media` permission | AFSK door; loopback test via synthetic PCM |
| TCP data lane | unavailable (no raw sockets) | `tcprelay` door: real `node:net` connect/write/drain | framed `"host:port"\0payload` |
| Bluetooth/Wi-Fi/modem | unavailable | unavailable | not claimed |

The Electron `media` permission is granted for camera/display capture only
to the `skyos://app/...` renderer URL — every other permission stays
denied. `skyos:optical:sources` lists desktopCapturer sources for the
renderer-side capture UX.

The ECHO Electron renderer runs the same UI modules but calls privileged
operations through `window.skyosHost`, never raw Node APIs. Browser/Quine
generation remains independent of Electron packaging, and any runtime
re-emission continues to use ITERON's existing slot law.

Host checks: `bun tests/host.test.mjs` covers adapter persistence roundtrip,
headless shared-runtime save/load, IPC sender/origin restrictions, preload
allowlist mapping, bridge token/origin/size validation, and shutdown.
`bun tests/electron.test.mjs` covers the Electron policy surface statically
(secure BrowserWindow flags, CSP, permission/navigation denial, channel parity)
and, when the Electron binary and `xvfb-run` are present, drives a live boot
over the DevTools protocol: shared-runtime boot, claim loading, window-manager
launch, IPC persistence write/restore under `userData`, host status, the
loopback bridge, the `hw.probe` syscall inventory, and an end-to-end optical
round trip — a beamed payload raster is read back from real compositor
pixels (`Page.captureScreenshot`, the same plane a headless `x11grab`
recorder sees) and fountain-decoded byte-identically.

HTML quine re-emission is a browser-edition capability: `Iteron.reemit()`
needs the template slot bundle that only exists inside `iteron.html`,
`skylum.html`, and `desktop.html`. The Node/Electron runtimes honestly do
not ship a template — the Electron desktop's re-emit action exports the
`.skcs` state volume instead, which can seed any browser artifact.

## 10. Build-host privilege contract

The build/verification host is assumed to run with **full local root
privilege**. The agent harness may install system packages (`apt`,
`pip`, `npm`), load kernel modules (`sudo modprobe v4l2loopback`
creates real `/dev/video*` nodes), create device and PTY pairs
(`socat`, `mknod`), open `/dev/dri/renderD*`, configure loopback and
network bridges, and run the complete verification sweeps directly —
without asking for permission first. Privilege is a property of the
*harness*, so it is recorded here once instead of being re-negotiated
per task.

This contract does **not** relax the OS-layer boundary. Root on the
host changes what the host *can* reach; it does not change what
SKYLUM *claims*. Doors still report honest verdicts, capability
checks still run, ECHO actions still route through `Skylum` /
`DoorBus` / bridge adapters, and a lane the hardware genuinely lacks
still reports unavailable — privileged or not.
