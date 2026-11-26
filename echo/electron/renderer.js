import { loadRuntime } from "../../host/runtime.js";
import { DOOR } from "../../skylum/doors.js";
import { Desktop } from "../desktop.js";

const statusNode = document.getElementById("boot-status");

const toB64 = bytes => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromB64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

try {
  const host = window.skyosHost;
  if (!host) throw new Error("electron_preload_unavailable");
  const wasmResponse = await fetch("../../vendor/skc-wasm.wasm");
  if (!wasmResponse.ok) throw new Error(`wasm_unavailable:${wasmResponse.status}`);
  const stateResponse = await fetch("../../skylum/seed.skcs");
  if (!stateResponse.ok) throw new Error(`state_volume_unavailable:${stateResponse.status}`);
  const vendorResponse = await fetch("../vendor/globe.gl.min.js");
  if (!vendorResponse.ok) throw new Error(`vendor_unavailable:${vendorResponse.status}`);
  const hostPersist = {
    available: true,
    opfsSupported: () => false,
    saveVolume: async (name, bytes) => {
      await host.saveVolume({ name, bytesB64: toB64(bytes) });
    },
    loadVolume: async name => {
      const result = await host.loadVolume({ name });
      return result.found ? fromB64(result.bytesB64) : null;
    },
    listVolumes: () => host.listVolumes(),
    deleteVolume: async name => (await host.deleteVolume({ name })).deleted === true,
  };
  const hostDoorExtras = () => [
    { id: DOOR.netprobe, name: "net-probe",
      adapter: { send: async bytes => {
        const result = await host.sendDoor({ id: DOOR.netprobe, payload: toB64(bytes) });
        return { verdict: Number.parseInt(result.receipt.slice(2, 4), 16) };
      } } },
    { id: DOOR.serialscan, name: "serial-scan",
      adapter: { recv: async maxBytes =>
        fromB64((await host.recvDoor({ id: DOOR.serialscan, maxBytes })).bytes) } },
    { id: DOOR.netifaces, name: "net-interfaces",
      adapter: { recv: async maxBytes =>
        fromB64((await host.recvDoor({ id: DOOR.netifaces, maxBytes })).bytes) } },
  ];
  const runtime = await loadRuntime({
    wasmBytes: new Uint8Array(await wasmResponse.arrayBuffer()),
    stateBytes: new Uint8Array(await stateResponse.arrayBuffer()),
    vendorBytes: new Uint8Array(await vendorResponse.arrayBuffer()),
    persist: hostPersist,
    doors: { extra: hostDoorExtras() },
    host: { runtime: "electron", capabilities: {
      filesystem: true, bridge: true, webserial: false,
      netprobe: true, serialscan: true, netifaces: true,
    } } });
  const os = {
    ...runtime,
    host,
    saveSession: async () => desktop?.saveSession?.(),
    get stateBlob() { return runtime.iteron.stateBlob; },
    set stateBlob(bytes) { runtime.iteron.stateBlob = bytes; },
    get manifest() { return runtime.iteron.manifest; },
    reemit: () => runtime.iteron.reemit(),
    download: async (data, name, type = "application/octet-stream") => {
      if (type === "text/html") {
        const html = typeof data === "string" ? data : new TextDecoder().decode(data);
        return host.exportArtifact({ name, html });
      }
      if (name.endsWith(".skcs")) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        return host.exportVolume({ name, bytesB64: toB64(bytes) });
      }
      throw new Error("host_export_type_unsupported");
    },
  };
  const desktop = new Desktop(os);
  window.OS = os;
  window.DESKTOP = desktop;
  await desktop.bootSession();
  const status = await runtime.skylum.status();
  statusNode.textContent = `Electron host ready · ${status.claims.length} claims`;
  const bridge = await host.bridgeStatus();
  document.getElementById("status-line").textContent =
    `HOST ELECTRON · BRIDGE ${bridge.enabled ? "ON 127.0.0.1" : "OFF"}`;
} catch (error) {
  statusNode.textContent = `Host failed: ${error.message}`;
}
