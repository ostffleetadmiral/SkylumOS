// doors.js — SKYLUM transport doors (LAYERS.md §3).
// Registry of named doors; every transfer produces a 42-byte receipt
// (door_id u8 | verdict u8 | fnv1a64 u64 | sha256[32], LE) via ITERON.
// DOM-free where possible; adapters degrade honestly when a browser
// capability is absent — never a stub.

export const DOOR = {
  file: 0,        // browser File API pick/load
  download: 1,    // anchor/blob save
  websocket: 2,   // WebSocket looppoint/peer
  webserial: 3,   // WebSerial UART (capability-checked)
  qrDisplay: 4,   // render SKCF frame -> canvas hex/block grid
  skcsVolume: 5,  // .skcs state volume read/write via ITERON
  mesh: 6,        // WebRTC data-channel lane (mesh.js)
  netprobe: 7,    // host TCP connect probe (Node/Electron bridge only)
  serialscan: 8,  // host serial-device listing (Node/Electron bridge only)
  netifaces: 9,   // host network-interface inventory (Node/Electron bridge only)
  audiofsk: 10,   // AFSK/BFSK modem: speaker->mic air-gap lane (audio.js)
  tcprelay: 11,   // host TCP data lane (Node/Electron bridge only)
};

export class DoorBus {
  constructor(iteron) {
    this.iteron = iteron;       // ITERON instance (core + state)
    this.doors = new Map();
    this.log = [];
  }

  register(id, name, adapter) {
    this.doors.set(id, { id, name, adapter, enabled: true });
    return this.doors.get(id);
  }

  // send(payload, doorId) -> receipt bytes; adapter.send may be sync/async
  async send(payload, doorId) {
    const d = this.doors.get(doorId);
    if (!d) throw new Error(`unknown door ${doorId}`);
    if (!d.enabled) return this.iteron.doorReceipt(doorId, 2, payload); // disabled verdict
    const out = await d.adapter.send(payload);
    const receipt = this.iteron.doorReceipt(doorId, out?.verdict ?? 0, payload);
    this.log.push({ door: d.name, dir: "tx", bytes: payload.length, at: Date.now() });
    return receipt;
  }

  async recv(doorId, maxBytes = 1 << 20) {
    const d = this.doors.get(doorId);
    if (!d || !d.adapter.recv) throw new Error(`door ${doorId} has no recv`);
    const data = await d.adapter.recv(maxBytes);
    this.log.push({ door: d.name, dir: "rx", bytes: data?.length ?? 0, at: Date.now() });
    return data;
  }
}

// ---------------------------------------------------------------------------
// Adapters — each returns {send, recv?} ; verdict convention: 0 ok.
// ---------------------------------------------------------------------------

// file door: read a user-picked File into bytes (browser-only).
export function fileDoor(inputEl) {
  return {
    async send() { throw new Error("file door is recv-only"); },
    async recv(maxBytes) {
      const f = inputEl.files && inputEl.files[0];
      if (!f) throw new Error("no file selected");
      const buf = await f.arrayBuffer();
      return new Uint8Array(buf).slice(0, maxBytes);
    },
  };
}

// download door: save bytes via anchor (browser-only).
export function downloadDoor(doc = document) {
  return {
    async send(payload, name = "skc-out.bin") {
      const a = doc.createElement("a");
      a.href = URL.createObjectURL(new Blob([payload]));
      a.download = name; a.click();
      URL.revokeObjectURL(a.href);
      return { verdict: 0 };
    },
  };
}

// websocket door: connect to ws://host:port, send payload, optionally await
// one reply frame. Real loopback-capable transport.
export function websocketDoor(url, { timeoutMs = 5000 } = {}) {
  let ws = null;
  return {
    async send(payload) {
      if (!ws || ws.readyState !== 1) {
        ws = new WebSocket(url);
        await new Promise((res, rej) => {
          ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed"));
        });
      }
      ws.send(payload);
      return { verdict: 0 };
    },
    async recv(maxBytes) {
      if (!ws || ws.readyState !== 1) throw new Error("ws not open");
      return await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("ws recv timeout")), timeoutMs);
        ws.onmessage = ev => {
          clearTimeout(t);
          const b = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data)
            : typeof ev.data === "string" ? new TextEncoder().encode(ev.data) : null;
          res(b ? b.slice(0, maxBytes) : null);
        };
        ws.onerror = () => { clearTimeout(t); rej(new Error("ws error")); };
      });
    },
    close() { ws?.close(); },
  };
}

// webserial door: UART via WebSerial API. Honest capability check —
// navigator.serial exists only in secure contexts on supporting browsers.
export function webserialDoor({ baudRate = 115200 } = {}) {
  const supported = typeof navigator !== "undefined" && !!navigator.serial;
  let port = null;
  return {
    supported,
    async send(payload) {
      if (!supported) return { verdict: 3 }; // unavailable — honest verdict
      if (!port) {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate });
      }
      const w = port.writable.getWriter();
      await w.write(payload);
      w.releaseLock();
      return { verdict: 0 };
    },
    async recv(maxBytes) {
      if (!supported || !port) throw new Error("serial unavailable");
      const r = port.readable.getReader();
      const { value } = await r.read();
      r.releaseLock();
      return value ? new Uint8Array(value).slice(0, maxBytes) : null;
    },
    async close() { await port?.close(); port = null; },
  };
}

// qr-display door: render an SKCF frame as a self-describing raster on
// canvas (shared skylum/optical.js codec — the painted grid is machine-
// decodable, not just visual). QR *generation* stays Python-side (§6).
import { rasterEncode } from "./optical.js";
export function qrDisplayDoor(canvas) {
  const ctx = canvas.getContext("2d");
  return {
    async send(frameBytes) {
      const { n, lum } = rasterEncode(frameBytes);
      const cell = Math.max(2, Math.floor(480 / Math.max(1, n)));
      canvas.width = n * cell; canvas.height = n * cell;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < n * n; i++) {
        const v = lum[i];
        const x = (i % n) * cell, y = Math.floor(i / n) * cell;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, cell, cell);
      }
      return { verdict: 0 };
    },
  };
}
