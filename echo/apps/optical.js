// optical.js — ECHO Optical Transceiver: a half-duplex fountain link over
// ONE light channel. TX renders SKCF frame carousels as luminance rasters
// (2D canvas always; WebGL instanced quads when a real GPU context is
// reachable — the renderer string is reported, not assumed). RX decodes
// the same raster law from three honest pixel sources:
//   loopback  — readback of our own TX canvas (full codec chain, no hw)
//   camera    — getUserMedia video frames (only when a camera exists)
//   screen    — getDisplayMedia; in Electron resolves to this window via
//               setDisplayMediaRequestHandler, in browsers the OS picker
// Grid size need not be known in advance: detectGrid() scans candidate
// n and locks on the embedded SK header (magic + version + self-check).
// Payload can be the running machine's own source — reemit() streamed
// live — because the channel carries any byte string.
// Camera/QR scanning fidelity stays Python/cv2-side (LAYERS.md §7).

import { CARRIER, FRAME_CODEC } from "../../iteron/iteron-core.js";
import { rasterEncode, rasterDecode, sampleRaster } from "../../skylum/optical.js";

const nameOf = (table, id) =>
  Object.keys(table).find(key => table[key] === id) ?? `unknown(${id})`;

const hexToBytes = text => {
  const clean = text.replace(/[^0-9a-fA-F]/g, "");
  if (!clean.length || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const hexDump = (bytes, max = 96) =>
  [...bytes.slice(0, max)].map(b => b.toString(16).padStart(2, "0")).join(" ") +
  (bytes.length > max ? " …" : "");

// Scan candidate grid sizes: the raster is assumed to fill the image;
// the SK header validates the right n (magic, version, n self-check,
// header-consistent length). Returns {n, cellPx, frame} or null.
function detectGrid(pixels, width, height) {
  const dim = Math.min(width, height);
  // n>=4: the 10-cell header alone needs n² >= 10. Small payloads make
  // small grids — scanning from 8 silently missed them.
  for (let n = 4; n <= 255 && n * 2 <= dim; n++) {
    const cellPx = dim / n;
    if (cellPx < 2) break;
    const lum = sampleRaster(pixels, width, height, n, cellPx);
    if (!lum) continue;
    if (lum[0] !== 0x53 || lum[1] !== 0x4b || lum[3] !== n) continue;
    const frame = rasterDecode(lum, n);
    if (frame) return { n, cellPx, frame };
  }
  return null;
}

// WebGL renderer for the raster carousel: cells as instanced quads fed
// by an n×n luminance texture. Returns {render, info} or null when no
// GPU context is reachable — the 2D path remains the honest baseline.
function createGlRenderer(canvas) {
  // Must be webgl2: the shaders below are GLSL 300 (gl_InstanceID,
  // texelFetch). Requesting "webgl" binds the canvas to WebGL1, where
  // compile fails AND the canvas can never give a "2d" context either —
  // silently breaking the 2D fallback whenever WebGL1 exists.
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  if (!gl) return null;
  const vs = `#version 300 es
    uniform sampler2D cells; uniform int n;
    out float v;
    void main(){
      int id=gl_InstanceID; vec2 cell=vec2(float(id%n),float(id/n));
      v=texelFetch(cells,ivec2(cell),0).r;
      // GL clip space is y-up; the raster is row-major y-down — flip y
      // or the SK header lands bottom-left and detection sees a mirror.
      vec2 p=vec2((cell.x+0.5)/float(n)*2.0-1.0,
                  1.0-(cell.y+0.5)/float(n)*2.0);
      vec2 quad=(vec2(gl_VertexID&1,gl_VertexID>>1)*2.0-1.0)/float(n);
      gl_Position=vec4(p+quad*0.9,0.,1.);
    }`;
  const fs = `#version 300 es
    precision mediump float; in float v; out vec4 c;
    void main(){ c=vec4(v,v,v,1.); }`;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vso = compile(gl.VERTEX_SHADER, vs), fso = compile(gl.FRAGMENT_SHADER, fs);
  if (!vso || !fso) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vso); gl.attachShader(prog, fso); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // Grid width n is arbitrary (31 here) — R8 rows aren't 4-aligned,
  // so the default UNPACK_ALIGNMENT=4 silently voids texImage2D.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const info = (() => {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  })();
  return {
    info,
    render(n, lum, cellPx) {
      canvas.width = n * cellPx; canvas.height = n * cellPx;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, "n"), n);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, n, 0, gl.RED, gl.UNSIGNED_BYTE, lum);
      gl.uniform1i(gl.getUniformLocation(prog, "cells"), 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n * n);
    },
    readPixels() {
      const out = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    },
  };
}

export function mountOptical(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const link = ctx.os.skylum.optical;

  // -- chrome ----------------------------------------------------------------
  const lane = doc.createElement("p"); lane.className = "optical-note";
  lane.textContent = "Optical transceiver — one light channel, TX↔RX alternated. " +
    "Camera scanning fidelity stays Python/cv2-side (§7).";
  const status = doc.createElement("p"); status.className = "mesh-lane";
  const canvas = doc.createElement("canvas"); canvas.className = "optical-raster";
  const video = doc.createElement("video"); video.muted = true; video.playsInline = true;
  video.className = "optical-video"; video.hidden = true;
  const detail = doc.createElement("pre");
  const sessions = doc.createElement("div");
  root.append(lane, status, canvas, video, detail, sessions);

  // TX controls
  const txText = doc.createElement("textarea");
  txText.placeholder = "TX payload text — or beam this machine's own source";
  const addBtn = (label, action, host = root) => {
    const b = doc.createElement("button"); b.textContent = label;
    b.onclick = async () => {
      const own = ++generation;
      try { await action(own); }
      catch (e) { if (ctx.isCurrent() && own === generation) detail.textContent = e.message; }
    };
    host.append(b); return b;
  };
  root.append(txText);

  // -- renderers -------------------------------------------------------------
  let gl = null;
  try { gl = createGlRenderer(canvas); } catch { gl = null; }
  const paint2d = (n, lum, cellPx) => {
    canvas.width = n * cellPx; canvas.height = n * cellPx;
    const g = canvas.getContext("2d");
    for (let i = 0; i < n * n; i++) {
      const v = lum[i];
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect((i % n) * cellPx, Math.floor(i / n) * cellPx, cellPx, cellPx);
    }
  };
  const paint = (n, lum, cellPx) =>
    gl ? gl.render(n, lum, cellPx) : paint2d(n, lum, cellPx);
  const readback = () => {
    if (gl) return gl.readPixels();
    const g = canvas.getContext("2d");
    return g.getImageData(0, 0, canvas.width, canvas.height).data;
  };

  const describe = () => {
    const glInfo = gl ? `GL ${gl.info}` : "2D canvas (no WebGL context)";
    const cam = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
      ? "camera-capable" : "no getUserMedia";
    const disp = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia
      ? "display-capture-capable" : "no getDisplayMedia";
    status.textContent =
      `link ${link.state} · ${glInfo} · ${cam} · ${disp}`;
  };
  link.onState = describe;
  describe();

  // -- session view ----------------------------------------------------------
  const renderPools = () => {
    sessions.replaceChildren();
    for (const [sid, pool] of link.pool.sessions) {
      const card = doc.createElement("div"); card.className = "optical-session";
      card.textContent =
        `session 0x${sid.toString(16).padStart(4, "0")} · ` +
        `${pool.payload ? "DECODED" : `${pool.frames.size}/${pool.k} frames`} · ` +
        `carrier ${nameOf(CARRIER, pool.carrier_id)} · ` +
        `codec ${nameOf(FRAME_CODEC, pool.codec_id)} · total ${pool.total_len}B`;
      if (pool.payload) {
        const save = doc.createElement("button");
        save.textContent = "Download payload";
        save.onclick = () => ctx.os.download(pool.payload, `skcf-${sid.toString(16)}.bin`);
        card.append(" ", save);
      }
      sessions.append(card);
    }
    if (!link.pool.sessions.size) sessions.textContent = "No frames ingested.";
  };
  const onPayload = () => { renderPools(); describe(); };
  link.onPayload = onPayload;
  renderPools();

  // -- RX ingest paths -------------------------------------------------------
  const ingestFrame = async (frame, own) => {
    const parsed = ctx.os.core.skcfParse(frame);
    const res = await link.rxFrame(frame);
    if (!ctx.isCurrent() || own !== generation) return;
    if (!parsed || parsed.verdict !== 0) {
      detail.textContent = `Raster frame rejected: ${parsed?.verdictName ?? "unparseable"}`;
      return;
    }
    detail.textContent =
      `rx seq ${parsed.seq} · k ${parsed.k} · session 0x${parsed.session_id.toString(16).padStart(4, "0")}` +
      (res.decoded ? ` · DECODED ${res.decoded.length}B` : "");
    renderPools();
  };

  // file + hex ingest (receive side, same as before)
  const pick = doc.createElement("input");
  pick.type = "file"; pick.accept = ".skcf,.bin"; pick.multiple = true;
  const hexBox = doc.createElement("textarea");
  hexBox.placeholder = "Paste hex-encoded SKCF frame (QR payload format)";
  root.append(pick, hexBox);
  pick.onchange = async () => {
    const own = ++generation;
    for (const f of [...(pick.files ?? [])]) {
      try { await ingestFrame(new Uint8Array(await f.arrayBuffer()), own); }
      catch (e) { if (ctx.isCurrent() && own === generation) detail.textContent = e.message; }
      if (!ctx.isCurrent() || own !== generation) return;
    }
  };
  addBtn("Ingest hex frame", async own => {
    const frame = hexToBytes(hexBox.value);
    if (!frame) { detail.textContent = "Hex input invalid — expected even hex."; return; }
    hexBox.value = "";
    await ingestFrame(frame, own);
  });

  // -- TX carousel -----------------------------------------------------------
  let txTimer = null;
  const txFps = 4; // conservative: camera exposure + decode headroom
  const startCarousel = (payload, label) => {
    link.tx(payload);
    detail.textContent =
      `TX ${label}: ${link.frames.length} frames @${txFps}fps · session ` +
      `0x${link.sessionId.toString(16).padStart(4, "0")} · ${payload.length}B`;
    if (txTimer) clearInterval(txTimer);
    txTimer = setInterval(() => {
      const frame = link.txNext();
      if (!frame) { clearInterval(txTimer); txTimer = null; return; }
      const { n, lum } = rasterEncode(frame);
      paint(n, lum, Math.max(2, Math.floor(360 / Math.max(1, n))));
    }, 1000 / txFps);
    describe();
  };
  addBtn("Beam text", () => {
    const bytes = new TextEncoder().encode(txText.value);
    if (!bytes.length) throw new Error("tx_payload_empty");
    startCarousel(bytes, "text");
  });
  addBtn("Beam state volume", async () => {
    const bytes = await ctx.os.skylum.save();
    startCarousel(bytes, "state.skcs");
  });
  addBtn("Beam this machine", async () => {
    if (ctx.os.host?.mode === "electron") {
      const bytes = await ctx.os.skylum.save();
      startCarousel(bytes, "state volume (HTML re-emit is a browser-edition capability)");
      return;
    }
    startCarousel(new TextEncoder().encode(ctx.os.iteron.reemit()), "reemit() source");
  });
  addBtn("Stop TX", () => {
    if (txTimer) { clearInterval(txTimer); txTimer = null; }
    link.stop(); describe();
  });

  // -- RX sources -------------------------------------------------------------
  addBtn("Loopback self-test", async own => {
    // The honest no-hardware path: pixels go through the real render +
    // readback + sample + decode chain — only the air gap is skipped.
    const frame = link.txNext() ?? (() => {
      const f = link.frames[0]; return f ?? null;
    })();
    if (!frame) {
      detail.textContent = "Start a TX carousel first — loopback reads its pixels.";
      return;
    }
    const { n, lum } = rasterEncode(frame);
    const cellPx = Math.max(2, Math.floor(360 / Math.max(1, n)));
    paint(n, lum, cellPx);
    const pixels = readback();
    const detected = await decodePixels(pixels, canvas.width, canvas.height, own);
    if (!detected) detail.textContent = "loopback: raster undetected";
  });

  let rxStream = null, rxTimer = null, lockedN = null;

  // Decode one captured image (RGBA bytes + dims) through the optical
  // chain: locked-grid fast path, full header scan when unlocked, then
  // skcfParse/pool/fountain. Shared by every RX source — and exposed on
  // the view node for automation hooks.
  const decodePixels = async (imgData, width, height, own) => {
    let detected = null;
    if (lockedN) {
      const cellPx = Math.min(width, height) / lockedN;
      const lum = sampleRaster(imgData, width, height, lockedN, cellPx);
      const frame = lum && rasterDecode(lum, lockedN);
      if (frame) detected = { n: lockedN, cellPx, frame };
    }
    if (!detected) {
      detected = detectGrid(imgData, width, height);
      if (detected) {
        lockedN = detected.n;
        detail.textContent =
          `rx: locked grid n=${detected.n} cell=${detected.cellPx.toFixed(1)}px`;
      } else lockedN = null;
    }
    if (detected) await ingestFrame(detected.frame, own);
    return detected;
  };

  const stopRx = () => {
    if (rxTimer) { clearInterval(rxTimer); rxTimer = null; }
    rxStream?.getTracks().forEach(t => t.stop());
    rxStream = null; video.hidden = true; video.srcObject = null;
    lockedN = null;
  };
  const startRx = (stream, label) => {
    stopRx();
    lockedN = null;
    rxStream = stream;
    video.srcObject = stream; video.hidden = false;
    video.play().catch(() => {});
    link.rxStart(); describe();
    const scratch = doc.createElement("canvas");
    const sg = scratch.getContext("2d", { willReadFrequently: true });
    rxTimer = setInterval(async () => {
      if (!ctx.isCurrent() || !video.videoWidth) return;
      scratch.width = video.videoWidth; scratch.height = video.videoHeight;
      sg.drawImage(video, 0, 0);
      const own = ++generation;
      const img = sg.getImageData(0, 0, scratch.width, scratch.height);
      await decodePixels(img.data, img.width, img.height, own);
    }, 250);
  };
  addBtn("RX camera", async () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("camera unavailable: no getUserMedia");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false,
    });
    startRx(stream, "camera");
  });
  addBtn("RX screen capture", async () => {
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw new Error("screen capture unavailable: no getDisplayMedia");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: false,
    });
    startRx(stream, "screen");
  });
  addBtn("Stop RX", () => { stopRx(); link.stop(); describe(); });
  addBtn("HW probe", async () => {
    if (ctx.os.host?.hwProbe) {
      const probe = await ctx.os.host.hwProbe();
      detail.textContent = JSON.stringify(probe, null, 2);
    } else detail.textContent = "hw probe unavailable: host doors exist only on Node/Electron runtimes";
  });

  // Automation hook — the real app functions, reachable for the Electron
  // self-capture smoke and headless drivers. Not part of the app contract.
  root.__optical = { link, decodePixels, startRx, stopRx, beam: startCarousel };

  return () => {
    generation++;
    root.__optical = null;
    if (txTimer) clearInterval(txTimer);
    stopRx();
    link.stop();
    if (link.onState === describe) link.onState = null;
    if (link.onPayload === onPayload) link.onPayload = null;
  };
}
