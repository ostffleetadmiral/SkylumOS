// mesh.js — ECHO Mesh Monitor: WebRTC overlay lane control + receipts.
// Signaling rides any door (offer/answer/accept base64 blobs). Every send
// returns the sealed 42-byte ITERON door receipt — parsed here into
// verdict / fnv1a64 / sha256 fields rather than shown as raw hex.
// The DoorBus audit log is surfaced read-only.

const receiptFields = bytes => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 42)
    return `receipt ${bytes?.length ?? 0}B`;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const door = view.getUint8(0);
  const verdict = view.getUint8(1);
  const fnv = view.getBigUint64(2, true).toString(16).padStart(16, "0");
  const sha = [...bytes.slice(10, 18)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `door ${door} verdict ${verdict} fnv ${fnv} sha ${sha}…`;
};

export function mountMesh(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const peer = doc.createElement("input"); peer.placeholder = "Peer ID";
  const signal = doc.createElement("textarea"); signal.placeholder = "Paste signaling payload";
  const message = doc.createElement("textarea"); message.placeholder = "Message";
  const log = doc.createElement("pre");
  const audit = doc.createElement("pre");
  audit.className = "mesh-audit";
  const lane = doc.createElement("p");
  lane.className = "mesh-lane";
  const bridge = ctx.os.host?.mode === "electron"
    ? "host bridge lanes available (doors 7-9)"
    : "browser lanes only — WebRTC/WebSocket/manual signal";
  lane.textContent =
    `lane: ${ctx.os.skylum.mesh.supported ? "WebRTC" : "unavailable"} · ${bridge}`;
  const addButton = (label, action) => {
    const b = doc.createElement("button"); b.textContent = label;
    b.onclick = async () => {
      const own = ++generation;
      try {
        const result = await action();
        if (ctx.isCurrent() && own === generation) log.textContent = typeof result === "string" ? result : JSON.stringify(result);
      } catch (e) { if (ctx.isCurrent() && own === generation) log.textContent = e.message; }
    };
    root.append(b);
  };
  root.append(peer, signal, message);
  addButton("Offer", async () => {
    const r = await ctx.os.skylum.mesh.offer(peer.value);
    signal.value = r.signal; return `Offer ready for ${r.peerId}`;
  });
  addButton("Answer", async () => {
    const r = await ctx.os.skylum.mesh.answer(peer.value, signal.value);
    signal.value = r.signal; return `Answer ready for ${r.peerId}`;
  });
  addButton("Accept answer", () => ctx.os.skylum.mesh.acceptAnswer(peer.value, signal.value));
  addButton("Send", async () => {
    const receipt = await ctx.os.skylum.mesh.send(peer.value, new TextEncoder().encode(message.value));
    return `send receipt: ${receiptFields(receipt)}`;
  });
  addButton("Broadcast", async () => {
    const out = await ctx.os.skylum.mesh.broadcast(new TextEncoder().encode(message.value));
    return out.map(entry => entry.error
      ? `${entry.peer}: ${entry.error}`
      : `${entry.peer}: ${receiptFields(entry.receipt)}`).join("\n") || "no open peers";
  });
  const peers = doc.createElement("button"); peers.textContent = "Refresh peers";
  peers.onclick = () => {
    const own = ++generation;
    queueMicrotask(() => {
      if (!ctx.isCurrent() || own !== generation) return;
      log.textContent = [...ctx.os.skylum.mesh.peers.entries()]
        .map(([id, p]) => `${id} ${p.open ? "open" : "connecting"}`)
        .join("\n") || "No peers";
    });
  };
  const refreshAudit = () => {
    if (!ctx.isCurrent()) return;
    audit.textContent = ctx.os.skylum.bus.log.slice(-20)
      .map(e => `${e.dir} ${e.door} ${e.bytes}B`).join("\n") || "door bus empty";
  };
  refreshAudit();
  const auditTimer = setInterval(refreshAudit, 2000);
  root.append(peers, log, audit);
  const onData = (id, bytes) => {
    if (ctx.isCurrent()) {
      const line = `${id}: ${new TextDecoder().decode(bytes)}`;
      log.textContent = `${log.textContent}\n${line}`.trim().split("\n").slice(-200).join("\n");
    }
  };
  const previous = ctx.os.skylum.mesh.onData;
  const chained = previous
    ? (id, bytes) => { previous(id, bytes); onData(id, bytes); }
    : onData;
  ctx.os.skylum.mesh.onData = chained;
  return () => {
    generation++;
    clearInterval(auditTimer);
    if (ctx.os.skylum.mesh.onData === chained)
      ctx.os.skylum.mesh.onData = previous ?? null;
  };
}
