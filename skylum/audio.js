// audio.js — SKYLUM audio lane: AFSK (BFSK) modem over real PCM.
// Wire format, bit level (LSB-first per byte):
//   4×0x55 preamble | 0xD5 start | "SKAF" magic | u16 len | payload | u16 crc
// crc = low16(FNV-1a-32(payload)). Frequencies default to a Bell-202-like
// pair (space 1200 Hz, mark 2200 Hz) at 600 baud — chosen for laptop
// speaker→mic air gaps. Decode is Goertzel energy per symbol window with
// 4-phase bit-boundary search; preamble+magic+crc gate acceptance, so a
// bad channel returns null — never a fabricated payload.
// DOM-free; the door adapter binds AudioContext/getUserMedia when present.

const MAGIC = [0x53, 0x4b, 0x41, 0x46]; // "SKAF"
const START = 0xd5;
export const AFSK_DEFAULTS = Object.freeze({
  sampleRate: 48000, markHz: 2200, spaceHz: 1200, baud: 600,
});

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

const byteBits = b => Array.from({ length: 8 }, (_, i) => (b >> i) & 1);

// payload -> Float32Array PCM (mono, +100ms silence guard bands).
export function afskEncode(payload, opts = {}) {
  const { sampleRate, markHz, spaceHz, baud } = { ...AFSK_DEFAULTS, ...opts };
  const crc = fnv1a32(payload);
  const frame = [
    0x55, 0x55, 0x55, 0x55, START,
    ...MAGIC, payload.length & 0xff, (payload.length >> 8) & 0xff,
    ...payload, crc & 0xffff & 0xff, ((crc & 0xffff) >> 8) & 0xff,
  ];
  const spb = sampleRate / baud;
  const guard = Math.floor(sampleRate * 0.1);
  const bits = frame.flatMap(byteBits);
  const pcm = new Float32Array(guard * 2 + Math.ceil(bits.length * spb));
  let phase = 0;
  for (let i = 0; i < bits.length; i++) {
    const f = bits[i] ? markHz : spaceHz;
    const w = 2 * Math.PI * f / sampleRate;
    for (let s = 0; s < spb; s++) {
      const idx = guard + Math.floor(i * spb) + s;
      if (idx < pcm.length) { pcm[idx] = 0.6 * Math.sin(phase); phase += w; }
    }
  }
  return pcm;
}

// Goertzel magnitude of `pcm[start..start+len)` at freq f.
function goertzel(pcm, start, len, f, sampleRate) {
  const k = 2 * Math.PI * f / sampleRate, w = 2 * Math.cos(k);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    s0 = pcm[start + i] + w * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - w * s1 * s2;
}

// Decode a bitstream window-aligned at `phase` samples. Returns
// {payload, startBit} or null. Scans for the alternating preamble then a
// "11" pair that can only be the tail of the 0xD5 start byte.
function decodeAtPhase(pcm, offset, spb, markHz, spaceHz, sampleRate) {
  const nBits = Math.floor((pcm.length - offset) / spb) - 1;
  if (nBits < 96) return null;
  const skip = Math.floor(spb * 0.2), len = Math.floor(spb * 0.6);
  const bits = new Uint8Array(nBits);
  for (let i = 0; i < nBits; i++) {
    const at = offset + Math.floor(i * spb) + skip;
    bits[i] = goertzel(pcm, at, len, markHz, sampleRate)
      >= goertzel(pcm, at, len, spaceHz, sampleRate) ? 1 : 0;
  }
  const byteAt = i => { let b = 0; for (let k = 0; k < 8; k++) b |= bits[i + k] << k; return b; };
  let alt = 0;
  for (let i = 0; i + 8 < nBits; i++) {
    if (i > 0 && bits[i] !== bits[i - 1]) alt++; else alt = 0;
    if (alt < 24 || bits[i] !== 1 || bits[i + 1] !== 1) continue;
    const startByte = i - 6; // "11" pair is bits 6-7 of the 0xD5 start byte
    if (startByte < 0 || byteAt(startByte) !== START) continue;
    if (byteAt(startByte + 8) !== MAGIC[0] || byteAt(startByte + 16) !== MAGIC[1] ||
        byteAt(startByte + 24) !== MAGIC[2] || byteAt(startByte + 32) !== MAGIC[3]) continue;
    const lenLo = byteAt(startByte + 40), lenHi = byteAt(startByte + 48);
    const len = lenLo | (lenHi << 8);
    const need = startByte + 56 + len * 8 + 16;
    if (need > nBits) continue;
    const payload = new Uint8Array(len);
    for (let k = 0; k < len; k++) payload[k] = byteAt(startByte + 56 + k * 8);
    const crc = byteAt(startByte + 56 + len * 8) | (byteAt(startByte + 64 + len * 8) << 8);
    if ((fnv1a32(payload) & 0xffff) !== crc) continue;
    return { payload, startBit: startByte };
  }
  return null;
}

// pcm -> payload bytes | null. Tries 4 carrier phases for bit alignment.
export function afskDecode(pcm, opts = {}) {
  const { sampleRate, markHz, spaceHz, baud } = { ...AFSK_DEFAULTS, ...opts };
  const spb = sampleRate / baud;
  if (!pcm || pcm.length < spb * 96) return null;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 64) energy += pcm[i] * pcm[i];
  if (energy < 1e-6) return null; // silence — honest null
  for (let phase = 0; phase < 4; phase++) {
    const hit = decodeAtPhase(pcm, Math.floor(phase * spb / 4), spb, markHz, spaceHz, sampleRate);
    if (hit) return hit.payload;
  }
  return null;
}

// Door adapter (door id 10). send() renders PCM into a live AudioContext
// and plays it — real acoustics; recv() captures mic PCM via
// ScriptProcessor and runs the same afskDecode the tests exercise.
// Unsupported environments return verdict 3 / throw — never fabricated.
export function audioFskDoor({ seconds = 6, ...opts } = {}) {
  const supported = typeof AudioContext !== "undefined" ||
    (typeof globalThis !== "undefined" && typeof globalThis.AudioContext !== "undefined");
  let ctx = null, stream = null;
  const ensureCtx = () => (ctx ??= new AudioContext());
  return {
    supported,
    async send(payload) {
      if (!supported) return { verdict: 3 };
      const pcm = afskEncode(payload, opts);
      const ac = ensureCtx();
      const buf = ac.createBuffer(1, pcm.length, opts.sampleRate ?? AFSK_DEFAULTS.sampleRate);
      buf.copyToChannel(pcm, 0);
      const src = ac.createBufferSource();
      src.buffer = buf; src.connect(ac.destination); src.start();
      await new Promise(res => { src.onended = res; });
      return { verdict: 0 };
    },
    async recv(maxBytes = 1 << 20) {
      if (!supported || typeof navigator === "undefined" ||
          !navigator.mediaDevices?.getUserMedia)
        throw new Error("audio door unavailable: no AudioContext/getUserMedia");
      const ac = ensureCtx();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(16384, 1, 1);
      const chunks = [];
      proc.onaudioprocess = ev => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      source.connect(proc); proc.connect(ac.destination);
      await new Promise(res => setTimeout(res, seconds * 1000));
      source.disconnect(); proc.disconnect();
      stream.getTracks().forEach(t => t.stop()); stream = null;
      const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0; for (const c of chunks) { pcm.set(c, at); at += c.length; }
      const payload = afskDecode(pcm, { sampleRate: ac.sampleRate, ...opts });
      if (!payload) throw new Error("audio decode failed: no valid SKAF frame");
      return payload.slice(0, maxBytes);
    },
    close() { stream?.getTracks().forEach(t => t.stop()); stream = null; ctx?.close(); ctx = null; },
  };
}
