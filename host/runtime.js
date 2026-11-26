import { IteronCore } from "../iteron/iteron-core.js";
import { Iteron, b64encode } from "../iteron/iteron.js";
import { Skylum } from "../skylum/index.js";

const DEFAULT_WASM = "../vendor/skc-wasm.wasm";
const DEFAULT_STATE = "../skylum/seed.skcs";
const DEFAULT_VENDOR = "../echo/vendor/globe.gl.min.js";

export async function loadRuntime({ wasmPath, statePath,
  vendorPath = null, wasmBytes = null, stateBytes = null, vendorBytes = null,
  persist, infer = {}, mesh = {}, doors = {}, host = { runtime: "node",
    capabilities: { filesystem: true, bridge: true, webserial: false } } } = {}) {
  const read = async (path, label) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${label}_unavailable:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const defaultNodeFiles = !wasmBytes && !stateBytes &&
    typeof process !== "undefined" && !!process.versions?.node;
  if (defaultNodeFiles) {
    const [{ readFile }, { dirname, resolve }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"), import("node:path"), import("node:url"),
    ]);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    wasmPath ??= process.env.SKYOS_SKC_WASM
      ? resolve(process.env.SKYOS_SKC_WASM)
      : resolve(root, "vendor/skc-wasm.wasm");
    statePath ??= resolve(root, "skylum/seed.skcs");
    vendorPath = vendorPath ? resolve(root, vendorPath) : resolve(root, "echo/vendor/globe.gl.min.js");
    const [wasm, initialState, vendor] = await Promise.all([
      readFile(wasmPath), readFile(statePath),
      vendorBytes ? Promise.resolve(vendorBytes) : readFile(vendorPath).catch(() => null),
    ]);
    return initializeRuntime({ wasm, initialState, vendor, persist, infer, mesh, doors, host });
  }
  const [wasm, initialState, vendor] = await Promise.all([
    wasmBytes ?? read(wasmPath ?? new URL(DEFAULT_WASM, import.meta.url).pathname, "wasm"),
    stateBytes ?? read(statePath ?? DEFAULT_STATE, "state_volume"),
    vendorBytes ?? (vendorPath ? read(vendorPath, "vendor").catch(() => null) : Promise.resolve(null)),
  ]);
  return initializeRuntime({ wasm, initialState, vendor, persist, infer, mesh, doors, host });
}

async function initializeRuntime({ wasm, initialState, vendor, persist, infer, mesh, doors, host }) {
  const wasmData = new Uint8Array(wasm);
  const stateData = new Uint8Array(initialState);
  const vendorData = vendor ? new Uint8Array(vendor) : null;
  const core = await IteronCore.create(wasmData);
  const parsed = core.skcsParse(stateData);
  if (!parsed) throw new Error("state_volume_malformed");
  const members = [];
  for (const member of parsed.members) {
    members.push({
      name: member.name,
      data: await core.inflateMember(member),
      kind: member.kindName ?? member.kind,
      media: member.media,
      meta: member.meta,
      codec: "auto",
    });
  }
  if (vendorData && !members.some(member => member.name === "vendor/globe.gl.min.js")) {
    members.push({ name: "vendor/globe.gl.min.js", data: vendorData,
      kind: "file", media: "text/javascript", codec: "auto" });
  }
  const packedState = await core.skcsPack(members, parsed.flags);
  const manifest = { format: "DESKTOP1", layers: ["iteron", "skylum", "echo"] };
  const parts = {
    wasmB64: b64encode(wasmData),
    stateB64: b64encode(stateData),
    vendorB64: vendorData ? b64encode(vendorData) : "",
    manifestStr: JSON.stringify(manifest),
    tmplB64: "",
    engineSrc: "",
    extraBootSrc: "",
  };
  const iteron = new Iteron(core, packedState, manifest, parts);
  const skylum = new Skylum(iteron, { infer, mesh, persist, doors, host });
  await skylum.loadState();
  return { core, iteron, skylum };
}

export function createHostApi(runtime) {
  const { iteron, skylum } = runtime;
  return Object.freeze({
    async status() {
      const status = await skylum.status();
      return { ...status, host: { ...skylum.host, desktop: false } };
    },
    async listClaims() {
      return skylum.memory.list().map(claim => ({
        name: claim.name, size: claim.size, perms: claim.perms, kind: claim.kind,
        media: claim.media, dirty: claim.dirty,
      }));
    },
    async readClaim(name, maxBytes = 1 << 20) {
      validateClaimName(name);
      validateLimit(maxBytes, "claim_limit", 1 << 20);
      const claim = skylum.memory.get(name);
      if (!claim) throw new Error("claim_not_found");
      if (claim.size > maxBytes) throw new Error("claim_too_large");
      const bytes = await skylum.memory.read(name);
      return { name, bytes: b64encode(bytes), size: bytes.length,
        sha256: Buffer.from(await skylum.memory.seal(name)).toString("hex") };
    },
    async saveVolume(name = "state.skcs") {
      validateVolumeName(name);
      const bytes = await skylum.save();
      await skylum.persist.saveVolume(name, bytes);
      iteron.stateBlob = bytes;
      return { name, bytes: bytes.length,
        sha256: Buffer.from(runtime.core.sha256(bytes)).toString("hex") };
    },
    async loadVolume(name = "state.skcs") {
      validateVolumeName(name);
      const bytes = await skylum.persist.loadVolume(name);
      if (!bytes) return { found: false, name };
      const parsed = runtime.core.skcsParse(bytes);
      if (!parsed) throw new Error("state_volume_malformed");
      iteron.stateBlob = bytes;
      await skylum.loadState();
      return { found: true, name, bytes: bytes.length, members: parsed.members.length };
    },
    async listVolumes() {
      return skylum.persist.listVolumes();
    },
    async infer(prompt) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_384)
        throw new Error("infer_prompt_invalid");
      const result = await skylum.infer.complete(prompt);
      return {
        text: result.text,
        usage: result.usage,
        seal: { fnv1a64: result.seal.fnv1a64.toString(),
          sha256: Buffer.from(result.seal.sha256).toString("hex") },
      };
    },
    async sendDoor(id, payloadB64) {
      if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("door_id_invalid");
      const bytes = decodePayload(payloadB64, 1 << 20);
      const receipt = await skylum.bus.send(bytes, id);
      return { receipt: Buffer.from(receipt).toString("hex") };
    },
    async hwProbe() {
      const { probeHardware } = await import("./hw-probe.js");
      return probeHardware();
    },
    async recvDoor(id, maxBytes = 1 << 20) {
      if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("door_id_invalid");
      validateLimit(maxBytes, "door_recv_limit", 1 << 20);
      const bytes = await skylum.bus.recv(id, maxBytes);
      return { bytes: Buffer.from(bytes).toString("base64"), size: bytes.length };
    },
    async reemit() {
      const html = iteron.reemit();
      return { html, bytes: Buffer.byteLength(html) };
    },
  });
}

export function validateClaimName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name) ||
      name.split("/").some(part => part === "." || part === ".."))
    throw new Error("claim_name_invalid");
  return name;
}

export function validateVolumeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
      name === "." || name === "..")
    throw new Error("volume_name_invalid");
  return name;
}

export function validateLimit(value, code = "limit_invalid", max = 1 << 20) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(code);
  return value;
}

export function decodePayload(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("payload_base64_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== value)
    throw new Error("payload_too_large_or_noncanonical");
  return new Uint8Array(bytes);
}
