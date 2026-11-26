// iteron.test.mjs — bun harness for the ITERON substrate.
// Run: bun prototypes/skyos/tests/iteron.test.mjs
// Covers: wasm ABI, digests, .skcs v2 roundtrip (raw/zlib/auto),
// SKCF parse, ZIP writer, sniff order, reemit byte-identity.

import { IteronCore, KIND, CODEC, crc32, zipStore, sniff, inflateRaw, deflateRaw } from "../iteron/iteron-core.js";
import { Iteron, b64encode } from "../iteron/iteron.js";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const WASM = process.env.SKYOS_SKC_WASM ??
  new URL("../vendor/skc-wasm.wasm", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok", name); } else { fail++; console.log("  FAIL", name); } };
const ser = v => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x);
const eq = (a, b, name) => ok(ser(a) === ser(b) || a === b, `${name} (${a} vs ${b})`);

const core = await IteronCore.create(readFileSync(WASM));
console.log("ITERON test — wasm memory", core.e.memory.buffer.byteLength, "B");

// -- digests ------------------------------------------------------------------
console.log("digests:");
eq(core.fnv1a64(new TextEncoder().encode("a")), 0xaf63dc4c8601ec8cn, "fnv1a64('a')");
eq(core.fnv1a64(new Uint8Array(0)), 0xcbf29ce484222325n, "fnv1a64('')");
eq(core.fnv1a32(new TextEncoder().encode("a")), 0xe40c292c, "fnv1a32('a')");
const sha = core.sha256(new TextEncoder().encode("abc"));
eq(sha.length, 32, "sha256 len");
eq(Array.from(sha.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join(""), "ba7816bf", "sha256('abc') prefix");

// -- .skcs v2 roundtrip ---------------------------------------------------------
console.log("skcs v2:");
const repetitive = new TextEncoder().encode("SKC1ITERON".repeat(500));
const noisy = new Uint8Array(1024);
for (let i = 0; i < 1024; i++) noisy[i] = (i * 2654435761) >>> 24;
const members = [
  { kind: "file", codec: "zlib", name: "big.txt", data: repetitive, media: "text/plain" },
  { kind: "ramdump", codec: "raw", name: "ram.bin", data: noisy, media: "raw",
    meta: JSON.stringify({ base: "0x1000", size: 1024, perms: "rw" }) },
  { kind: "manifest", codec: "auto", name: "MANIFEST.json",
    data: new TextEncoder().encode(JSON.stringify({ format: "SKC1", n: 3 })) },
];
const skcs = await core.skcsPack(members, 0);
ok(sniff(skcs).format === "skcs", "skcs magic sniff");
ok(skcs.length < repetitive.length + noisy.length, "skcs smaller than raw sum (zlib worked)");

const parsed = core.skcsParse(skcs);
eq(parsed.members.length, 3, "member count");
eq(parsed.members[0].codecName, "zlib", "codec0 zlib");
eq(parsed.members[1].kindName, "ramdump", "kind1 ramdump");
eq(parsed.members[2].codecName, "raw", "codec2 auto->raw for tiny manifest");

// inflate members back
const d0 = await core.inflateMember(parsed.members[0]);
eq(d0.length, repetitive.length, "inflated len0");
eq(core.fnv1a64(d0), core.fnv1a64(repetitive), "inflated fnv match");
const d1 = await core.inflateMember(parsed.members[1]);
eq(d1.length, noisy.length, "inflated len1");
const d2 = await core.inflateMember(parsed.members[2]);
eq(JSON.parse(new TextDecoder().decode(d2)).format, "SKC1", "manifest roundtrip");

// repack parsed members -> byte-stable second generation
const repackMembers = parsed.members.map(m => ({
  kind: m.kindName, codec: m.codecName, name: m.name,
  data: m.data, media: m.media, meta: m.meta,
}));
// NOTE: skcs_pack expects RAW data but parse gives STORED data — for codec=1
// members we must inflate first. This is the documented asymmetry.
const repackRaw = [];
for (const m of parsed.members) {
  const raw = await core.inflateMember(m);
  repackRaw.push({ kind: m.kindName, codec: m.codecName, name: m.name, data: raw, media: m.media, meta: m.meta });
}
const skcs2 = await core.skcsPack(repackRaw, 0);
const p2 = core.skcsParse(skcs2);
eq(p2.members.length, 3, "repack member count");
eq((await core.inflateMember(p2.members[0])).length, repetitive.length, "repack roundtrip len");

// -- SKCF parse -----------------------------------------------------------------
console.log("skcf:");
// build a real frame via fountain_encode (payload -> frames blob)
const payload = new TextEncoder().encode("SKC1 frame test payload ".repeat(20));
const framesBlob = core.fountainEncode(payload, 256, 0x5ac1, 4);
const frames = [...core.iterFrames(framesBlob)];
ok(frames.length === 4, "fountain 4 frames");
const h = core.skcfParse(frames[0]);
eq(h.verdict, 0, "skcf verdict ok");
eq(h.k, Math.ceil(payload.length / 256), "skcf k");
eq(h.session_id, 0x5ac1, "skcf session");
eq(h.codec_id, 0, "skcf codec raw");
eq(h.carrier_id, 0, "skcf carrier qr");
// decode back — feed frames blob through fountain_decode
const totalLen = payload.length;
const decoded = core.fountainDecode(framesBlob, totalLen, 256, 0x5ac1);
eq(decoded.length, totalLen, "fountain decode len");
eq(core.fnv1a64(decoded), core.fnv1a64(payload), "fountain decode fnv");
// drop 1 of 4 frames, still decodes (fountain property)
const partial = new Uint8Array(4 + frames.slice(1).reduce((a, f) => a + 4 + f.length, 0));
{
  const dv = new DataView(partial.buffer);
  dv.setUint32(0, 3, true);
  let pos = 4;
  for (const f of frames.slice(1)) { dv.setUint32(pos, f.length, true); pos += 4; partial.set(f, pos); pos += f.length; }
}
const dec2 = core.fountainDecode(partial, totalLen, 256, 0x5ac1);
eq(dec2 ? dec2.length : 0, totalLen, "fountain decode w/ dropped frame");
// malformed frame
const bad = core.skcfParse(new Uint8Array([1, 2, 3]));
eq(bad.verdict, 3, "skcf malformed verdict");

// -- ZIP writer ------------------------------------------------------------------
console.log("zipStore:");
const zf = [
  { name: "payload.skc", data: skcs },
  { name: "note.txt", data: new TextEncoder().encode("hello iteron") },
];
const zip = zipStore(zf);
ok(zip[0] === 0x50 && zip[1] === 0x4b, "zip PK magic");
eq(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "crc32 vector");
// cross-check with python zipfile
writeFileSync("/tmp/iteron_test.zip", zip);
try {
  const out = execSync(`python3 -c "import zipfile;z=zipfile.ZipFile('/tmp/iteron_test.zip');print(z.namelist());print(len(z.read('payload.skc')),len(z.read('note.txt')))"`).toString();
  ok(out.includes("payload.skc") && out.includes("note.txt"), "python zipfile reads zipStore output: " + out.trim().split("\n").pop());
} catch (e) { ok(false, "python zipfile check: " + e.message); }

// -- sniff ---------------------------------------------------------------------
console.log("sniff:");
eq(sniff(zip).format, "skc", "sniff zip");
eq(sniff(skcs).format, "skcs", "sniff skcs");
eq(sniff(frames[0]).format, "skcf", "sniff skcf frame");
eq(sniff(core.fskEncode(new Uint8Array([1, 2, 3]), 1200)).format, "wav", "sniff wav");
eq(sniff(new Uint8Array([0, 1, 2])).format, "raw", "sniff raw");

// -- reemit byte-identity ---------------------------------------------------------
console.log("reemit:");
// synthetic template + parts (DOM-free)
const tmplHtml = `<!DOCTYPE html><html><body>
<script type="application/octet-stream" id="iteron-wasm">__WASM_B64__</script>
<script type="application/octet-stream" id="iteron-state">__STATE_B64__</script>
<script type="application/json" id="iteron-manifest">__MANIFEST__</script>
<script type="application/octet-stream" id="iteron-tmpl">__TEMPLATE_B64__</script>
<script type="application/octet-stream" id="iteron-engine-src">__ENGINE__</script>
<script>__ENGINE__</script>
<script id="iteron-extra-boot">__EXTRA_BOOT__</script>
</body></html>`;
const parts = {
  wasmB64: "QUJD",                       // "ABC"
  stateB64: b64encode(skcs),
  manifestStr: JSON.stringify({ format: "ITERON1", n: 1 }),
  tmplB64: Buffer.from(tmplHtml).toString("base64"),
  engineSrc: "//engine",
  extraBootSrc: "//extra boot layer",
};
const iteron = new Iteron(core, skcs, JSON.parse(parts.manifestStr), parts);
const emitted = iteron.reemit();
// emulate build: template.replace each marker (same order as make_quine.py)
const expected = tmplHtml
  .replaceAll("__WASM_B64__", parts.wasmB64)
  .replaceAll("__STATE_B64__", parts.stateB64)
  .replaceAll("__MANIFEST__", JSON.stringify({ format: "ITERON1", n: 1 }).replaceAll("<", "\\u003c"))
  .replaceAll("__TEMPLATE_B64__", parts.tmplB64)
  .replaceAll("__EXTRA_BOOT__", parts.extraBootSrc)
  .replaceAll("__ENGINE__", parts.engineSrc);
ok(emitted === expected, "reemit byte-identity vs build substitution");
// second-generation: parse emitted artifact's tmpl slot -> reemit again -> stable
const m = emitted.match(/id="iteron-tmpl">([^<]+)</);
ok(!!m, "tmpl slot extractable from emitted html");
if (m) {
  const iteron2 = new Iteron(core, skcs, JSON.parse(parts.manifestStr), { ...parts, tmplB64: m[1] });
  ok(iteron2.reemit() === emitted, "second-generation reemit stable");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
