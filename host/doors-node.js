// doors-node.js — host-side door adapters for the Node/Electron runtimes.
// These provide real hardware/network lanes that a browser tab cannot
// reach, behind the same DoorBus {send,recv} + 42-byte receipt contract.
// Nothing here fabricates capability: probes are real syscalls and empty
// inventories stay honestly empty.

import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { readdir } from "node:fs/promises";
import { DOOR } from "../skylum/doors.js";

const TCP_PROBE_TIMEOUT_MS = 3000;
const TCP_PROBE_MAX_BYTES = 256;

// netprobe door (id 7, send-only): payload is utf8 "host:port".
// Returns {verdict:0} on established TCP connect within the timeout,
// {verdict:1} on refused/timeout/invalid. Bounded, loopback-or-LAN only
// by whatever address the caller supplies — no arbitrary host exec.
export function netProbeDoor() {
  return {
    send: payload => {
      const target = new TextDecoder().decode(payload.slice(0, TCP_PROBE_MAX_BYTES)).trim();
      const match = /^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(target);
      if (!match) return { verdict: 3 };
      const host = match[1].replace(/^\[|\]$/g, "");
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { verdict: 3 };
      return new Promise(resolve => {
        const socket = new Socket();
        const finish = verdict => {
          socket.destroy();
          resolve({ verdict });
        };
        socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => finish(1));
        socket.once("error", () => finish(1));
        socket.connect(port, host, () => finish(0));
      });
    },
  };
}

// netifaces door (id 9, recv-only): JSON inventory of real interfaces —
// name, family, address, netmask, internal flag, mac.
export function netInterfacesDoor() {
  const encode = () => {
    const ifaces = networkInterfaces();
    const out = Object.fromEntries(Object.entries(ifaces).map(([name, list]) => [
      name,
      (list ?? []).map(entry => ({
        address: entry.address, family: entry.family, netmask: entry.netmask,
        internal: entry.internal, mac: entry.mac,
      })),
    ]));
    return new TextEncoder().encode(JSON.stringify(out));
  };
  return {
    send: () => { throw new Error("netifaces door is recv-only"); },
    recv: async maxBytes => {
      const bytes = encode();
      return maxBytes && bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    },
  };
}

// serialscan door (id 8, recv-only): JSON list of serial-looking device
// nodes actually present on this host. Real readdir scan; empty array
// when the host exposes none — never a simulated port.
const SERIAL_PATTERNS = [/^tty(S|USB|ACM|AMA|XRUSB|USB_SERIAL)\d+/, /^cu\./];
export function serialScanDoor() {
  return {
    send: () => { throw new Error("serialscan door is recv-only"); },
    recv: async maxBytes => {
      const found = [];
      try {
        for (const entry of await readdir("/dev"))
          if (SERIAL_PATTERNS.some(pattern => pattern.test(entry))) found.push(`/dev/${entry}`);
      } catch { /* /dev unreadable — report empty inventory */ }
      try {
        for (const entry of await readdir("/dev/serial/by-id")) found.push(`/dev/serial/by-id/${entry}`);
      } catch { /* no by-id directory */ }
      const bytes = new TextEncoder().encode(JSON.stringify(found.sort()));
      return maxBytes && bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    },
  };
}

// tcprelay door (id 11): a real socket data lane for host runtimes.
// send() payload = utf8 "host:port" + 0x00 + data — the target is dialed
// on first use and cached; recv(maxBytes) drains bytes the socket has
// received from the current target (waiting up to timeoutMs when the
// buffer is empty). Lets a browser-era SkyOS move mesh/fountain frames
// over real TCP on hosts where it runs — fail-closed verdicts only.
const TCP_RELAY_TIMEOUT_MS = 5000;
export function tcpRelayDoor({ timeoutMs = TCP_RELAY_TIMEOUT_MS } = {}) {
  let sock = null, queue = [], waiter = null, targetKey = null;
  const drop = () => {
    sock?.destroy(); sock = null; targetKey = null;
    const w = waiter; waiter = null;
    w?.resolve(new Uint8Array(0));
  };
  return {
    async send(payload) {
      const cut = payload.indexOf(0);
      if (cut < 1) return { verdict: 3 };
      const match = /^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/
        .exec(new TextDecoder().decode(payload.slice(0, cut)));
      if (!match) return { verdict: 3 };
      const host = match[1].replace(/^\[|\]$/g, ""), port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { verdict: 3 };
      if (targetKey !== `${host}:${port}` || !sock || sock.destroyed) {
        drop();
        await new Promise((resolve, reject) => {
          sock = new Socket();
          const onErr = e => { drop(); reject(e); };
          sock.once("error", onErr);
          sock.setNoDelay(true);
          sock.connect(port, host, () => {
            sock.off("error", onErr);
            targetKey = `${host}:${port}`;
            sock.on("data", d => {
              queue.push(d);
              const w = waiter; waiter = null;
              w?.resolve(drain());
            });
            sock.on("error", drop);
            sock.on("close", drop);
            resolve();
          });
        });
      }
      if (cut + 1 < payload.length) sock.write(payload.slice(cut + 1));
      return { verdict: 0 };
    },
    recv(maxBytes = 1 << 20) {
      const drainNow = drain();
      if (drainNow.length) return Promise.resolve(drainNow.slice(0, maxBytes));
      if (!sock || sock.destroyed) throw new Error("tcprelay: no open socket");
      return new Promise(resolve => {
        const t = setTimeout(() => { waiter = null; resolve(new Uint8Array(0)); }, timeoutMs);
        waiter = { resolve: v => { clearTimeout(t); resolve(v.slice(0, maxBytes)); } };
      });
    },
    close: drop,
  };
  function drain() {
    const out = queue.concat(); queue = [];
    const n = out.reduce((s, b) => s + b.length, 0);
    const buf = new Uint8Array(n); let at = 0;
    for (const b of out) { buf.set(b, at); at += b.length; }
    return buf;
  }
}

// Extra door list for Skylum's opts.doors.extra injection point.
export function nodeHostDoors() {
  return [
    { id: DOOR.netprobe, name: "net-probe", adapter: netProbeDoor() },
    { id: DOOR.serialscan, name: "serial-scan", adapter: serialScanDoor() },
    { id: DOOR.netifaces, name: "net-interfaces", adapter: netInterfacesDoor() },
    { id: DOOR.tcprelay, name: "tcp-relay", adapter: tcpRelayDoor() },
  ];
}
