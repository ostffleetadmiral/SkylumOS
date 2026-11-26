// optical.js — SKYLUM optical lane: raster codec + half-duplex session
// machine for the screen↔camera channel (LAYERS.md §3 door 4).
//
// Raster law: an n×n grid of luminance cells; each cell's gray level IS
// the byte value (0–255). The first HEADER cells are a self-describing
// header so a decoder needs no out-of-band length:
//   [0] 'S' [1] 'K' [2] ver=1 [3] n(u8) [4..6] len u24 BE
//   [7..8] fletcher16(header bytes 2..6) [9] reserved=0
// Payload cells follow row-major. Rendering (cell size, canvas, WebGL)
// is ECHO's job; this module only maps bytes ↔ cell luminances and runs
// the session pool. DOM-free — fully testable on synthetic buffers.

export const OPTICAL_VERSION = 1;
export const OPTICAL_HEADER = 10;

// fletcher-16 over a byte range — named checksum, 6 lines.
export function fletcher16(bytes, off = 0, len = bytes.length - off) {
  let a = 0, b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + bytes[off + i]) % 255;
    b = (b + a) % 255;
  }
  return (b << 8) | a;
}

// frame bytes -> { n, lum: Uint8Array(n*n) } — lum values are the gray
// level each cell should be painted with (0=black … 255=white).
export function rasterEncode(frame) {
  const len = frame.length;
  const n = Math.ceil(Math.sqrt(OPTICAL_HEADER + len));
  if (n > 255) throw new Error("raster_too_large");
  const lum = new Uint8Array(n * n);
  lum[0] = 0x53; // 'S'
  lum[1] = 0x4b; // 'K'
  lum[2] = OPTICAL_VERSION;
  lum[3] = n;
  lum[4] = (len >> 16) & 0xff;
  lum[5] = (len >> 8) & 0xff;
  lum[6] = len & 0xff;
  const crc = fletcher16(frame);
  lum[7] = (crc >> 8) & 0xff;
  lum[8] = crc & 0xff;
  lum[9] = 0;
  lum.set(frame, OPTICAL_HEADER);
  return { n, lum };
}

// sampled luminances (n*n bytes, row-major, cell-center) -> frame or null.
// Returns null on any inconsistency — never fabricates a frame.
export function rasterDecode(lum, n) {
  if (!n || lum.length !== n * n) return null;
  if (lum[0] !== 0x53 || lum[1] !== 0x4b) return null;       // magic
  if (lum[2] !== OPTICAL_VERSION) return null;               // version
  if (lum[3] !== n) return null;                             // grid self-check
  const len = (lum[4] << 16) | (lum[5] << 8) | lum[6];
  const need = OPTICAL_HEADER + len;
  if (len <= 0 || need > n * n) return null;                 // bounds
  const frame = lum.slice(OPTICAL_HEADER, need);
  const crc = fletcher16(frame);
  if (((crc >> 8) & 0xff) !== lum[7] || (crc & 0xff) !== lum[8]) return null;
  return frame;
}

// Sample an RGBA pixel buffer into cell luminances by averaging the
// center quarter of each cell (robust to cell-edge bleed). `pixels` is a
// Uint8Array/Uint8ClampedArray of w*h*4 bytes; `cells` n×n. `cellSize`
// may be fractional — real captures almost never land on integer cell
// widths, and integer truncation drifts sampling off-cell by the last
// column. Anchored top-left.
export function sampleRaster(pixels, width, height, n, cellSize) {
  if (n * cellSize > width || n * cellSize > height) return null;
  const lum = new Uint8Array(n * n);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      let sum = 0, count = 0;
      const x0 = Math.floor((cx + 0.25) * cellSize);
      const y0 = Math.floor((cy + 0.25) * cellSize);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 0.75) * cellSize));
      const y1 = Math.max(y0 + 1, Math.floor((cy + 0.75) * cellSize));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 4;
          // ITU-R BT.601 luma — matches how displays render gray
          sum += (pixels[p] * 299 + pixels[p + 1] * 587 + pixels[p + 2] * 114) / 1000;
          count++;
        }
      }
      lum[cy * n + cx] = Math.round(sum / count);
    }
  }
  return lum;
}

// ---------------------------------------------------------------------------
// FramePool — per-session SKCF accumulation shared by app + OpticalLink.
// ---------------------------------------------------------------------------

export class FramePool {
  constructor() {
    // session_id -> {k, block_len, total_len, codec_id, carrier_id,
    //                frames: Map(seq -> frame), payload}
    this.sessions = new Map();
  }

  // Ingest one parsed SKCF frame (from core.skcfParse). Returns
  // {accepted, sessionId, seq, complete, progress} — accepted=false for
  // foreign/malformed frames, complete=true once k frames are held.
  ingest(frame, parsed) {
    if (!parsed || parsed.verdict !== 0) return { accepted: false };
    let pool = this.sessions.get(parsed.session_id);
    if (!pool) {
      pool = { k: parsed.k, block_len: parsed.block_len,
        total_len: parsed.total_len, codec_id: parsed.codec_id,
        carrier_id: parsed.carrier_id, frames: new Map(), payload: null };
      this.sessions.set(parsed.session_id, pool);
    }
    pool.frames.set(parsed.seq, frame);
    return { accepted: true, sessionId: parsed.session_id, seq: parsed.seq,
      complete: pool.frames.size >= pool.k, progress: pool.frames.size };
  }

  // Serialize a session's frames into the fountain blob format:
  // u32 n | {u32 len, frame}*  (matches core.fountainDecode input).
  blob(sessionId) {
    const pool = this.sessions.get(sessionId);
    if (!pool) return null;
    const frames = [...pool.frames.values()];
    const out = new Uint8Array(4 + frames.reduce((n, f) => n + 4 + f.length, 0));
    const dv = new DataView(out.buffer);
    dv.setUint32(0, frames.length, true);
    let pos = 4;
    for (const f of frames) {
      dv.setUint32(pos, f.length, true); pos += 4;
      out.set(f, pos); pos += f.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// OpticalLink — half-duplex transceiver machine over ONE light channel.
// A node is either transmitting a fountain carousel or listening for one;
// never both. States: idle | tx | rx | done. Payload semantics stay at
// the app layer (the stream can carry anything — including reemit() of
// the very machine doing the transmitting).
// ---------------------------------------------------------------------------

export class OpticalLink {
  constructor(iteron, { blockLen = 900 } = {}) {
    this.iteron = iteron;
    this.blockLen = blockLen;
    this.pool = new FramePool();
    this.state = "idle";
    this.frames = [];        // current TX carousel (frame bytes)
    this.cursor = 0;
    this.sessionId = null;
    this.onPayload = null;   // (sessionId, payloadBytes) => void
    this.onState = null;     // (state, info) => void
  }

  _set(state, info) {
    this.state = state;
    this.onState?.(state, info);
  }

  // Build a TX carousel for a payload. Returns the frame list; the
  // caller (app/host) advances cursor and renders each frame's raster.
  tx(payload, { sessionId } = {}) {
    const sid = sessionId ?? ((Math.random() * 0xffff) | 0);
    const blob = this.iteron.core.fountainEncode(payload, this.blockLen, sid);
    this.frames = [...this.iteron.core.iterFrames(blob)];
    if (!this.frames.length) throw new Error("fountain_encode_empty");
    this.cursor = 0;
    this.sessionId = sid;
    this._set("tx", { sessionId: sid, frames: this.frames.length, bytes: payload.length });
    return this.frames;
  }

  // Next carousel frame — carousel loops forever until txStop() or
  // rxStart(), so a receiver joining mid-stream can still complete.
  txNext() {
    if (this.state !== "tx" || !this.frames.length) return null;
    const frame = this.frames[this.cursor];
    this.cursor = (this.cursor + 1) % this.frames.length;
    return frame;
  }

  rxStart() {
    this._set("rx", { sessionId: this.sessionId });
  }

  // Feed a raster-decoded frame during rx. Parses + pools; on reaching
  // ≥k distinct frames attempts fountain decode. Returns ingest result
  // plus {decoded} when a payload completed.
  async rxFrame(frame) {
    const parsed = this.iteron.core.skcfParse(frame);
    const result = this.pool.ingest(frame, parsed);
    if (result.complete) {
      const pool = this.pool.sessions.get(result.sessionId);
      if (pool && !pool.payload) {
        const out = this.iteron.core.fountainDecode(
          this.pool.blob(result.sessionId),
          pool.total_len, pool.block_len, result.sessionId);
        if (out?.length) {
          pool.payload = out;
          this.onPayload?.(result.sessionId, out);
          this._set("done", { sessionId: result.sessionId, bytes: out.length });
          return { ...result, decoded: out };
        }
      }
    }
    return result;
  }

  stop() { this._set("idle", {}); }
}
