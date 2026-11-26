// skylum.test.mjs — bun harness for the SKYLUM OS-services layer.
// Run: bun prototypes/skyos/tests/skylum.test.mjs
// Covers: VSpace claims over real wasm .skcs, codec asymmetry regression,
// staging arena, ClaimSpace, seats determinism, inference e2e (real HTTP),
// mesh signal codec + honest RTC absence, DoorBus receipts, persist
// honest-degradation, Skylum facade, and the stripped quine bundle eval.

import { IteronCore } from "../iteron/iteron-core.js";
import { Iteron, b64encode } from "../iteron/iteron.js";
import { VSpace, STAGING_SIZE, STAGING_MEMBER } from "../skylum/memory.js";
import { ClaimSpace, claimMember, claimMeta, CLAIM_KIND } from "../skylum/state.js";
import { Scheduler, Seat } from "../skylum/seats.js";
import { InferenceDoor } from "../skylum/infer.js";
import { MeshNode, meshSupported, encodeSignal, decodeSignal } from "../skylum/mesh.js";
import { DoorBus, DOOR, fileDoor, downloadDoor, websocketDoor, webserialDoor, qrDisplayDoor } from "../skylum/doors.js";
import { OpticalLink, FramePool, rasterEncode, rasterDecode, sampleRaster, fletcher16 } from "../skylum/optical.js";
import { solarState, lunarState, altAz, observerSky, gmst, julianDate, STARS } from "../skylum/astro.js";
import { afskEncode, afskDecode, audioFskDoor } from "../skylum/audio.js";
import { persist, opfsSupported, saveVolume, loadVolume } from "../skylum/persist.js";
import { Skylum } from "../skylum/index.js";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const WASM = process.env.SKYOS_SKC_WASM ??
  new URL("../vendor/skc-wasm.wasm", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok", name); } else { fail++; console.log("  FAIL", name); } };
const ser = v => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x);
const eq = (a, b, name) => ok(ser(a) === ser(b) || a === b, `${name} (${a} vs ${b})`);
const te = new TextEncoder(), td = new TextDecoder();

const core = await IteronCore.create(readFileSync(WASM));

// minimal Iteron-like host for services that only need core+stateBlob
function makeIteron(stateBlob = new Uint8Array(0)) {
  return {
    core,
    stateBlob,
    manifest: {}, manifestStr: "{}",
    async commit(members, flags = 0) {
      this.stateBlob = await core.skcsPack(members, flags);
      return this.stateBlob;
    },
    doorReceipt(doorId, verdict, payload) {
      const r = new Uint8Array(42);
      const dv = new DataView(r.buffer);
      dv.setUint8(0, doorId); dv.setUint8(1, verdict);
      dv.setBigUint64(2, core.fnv1a64(payload), true);
      r.set(core.sha256(payload), 10);
      return r;
    },
  };
}

// -- VSpace claims -------------------------------------------------------------
console.log("VSpace:");
{
  const it = makeIteron();
  const vs = new VSpace(it);
  const payload = te.encode("SKYLUM claim payload ".repeat(200)); // repetitive -> zlib
  await vs.alloc("app.bin", payload.length, { kind: "file", media: "application/octet-stream" });
  await vs.write("app.bin", payload, 0);
  // read back
  const back = await vs.read("app.bin");
  eq(back.length, payload.length, "claim read len");
  eq(core.fnv1a64(back), core.fnv1a64(payload), "claim read fnv");
  // partial read
  const part = await vs.read("app.bin", 4, 8);
  eq(td.decode(part), td.decode(payload.slice(4, 12)), "claim partial read");
  // seal
  const seal = await vs.seal("app.bin");
  eq(seal.length, 32, "seal sha256 len");
  // perms enforcement
  await vs.alloc("ro.bin", 16, { perms: "r" });
  let threw = false;
  try { await vs.write("ro.bin", new Uint8Array(4)); } catch { threw = true; }
  ok(threw, "read-only claim rejects write");
  // duplicate alloc
  threw = false;
  try { await vs.alloc("app.bin", 4); } catch { threw = true; }
  ok(threw, "duplicate claim rejected");
  // write bounds
  threw = false;
  try { await vs.write("app.bin", new Uint8Array(payload.length + 1)); } catch { threw = true; }
  ok(threw, "write beyond claim rejected");

  // save -> real .skcs -> parse -> load -> verify (codec asymmetry regression)
  const blob = await vs.save();
  eq(blob[0], 0x53, "skcs magic S"); // 'S' of SKC1
  const parsed = core.skcsParse(blob);
  eq(parsed.members.length, 2, "volume member count (staging not yet created)");
}

// staging arena — high-water mark, not full 1MiB
console.log("staging:");
{
  const it = makeIteron();
  const vs = new VSpace(it);
  const small = te.encode("staged bytes");
  await vs.stage(small);
  const claim = await vs.commit("staged.txt", { kind: "file", media: "text/plain" });
  eq(claim.member.data.length, small.length, "commit emits staged length not arena size");
  eq(td.decode(claim.member.data), "staged bytes", "commit payload intact");
  // arena reusable: stage again at offset
  await vs.stage(te.encode("XY"), 10);
  const c2 = await vs.commit("staged2.bin");
  eq(c2.member.data.length, 12, "second commit respects high-water mark");
  eq(c2.member.data[10], 0x58, "offset write landed");
  // overflow honest error
  let threw = false;
  try { await vs.stage(new Uint8Array(STAGING_SIZE + 1)); } catch { threw = true; }
  ok(threw, "staging overflow rejected");
  ok(STAGING_SIZE === (1 << 20), "staging arena is 1MiB");
}

// codec asymmetry: zlib member survives load->save->parse->inflate
console.log("codec asymmetry:");
{
  const it = makeIteron();
  const vs = new VSpace(it);
  const big = te.encode("compress me compress me compress me ".repeat(2000));
  await vs.alloc("big.txt", big.length);
  await vs.write("big.txt", big);
  const blob1 = await vs.save();
  const p1 = core.skcsParse(blob1);
  const bigMember = p1.members.find(m => m.name === "big.txt");
  eq(bigMember.codecName, "zlib", "auto codec picked zlib for repetitive data");
  ok(bigMember.size < big.length, "stored size smaller than raw (real compression)");

  // load into a FRESH VSpace (normalizes stored->raw), save again, verify
  const it2 = makeIteron();
  const vs2 = new VSpace(it2);
  await vs2.load(p1);
  const blob2 = await vs2.save();
  const p2 = core.skcsParse(blob2);
  const m2 = p2.members.find(m => m.name === "big.txt");
  const raw2 = await core.inflateMember(m2);
  eq(core.fnv1a64(raw2), core.fnv1a64(big), "zlib member survives load->save roundtrip");
}

// -- ClaimSpace -----------------------------------------------------------------
console.log("ClaimSpace:");
{
  const cs = new ClaimSpace();
  cs.put("note.txt", "hello skylum", { kind: "file", media: "text/plain" });
  cs.putRamdump("ram.img", new Uint8Array(64).fill(0xAB), { base: "0x20000", size: 64, perms: "rw" });
  cs.putVram("fb.rgba", new Uint8Array(4 * 4 * 4), { width: 4, height: 4 });
  cs.putManifest({ os: "SKYLUM", v: 1 });
  eq(cs.members().length, 4, "claim space member count");
  const it = makeIteron();
  const blob = await cs.save(it);
  const parsed = core.skcsParse(blob);
  eq(parsed.members.length, 4, "packed member count");
  const kinds = parsed.members.map(m => m.kindName).sort();
  eq(kinds, ["file", "manifest", "ramdump", "vram"], "member kinds roundtrip");
  // load parsed back -> save again -> still valid (normalization path)
  const cs2 = new ClaimSpace();
  cs2.load(parsed);
  const blob2 = await cs2.save(makeIteron());
  const p2 = core.skcsParse(blob2);
  eq(p2.members.length, 4, "reload->resave member count");
  const fb = p2.members.find(m => m.name === "fb.rgba");
  eq(fb.kindName, "vram", "vram kind survives reload");
  const meta = JSON.parse(fb.meta);
  eq(meta.width, 4, "vram meta width");
}

// -- seats ----------------------------------------------------------------------
console.log("seats:");
{
  const sched = new Scheduler();
  const log = [];
  function* taskA() { for (let i = 0; i < 3; i++) { log.push("A" + i); yield; } return "doneA"; }
  function* taskB() { for (let i = 0; i < 2; i++) { log.push("B" + i); yield; } return "doneB"; }
  sched.submit("a", taskA, 10);
  sched.submit("b", taskB, 10);
  const r1 = sched.run(100);
  eq(log.slice(0, 5).join(","), "A0,B0,A1,B1,A2", "round-robin interleave deterministic");
  eq(r1.seats.find(s => s.id === "a").done, true, "seat a done");
  eq(r1.seats.find(s => s.id === "b").done, true, "seat b done");
  // regression: second run() must actually run (was cumulative-tickCount bug)
  const log2 = [];
  function* taskC() { log2.push("c0"); yield; log2.push("c1"); return "cdone"; }
  sched.submit("c", taskC, 10);
  sched.run(100);
  eq(log2.join(","), "c0,c1", "second run() executes (tickCount regression)");
  // fuel exhaustion: fuel=1 allows exactly one step
  const sched2 = new Scheduler();
  let steps = 0;
  function* fuelTask() { while (true) { steps++; yield; } }
  sched2.submit("f", fuelTask, 1);
  sched2.tick();
  ok(steps === 1, "fuel=1 allows one step");
  sched2.tick();
  eq(steps, 1, "fuel exhausted stops task");
  const seat = sched2.seats.get("f");
  eq(seat.done, true, "exhausted seat marked done");
  // receipt shape
  const rec = sched.receipt();
  ok(rec.seats.length === 3 && typeof rec.tick === "number", "receipt shape");
}

// -- inference ------------------------------------------------------------------
console.log("infer:");
{
  const it = makeIteron();
  const noEp = new InferenceDoor(it);
  eq(noEp.available, false, "no endpoint -> unavailable");
  let threw = false;
  try { await noEp.complete("hi"); } catch (e) { threw = /unavailable/.test(e.message); }
  ok(threw, "complete() without endpoint throws honest error");

  // envelope shape (pure)
  const env = noEp.envelope("hello", { maxTokens: 64, system: "sys" });
  eq(env.model, "local", "envelope model");
  eq(env.messages.length, 2, "envelope system+user");
  eq(env.messages[0].role, "system", "envelope system role");
  eq(env.max_tokens, 64, "envelope max_tokens");

  // real e2e: Bun.serve OpenAI-compatible endpoint
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return Response.json({
        model: "test-model",
        choices: [{ message: { role: "assistant", content: "SKYLUM inference OK" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
    },
  });
  try {
    const door = new InferenceDoor(it, { endpoint: `http://127.0.0.1:${server.port}/v1/chat`, model: "test-model" });
    eq(door.available, true, "endpoint configured -> available");
    const res = await door.complete("ping", { maxTokens: 16 });
    eq(res.text, "SKYLUM inference OK", "inference text roundtrip");
    eq(res.model, "test-model", "inference model echo");
    eq(res.usage.completion_tokens, 4, "inference usage");
    // seal verifies against real digests
    const payload = te.encode(res.text);
    eq(res.seal.fnv1a64, core.fnv1a64(payload), "inference seal fnv1a64");
    eq(Array.from(res.seal.sha256), Array.from(core.sha256(payload)), "inference seal sha256");
    // unreachable endpoint -> honest throw, no fabricated completion
    const dead = new InferenceDoor(it, { endpoint: "http://127.0.0.1:1/nope", timeoutMs: 800 });
    threw = false;
    try { await dead.complete("x"); } catch { threw = true; }
    ok(threw, "unreachable endpoint throws (no fabricated completion)");
  } finally { server.stop(); }

  // llamacpp native backend: POST {endpoint}/completion, llama-shaped reply
  const llama = Bun.serve({
    port: 0,
    fetch(req) {
      ok(new URL(req.url).pathname === "/completion", "llamacpp posts to /completion");
      return Response.json({
        content: " llama native reply",
        tokens_evaluated: 9, tokens_predicted: 4,
        timings: { predicted_per_second: 42.5 },
        model: "gguf-local",
      });
    },
  });
  try {
    const door = new InferenceDoor(it, { kind: "llamacpp",
      endpoint: `http://127.0.0.1:${llama.port}`, model: "gguf-local" });
    const env = door.envelope("hi", { maxTokens: 32, system: "sys" });
    eq(env.prompt, "sys\n\nhi", "llamacpp envelope folds system into prompt");
    eq(env.n_predict, 32, "llamacpp n_predict");
    const res = await door.complete("ping");
    eq(res.text, " llama native reply", "llamacpp content field");
    eq(res.usage.completion_tokens, 4, "llamacpp usage tokens_predicted");
    eq(res.usage.per_second, 42.5, "llamacpp timing passthrough");
    const payload = te.encode(res.text);
    eq(res.seal.fnv1a64, core.fnv1a64(payload), "llamacpp seal fnv1a64");
  } finally { llama.stop(); }

  // whisper-http backend: multipart form -> {text}
  const whisper = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      const file = form.get("file");
      ok(file instanceof File && file.size > 0, "whisper receives file part");
      eq(form.get("response_format"), "json", "whisper response_format");
      return Response.json({ text: "transcribed speech" });
    },
  });
  try {
    const door = new InferenceDoor(it, { kind: "whisper-http",
      endpoint: `http://127.0.0.1:${whisper.port}/inference`, model: "whisper-1" });
    const res = await door.transcribe(te.encode("RIFF-fake-wav"), { filename: "a.wav" });
    eq(res.text, "transcribed speech", "whisper text roundtrip");
    eq(res.model, "whisper-1", "whisper model echo");
    threw = false;
    const notWhisper = new InferenceDoor(it, { kind: "openai", endpoint: "http://x" });
    try { await notWhisper.transcribe(te.encode("x")); } catch { threw = true; }
    ok(threw, "transcribe rejected on non-whisper backend");
  } finally { whisper.stop(); }

  // wllama backend: honest unavailable until module + model are loaded
  {
    const w = new InferenceDoor(it, { kind: "wllama", esmUrl: null });
    eq(w.available, false, "wllama without module/esm is honestly unavailable");
    threw = false;
    const w2 = new InferenceDoor(it, { kind: "wllama", wllamaModule: null, esmUrl: null });
    try { await w2.complete("hi"); } catch (e) { threw = true; }
    ok(threw, "wllama complete fails closed when module absent");
    threw = false;
    const w3 = new InferenceDoor(it, { kind: "wllama", esmUrl: "file:///nonexistent.js" });
    try { await w3.complete("hi"); } catch { threw = true; }
    ok(threw, "wllama bad esmUrl throws (no fabricated completion)");
  }
}

// -- mesh -----------------------------------------------------------------------
console.log("mesh:");
{
  // signal codec roundtrip (pure — works without RTC)
  const desc = { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n", candidates: [] };
  const sig = encodeSignal(desc);
  eq(decodeSignal(sig).sdp, desc.sdp, "signal codec roundtrip");
  ok(typeof sig === "string" && sig.length > 0, "signal is base64 string");

  const it = makeIteron();
  const node = new MeshNode(it);
  eq(node.supported, meshSupported(), "supported flag honest");
  // bun has no RTCPeerConnection -> offer must throw honest error
  if (!meshSupported()) {
    let threw = false;
    try { await node.offer("p1"); } catch (e) { threw = /WebRTC unavailable/.test(e.message); }
    ok(threw, "offer() without WebRTC throws honest error");
    eq(node.peers.size, 0, "no phantom peer registered");
  } else {
    // real RTC path available — at minimum offer() must produce a signal
    const o = await node.offer("p1");
    ok(typeof o.signal === "string" && o.signal.length > 10, "offer produced signal");
    node.close("p1");
  }
}

// -- doors ----------------------------------------------------------------------
console.log("doors:");
{
  const it = makeIteron();
  const bus = new DoorBus(it);
  const payload = te.encode("door test payload");
  // in-test adapter (the designed injection seam — not a stub of our logic)
  let sent = null;
  bus.register(DOOR.websocket, "ws-test", {
    send: async b => { sent = b; return { verdict: 0 }; },
    recv: async () => payload,
  });
  const receipt = await bus.send(payload, DOOR.websocket);
  eq(receipt.length, 42, "receipt is 42 bytes");
  eq(receipt[0], DOOR.websocket, "receipt door_id");
  eq(receipt[1], 0, "receipt verdict ok");
  eq(sent.length, payload.length, "adapter received payload");
  // recompute digests from receipt bytes
  const dv = new DataView(receipt.buffer);
  eq(dv.getBigUint64(2, true), core.fnv1a64(payload), "receipt fnv1a64 field");
  eq(Array.from(receipt.slice(10, 42)), Array.from(core.sha256(payload)), "receipt sha256 field");
  // recv path
  const got = await bus.recv(DOOR.websocket);
  eq(got.length, payload.length, "recv roundtrip");
  // disabled door -> verdict 2, adapter untouched
  bus.doors.get(DOOR.websocket).enabled = false;
  sent = null;
  const r2 = await bus.send(payload, DOOR.websocket);
  eq(r2[1], 2, "disabled door verdict=2");
  eq(sent, null, "disabled door never touches adapter");
  bus.doors.get(DOOR.websocket).enabled = true;
  // unknown door
  let threw = false;
  try { await bus.send(payload, 99); } catch { threw = true; }
  ok(threw, "unknown door throws");
  // door without recv
  bus.register(DOOR.download, "dl", { send: async () => ({ verdict: 0 }) });
  threw = false;
  try { await bus.recv(DOOR.download); } catch { threw = true; }
  ok(threw, "recv on send-only door throws");
  // capability honesty
  eq(webserialDoor().supported, typeof navigator !== "undefined" && !!navigator.serial, "webserial supported flag honest");
  ok(typeof downloadDoor === "function" && typeof fileDoor === "function" &&
     typeof qrDisplayDoor === "function" && typeof websocketDoor === "function" &&
     typeof webserialDoor === "function", "door factories exported");
  // audit log: 1 tx + 1 rx (disabled-door send returns before logging —
  // nothing crossed the boundary, so nothing is attested)
  eq(bus.log.length, 2, "door bus audit log has tx+rx entries");
  eq(bus.log[0].dir, "tx", "audit tx entry");
  eq(bus.log[1].dir, "rx", "audit rx entry");
}

// -- optical lane (raster codec + half-duplex link) ------------------------------
console.log("optical:");
{
  // raster codec roundtrip across sizes — payload lands in cells verbatim
  for (const size of [1, 31, 64, 900, 2048]) {
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 37 + 11) & 0xff;
    const { n, lum } = rasterEncode(payload);
    eq(lum[0], 0x53, `raster magic S (${size})`);
    eq(lum[3], n, `raster n self-check (${size})`);
    const back = rasterDecode(lum, n);
    eq(back?.length, size, `raster decode length (${size})`);
    eq(Array.from(back ?? []), Array.from(payload), `raster roundtrip (${size})`);
  }
  // corruption is caught by the header checksum — never fabricates a frame
  {
    const { n, lum } = rasterEncode(te.encode("corrupt-me"));
    lum[12] ^= 0xff; // inside the payload region (cells 10..19 for len 10)
    eq(rasterDecode(lum, n), null, "corrupted payload fails checksum");
    lum[0] = 0x00;
    eq(rasterDecode(lum, n), null, "corrupted magic rejected");
    eq(rasterDecode(new Uint8Array(n * n + 1), n), null, "wrong lum length rejected");
    ok(fletcher16(te.encode("abc")) === fletcher16(te.encode("abc")), "fletcher16 deterministic");
  }
  // pixel path: paint cells into a synthetic RGBA buffer, sample it back
  {
    const payload = te.encode("pixel path frame");
    const { n, lum } = rasterEncode(payload);
    const cellPx = 8;
    const rgba = new Uint8Array(n * cellPx * n * cellPx * 4);
    for (let i = 0; i < n * n; i++) {
      const v = lum[i], x0 = (i % n) * cellPx, y0 = Math.floor(i / n) * cellPx;
      for (let y = y0; y < y0 + cellPx; y++) for (let x = x0; x < x0 + cellPx; x++) {
        const p = (y * n * cellPx + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255;
      }
    }
    const sampled = sampleRaster(rgba, n * cellPx, n * cellPx, n, cellPx);
    eq(Array.from(sampled), Array.from(lum), "sampleRaster recovers cell luminances");
    eq(Array.from(rasterDecode(sampled, n)), Array.from(payload), "pixel-path roundtrip");
  }
  // half-duplex link: tx carousel -> rxFrame -> fountain decode
  {
    const link = new OpticalLink(makeIteron());
    const payload = te.encode("beam this machine".repeat(64));
    link.onPayload = (sid, bytes) => { link._decoded = { sid, bytes }; };
    link.tx(payload, { sessionId: 0x5AC1 });
    eq(link.state, "tx", "tx() enters tx state");
    const frames = link.frames;
    ok(frames.length >= 2, `carousel has >=2 frames (${frames.length})`);
    let cursor0 = link.cursor;
    const f0 = link.txNext();
    eq(link.cursor, (cursor0 + 1) % frames.length, "carousel advances and wraps");
    link.rxStart();
    eq(link.state, "rx", "rxStart switches half-duplex direction");
    eq(link.txNext(), null, "tx silences while receiving");
    for (const f of frames) {
      const r = await link.rxFrame(f);
      if (r.decoded) break;
    }
    ok(link._decoded?.bytes?.length === payload.length, "fountain decode completes from carousel");
    eq(td.decode(link._decoded.bytes), td.decode(payload), "received payload identical to sent");
    link.stop();
    eq(link.state, "idle", "stop returns to idle");
    // FramePool dedupe: same seq twice counts once
    const pool = new FramePool();
    const parsed = { verdict: 0, session_id: 9, seq: 3, k: 5, block_len: 100,
      total_len: 200, codec_id: 0, carrier_id: 1 };
    pool.ingest(new Uint8Array(10), parsed);
    const again = pool.ingest(new Uint8Array(10), parsed);
    eq(again.progress, 1, "duplicate seq ingests once");
    eq(pool.ingest(new Uint8Array(4), { verdict: 3 }).accepted, false, "malformed frame refused");
  }
  // qr-display door shares the raster codec (self-describing grid)
  {
    const doc = {
      cells: [],
      getContext: () => ({
        fillStyle: "", fillRect(x, y) { doc.cells.push([x, y]); },
      }),
      width: 0, height: 0,
    };
    const door = qrDisplayDoor(doc);
    const frame = te.encode("door raster");
    const r = await door.send(frame);
    eq(r.verdict, 0, "qr-display door returns ok verdict");
    ok(doc.width > 0 && doc.width === doc.height, "qr-display paints a square grid");
  }
}

// -- astro + audio lanes (celestial service + AFSK modem) -----------------------
console.log("astro:");
{
  // solar declination at the 2024 vernal equinox (Mar 20 03:06 UTC) ≈ 0
  const eqn = solarState(new Date("2024-03-20T03:06:00Z"));
  ok(Math.abs(eqn.dec) < 0.2, `equinox solar dec ≈ 0 (got ${eqn.dec.toFixed(3)})`);
  // June solstice (2024-06-20 20:51 UTC) → dec ≈ +23.44
  const sol = solarState(new Date("2024-06-20T20:51:00Z"));
  ok(Math.abs(sol.dec - 23.44) < 0.2, `solstice dec ≈ 23.44 (got ${sol.dec.toFixed(3)})`);
  // GMST at J2000 epoch = 18.697h (IAU constant)
  ok(Math.abs(gmst(new Date("2000-01-01T12:00:00Z")) - 18.697) < 0.05,
    "GMST at J2000 ≈ 18.697h");
  // invariant at ANY instant: the sun sits at ~zenith over its own
  // subsolar point — the strongest end-to-end check of the whole chain
  for (const iso of ["2024-01-15T06:30:00Z", "2024-07-04T18:45:00Z"]) {
    const s = solarState(new Date(iso));
    const h = altAz(s.ra, s.dec, s.lat, s.lng, new Date(iso));
    ok(h.alt > 89, `sun at zenith over subsolar point ${iso} (alt ${h.alt.toFixed(2)})`);
  }
  // same invariant for the moon over its sublunar point (±2° tolerance —
  // truncated lunar series is honest about its precision)
  const m = lunarState(new Date("2024-04-08T18:00:00Z")); // total eclipse day
  ok(m.illum >= 0 && m.illum <= 1 && m.phase >= 0 && m.phase < 360,
    `moon phase fields bounded (illum ${m.illum.toFixed(2)}, phase ${m.phase.toFixed(0)})`);
  ok(Math.abs(m.illum) < 0.05, "eclipse-day moon is new (illum ≈ 0)");
  // sublunar-zenith invariant: the moon sits at ~zenith over its own
  // sublunar point (tolerance 3° — truncated lunar series is honest
  // about ~1° position error)
  {
    const d = new Date("2024-11-15T21:30:00Z"), mm = lunarState(d);
    const gha = ((15 * (gmst(d) - mm.ra)) % 360 + 360) % 360;
    const subLon = gha > 180 ? 360 - gha : -gha;
    const h = altAz(mm.ra, mm.dec, mm.dec, subLon, d);
    ok(h.alt > 87, `moon at zenith over sublunar point (alt ${h.alt.toFixed(2)})`);
  }
  // Polaris: altitude ≈ observer latitude anywhere in the north
  const p = STARS.find(s => s.name === "Polaris");
  const pa = altAz(p.ra, p.dec, 40, -74, new Date("2024-09-01T02:00:00Z"));
  ok(Math.abs(pa.alt - 40) < 1.6 && Math.abs(pa.az < 3 || pa.az > 357),
    `Polaris alt ≈ lat (got alt ${pa.alt.toFixed(2)} az ${pa.az.toFixed(1)})`);
  ok(STARS.length >= 30, "bright-star catalog populated");
  const sky = observerSky(new Date("2024-06-01T04:00:00Z"), 35, -105);
  ok(sky.stars.length === STARS.length && sky.sun.alt < 0 && Number.isFinite(sky.moon.az),
    "observerSky snapshot coherent (pre-dawn: sun below horizon)");
  eq(julianDate(new Date("2000-01-01T12:00:00Z")), 2451545.0, "J2000 julian date");
}

console.log("audio:");
{
  const enc = te.encode("SKYOS-AFSK-AIR-GAP");
  // roundtrip at default + slow/fast params
  for (const opts of [{}, { baud: 300 }, { baud: 1200, markHz: 2400, spaceHz: 1400 }]) {
    const pcm = afskEncode(enc, opts);
    const out = afskDecode(pcm, opts);
    ok(out && [...out].join() === [...enc].join(),
      `afsk roundtrip ${opts.baud ?? 600} baud`);
  }
  // carrier-phase misalignment: decoder must re-sync from a shifted start
  const shifted = afskEncode(enc).subarray(37);
  ok(afskDecode(shifted) !== null, "afsk re-syncs at arbitrary phase offset");
  // silence -> null, never a payload
  eq(afskDecode(new Float32Array(96000)), null, "silence decodes to null");
  // corruption -> crc gate -> null. NOTE: a non-coherent BFSK decoder is
  // blind to signal *sign* — real corruption means zeroed/wrong-tone
  // energy, not a phase flip (that inverts identically at both marks).
  const bad = afskEncode(enc);
  bad.fill(0, 20000, 22000); // inside the payload region
  eq(afskDecode(bad), null, "corrupted frame rejected by crc gate");
  // larger payload roundtrip
  const big = new Uint8Array(200).map((_, i) => (i * 31 + 7) & 0xff);
  ok([...(afskDecode(afskEncode(big)) ?? [])].join() === [...big].join(),
    "200-byte payload roundtrip");
  // door adapter honest about missing AudioContext (bun has none)
  const ad = audioFskDoor();
  eq(ad.supported, false, "audio door reports unsupported without AudioContext");
  eq((await ad.send(enc)).verdict, 3, "audio send -> verdict 3 (unavailable)");
}

console.log("persist:");
{
  eq(typeof persist.saveVolume, "function", "persist aggregate exposes saveVolume");
  eq(opfsSupported(), typeof navigator !== "undefined" && !!navigator.storage?.getDirectory, "opfsSupported honest");
  if (!opfsSupported()) {
    let threw = false;
    try { await saveVolume("x.bin", new Uint8Array(4)); } catch (e) { threw = /OPFS unavailable/.test(e.message); }
    ok(threw, "saveVolume without OPFS throws honest error");
    eq(await loadVolume("nope.bin").catch(() => "threw"), "threw", "loadVolume without OPFS throws");
  }
}

// -- Skylum facade ---------------------------------------------------------------
console.log("Skylum facade:");
{
  // real Iteron instance with synthetic parts (same pattern as iteron.test)
  const emptySkcs = await core.skcsPack([], 0);
  const parts = {
    wasmB64: "", stateB64: b64encode(emptySkcs),
    manifestStr: "{}", tmplB64: "", engineSrc: "", extraBootSrc: "",
  };
  const iteron = new Iteron(core, emptySkcs, {}, parts);
  const sky = new Skylum(iteron, { doors: { download: false, webserial: false } });
  eq(typeof sky.memory.alloc, "function", "facade exposes VSpace");
  eq(typeof sky.seats.tick, "function", "facade exposes Scheduler");
  eq(sky.infer.available, false, "facade infer unavailable w/o endpoint");
  eq(sky.mesh.supported, meshSupported(), "facade mesh supported flag");

  // loadState on empty volume -> empty claims
  await sky.loadState();
  eq(sky.memory.claims.size, 0, "empty volume -> no claims");

  // alloc + save + status
  await sky.memory.alloc("boot.cfg", 32);
  await sky.memory.write("boot.cfg", te.encode("skylum boot config"));
  const blob = await sky.save();
  ok(blob.length > 28, "save produced .skcs volume");
  eq(iteron.stateBlob.length, blob.length, "iteron.stateBlob updated by commit");

  // status is read-only: receipts array must not grow across polls
  const recsBefore = sky.seats.receipts.length;
  const st1 = await sky.status();
  const st2 = await sky.status();
  eq(sky.seats.receipts.length, recsBefore, "status() does not mutate seat receipts");
  eq(st1.fabric.configured, true, "fabric client is present in the SKYLUM status surface");
  eq(st1.claims.length, st2.claims.length, "status claims stable");
  eq(st1.claims[0].name, "boot.cfg", "status reflects claim");
  eq(st1.persist.opfs, opfsSupported(), "status persist flag");
  eq(typeof st1.tick, "number", "status tick present");
  eq(st1.doors.every(d => typeof d.name === "string"), true, "status doors listed");
  eq(await sky.memory.free("boot.cfg"), true, "VSpace.free removes an existing claim");
  eq(await sky.memory.free("boot.cfg"), false, "VSpace.free reports missing claim");
  eq(sky.memory.list().some(c => c.name === "boot.cfg"), false, "VSpace.list omits freed claim");

  // roundtrip: new facade loads the saved volume
  const iteron2 = new Iteron(core, blob, {}, parts);
  const sky2 = new Skylum(iteron2, { doors: { download: false, webserial: false } });
  await sky2.loadState();
  eq(sky2.memory.claims.size, 1, "restored claim count");
  const cfg = await sky2.memory.read("boot.cfg");
  eq(td.decode(cfg).startsWith("skylum boot"), true, "restored claim bytes intact");
}

// -- quine bundle eval ------------------------------------------------------------
console.log("bundle:");
{
  // the stripped classic-script bundle must parse+eval with window shimmed.
  const skyosDir = new URL("..", import.meta.url).pathname;
  const engine = execSync(
    `cd "${skyosDir}skylum" && python3 -c "import sys; sys.path.insert(0,'../iteron'); import make_skylum; print(make_skylum.bundle_skylum_engine())"`,
    { maxBuffer: 64 * 1024 * 1024 }).toString();
  ok(!/^import /m.test(engine) && !/^export /m.test(engine), "bundle has no ESM syntax");
  ok(!engine.includes("</script"), "bundle has no </script");
  ok(engine.includes("class VSpace") && engine.includes("class Skylum"), "bundle contains skylum classes");
  // eval with window shim — footer assigns window.* globals
  const g = globalThis;
  const hadWindow = "window" in g;
  const oldWindow = g.window;
  g.window = {};
  try {
    new Function(engine)();
    ok(typeof g.window.Skylum === "function", "bundle eval exposes window.Skylum");
    ok(typeof g.window.VSpace === "function", "bundle eval exposes window.VSpace");
    ok(typeof g.window.Scheduler === "function", "bundle eval exposes window.Scheduler");
    ok(typeof g.window.persist?.saveVolume === "function", "bundle eval exposes persist aggregate");
    ok(typeof g.window.DOOR?.mesh === "number", "bundle eval exposes DOOR registry");
    ok(typeof g.window.meshSignal?.encodeSignal === "function", "bundle eval exposes meshSignal");
    ok(typeof g.window.IteronCore === "function", "bundle eval exposes IteronCore");
    // and the classes actually work post-eval
    const sky = new g.window.Skylum({ core, stateBlob: new Uint8Array(0), commit: async m => core.skcsPack(m, 0), doorReceipt: (d, v, p) => new Uint8Array(42) });
    ok(typeof sky.memory.stage === "function", "bundle-constructed Skylum has VSpace");
  } catch (e) {
    ok(false, "bundle eval threw: " + (e.stack || e).toString().slice(0, 200));
  } finally {
    if (hadWindow) g.window = oldWindow; else delete g.window;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
