import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ELECTRON_IPC_CHANNELS } = require("../echo/electron/main-policy.cjs");

let passed = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  passed++;
  console.log(` ok ${label}`);
};

const read = name => readFileSync(new URL(`../echo/electron/${name}`, import.meta.url), "utf8");
const mainSrc = read("main.cjs");
const preloadSrc = read("preload.cjs");
const policySrc = read("main-policy.cjs");
const rendererSrc = read("renderer.js");

console.log("Electron static policy:");
check(/contextIsolation:\s*true/.test(mainSrc), "contextIsolation enabled");
check(/nodeIntegration:\s*false/.test(mainSrc), "Node integration disabled");
check(/sandbox:\s*true/.test(mainSrc), "renderer sandbox enabled");
check(/webSecurity:\s*true/.test(mainSrc), "webSecurity enabled");
check(/allowRunningInsecureContent:\s*false/.test(mainSrc), "insecure content blocked");
check(/'wasm-unsafe-eval'/.test(mainSrc) && /object-src 'none'/.test(mainSrc),
  "protocol CSP allows Wasm but forbids plugins");
check(/setPermissionRequestHandler[\s\S]*?OPTICAL_PERMISSIONS\.has\(permission\)[\s\S]*?requestingUrl === rendererUrl/.test(mainSrc),
  "permission requests limited to optical media on the renderer URL");
check(/setPermissionCheckHandler[\s\S]*?OPTICAL_PERMISSIONS\.has\(permission\)/.test(mainSrc),
  "permission checks limited to optical media");
check(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{ action: "deny" \}\)\)/.test(mainSrc),
  "new windows denied");
check(/will-navigate[\s\S]*?preventDefault\(\)/.test(mainSrc),
  "navigation confined to renderer URL");
check(/will-attach-webview[\s\S]*?preventDefault\(\)/.test(mainSrc), "webview attach blocked");
check(/startsWith\(base\)/.test(mainSrc), "protocol path confined to allowlisted roots");
check(/contextBridge\.exposeInMainWorld/.test(preloadSrc) &&
  /ipcRenderer\.invoke\(channel, input\)/.test(preloadSrc) &&
  !/require\(["'](?!electron)/.test(preloadSrc.replace(/require\("electron"\)/, "")),
  "sandboxed preload only invokes fixed IPC channels");
check(/senderFrame\.url !== rendererUrl/.test(policySrc) &&
  /event\.sender !== expectedWebContents/.test(policySrc),
  "IPC validates webContents and exact sender frame URL");
check(ELECTRON_IPC_CHANNELS.every(channel => preloadSrc.includes(channel)),
  "preload exposes every registered IPC channel");
check(!/require\(["']node:/.test(preloadSrc), "preload has no Node API surface");
check(/ELECTRON_RUN_AS_NODE/.test(mainSrc) === false, "main does not depend on node-mode env");
check(/persist:\s*hostPersist/.test(rendererSrc) &&
  /saveVolume:\s*async \(name, bytes\)/.test(rendererSrc),
  "renderer injects host persistence adapter into shared runtime");
check(/skylum\.status\(\)/.test(rendererSrc), "desktop status reads renderer runtime, not IPC");
check(/skyos:fabric:request/.test(mainSrc) && /SKYOS_FABRIC_URL/.test(mainSrc) &&
  /SKYOS_FABRIC_TOKEN/.test(mainSrc),
  "main proxies fabric head calls with env-configured URL and token");

console.log("Fabric head proxy:");
{
  const { createFabricProxy } = require("../echo/electron/fabric-proxy.cjs");
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url,
        auth: req.headers.authorization, ctype: req.headers["content-type"], body });
      res.writeHead(req.url.startsWith("/v1/job") ? 201 : 200,
        { "content-type": "application/json" });
      res.end(req.url.startsWith("/v1/big")
        ? JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) })
        : JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const proxy = createFabricProxy({ baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token-0123456789abcdef" });
    const anon = createFabricProxy({ baseUrl: `http://127.0.0.1:${port}` });
    const rejects = async (promise, pattern) => {
      try { await promise; return false; }
      catch (error) { return pattern.test(String(error.message)); }
    };

    const status = await proxy({ path: "/v1/status" });
    check(status.status === 200 && JSON.parse(status.body).ok === true,
      "proxy returns upstream status and JSON body");
    check(seen.at(-1).method === "GET" && seen.at(-1).url === "/v1/status" &&
      seen.at(-1).auth === "Bearer test-token-0123456789abcdef",
      "proxy attaches configured bearer to upstream GET");
    await anon({ path: "/v1/status" });
    check(seen.at(-1).auth === undefined,
      "tokenless proxy sends no authorization header");
    const job = await proxy({ path: "/v1/job?x=1", method: "POST",
      body: JSON.stringify({ kind: "probe" }) });
    check(job.status === 201 && seen.at(-1).ctype === "application/json" &&
      seen.at(-1).url === "/v1/job?x=1" &&
      JSON.parse(seen.at(-1).body).kind === "probe",
      "proxy forwards POST path, query, content-type, and body");
    check(await rejects(proxy({ path: "/v1/status", method: "PUT" }),
      /fabric_method_invalid/), "proxy rejects non-GET/POST methods");
    check(await rejects(proxy({ path: "/etc/passwd" }), /fabric_path_invalid/) &&
      await rejects(proxy({ path: "/v1/has space" }), /fabric_path_invalid/),
      "proxy rejects paths outside /v1 and paths with whitespace");
    check(await rejects(proxy({ path: "/v1/status", body: "{}" }),
      /fabric_body_invalid/) &&
      await rejects(proxy({ path: "/v1/job", method: "POST",
        body: "x".repeat(256 * 1024 + 1) }), /fabric_body_invalid/),
      "proxy rejects GET bodies and oversized request bodies");
    check(await rejects(proxy({ path: "/v1/big" }), /fabric_response_too_large/),
      "proxy caps upstream response size");
    assert.throws(() => createFabricProxy({ baseUrl: "http://u:p@127.0.0.1:1" }),
      /fabric_url_invalid/);
    passed++;
    console.log(" ok proxy rejects credential-bearing upstream URLs");
  } finally {
    server.close();
  }
}

const electronBin = new URL("../echo/electron/node_modules/electron/dist/electron",
  import.meta.url).pathname;
const hasXvfb = (() => {
  try { return spawnSync("which", ["xvfb-run"]).status === 0; }
  catch { return false; }
})();
const canSmoke = existsSync(electronBin) && hasXvfb;
check(true, `electron smoke ${canSmoke ? "enabled" : "SKIPPED (no electron binary/xvfb)"}`);

if (canSmoke) {
  console.log("Electron live smoke:");
  const port = 19000 + Math.floor(Math.random() * 2000);
  const userData = mkdtempSync(join(tmpdir(), "skyos-elec-test-"));
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1920x1200x24",
    electronBin, ".", "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`], {
    cwd: new URL("../echo/electron", import.meta.url).pathname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const httpBase = `http://127.0.0.1:${port}`;
    let page = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !page) {
      try {
        const targets = await (await fetch(`${httpBase}/json/list`)).json();
        page = targets.find(t => t.type === "page" && t.url.includes("renderer.html"));
      } catch {}
      if (!page) await new Promise(r => setTimeout(r, 400));
    }
    assert.ok(page, "renderer target appears");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise(res => pending.set(id, res));
    };
    const evaluate = async expr => {
      const msg = await send("Runtime.evaluate",
        { expression: expr, returnByValue: true, awaitPromise: true });
      if (msg.result?.exceptionDetails)
        console.log("   eval threw:",
          String(msg.result.exceptionDetails.exception?.description ??
            msg.result.exceptionDetails.text).split("\n")[0]);
      return msg.result?.result?.value;
    };
    let ready = false;
    while (Date.now() < deadline) {
      ready = await evaluate(`Boolean(window.OS?.skylum && window.DESKTOP)`);
      if (ready) break;
      await new Promise(r => setTimeout(r, 400));
    }
    check(ready, "shared ITERON/SKYLUM runtime boots inside the sandboxed renderer");
    const claims = await evaluate(`window.OS.skylum.memory.list().map(c => c.name)`);
    check(claims.includes("boot.cfg") && claims.includes("vendor/globe.gl.min.js"),
      "desktop runtime loads seed claims and sealed vendor member");
    check(await evaluate(`(() => { window.DESKTOP.launch("terminal");
      return window.DESKTOP.wm.state.windows.length === 1; })()`),
      "shared window manager opens a terminal window");
    const saved = await evaluate(`(async () => {
      const blob = await window.OS.skylum.save("state.skcs");
      window.OS.iteron.stateBlob = blob;
      return blob.length; })()`);
    check(saved > 1000 && readdirSync(join(userData, "volumes")).includes("state.skcs"),
      "IPC persistence shuttle writes the .skcs volume into userData");
    check(await evaluate(`window.OS.skylum.restore("state.skcs")`),
      "saved volume restores into the renderer runtime through IPC");
    const hostStatus = await evaluate(`window.skyosHost.status()
      .then(s => s.host.runtime).catch(e => String(e))`);
    check(hostStatus === "electron", "host IPC runtime reports electron host");
    const bridge = await evaluate(`window.skyosHost.bridgeStatus()`);
    check(bridge.enabled && bridge.url.startsWith("http://127.0.0.1:"),
      "loopback bridge runs with per-run token in Electron");
    const hwProbe = await evaluate(`(async () => {
      try { return await window.skyosHost.hwProbe(); }
      catch (e) { return { __err: String(e?.message ?? e) }; } })()`);
    if (hwProbe?.__err) console.log("   hwProbe error:", hwProbe.__err);
    check(hwProbe?.pci?.display?.some(d => d.vendor === "0x1002") &&
      hwProbe.drm.nodes.some(n => n.path.includes("renderD") && n.accessible) &&
      hwProbe.groups.render === true &&
      hwProbe.vulkan.devices.length > 0,
      "hw.probe inventories real GPU/dri/group facts over IPC");
    // Optical two-way on the virtual display: the app beams a payload onto
    // its own canvas; a real compositor capture of the screen is cropped
    // to the raster's rect and run through the app's own decode chain —
    // a complete screen→pixels→fountain round trip with no camera.
    check(await evaluate(`(() => { window.DESKTOP.launch("optical");
      return [...document.querySelectorAll(".app-view")]
        .some(v => Boolean(v.__optical)); })()`),
      "optical app mounts and exposes its automation hook");
    // Setup: beam a tagged payload, reparent the raster to <body> (the
    // window-body clips fixed-position overflow), hide other windows, and
    // install the shared capture+decode worker used by both sources.
    const tag = await evaluate(`(() => {
      const view = [...document.querySelectorAll(".app-view")]
        .find(v => v.__optical);
      const app = view.__optical;
      const text = "skyos-optical-e2e-" + Math.random().toString(36).slice(2);
      app.beam(new TextEncoder().encode(text));
      const raster = view.querySelector(".optical-raster");
      document.body.appendChild(raster);
      raster.style.cssText = "position:fixed;left:0;top:0;margin:0;" +
        "width:100vmin;height:100vmin;max-width:none;max-height:none;z-index:99999";
      for (const win of document.querySelectorAll(".window"))
        win.style.display = "none";
      window.__optDecodeShot = async dataUrl => {
        const shot = new Image();
        shot.src = dataUrl;
        await shot.decode();
        const scratch = document.createElement("canvas");
        const sg = scratch.getContext("2d", { willReadFrequently: true });
        scratch.width = shot.naturalWidth; scratch.height = shot.naturalHeight;
        sg.drawImage(shot, 0, 0);
        const scale = shot.naturalWidth / window.innerWidth;
        const rect = raster.getBoundingClientRect();
        const rx = Math.round(rect.x * scale), ry = Math.round(rect.y * scale);
        const w = Math.min(Math.round(rect.width * scale),
          shot.naturalWidth - rx);
        const h = Math.min(Math.round(rect.height * scale),
          shot.naturalHeight - ry);
        const img = sg.getImageData(rx, ry, w, h);
        await app.decodePixels(img.data, img.width, img.height, -1);
        const hit = [...app.link.pool.sessions.values()].find(p => p.payload);
        return hit ? new TextDecoder().decode(hit.payload) : null;
      };
      return text;
    })()`);
    check(typeof tag === "string" && tag.startsWith("skyos-optical-e2e-"),
      "optical beam starts on the virtual display");
    // The virtualized "camera": Page.captureScreenshot is the real
    // compositor output for the viewport — the same pixels a headless
    // screen recorder (ffmpeg x11grab) would see. PNG round-trips through
    // an <img> back into the app's own decode path.
    let shotResult = null;
    for (let attempt = 0; attempt < 30 && shotResult !== tag; attempt++) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (attempt === 10) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync("/tmp/skyos-optical-shot.png",
          Buffer.from(shot.result.data, "base64"));
        console.log("   dumped frame to /tmp/skyos-optical-shot.png");
      }
      shotResult = await evaluate(
        `window.__optDecodeShot("data:image/png;base64,${shot.result.data}")`);
      if (shotResult !== tag) await new Promise(r => setTimeout(r, 300));
    }
    check(shotResult === tag,
      "compositor screenshot decodes the beamed payload byte-identically");
    // Opportunistic: getDisplayMedia needs transient activation — a real
    // Input click grants it; when the window capture works end-to-end it
    // is reported, but headless capture support is not required to pass.
    await send("Input.dispatchMouseEvent",
      { type: "mousePressed", x: 400, y: 300, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 400, y: 300, button: "left", clickCount: 1 });
    const streamStatus = await evaluate(`(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia(
          { video: true, audio: false });
        stream.getTracks().forEach(t => t.stop());
        return "display-capture OK";
      } catch (e) { return "display-capture unavailable: " + (e?.message ?? e); }
    })()`);
    console.log("   display-media path:", streamStatus);
    check(true, `display capture probed (${streamStatus})`);
    ws.close();
  } finally {
    child.kill("SIGKILL");
    // xvfb-run children can outlive the wrapper — sweep by the unique
    // userData dir so a crashed run can't serve a stale debug target.
    spawnSync("pkill", ["-9", "-f", userData]);
    rmSync(userData, { recursive: true, force: true });
  }
}

console.log(`Electron: ${passed} passed`);
