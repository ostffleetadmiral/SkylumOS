import { IteronCore } from "../iteron/iteron-core.js";
import { Iteron, b64encode } from "../iteron/iteron.js";
import { Skylum } from "../skylum/index.js";
import { Desktop } from "./desktop.js";

const WASM_URL = "/skyos/vendor/skc-wasm.wasm";

export async function bootDesktop({ doc = document, wasmBytes = null, stateBlob = null,
  manifest = null, parts = null, infer = {}, mesh = {} } = {}) {
  const fetchBytes = async (url, label) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label}_unavailable:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const bootWasm = wasmBytes ?? await fetchBytes(WASM_URL, "wasm");
  const core = await IteronCore.create(bootWasm);
  let state = stateBlob ?? await fetchBytes("../skylum/seed.skcs", "state_volume");
  if (!parts?.vendorB64 && !stateBlob) {
    const vendorResponse = await fetch("./vendor/globe.gl.min.js");
    if (!vendorResponse.ok) throw new Error("globe vendor unavailable");
    const vendor = new Uint8Array(await vendorResponse.arrayBuffer());
    const parsed = core.skcsParse(state);
    if (!parsed) throw new Error("malformed_state_volume");
    const members = [];
    for (const member of parsed.members) {
      const raw = await core.inflateMember(member);
      const kind = member.kindName ?? member.kind;
      members.push({ name: member.name, data: raw, kind, media: member.media,
        meta: member.meta, codec: "auto" });
    }
    members.push({ name: "vendor/globe.gl.min.js", data: vendor, kind: "file",
      media: "text/javascript", codec: "auto" });
    state = await core.skcsPack(members, parsed.flags);
  }
  const manifestValue = manifest ?? { format: "DESKTOP1", layers: ["iteron", "skylum", "echo"] };
  const iteron = new Iteron(core, state, manifestValue, parts ?? {
    wasmB64: "", stateB64: b64encode(state), manifestStr: JSON.stringify(manifestValue),
    vendorB64: "", tmplB64: "", engineSrc: "", extraBootSrc: "",
  });
  const skylum = new Skylum(iteron, { infer, mesh });
  await skylum.loadState();
  const os = {
    core, iteron, skylum,
    getCore: async () => core,
    saveSession: async () => desktop?.saveSession?.(),
    download(data, name, type = "application/octet-stream") {
      const blob = new Blob([data], { type }), url = URL.createObjectURL(blob);
      const a = doc.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
  const desktop = new Desktop(os, doc);
  try {
    await desktop.bootSession();
  } catch (error) {
    desktop.destroy();
    throw error;
  }
  doc.defaultView.OS = os;
  doc.defaultView.DESKTOP = desktop;
  return { os, desktop };
}

if (typeof document !== "undefined" && document.getElementById("window-layer")) {
  bootDesktop().then(({ os }) => {
    const status = document.getElementById("boot-status");
    status.textContent = `SkyOS desktop ready · ${os.skylum.memory.claims.size} claims`;
  }).catch(error => {
    document.getElementById("boot-status").textContent = `Boot failed: ${error.message}`;
  });
}
