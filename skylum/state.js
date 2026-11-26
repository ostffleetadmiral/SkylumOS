// state.js — SKYLUM OS state: claims mapped onto .skcs member kinds.
// Persistence = ITERON skcs_pack/skcs_parse roundtrip; claims carry
// metadata in member.meta (JSON) so the volume stays self-describing.

import { KIND } from "../iteron/iteron-core.js";

// claim kinds -> .skcs member kinds (LAYERS.md §1)
export const CLAIM_KIND = {
  file: KIND.file,        // ordinary payload file
  ramdump: KIND.ramdump,  // memory region image {base,size,perms}
  vram: KIND.vram,        // framebuffer {width,height,format,pitch}
  manifest: KIND.manifest,// OS manifest / claim table
};

const KIND_NAMES = ["file", "ramdump", "vram", "manifest"];

// Build a member record for the ITERON skcs_pack ABI.
export function claimMember(name, data, { kind = "file", media = "", meta = {} } = {}) {
  return {
    kind,
    codec: "auto",           // ITERON resolves raw/zlib per member
    name,
    data: data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)),
    media,
    meta: Object.keys(meta).length ? JSON.stringify(meta) : "",
  };
}

// Parse meta JSON safely.
export function claimMeta(member) {
  try { return member.meta ? JSON.parse(member.meta) : {}; }
  catch { return {}; }
}

// SKYLUM claim table -> member list for iteron.commit()
export class ClaimSpace {
  constructor() { this.claims = new Map(); }

  put(name, data, opts = {}) {
    const m = claimMember(name, data, opts);
    this.claims.set(name, m);
    return m;
  }

  // typed helpers
  putRamdump(name, bytes, { base = "0x0", size = null, perms = "rw" } = {}) {
    return this.put(name, bytes, {
      kind: "ramdump", media: "raw",
      meta: { base, size: size ?? bytes.length, perms },
    });
  }

  putVram(name, rgba, { width, height, format = "rgba8", pitch = width * 4 } = {}) {
    return this.put(name, rgba, {
      kind: "vram", media: format,
      meta: { width, height, format, pitch },
    });
  }

  putManifest(obj) {
    return this.put("MANIFEST.json", JSON.stringify(obj, null, 2),
      { kind: "manifest", media: "application/json" });
  }

  members() { return [...this.claims.values()]; }

  // persist: pack claims into a new .skcs state volume via ITERON.
  // Members may be claimMember products (raw data) OR raw skcsParse
  // output (stored bytes, numeric kind/codec) — normalize both through
  // inflateMember + claimMember so skcsPack always sees raw data.
  async save(iteron, flags = 0) {
    const out = [];
    for (const m of this.claims.values()) {
      const raw = await iteron.core.inflateMember(m);
      const kind = typeof m.kind === "number"
        ? (KIND_NAMES[m.kind] ?? "file") : (m.kind ?? "file");
      out.push(claimMember(m.name, raw, {
        kind, media: m.media ?? "", meta: claimMeta(m),
      }));
    }
    return iteron.commit(out, flags);
  }

  // load: hydrate claims from a parsed .skcs volume. Members keep their
  // parsed shape (stored bytes); save() normalizes before packing.
  load(parsed) {
    this.claims.clear();
    for (const m of parsed?.members ?? []) {
      this.claims.set(m.name, m);
    }
    return this;
  }
}
