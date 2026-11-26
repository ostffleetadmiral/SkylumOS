const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, protocol } = require("electron");
const { randomBytes } = require("node:crypto");
const { mkdir, open, readFile, rename, rm } = require("node:fs/promises");
const path = require("node:path");
const { join } = path;
const { registerHostHandlers } = require("./main-policy.cjs");

protocol.registerSchemesAsPrivileged([
  { scheme: "skyos", privileges: { standard: true, secure: true, supportFetchAPI: true,
    corsEnabled: true, stream: true } },
]);

const state = {
  runtime: null,
  hostApi: null,
  bridge: null,
  token: randomBytes(32).toString("hex"),
  window: null,
  handlersInstalled: false,
};
const rendererUrl = "skyos://app/echo/electron/renderer.html";
const skyosRoot = path.resolve(__dirname, "../..");
const protoRoot = path.resolve(__dirname, "../../..");
const MAX_VOLUME_BYTES = 64 * 1024 * 1024;

async function writeAtomic(target, bytes) {
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function validateVolumeName(name = "state") {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
      name === "." || name === "..") throw new Error("volume_name_invalid");
  return name;
}

async function installHandlers() {
  if (state.handlersInstalled) return;
  const [{ loadRuntime }, { createHostApi }, { createNodePersistence }, { startBridge },
    { nodeHostDoors }, { createSupervisor }] =
    await Promise.all([
      import("../../host/runtime.js"),
      import("../../host/runtime.js"),
      import("../../host/persist-node.js"),
      import("../../host/bridge.js"),
      import("../../host/doors-node.js"),
      import("../../host/services-node.mjs"),
    ]);
  const persistRoot = join(app.getPath("userData"), "volumes");
  const persist = createNodePersistence(persistRoot);
  let stateBytes = null;
  try { stateBytes = new Uint8Array(await readFile(join(persistRoot, "state.skcs"))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  state.runtime = await loadRuntime({
    persist, ...(stateBytes ? { stateBytes } : {}),
    doors: { extra: nodeHostDoors() },
    host: { runtime: "electron", capabilities: {
      filesystem: true, bridge: true, webserial: false,
      netprobe: true, serialscan: true, netifaces: true,
    } },
  });
  state.hostApi = createHostApi(state.runtime);
  state.bridge = await startBridge({ runtime: state.runtime, token: state.token,
    host: "127.0.0.1", port: 0 });

  // External-app runtimes (God's Eye View, Space Agent) are seeded from the
  // canonical manifest in host/services.mjs. Auto-start is on by default so
  // embed windows come alive without manual steps; SKYOS_AUTOSTART=0
  // disables it, or a comma list limits which services are ensured. Only
  // children this supervisor spawns are reaped on quit — runtimes that were
  // already answering are left alone.
  state.services = createSupervisor({
    roots: [protoRoot, path.resolve(protoRoot, ".."), process.cwd()],
    logDir: join(app.getPath("userData"), "service-logs"),
  });
  const autoStart = process.env.SKYOS_AUTOSTART ?? "all";
  if (autoStart !== "0") {
    const ids = autoStart === "all" ? "all"
      : autoStart.split(",").map(s => s.trim()).filter(Boolean);
    void state.services.ensure(ids).catch(() => {});
  }

  const actions = {
  "skyos:status": () => state.hostApi.status(),
  "skyos:claims:list": () => state.hostApi.listClaims(),
  "skyos:claims:read": args => state.hostApi.readClaim(args?.name, args?.maxBytes),
  "skyos:volumes:list": async () => (await persist.listVolumes())
    .filter(name => name.endsWith(".skcs")),
  "skyos:volumes:load": async args => {
    const name = validateVolumeName(args?.name);
    const bytes = await persist.loadVolume(name);
    if (!bytes) return { found: false, name };
    if (bytes.length > MAX_VOLUME_BYTES) throw new Error("volume_too_large");
    return { found: true, name, bytes: bytes.length,
      bytesB64: Buffer.from(bytes).toString("base64") };
  },
  "skyos:volumes:save": async args => {
    const name = validateVolumeName(args?.name);
    if (typeof args?.bytesB64 !== "string") throw new Error("volume_payload_invalid");
    const bytes = Buffer.from(args.bytesB64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_VOLUME_BYTES)
      throw new Error("volume_payload_invalid");
    if (bytes.toString("base64") !== args.bytesB64)
      throw new Error("volume_payload_noncanonical");
    await persist.saveVolume(name, bytes);
    return { name, bytes: bytes.length };
  },
  "skyos:volumes:delete": async args => ({
    deleted: await persist.deleteVolume(validateVolumeName(args?.name)),
  }),
  "skyos:infer": args => state.hostApi.infer(args?.prompt),
  "skyos:door:send": args => state.hostApi.sendDoor(args?.id, args?.payload),
  "skyos:door:recv": args => state.hostApi.recvDoor(args?.id, args?.maxBytes),
  "skyos:quine:reemit": () => state.hostApi.reemit(),
  "skyos:volume:import": async () => {
    const result = await dialog.showOpenDialog(state.window, {
      filters: [{ name: "SkyOS volume", extensions: ["skcs"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return { canceled: true };
    const bytes = await readFile(result.filePaths[0]);
    if (bytes.length === 0 || bytes.length > MAX_VOLUME_BYTES)
      throw new Error("volume_payload_invalid");
    return { canceled: false, name: result.filePaths[0].split(/[\\/]/).at(-1),
      bytesB64: bytes.toString("base64") };
  },
  "skyos:volume:export": async args => {
    const name = validateVolumeName(args?.name ?? "state.skcs");
    if (typeof args?.bytesB64 !== "string") throw new Error("volume_payload_invalid");
    const bytes = Buffer.from(args.bytesB64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_VOLUME_BYTES ||
        bytes.toString("base64") !== args.bytesB64)
      throw new Error("volume_payload_invalid");
    const result = await dialog.showSaveDialog(state.window, {
      defaultPath: name,
      filters: [{ name: "SkyOS volume", extensions: ["skcs"] }],
    });
    if (result.canceled) return { canceled: true };
    await writeAtomic(result.filePath, bytes);
    return { canceled: false, name: result.filePath.split(/[\\/]/).at(-1), bytes: bytes.length };
  },
  "skyos:artifact:export": async args => {
    const name = args?.name;
    if (typeof name !== "string" || !/^[a-z0-9-]{1,32}\.html$/.test(name))
      throw new Error("artifact_name_invalid");
    const result = await dialog.showSaveDialog(state.window, {
      defaultPath: name,
      filters: [{ name: "HTML artifact", extensions: ["html"] }],
    });
    if (result.canceled) return { canceled: true };
    const html = args?.html;
    if (typeof html !== "string" || Buffer.byteLength(html) > 16 * 1024 * 1024)
      throw new Error("artifact_payload_invalid");
    await writeAtomic(result.filePath, Buffer.from(html, "utf8"));
    return { canceled: false, name: result.filePath.split(/[\\/]/).at(-1),
      bytes: Buffer.byteLength(html) };
  },
  "skyos:bridge:enable": async args => {
    if (args?.enabled === false && state.bridge) {
      await state.bridge.close();
      state.bridge = null;
      return { enabled: false };
    }
    if (!state.bridge) state.bridge = await startBridge({
      runtime: state.runtime, token: state.token, host: "127.0.0.1", port: 0,
    });
    return { enabled: true, url: state.bridge.url, token: state.token };
  },
  "skyos:bridge:status": () => state.bridge ? {
    enabled: true, url: state.bridge.url, token: state.token,
  } : { enabled: false },
  "skyos:services:status": () => state.services.status(),
  "skyos:services:ensure": args =>
    state.services.ensure(args?.id ?? args?.ids ?? "all"),
  "skyos:hw:probe": async () => {
    const probe = await state.hostApi.hwProbe();
    try {
      return { ...probe, electronGpu: await app.getGPUInfo("basic") };
    } catch {
      return probe; // GPU info is a bonus — probe alone is still true
    }
  },
  "skyos:optical:sources": async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"], thumbnailSize: { width: 0, height: 0 },
    });
    return { sources: sources.map(s => ({ id: s.id, name: s.name })) };
  },
  };
  state.ipcActions = actions;
  state.handlersInstalled = true;
}

async function createWindow() {
  await installHandlers();
  await protocol.handle("skyos", async request => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ""); }
    catch { return new Response("Not found", { status: 404 }); }
    const base = (relative === "skc" || relative.startsWith("skc/"))
      ? protoRoot + path.sep : skyosRoot + path.sep;
    const target = path.resolve(base, relative);
    if (!target.startsWith(base)) return new Response("Not found", { status: 404 });
    try {
      const bytes = await readFile(target);
      const type = target.endsWith(".js") || target.endsWith(".mjs") ? "text/javascript" :
        target.endsWith(".css") ? "text/css" : target.endsWith(".wasm") ? "application/wasm" :
          target.endsWith(".skcs") ? "application/octet-stream" : "text/html";
      return new Response(bytes, { headers: { "content-type": type,
        "content-security-policy": "default-src 'self' blob: data:; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:* file:; object-src 'none'; base-uri 'none'; frame-src 'self' skyos: http://127.0.0.1:* http://localhost:*;" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  state.window = window;
  state.removeHandlers = registerHostHandlers(ipcMain, {
    webContents: window.webContents, actions: state.ipcActions, rendererUrl,
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  // Camera/display-media are legitimate for the optical lane and only for
  // our own renderer URL; every other permission stays denied.
  const OPTICAL_PERMISSIONS = new Set(["media"]);
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) =>
      callback(OPTICAL_PERMISSIONS.has(permission) &&
        details?.requestingUrl === rendererUrl));
  window.webContents.session.setPermissionCheckHandler(
    (_webContents, permission) => OPTICAL_PERMISSIONS.has(permission));
  // getDisplayMedia() in the renderer resolves to this window — a real
  // compositor pixel path for the optical lane's self-receive mode.
  window.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["window"], thumbnailSize: { width: 0, height: 0 },
    });
    const title = state.window?.getTitle();
    const own = sources.find(s => s.name === title) ?? sources[0];
    if (own) callback({ video: own });
    else callback({});
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.on("closed", () => {
    state.removeHandlers?.();
    state.removeHandlers = null;
    state.window = null;
  });
  await window.loadURL("skyos://app/echo/electron/renderer.html");
}

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", async event => {
  if (state.bridge || state.services) {
    event.preventDefault();
    try { await state.bridge?.close(); }
    finally {
      state.bridge = null;
      await state.services?.close().catch(() => {});
      state.services = null;
      app.exit(0);
    }
  }
});
app.on("will-quit", () => {
  state.removeHandlers?.();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
