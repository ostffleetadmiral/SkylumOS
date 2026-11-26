# Skyloom Fabric v1

Fabric is the bounded coordination service between SkyOS/SkyLum instantiations.
ITERON remains the deterministic volume/quine substrate, SKYLUM owns services
and host integration, ECHO presents Fabric state and operations, and this
service provides head-led membership, typed job dispatch, and signaling.

## Authority and reach

The first deployment is a **single-head LAN/IPv6 fabric**. `sheraton`
(`192.168.12.210`) is the head and journal authority; `ostf-digit`
(`192.168.12.162`) is a worker and exposes Whisper locally on port `8080`.
This is the current verified LAN deployment; it is still one head, not
replicated consensus.

The head is a single point of failure: registration, dispatch, quorum
resolution, signaling rendezvous, and the journal stop when it is unavailable.
The hash-chained journal is tamper-evident sequencing on one authority; it is
not replicated consensus, Byzantine fault tolerance, or protection against a
compromised head rewriting its own history. `wan_hairpin` is down; v1 does not
claim public WAN reachability, automatic relay discovery, or an internet mesh.
IPv6 endpoint advertisement is capability data, not proof of routability.

## Start and configure

Run the head with Bun or Node 22+ from the SkylumOS repository root:

```sh
umask 077
mkdir -p .skyos
openssl rand -hex 32 > .skyos/fabric.token
chmod 600 .skyos/fabric.token
FABRIC_HOST=0.0.0.0 FABRIC_PORT=8977 bun skyos/fabric/server.mjs
```

The default bind is `127.0.0.1`. `0.0.0.0` or `::` is an explicit operator
choice for LAN access; firewall port `8977` to the trusted LAN, not the public
internet. The service accepts only the four configured bind names. The
token is read from `FABRIC_TOKEN`, or from `FABRIC_TOKEN_FILE` (default
`.skyos/fabric.token`). It must contain at least 24 bytes; prefer a random
32-byte-or-longer secret. Protect token files as credentials and distribute
the same bearer secret to each agent through a secure channel. Rotate the
shared secret by restarting the head and agents together. v1 has one shared
token and no per-node key, revocation, encryption negotiation, or TLS
termination; use a private LAN or a separately managed TLS terminator/VPN.

Example worker start:

```sh
FABRIC_TOKEN="$(cat /secure/path/fabric.token)" \
  node skyos/fabric/agent.mjs \
  --node ostf-digit --head http://192.168.12.210:8977
```

`FABRIC_TOKEN` should be provided by the service manager's secret facility;
avoid putting secrets in command history, process arguments, URLs, logs, or
browser-visible `NEXT_PUBLIC_*` variables. The agent also accepts
`--interval <ms>` (250–60000, default `1000`) to bound its heartbeat/poll
cadence. The current node agent is npm-dependency-free ESM: it uses Node
built-ins plus the vendored `skc-wasm.wasm` through `iteron/iteron-core.js`;
it does not shell out to the Python `skc` CLI. It reports available Node/Bun/Zig,
PCI, `/dev/dri`, `/dev/kfd`, Whisper, and vendored WASM digest capabilities.
It does not install software, provision services, or claim a capability merely
because a device path exists.

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `FABRIC_HOST` | `127.0.0.1` | Listener address; LAN binding is opt-in |
| `FABRIC_PORT` | `8977` | HTTP/WebSocket listener port |
| `FABRIC_TOKEN` | unset | Shared bearer token; takes precedence over file |
| `FABRIC_TOKEN_FILE` | `.skyos/fabric.token` | Token file path |
| `FABRIC_HEAD_ID` | `head` | Display identity in status |
| `FABRIC_AGENT_PORT` | `0` | Port advertised in node endpoint records; `0` advertises no service port (the agent does not open a listener) |
| `SKYOS_CLAIMS_DIR` | `<cwd>/.skyos/claims` | Root for bounded `claim.read` |
| `WHISPER_URL` | `http://127.0.0.1:8080/inference` | Worker-local Whisper transcription endpoint (multipart WAV POST) |

## HTTP and WebSocket protocol

All payloads are JSON. Request headers are bounded; mutating POST requests
require `Authorization: Bearer <token>`. Private worker polling and signal
queue reads also authenticate. Read-only status views are intentionally
public, so do not put secrets in capability fields, endpoints, or journal
payloads.

| Route | Auth | Contract |
|---|---|---|
| `GET /v1/status` | Public | Protocol version, single-head mode, lanes, and counts |
| `GET /v1/nodes` | Public | Bounded public node inventory |
| `GET /v1/jobs` | Public | Bounded job summaries; result content is not disclosed |
| `GET /v1/journal?limit=N` | Public | Tail (1–1000 records) plus full-chain verification result |
| `POST /v1/register` | Bearer | Register/update identity, incarnation, capabilities, endpoints |
| `POST /v1/heartbeat` | Bearer | Refresh liveness and capability report |
| `POST /v1/job` | Bearer | Submit typed job; stable caller ID makes retry idempotent |
| `POST /v1/result` | Bearer | Submit selected node's result with SHA-256 digest |
| `POST /v1/signal` | Bearer | Queue a bounded `offer`, `answer`, or `ice` packet |
| `GET /v1/next?node=...` | Bearer | Authenticated worker poll; claims one outstanding assignment |
| `GET /v1/signals?node=...` | Bearer | Authenticated signal queue drain |
| `GET /v1/signal?node=...&token=...` (WebSocket upgrade) | Bearer query credential | Browser-compatible signaling transport; token appears in URL/log surfaces, so prefer HTTP bearer clients where possible |

The browser WebSocket API cannot set arbitrary Authorization headers. The v1
browser client therefore passes the bearer token as a query credential for
the WebSocket upgrade; this is a documented compromise and should only be
used over a trusted encrypted tunnel. HTTP mutation APIs do not accept tokens
in query parameters. An origin allowlist can be configured in the server
factory; do not use wildcard CORS with a shared secret.

## Job inputs and worker behavior

| Kind | Input contract | Worker behavior |
|---|---|---|
| `probe` | `null` or an ignored non-array object | Returns host/runtime facts only; no filesystem or network probe beyond process state. |
| `claim.read` | `{ "name": "<relative member>", "maxBytes"?: integer }` | Reads one bounded regular file under `SKYOS_CLAIMS_DIR`; rejects traversal, symlink escape, non-files, oversized reads, and mid-read changes. Returns base64 bytes, SHA-256, and size. |
| `skc.roundtrip` | `{ "data": "<canonical base64>" }`, decoded size 1–512 KiB | Runs the vendored SKC wasm fountain codec in-process (`fountainEncode` then `fountainDecode`) and returns `{ bytes_b64, sha256, identical }`. |
| `infer.whisper` | `{ "audio_b64": "<canonical base64 WAV>", "filename"?: "<safe name>" }`, decoded size 1–160 KiB | POSTs multipart form field `file` (plus `response_format`, `response-format`, and `temperature=0.0`) to `WHISPER_URL`; default is `http://127.0.0.1:8080/inference`. Response JSON is capped at 256 KiB. |

`filename` is optional for Whisper and, when present, must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Invalid input is rejected by the head before
dispatch; workers repeat the same bounds before touching local resources.

## Bounds, execution and quorum

- At most 256 nodes, 1000 retained jobs, 100,000 journal entries, 1 MiB per
  HTTP body/response, 16 KiB capabilities, and 64 KiB per signaling payload.
- Job input is at most 256 KiB; job results at most 512 KiB. Input validators
  enforce an allowlisted kind and type-specific limits. Claim paths reject
  traversal and resolve symlinks against the configured claims root.
- Supported jobs are `probe`, `claim.read`, `skc.roundtrip`, and
  `infer.whisper`. Worker HTTP calls and long-running execution have deadlines;
  SKC execution is the bounded in-process wasm codec described above, and
  Whisper response size is capped.
- Jobs use caller-provided IDs for idempotent retries. A conflicting reuse of
  an ID with a different input is rejected. A node may claim one assignment
  at a time; expired workers can be replaced by another eligible node, and
  stale/duplicate results do not change a completed job.
- Replicas and quorum are explicit. The server rejects a submission when it
  cannot currently select the requested replicas/quorum; it does not silently
  lower the threshold. Completion requires exact result-digest agreement from
  the configured quorum. A timeout or impossible quorum yields a terminal
  error state rather than waiting on a hung node.
- These are workload-level exact-match checks, not proof of independent
  computation. Shared tokens and a single head do not defend against malicious
  workers or operators. Do not use Fabric as a security boundary for secrets,
  payments, or safety-critical decisions.

## Journal

Every record includes a monotonic sequence, previous SHA-256, event type,
payload, timestamp, and SHA-256 over canonical JSON. `GET /v1/journal`
recomputes the chain independently and reports `{valid, sequence, head}`.
This detects accidental/tamper edits within the returned history; it does
not provide durable storage across process restarts, signatures, an external
checkpoint, or protection from a malicious head. The current in-memory
journal resets when the process restarts. Back up/export verified tails if
operators need durable audit evidence.

## Desktop and static operation

The ECHO Fabric app reads status, nodes, jobs, and journal through the
SKYLUM Fabric client. It displays offline/error states and supports only the
four bounded job kinds. Browser clients cannot hold a shared head token safely;
do not inject the cluster token into public Next build variables. Use the
desktop app for read-only monitoring or a separately authenticated operator
gateway for job submission. Direct tokenized browser mutation is inappropriate
for a static export.

Next `rewrites()` run only in Next server/dev mode, not a static export. The
Fabric head must be independently reachable from the browser when direct
monitoring is desired; configure `NEXT_PUBLIC_FABRIC_URL` only for a
read-only endpoint that is intentionally public. Static GitHub Pages cannot
start or proxy Fabric. See `PORTS.md` for local ports and `LAYERS.md` for
layer ownership.

## Verification

From repository root:

```sh
bun skyos/tests/fabric.test.mjs
bun skyos/tests/iteron.test.mjs
bun skyos/tests/skylum.test.mjs
bun skyos/tests/echo.test.mjs
bun skyos/tests/host.test.mjs
bun skyos/tests/services.test.mjs
bun skyos/tests/electron.test.mjs
```

Unit tests use loopback/in-process state. For the `sheraton`/`ostf-digit`
deployment, the live check is to start the head and both agents as above,
then submit `probe`, `claim.read` with `replicas=2`/`quorum=2`,
`skc.roundtrip` with `replicas=2`/`quorum=2`, and `infer.whisper` pinned by
`capabilities_required: {"inference.whisper":"http://127.0.0.1:8080/inference"}`.
Confirm `/v1/jobs` reaches `complete` with the expected vote counts and
`/v1/journal` reports `verification.valid=true`. Public job views intentionally
hide result payloads; compare canonical digests against locally computed
result digests or a direct worker-endpoint response when payload proof is
required.
