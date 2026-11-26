// iteron-core.js — ITERON substrate engine (DOM-free).
// Wraps the skc-wasm zero-import executor: all SKC1 formats, digests,
// member marshal for .skcs v2, store-only ZIP writer, format sniffing.
// Runs in browser and bun. Memory-detach rule: re-fetch memory.buffer
// view after every allocating call — never cache the Uint8Array view.
//
// Contract: prototypes/skyos/docs/LAYERS.md

export const KIND = { file: 0, ramdump: 1, vram: 2, manifest: 3 };
export const CODEC = { raw: 0, zlib: 1 }; // zig-side; "auto" resolved in JS
export const CARRIER = { qr: 0, blocks: 1, rgba: 2, tcp: 3, serial: 4 };
export const FRAME_CODEC = { raw: 0, encraw: 1, lemonade: 2, polyglot: 3 };
export const SKCF_VERDICT = ["ok", "foreign", "bad_version", "malformed"];

const te = new TextEncoder();
const td = new TextDecoder();

// ---------------------------------------------------------------------------
// CRC-32 (IEEE) — needed for the ZIP writer; table-built once.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class IteronCore {
  constructor(exports) {
    this.e = exports;
  }

  static async create(wasmBytes) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return new IteronCore(instance.exports);
  }

  // -- memory helpers (detach-safe) -----------------------------------------
  view() { return new Uint8Array(this.e.memory.buffer); }

  _allocCopy(data) {
    if (data.length === 0) return 0; // zero-len slice; ptr value unused
    const p = this.e.skc_alloc(data.length);
    if (!p) throw new Error("skc_alloc failed");
    this.view().set(data, p);
    return p;
  }

  // Call an export that returns a ptr+len result; copies out before return.
  _callRet(fn, ...args) {
    const p = fn(...args);
    if (!p) return null;
    const len = this.e.skc_last_len();
    return this.view().slice(p, p + len);
  }

  _callScalar(fn, ...args) { return fn(...args); }

  // -- digests ---------------------------------------------------------------
  sha256(data) { return this._callRet(this.e.skc_sha256, this._allocCopy(data), data.length); }
  fnv1a32(data) { return this._callScalar(this.e.skc_fnv1a, this._allocCopy(data), data.length) >>> 0; }
  fnv1a64(data) { return BigInt.asUintN(64, this._callScalar(this.e.skc_fnv1a64, this._allocCopy(data), data.length)); }

  // -- lemonade ---------------------------------------------------------------
  // files: [{name, data}] -> LEML blob
  lemonadePack(manifestObj, files) {
    const mf = te.encode(JSON.stringify(manifestObj));
    const parts = [new Uint8Array(4)];
    new DataView(parts[0].buffer).setUint32(0, files.length, true);
    const chunks = [parts[0]];
    let total = 4;
    for (const f of files) {
      const nb = te.encode(f.name), db = f.data instanceof Uint8Array ? f.data : te.encode(String(f.data));
      const h = new Uint8Array(2 + nb.length + 4 + db.length);
      const dv = new DataView(h.buffer);
      dv.setUint16(0, nb.length, true);
      h.set(nb, 2);
      dv.setUint32(2 + nb.length, db.length, true);
      h.set(db, 6 + nb.length);
      chunks.push(h); total += h.length;
    }
    const flat = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { flat.set(c, off); off += c.length; }
    const mp = this._allocCopy(mf), fp = this._allocCopy(flat);
    return this._callRet(this.e.lemonade_pack, mp, mf.length, fp, flat.length);
  }

  // LEML blob -> {manifest: object, files: [{name, data}]}
  lemonadeUnpack(blob) {
    const p = this._allocCopy(blob);
    const raw = this._callRet(this.e.lemonade_unpack, p, blob.length);
    if (!raw) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let pos = 0;
    const mlen = dv.getUint32(pos, true); pos += 4;
    const manifest = JSON.parse(td.decode(raw.subarray(pos, pos + mlen))); pos += mlen;
    const count = dv.getUint32(pos, true); pos += 4;
    const files = [];
    for (let i = 0; i < count; i++) {
      const nl = dv.getUint16(pos, true); pos += 2;
      const name = td.decode(raw.subarray(pos, pos + nl)); pos += nl;
      const dl = dv.getUint32(pos, true); pos += 4;
      files.push({ name, data: raw.slice(pos, pos + dl) }); pos += dl;
    }
    return { manifest, files };
  }

  // -- FSK --------------------------------------------------------------------
  fskEncode(data, baud = 1200) {
    const p = this._allocCopy(data);
    return this._callRet(this.e.fsk_encode, p, data.length, baud);
  }
  fskDecode(wav, baud = 1200) {
    const p = this._allocCopy(wav);
    return this._callRet(this.e.fsk_decode, p, wav.length, baud);
  }

  // -- fountain ---------------------------------------------------------------
  // framesBlob format: u32 nframes | per frame {u32 len, frame bytes}
  fountainEncode(payload, blockLen = 900, sessionId = 0x5ac1, count = 0) {
    const p = this._allocCopy(payload);
    return this._callRet(this.e.fountain_encode, p, payload.length, blockLen, sessionId, count);
  }
  fountainDecode(framesBlob, totalLen, blockLen = 900, sessionId = 0x5ac1) {
    const p = this._allocCopy(framesBlob);
    return this._callRet(this.e.fountain_decode, p, framesBlob.length, totalLen, blockLen, sessionId);
  }

  // iterate decoded frames from a frames blob
  *iterFrames(framesBlob) {
    const dv = new DataView(framesBlob.buffer, framesBlob.byteOffset, framesBlob.byteLength);
    const n = dv.getUint32(0, true);
    let pos = 4;
    for (let i = 0; i < n; i++) {
      const len = dv.getUint32(pos, true); pos += 4;
      yield framesBlob.slice(pos, pos + len); pos += len;
    }
  }

  // -- SKCF single-frame parse -------------------------------------------------
  // -> {verdict, verdictName, session_id, seq, k, block_len, total_len,
  //     fnv1a, codec_id, carrier_id, flags, payload_len} or null fields
  skcfParse(frame) {
    const p = this._allocCopy(frame);
    const raw = this._callRet(this.e.skcf_parse, p, frame.length);
    if (!raw || raw.length < 1) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const verdict = dv.getUint8(0);
    const r = { verdict, verdictName: SKCF_VERDICT[verdict] ?? "?" };
    if (verdict === 0 && raw.length >= 26) {
      let pos = 1;
      r.session_id = dv.getUint16(pos, true); pos += 2;
      r.seq = dv.getUint32(pos, true); pos += 4;
      r.k = dv.getUint16(pos, true); pos += 2;
      r.block_len = dv.getUint16(pos, true); pos += 2;
      r.total_len = dv.getUint32(pos, true); pos += 4;
      r.fnv1a = dv.getUint32(pos, true); pos += 4;
      r.codec_id = dv.getUint8(pos); pos += 1;
      r.carrier_id = dv.getUint8(pos); pos += 1;
      r.flags = dv.getUint8(pos); pos += 1;
      r.payload_len = dv.getUint32(pos, true);
    }
    return r;
  }

  // -- .skcs v2 ----------------------------------------------------------------
  // members: [{kind, codec('raw'|'zlib'|'auto'), name, sha256?(auto), data(Uint8Array),
  //           media?, meta?}]  -> .skcs bytes
  async skcsPack(members, flags = 0) {
    // resolve codec "auto": compress-probe via CompressionStream when available
    const resolved = [];
    for (const m of members) {
      let codec = m.codec ?? "raw";
      let data = m.data instanceof Uint8Array ? m.data : te.encode(String(m.data));
      if (codec === "auto") {
        const comp = await deflateRaw(data).catch(() => null);
        codec = comp && comp.length < data.length ? "zlib" : "raw";
      }
      resolved.push({ ...m, codec, data });
    }
    // build member table — contiguous per-member record:
    // {u8 kind, u8 codec, u16 name_len, name, sha256[32], u32 data_len,
    //  data, u16 media_len, media, u32 meta_len, meta}
    const enc = new TextEncoder();
    const parts = [];
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, resolved.length, true);
    parts.push(head);
    for (const m of resolved) {
      const nb = enc.encode(m.name);
      const media = m.media ? enc.encode(m.media) : new Uint8Array(0);
      const meta = m.meta ? (typeof m.meta === "string" ? enc.encode(m.meta) : m.meta) : new Uint8Array(0);
      const sha = m.sha256 instanceof Uint8Array ? m.sha256 : this.sha256(m.data);
      const rec = new Uint8Array(2 + 2 + nb.length + 32 + 4 + m.data.length + 2 + media.length + 4 + meta.length);
      const dv = new DataView(rec.buffer);
      let pos = 0;
      dv.setUint8(pos, KIND[m.kind] ?? KIND.file); pos += 1;
      dv.setUint8(pos, CODEC[m.codec] ?? 0); pos += 1;
      dv.setUint16(pos, nb.length, true); pos += 2;
      rec.set(nb, pos); pos += nb.length;
      rec.set(sha, pos); pos += 32;
      dv.setUint32(pos, m.data.length, true); pos += 4;
      rec.set(m.data, pos); pos += m.data.length;
      dv.setUint16(pos, media.length, true); pos += 2;
      rec.set(media, pos); pos += media.length;
      dv.setUint32(pos, meta.length, true); pos += 4;
      rec.set(meta, pos);
      parts.push(rec);
    }
    const total = parts.reduce((a, c) => a + c.length, 0);
    const flat = new Uint8Array(total);
    let off = 0;
    for (const c of parts) { flat.set(c, off); off += c.length; }
    const p = this._allocCopy(flat);
    return this._callRet(this.e.skcs_pack, p, flat.length, flags);
  }

  // .skcs bytes -> {flags, members:[{kind,kindName,codec,codecName,name,size,
  //   raw_size,offset,media,meta,data(stored bytes)}]}
  // NOTE: member.data is STORED bytes — inflate via inflateMember() when codec=1.
  skcsParse(blob) {
    const p = this._allocCopy(blob);
    const raw = this._callRet(this.e.skcs_parse, p, blob.length);
    if (!raw || raw.length < 6) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let pos = 0;
    const magicOk = dv.getUint8(pos); pos += 1;
    const flags = dv.getUint8(pos); pos += 1;
    const count = dv.getUint32(pos, true); pos += 4;
    if (!magicOk) return { flags, members: [] };
    const KINDN = ["file", "ramdump", "vram", "manifest"];
    const CODECN = ["raw", "zlib"];
    const members = [];
    for (let i = 0; i < count; i++) {
      const kind = dv.getUint8(pos); pos += 1;
      const codec = dv.getUint8(pos); pos += 1;
      const nl = dv.getUint16(pos, true); pos += 2;
      const name = td.decode(raw.subarray(pos, pos + nl)); pos += nl;
      const size = Number(dv.getBigUint64(pos, true)); pos += 8;
      const rawSize = Number(dv.getBigUint64(pos, true)); pos += 8;
      const offset = Number(dv.getBigUint64(pos, true)); pos += 8;
      const ml = dv.getUint16(pos, true); pos += 2;
      const media = td.decode(raw.subarray(pos, pos + ml)); pos += ml;
      const metaLen = dv.getUint32(pos, true); pos += 4;
      const meta = raw.slice(pos, pos + metaLen); pos += metaLen;
      const dl = dv.getUint32(pos, true); pos += 4;
      const data = raw.slice(pos, pos + dl); pos += dl;
      members.push({
        kind, kindName: KINDN[kind] ?? "?", codec, codecName: CODECN[codec] ?? "?",
        name, size, raw_size: rawSize, offset, media,
        meta: td.decode(meta), data,
      });
    }
    return { flags, members };
  }

  // inflate a stored member payload (codec=1 -> raw deflate)
  async inflateMember(m) {
    if (m.codec !== 1) return m.data;
    return inflateRaw(m.data, m.raw_size);
  }
}

// ---------------------------------------------------------------------------
// CompressionStream helpers (capability-detected)
// ---------------------------------------------------------------------------
export async function deflateRaw(data) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

export async function inflateRaw(data, expectedLen = 0) {
  if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (expectedLen && out.length !== expectedLen) throw new Error(`inflate size mismatch ${out.length}!=${expectedLen}`);
  return out;
}

// ---------------------------------------------------------------------------
// Store-only ZIP writer (method 0) — .skc interchange emit, ITERON side.
// files: [{name, data(Uint8Array)}] -> zip bytes (crc32 + EOCD verified).
// ---------------------------------------------------------------------------
export function zipStore(files) {
  const enc = te;
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data));
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);   // version needed
    dv.setUint16(6, 0x0800, true); // UTF-8 flag
    dv.setUint16(8, 0, true);    // method: store
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); // time/date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    chunks.push(lh, data);

    const ch = new Uint8Array(46 + name.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true); cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, name.length, true);
    // extra/comment/disk/attrs all zero
    cdv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cdStart = offset;
  const cdLen = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, cdStart, true);
  const total = offset + cdLen + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}

// ---------------------------------------------------------------------------
// Format sniff — LAYERS.md §5 order. Returns {format, offset}.
// ---------------------------------------------------------------------------
export function sniff(buf) {
  const v = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const s = (off, str) => {
    if (v.length < off + str.length) return false;
    for (let i = 0; i < str.length; i++) if (v[off + i] !== str.charCodeAt(i)) return false;
    return true;
  };
  if (s(0, "PK\x03\x04")) return { format: "skc", offset: 0 };
  if (s(0, "SKC1")) return { format: "skcs", offset: 0 };
  if (s(0, "LEML")) return { format: "lemonade", offset: 0 };
  if (s(0, "RIFF")) return { format: "wav", offset: 0 };
  if (s(0, "OCS1")) return { format: "encraw", offset: 0 };
  if (s(0, "SK") && v.length > 2 && v[2] === 1) return { format: "skcf", offset: 0 };
  if (v.length > 5 && (s(0, "<!--") || s(0, "<htm") || s(0, "<!DO"))) return { format: "html", offset: 0 };
  return { format: "raw", offset: 0 };
}
