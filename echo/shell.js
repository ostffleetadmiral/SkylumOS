// shell.js — ECHO desktop shell (LAYERS.md: views only, read-only on core).
// Hosts the ITERON quine artifact, inspects dropped volumes via
// iteron-core.js, renders SKCF frames on canvas, and attaches the
// SKYLUM door bus for transfers initiated from the shell.
//
// Serve over http (ES modules + iframe): python3 -m http.server

import { IteronCore, sniff } from "../iteron/iteron-core.js";
import { DoorBus, DOOR, downloadDoor, fileDoor, qrDisplayDoor } from "../skylum/doors.js";
import { ClaimSpace } from "../skylum/state.js";

// Serve the repository root so the vendored wasm is available at this URL.
const WASM_URL = "/skyos/vendor/skc-wasm.wasm";
const stage = document.getElementById("stage");
const drop = document.getElementById("drop");
const cards = document.getElementById("cards");
const framedump = document.getElementById("framedump");
const doorsEl = document.getElementById("doors");

let core = null;
let claims = new ClaimSpace();
let bus = null;

const log = m => console.log("[echo]", m);

async function getCore() {
  if (!core) {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error("skc-wasm.wasm not found — build skc zig first");
    core = await IteronCore.create(new Uint8Array(await res.arrayBuffer()));
  }
  return core;
}

// ---- quine host ------------------------------------------------------------
const quineFrame = document.getElementById("quine");
const skylumEl = document.getElementById("skylum");
function loadQuine(src) {
  quineFrame.src = src;
  skylumEl.className = "card dim";
  skylumEl.textContent = "—";
}
document.getElementById("load-quine").onclick = () => loadQuine("../iteron/iteron.html");
document.getElementById("load-skylum").onclick = () => loadQuine("../skylum/skylum.html");

// ---- SKYLUM status reflection (read-only) -----------------------------------
// Polls the quine iframe's window.SKYLUM — same-origin only; a cross-origin
// or non-SKYLUM artifact simply reports unavailable. Never mutates state.
async function pollSkylum() {
  let sky = null;
  try { sky = quineFrame.contentWindow?.SKYLUM ?? null; } catch { /* cross-origin */ }
  if (!sky || typeof sky.status !== "function") {
    if (skylumEl.textContent !== "no SKYLUM in artifact") {
      skylumEl.className = "card dim";
      skylumEl.textContent = "no SKYLUM in artifact";
    }
    return;
  }
  try {
    const st = await sky.status();
    skylumEl.className = "card";
    skylumEl.innerHTML =
      `claims ${st.claims.length} · seats ${st.seats.length} · doors ${st.doors.length}<br>` +
      `mesh ${st.mesh.supported ? "rtc" : "off"} (${st.mesh.peers} peers) · ` +
      `opfs ${st.persist.opfs ? "on" : "off"} · infer ${st.infer.available ? "endpoint" : "none"}<br>` +
      `<span class="dim">` + st.claims.slice(0, 6).map(c =>
        `${escapeHtml(c.name)} ${c.size}B`).join(" · ") +
      (st.claims.length > 6 ? " …" : "") + `</span>`;
  } catch (e) {
    skylumEl.className = "card dim";
    skylumEl.textContent = "SKYLUM status error: " + e;
  }
}
setInterval(pollSkylum, 2000);
loadQuine("../iteron/iteron.html");

// ---- volume inspector -------------------------------------------------------
async function inspectBuffer(buf, label) {
  const c = await getCore();
  const { format } = sniff(buf);
  cards.innerHTML = "";
  if (format === "skcs") {
    const parsed = c.skcsParse(buf);
    claims.load(parsed);
    for (const m of parsed.members) {
      const data = await c.inflateMember(m);
      const card = document.createElement("div");
      card.className = "card";
      const sha = Array.from(c.sha256(data)).map(b => b.toString(16).padStart(2, "0")).join("");
      card.innerHTML = `<div class="name">${escapeHtml(m.name)}</div>
        <div class="meta">${m.kindName} · ${m.codecName} · ${data.length}B (raw ${m.raw_size})
        · sha256 ${sha.slice(0, 24)}…</div>`;
      const btn = document.createElement("button");
      btn.textContent = "extract";
      btn.onclick = () => download(data, m.name);
      card.appendChild(btn);
      cards.appendChild(card);
    }
    attachBus();
  } else if (format === "skcf") {
    showFrame(buf);
  } else {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="name">${escapeHtml(label)}</div>
      <div class="meta">format=${format} · ${buf.length}B — not a .skcs volume</div>`;
    cards.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showFrame(frame) {
  const c = core;
  if (!c) return;
  const h = c.skcfParse(frame);
  framedump.textContent = JSON.stringify(h, (k, v) => typeof v === "bigint" ? v.toString() : v, 2);
  qrDisplayDoor(document.getElementById("frameview")).send(frame);
}

function download(data, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

// ---- SKYLUM bus --------------------------------------------------------------
function attachBus() {
  const c = core;
  // facade exposing the same doorReceipt contract as ITERON, backed by
  // this shell's own wasm core instance (real digests, not a stub)
  const facade = {
    doorReceipt(id, verdict, payload) {
      const r = new Uint8Array(42);
      const dv = new DataView(r.buffer);
      dv.setUint8(0, id); dv.setUint8(1, verdict);
      dv.setBigUint64(2, c.fnv1a64(payload), true);
      r.set(c.sha256(payload), 10);
      return r;
    },
  };
  bus = new DoorBus(facade);
  bus.register(DOOR.download, "download", downloadDoor());
  bus.register(DOOR.file, "file", fileDoor(document.getElementById("file-pick")));
  bus.register(DOOR.qrDisplay, "qr-display", qrDisplayDoor(document.getElementById("frameview")));
  doorsEl.className = "card";
  doorsEl.innerHTML = [...bus.doors.values()].map(d =>
    `<div>· ${d.name} <span class="dim">(door ${d.id})</span></div>`).join("");
}

// ---- drop zone ----------------------------------------------------------------
let dragN = 0;
stage.addEventListener("dragenter", e => { e.preventDefault(); dragN++; drop.classList.add("on"); });
stage.addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; drop.classList.remove("on"); } });
stage.addEventListener("dragover", e => e.preventDefault());
stage.addEventListener("drop", async e => {
  e.preventDefault(); dragN = 0; drop.classList.remove("on");
  const f = e.dataTransfer.files[0];
  if (f) inspectBuffer(new Uint8Array(await f.arrayBuffer()), f.name);
});

document.getElementById("pick").onclick = () => document.getElementById("file-pick").click();
document.getElementById("file-pick").onchange = async e => {
  const f = e.target.files[0];
  if (f) inspectBuffer(new Uint8Array(await f.arrayBuffer()), f.name);
};

log("ECHO shell online — drop a .skcs/.skcf or load the ITERON quine");
