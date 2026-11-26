// iteron.js — ITERON quine-runtime (browser side).
// Boots the engine from embedded slots, exposes window.ITERON, implements
// reemit() per LAYERS.md §4.
//
// Slot law (dot3/vSuper pattern): the artifact carries __TEMPLATE_B64__ —
// base64 of template.html itself. The decoded template still contains the
// literal markers __WASM_B64__/__STATE_B64__/__MANIFEST__/__ENGINE__/
// __TEMPLATE_B64__, so reemit() = decode template → substitute slots →
// byte-identical HTML iff inputs unchanged.

import { IteronCore } from "./iteron-core.js";

const B64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function b64encode(bytes) {
  // chunked — spread-arg btoa blows the stack on large blobs
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

const SLOT_IDS = {
  wasm: "iteron-wasm",
  state: "iteron-state",
  manifest: "iteron-manifest",
  tmpl: "iteron-tmpl",
  extraBoot: "iteron-extra-boot",
};

export class Iteron {
  // parts: {wasmB64, stateB64, manifestStr, engineSrc, tmplB64}
  constructor(core, stateBlob, manifest, parts) {
    this.core = core;
    this.stateBlob = stateBlob;
    this.manifest = manifest;
    this.parts = parts;
    // canonical manifest string — reemit() reuses it verbatim so output is
    // byte-identical; mutate via setManifest() which re-serializes.
    this.manifestStr = parts.manifestStr ?? JSON.stringify(manifest).replaceAll("<", "\\u003c");
  }

  setManifest(obj) {
    this.manifest = obj;
    this.manifestStr = JSON.stringify(obj).replaceAll("<", "\\u003c");
  }

  static async boot(doc = document) {
    const g = id => doc.getElementById(id).textContent;
    const parts = {
      wasmB64: g(SLOT_IDS.wasm).trim(),
      stateB64: g(SLOT_IDS.state).trim(),
      manifestStr: g(SLOT_IDS.manifest),
      tmplB64: g(SLOT_IDS.tmpl).trim(),
      engineSrc: g("iteron-engine-src"),
      extraBootSrc: doc.getElementById(SLOT_IDS.extraBoot)?.textContent ?? "",
    };
    const core = await IteronCore.create(B64(parts.wasmB64));
    const manifest = JSON.parse(parts.manifestStr);
    return new Iteron(core, B64(parts.stateB64), manifest, parts);
  }

  // reemit(): regenerate artifact HTML from current state. Pure function —
  // testable in bun without DOM.
  reemit() {
    const tmplBytes = B64(this.parts.tmplB64);
    const tmpl = new TextDecoder().decode(tmplBytes);
    const wasmMarker = "__WASM_" + "B64__";
    const stateMarker = "__STATE_" + "B64__";
    const vendorMarker = "__VENDOR_" + "B64__";
    const manifestMarker = "__MANI" + "FEST__";
    const desktopBootMarker = "__DESKTOP_" + "BOOT__";
    const extraBootMarker = "__EXTRA_" + "BOOT__";
    const templateSlotMarker = "__TEMPLATE_" + "B64__";
    // order matters: __TEMPLATE_B64__ before __ENGINE__ — engineSrc contains
    // the literal marker strings (its own replaceAll calls) which must
    // survive verbatim, exactly as make_quine.py substitutes them.
    // __EXTRA_BOOT__ likewise precedes __ENGINE__.
    return tmpl
      .replaceAll(wasmMarker, this.parts.wasmB64)
      .replaceAll(vendorMarker, this.parts.vendorB64 ?? "")
      .replaceAll(stateMarker, this.parts.vendorB64 ? this.parts.stateB64 : b64encode(this.stateBlob))
      .replaceAll(manifestMarker, this.manifestStr)
      .replaceAll(templateSlotMarker, this.parts.tmplB64)
      .replaceAll(extraBootMarker, this.parts.extraBootSrc ?? "")
      .replaceAll("__ENGINE__", this.parts.engineSrc)
      .replaceAll(desktopBootMarker, this.parts.desktopBootSrc ?? "");
  }

  // inspect the state volume (.skcs) — inflates codec members
  async inspect() {
    const parsed = this.core.skcsParse(this.stateBlob);
    const members = [];
    for (const m of parsed?.members ?? []) {
      members.push({ ...m, data: await this.core.inflateMember(m) });
    }
    return { flags: parsed?.flags ?? 0, members };
  }

  // commit a new state volume
  async commit(members, flags = 0) {
    this.stateBlob = await this.core.skcsPack(members, flags);
    return this.stateBlob;
  }

  // door receipt per LAYERS.md §3: door_id u8 | verdict u8 | fnv1a64 u64 |
  // sha256[32] — 42 bytes, little-endian.
  doorReceipt(doorId, verdict, payload) {
    const r = new Uint8Array(42);
    const dv = new DataView(r.buffer);
    dv.setUint8(0, doorId);
    dv.setUint8(1, verdict);
    dv.setBigUint64(2, this.core.fnv1a64(payload), true);
    r.set(this.core.sha256(payload), 10);
    return r;
  }
}
