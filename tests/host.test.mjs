import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodePersistence } from "../host/persist-node.js";
import { startBridge } from "../host/bridge.js";
import { authorizeToken, createHostProtocol } from "../host/protocol.js";
import { decodePayload, loadRuntime, validateClaimName, validateLimit, validateVolumeName } from "../host/runtime.js";
import { nodeHostDoors } from "../host/doors-node.js";
import { DOOR } from "../skylum/doors.js";
import { Skylum } from "../skylum/index.js";
import { createServer } from "node:net";
import { createPreloadApi, PRELOAD_CHANNELS } from "../echo/electron/preload-api.cjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ELECTRON_IPC_CHANNELS, registerHostHandlers } =
  require("../echo/electron/main-policy.cjs");

let passed = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  passed++;
  console.log(` ok ${label}`);
};

function throws(fn, expected, label) {
  assert.throws(fn, error => error.message === expected, label);
  passed++;
  console.log(` ok ${label}`);
}

console.log("Host input validation:");
check(validateClaimName("vendor/globe.gl.min.js") === "vendor/globe.gl.min.js",
  "claim paths accept bounded relative members");
throws(() => validateClaimName("../secret"), "claim_name_invalid", "claim path traversal rejected");
check(validateVolumeName("state.skcs") === "state.skcs", "simple volume names accepted");
throws(() => validateVolumeName("../state.skcs"), "volume_name_invalid", "volume path traversal rejected");
check(validateLimit(1 << 20) === 1 << 20, "payload limit boundary accepted");
throws(() => validateLimit((1 << 20) + 1), "limit_invalid", "payload above limit rejected");
check(decodePayload(Buffer.from([0, 1, 254, 255]).toString("base64"), 4).length === 4,
  "canonical base64 payload decodes");
throws(() => decodePayload("AA=A", 4), "payload_base64_invalid", "malformed base64 rejected");
throws(() => decodePayload("AQ==", 0), "payload_too_large_or_noncanonical", "decoded payload cap enforced");
check(authorizeToken("token", "token"), "bridge token accepted");
check(!authorizeToken("token", "other"), "wrong bridge token rejected");
{
  const calls = [];
  const api = createPreloadApi((...args) => { calls.push(args); return Promise.resolve(true); });
  check(Object.isFrozen(api) && api.mode === "electron",
    "preload API exposes an immutable, mode-labeled capability object");
  check(Object.keys(api).filter(key => key !== "mode").length === Object.keys(PRELOAD_CHANNELS).length,
    "preload methods exactly match the explicit IPC channel allowlist");
  await api.status();
  check(calls[0][0] === "skyos:status" && calls[0][1] === undefined,
    "preload status call maps to its fixed IPC channel");
  await api.saveVolume({ name: "state" });
  check(calls[1][0] === "skyos:volumes:save",
    "preload exposes named service methods rather than arbitrary invoke");
  const preloadSrc = readFileSync(
    new URL("../echo/electron/preload.cjs", import.meta.url), "utf8");
  const preloadChannels = new Set(preloadSrc.match(/skyos:[a-z:]+/g));
  check(preloadChannels.size === Object.keys(PRELOAD_CHANNELS).length &&
    [...preloadChannels].every(channel => ELECTRON_IPC_CHANNELS.includes(channel)),
    "sandboxed preload channel table stays in parity with IPC allowlist");
  check(/contextIsolation:\s*true/.test(readFileSync(
    new URL("../echo/electron/main.cjs", import.meta.url), "utf8")) &&
    /nodeIntegration:\s*false/.test(readFileSync(
    new URL("../echo/electron/main.cjs", import.meta.url), "utf8")) &&
    /sandbox:\s*true/.test(readFileSync(
    new URL("../echo/electron/main.cjs", import.meta.url), "utf8")),
    "BrowserWindow keeps contextIsolation, no Node integration, sandbox on");
}

console.log("Electron IPC policy:");
{
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle: (channel, handler) => {
      if (handlers.has(channel)) throw new Error("handler_duplicate");
      handlers.set(channel, handler);
    },
    removeHandler: channel => { removed.push(channel); handlers.delete(channel); },
  };
  const webContents = {};
  const actions = Object.fromEntries(ELECTRON_IPC_CHANNELS.map(channel =>
    [channel, input => ({ channel, input })]));
  const dispose = registerHostHandlers(ipcMain, {
    webContents, actions, rendererUrl: "skyos://app/echo/electron/renderer.html",
  });
  check(handlers.size === ELECTRON_IPC_CHANNELS.length,
    "main registers only explicit capability handlers");
  const statusHandler = handlers.get("skyos:status");
  const result = await statusHandler({
    sender: webContents,
    senderFrame: { url: "skyos://app/echo/electron/renderer.html" },
  }, { request: 1 });
  check(result.channel === "skyos:status" && result.input.request === 1,
    "IPC action executes for the trusted top-level renderer");
  await assert.rejects(statusHandler({
    sender: {}, senderFrame: { url: "skyos://app/echo/electron/renderer.html" },
  }), { message: "ipc_sender_denied" });
  passed++;
  console.log(" ok IPC rejects other webContents");
  await assert.rejects(statusHandler({
    sender: webContents, senderFrame: { url: "https://attacker.example/" },
  }), { message: "ipc_frame_denied" });
  passed++;
  console.log(" ok IPC rejects untrusted frames");
  dispose();
  check(handlers.size === 0 && removed.length === ELECTRON_IPC_CHANNELS.length,
    "IPC handlers remove cleanly on application shutdown");
}

console.log("Node persistence:");
{
  const dir = await mkdtemp(join(tmpdir(), "skyos-host-"));
  try {
    const persist = createNodePersistence(dir);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await persist.saveVolume("volume.skcs", bytes);
    check(Buffer.compare(Buffer.from(await persist.loadVolume("volume.skcs")), Buffer.from(bytes)) === 0,
      "volume saved and loaded byte-identically");
    check((await persist.listVolumes()).join(",") === "volume.skcs", "volume list is sorted and filtered");
    check(await persist.deleteVolume("volume.skcs"), "existing volume deleted");
    check(await persist.loadVolume("volume.skcs") === null, "missing volume returns null");
    check(!(await persist.deleteVolume("missing.skcs")), "deleting missing volume reports false");
    await assert.rejects(persist.saveVolume("../escape", bytes), { message: "volume_name_invalid" });
    passed++;
    console.log(" ok persistence rejects traversal before write");
    await assert.rejects(access(join(dir, "..", "escape")));
    passed++;
    console.log(" ok traversal target remains untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("Shared ITERON/SKYLUM host:");
{
  const root = resolve(new URL("..", import.meta.url).pathname);
  const dir = await mkdtemp(join(tmpdir(), "skyos-host-runtime-"));
  try {
    const persist = createNodePersistence(dir);
    const runtime = await loadRuntime({ persist });
    const protocol = createHostProtocol(runtime);
    const status = await protocol.dispatch("status");
    check(status.host.runtime === "node" && status.persist.available,
      "headless boot reports Node host and filesystem persistence");
    check(status.claims.some(claim => claim.name === "boot.cfg") &&
      status.claims.some(claim => claim.name === "vendor/globe.gl.min.js"),
    "shared runtime loads claims and sealed vendor member");
    const read = await protocol.dispatch("claims.read", { name: "boot.cfg" });
    check(read.size > 0 && /^[a-f0-9]{64}$/.test(read.sha256),
      "claim read returns bounded bytes and SHA-256 seal");
    const saved = await protocol.dispatch("volumes.save", { name: "roundtrip.skcs" });
    const bytes = await persist.loadVolume("roundtrip.skcs");
    const parsed = runtime.core.skcsParse(bytes);
    check(saved.bytes === bytes.length && parsed?.members.length >= 4,
      "headless save writes a valid .skcs volume");
    runtime.skylum.memory.free("boot.cfg");
    check(!(await protocol.dispatch("claims.list")).some(claim => claim.name === "boot.cfg"),
      "protocol reflects service mutations through shared runtime");
    check((await protocol.dispatch("volumes.load", { name: "roundtrip.skcs" })).found &&
      runtime.skylum.memory.get("boot.cfg") !== null,
    "saved volume restores state through shared SKYLUM");
    await assert.rejects(protocol.dispatch("process.exec"), { message: "host_command_denied" });
    passed++;
    console.log(" ok protocol refuses arbitrary process commands");
    await assert.rejects(protocol.dispatch("claims.read", { name: "../secret" }),
      { message: "claim_name_invalid" });
    passed++;
    console.log(" ok protocol validates claim selectors");
    await assert.rejects(protocol.dispatch("volumes.save", { name: "../../escape" }),
      { message: "volume_name_invalid" });
    passed++;
    console.log(" ok protocol validates persistence names");
    const result = await protocol.dispatch("quine.reemit");
    check(result.bytes === Buffer.byteLength(result.html), "headless quine command returns measured output");
    const probe = await protocol.dispatch("hw.probe");
    check(probe.platform === process.platform &&
      Array.isArray(probe.pci?.display) &&
      Array.isArray(probe.drm?.nodes) &&
      typeof probe.groups === "object" &&
      probe.vulkan !== null,
      "hw.probe returns the measured inventory shape");
    check(probe.drm.nodes.every(node =>
      typeof node.path === "string" && typeof node.accessible === "boolean"),
      "hw.probe dri nodes report honest accessibility");
    check(probe.pci.display.every(dev => dev.vendor === null ||
      /^0x[0-9a-f]+$/i.test(dev.vendor)),
      "hw.probe pci vendors are real sysfs ids");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("Host doors:");
{
  const dir = await mkdtemp(join(tmpdir(), "skyos-host-doors-"));
  let server, runtime;
  try {
    throws(() => new Skylum({}, { doors: { extra: [{ id: 42 }] } }),
      "door_extra_invalid", "host adapters must declare id, name, and send/recv");
    runtime = await loadRuntime({
      persist: createNodePersistence(dir),
      doors: { extra: nodeHostDoors() },
    });
    const protocol = createHostProtocol(runtime);
    const status = await protocol.dispatch("status");
    for (const id of [DOOR.netprobe, DOOR.serialscan, DOOR.netifaces])
      check(status.doors.some(door => door.id === id),
        `host runtime registers door ${id}`);
    server = createServer().listen(0, "127.0.0.1");
    await new Promise(res => server.once("listening", res));
    const open = await protocol.dispatch("doors.send", {
      id: DOOR.netprobe,
      payload: Buffer.from(`127.0.0.1:${server.address().port}`).toString("base64"),
    });
    check(Buffer.from(open.receipt, "hex")[1] === 0,
      "netprobe receipts a real established TCP connection");
    const closedPort = server.address().port;
    await new Promise(res => server.close(res)); server = null;
    const closed = await protocol.dispatch("doors.send", {
      id: DOOR.netprobe,
      payload: Buffer.from(`127.0.0.1:${closedPort}`).toString("base64"),
    });
    check(Buffer.from(closed.receipt, "hex")[1] === 1,
      "netprobe reports a refused connection honestly");
    const malformed = await protocol.dispatch("doors.send", {
      id: DOOR.netprobe,
      payload: Buffer.from("not a target").toString("base64"),
    });
    check(Buffer.from(malformed.receipt, "hex")[1] === 3,
      "netprobe rejects malformed targets without probing");
    const ifaces = JSON.parse(Buffer.from(
      (await protocol.dispatch("doors.recv", { id: DOOR.netifaces })).bytes, "base64"
    ).toString());
    check(ifaces !== null && typeof ifaces === "object" &&
      Object.values(ifaces).some(list => list.some(entry => entry.internal)),
      "netifaces returns the real interface inventory with loopback marked internal");
    check(runtime.skylum.bus.log.at(-1).dir === "rx",
      "door recv writes an rx entry to the bus audit log");
    const serials = JSON.parse(Buffer.from(
      (await protocol.dispatch("doors.recv", { id: DOOR.serialscan })).bytes, "base64"
    ).toString());
    check(Array.isArray(serials) &&
      serials.every(path => path.startsWith("/dev/")),
      "serialscan returns honest /dev inventory (empty is a valid answer)");
    await assert.rejects(protocol.dispatch("doors.recv", { id: DOOR.netprobe }),
      { message: `door ${DOOR.netprobe} has no recv` });
    passed++;
    console.log(" ok recv on a send-only door fails closed");

    // tcprelay: real socket roundtrip through a live echo server
    server = createServer(sock => sock.pipe(sock)).listen(0, "127.0.0.1");
    await new Promise(res => server.once("listening", res));
    check(status.doors.some(door => door.id === DOOR.tcprelay),
      "host runtime registers tcprelay door");
    const relayPayload = Buffer.concat([
      Buffer.from(`127.0.0.1:${server.address().port}`),
      Buffer.from([0]),
      Buffer.from("mesh-frame-over-tcp"),
    ]);
    const relayReceipt = await protocol.dispatch("doors.send", {
      id: DOOR.tcprelay, payload: relayPayload.toString("base64"),
    });
    check(Buffer.from(relayReceipt.receipt, "hex")[1] === 0,
      "tcprelay send receipts a real socket write");
    const echoed = Buffer.from(
      (await protocol.dispatch("doors.recv", { id: DOOR.tcprelay })).bytes, "base64");
    check(echoed.toString() === "mesh-frame-over-tcp",
      "tcprelay recv drains real socket bytes back");
    const badRelay = await protocol.dispatch("doors.send", {
      id: DOOR.tcprelay, payload: Buffer.from("no-separator-here").toString("base64"),
    });
    check(Buffer.from(badRelay.receipt, "hex")[1] === 3,
      "tcprelay rejects payloads without a target frame");
  } finally {
    server?.close();
    runtime?.skylum.bus.doors.get(DOOR.tcprelay)?.adapter?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("Loopback bridge:");
{
  const dir = await mkdtemp(join(tmpdir(), "skyos-bridge-"));
  const runtime = await loadRuntime({ persist: createNodePersistence(dir) });
  const token = "host-test-token";
  let bridge;
  try {
    await assert.rejects(startBridge({ runtime, host: "0.0.0.0" }),
      { message: "bridge_bind_must_be_loopback" });
    passed++;
    console.log(" ok non-loopback bind rejected");
    bridge = await startBridge({ runtime, token, allowedOrigins: ["https://allowed.example"] });
    const post = (body, headers = {}) => fetch(bridge.url, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const unauthorized = await post({ version: 1, command: "status" });
    check(unauthorized.status === 401, "bridge requires per-run bearer token");
    const originDenied = await post({ version: 1, command: "status" },
      { authorization: `Bearer ${token}`, origin: "https://hostile.example" });
    check(originDenied.status === 403, "bridge rejects unapproved browser origins");
    const ok = await post({ version: 1, command: "status" },
      { authorization: `Bearer ${token}` });
    const body = await ok.json();
    check(ok.status === 200 && body.value.host.runtime === "node",
      "authorized bridge serves shared host status");
    const forbidden = await post({ version: 1, command: "process.exec", args: { command: "id" } },
      { authorization: `Bearer ${token}` });
    check(forbidden.status === 403 && (await forbidden.json()).error === "host_command_denied",
      "bridge denies commands outside fixed allowlist");
    const badVersion = await post({ version: 2, command: "status" },
      { authorization: `Bearer ${token}` });
    check(badVersion.status === 400, "bridge requires protocol version match");
    const oversized = await new Promise((resolve, reject) => {
      const req = httpRequest(bridge.url, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "content-length": String(1 << 21) } }, resolve);
      req.once("error", reject);
      req.end("{}");
    });
    check(oversized.statusCode === 413, "bridge rejects oversized declared requests");
    oversized.resume();
  } finally {
    await bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
  let stopped = false;
  try { await fetch(bridge.url); } catch { stopped = true; }
  check(stopped, "bridge shuts down its listening socket");
}

console.log(`Host: ${passed} passed`);
