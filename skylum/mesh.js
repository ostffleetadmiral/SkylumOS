// mesh.js — SKYLUM overlay/mesh lane: WebRTC data-channel fabric.
// The browser-honest freenet path: no raw sockets, but real P2P data
// channels between peers. Signaling is manual (offer/answer/ICE blobs as
// base64 JSON) so it works over any door — copy/paste, websocket, QR,
// serial. Broadcast + per-peer send; every transfer gets an ITERON seal.

import { DOOR } from "./doors.js";

export function meshSupported() {
  return typeof RTCPeerConnection !== "undefined";
}

// signaling blob encode/decode — pure functions, testable without RTC
export function encodeSignal(desc) {
  return btoa(JSON.stringify(desc));
}
export function decodeSignal(b64) {
  return JSON.parse(atob(b64));
}

export class MeshNode {
  constructor(iteron, { iceServers = [] } = {}) {
    this.iteron = iteron;
    this.supported = meshSupported();
    this.iceServers = iceServers;
    this.peers = new Map();   // peerId -> {pc, dc, role, open}
    this.onData = null;       // (peerId, bytes) => void
  }

  _pc() {
    return new RTCPeerConnection({ iceServers: this.iceServers });
  }

  // create an offer for a new peer; returns {peerId, signal}
  async offer(peerId) {
    if (!this.supported) throw new Error("WebRTC unavailable");
    const pc = this._pc();
    const dc = pc.createDataChannel("skc");
    this._wire(peerId, pc, dc, "offerer");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._gather(pc);
    return { peerId, signal: encodeSignal(pc.localDescription) };
  }

  // answer a remote offer; returns {peerId, signal}
  async answer(peerId, offerSignal) {
    if (!this.supported) throw new Error("WebRTC unavailable");
    const desc = decodeSignal(offerSignal);
    const pc = this._pc();
    pc.ondatachannel = ev => this._wire(peerId, pc, ev.channel, "answerer");
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._gather(pc);
    return { peerId, signal: encodeSignal(pc.localDescription) };
  }

  // complete negotiation: offerer applies remote answer
  async acceptAnswer(peerId, answerSignal) {
    const p = this.peers.get(peerId);
    if (!p) throw new Error(`unknown peer ${peerId}`);
    await p.pc.setRemoteDescription(decodeSignal(answerSignal));
  }

  async _gather(pc) {
    // wait briefly for ICE gathering to finish (trickle not used —
    // candidates ride inside the description for copy/paste signaling)
    if (pc.iceGatheringState === "complete") return;
    await new Promise(res => {
      const to = setTimeout(res, 1500);
      const onState = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(to);
          pc.removeEventListener("icegatheringstatechange", onState);
          res();
        }
      };
      pc.addEventListener("icegatheringstatechange", onState);
    });
  }

  _wire(peerId, pc, dc, role) {
    dc.binaryType = "arraybuffer"; // ev.data arrives as ArrayBuffer
    const peer = { pc, dc, role, open: false };
    this.peers.set(peerId, peer);
    dc.onopen = () => { peer.open = true; };
    dc.onmessage = ev => {
      const bytes = typeof ev.data === "string"
        ? new TextEncoder().encode(ev.data)
        : new Uint8Array(ev.data);
      if (this.onData) this.onData(peerId, bytes);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        this.peers.delete(peerId);
    };
  }

  // send bytes to one peer; returns ITERON seal receipt (door 6 = mesh)
  async send(peerId, bytes) {
    const p = this.peers.get(peerId);
    if (!p || !p.open) throw new Error(`peer ${peerId} not open`);
    p.dc.send(bytes);
    return this.iteron.doorReceipt(DOOR.mesh, 0, bytes);
  }

  // broadcast to all open peers — per-peer failures are isolated and
  // reported, never abort the remaining sends.
  async broadcast(bytes) {
    const out = [];
    for (const [id, p] of [...this.peers]) {
      if (!p.open) continue;
      try {
        p.dc.send(bytes);
        out.push({ peer: id, receipt: this.iteron.doorReceipt(DOOR.mesh, 0, bytes) });
      } catch (e) {
        out.push({ peer: id, error: String(e) });
      }
    }
    return out;
  }

  close(peerId) {
    const p = this.peers.get(peerId);
    if (p) { p.dc.close(); p.pc.close(); this.peers.delete(peerId); }
  }
}
