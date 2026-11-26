import { createWindowState, transitionWindowState, windowStateSnapshot, restoreWindowState, clampWindowRect, WindowManager } from "../echo/wm.js";
import { createTerminalDispatcher } from "../echo/term.js";
import { APP_REGISTRY, CAPABILITIES, validateAppRegistry } from "../echo/apps.mjs";
import { EMBED_TARGETS, mountGodseye, mountSpaceagent } from "../echo/apps/embed.js";
import { mountFabric } from "../echo/apps/fabric.js";
import { VSpace } from "../skylum/memory.js";
import { Skylum } from "../skylum/index.js";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IteronCore } from "../iteron/iteron-core.js";
import { Iteron } from "../iteron/iteron.js";

let pass = 0, fail = 0;
const check = (condition, name) => {
  if (condition) { pass++; console.log(" ok", name); }
  else { fail++; console.error(" FAIL", name); }
};
const throws = async (fn, message) => {
  try { await fn(); } catch (e) { return e.message === message; }
  return false;
};
const bounds = { width: 1280, height: 800 };

console.log("Window reducer:");
{
  let s = createWindowState();
  s = transitionWindowState(s, { type: "open", id: "terminal" }, bounds);
  check(s.windows.length === 1 && s.focusedId === "terminal", "open + focus");
  s = transitionWindowState(s, { type: "toggle-maximize", id: "terminal" }, bounds);
  check(s.windows[0].rect.width === bounds.width && s.windows[0].maximized, "maximize viewport");
  const resized = { width: 700, height: 500 };
  s = transitionWindowState(s, { type: "restore-geometry", id: "terminal",
    rect: { x: 1200, y: 700, width: 900, height: 650 } }, bounds);
  s = transitionWindowState(s, { type: "toggle-maximize", id: "terminal" }, bounds);
  const maximizedSnapshot = windowStateSnapshot(s);
  const restored = restoreWindowState(maximizedSnapshot, resized);
  const restoredWindow = restored.windows[0];
  check(restoredWindow.maximized && restoredWindow.rect.width === 700 &&
    restoredWindow.rect.height === 500 && restoredWindow.restoreRect.width === 700 &&
    restoredWindow.restoreRect.height === 500 && restoredWindow.restoreRect.x === 0 &&
    restoredWindow.restoreRect.y === 0,
    "maximized session restore clamps saved geometry to resized viewport");
  s = restored;
  s = transitionWindowState(s, { type: "toggle-maximize", id: "terminal" }, resized);
  const w = s.windows[0];
  check(w.rect.width === 700 && w.rect.height === 500 && w.rect.x === 0 && w.rect.y === 0 &&
    !w.maximized && w.restoreRect === null,
    "restoring maximized window clamps pre-maximize geometry to the current viewport");
  s = transitionWindowState(s, { type: "toggle-maximize", id: "terminal" }, resized);
  s = transitionWindowState(s, { type: "restore-geometry", id: "terminal",
    rect: { x: 650, y: 480, width: 600, height: 400 } }, resized);
  check(s.windows[0].rect.width === 600 && s.windows[0].rect.height === 400 &&
    s.windows[0].rect.x === 100 && s.windows[0].rect.y === 100,
    "restore-geometry exits maximized state and clamps requested rectangle");
  s = transitionWindowState(s, { type: "toggle-maximize", id: "terminal" }, resized);
  check(throws(() => transitionWindowState(s, { type: "minimize", id: "missing" }, resized),
    "window_not_found"), "unknown window fails closed");
  check(throws(() => transitionWindowState(s, { type: "restore-geometry", id: "terminal",
    rect: { x: NaN, y: 0, width: 300, height: 200 } }, resized),
  "window_rect_invalid"), "malformed geometry rejected");
  const huge = clampWindowRect({ x: 9999, y: 9999, width: 9000, height: 9000 }, bounds);
  check(huge.width === 1280 && huge.height === 800 &&
    huge.x === 0 && huge.y === 0,
  "oversized geometry is clamped to the current viewport");
  check(throws(() => clampWindowRect({ x: 0, y: 0, width: 300, height: 200 },
    { width: 279, height: 240 }), "window_bounds_invalid"),
  "bounds smaller than minimum window size fail closed");
  const tooSmall = clampWindowRect({ x: 0, y: 0, width: 1, height: 1 }, bounds);
  const tooLarge = clampWindowRect({ x: 0, y: 0, width: 5000, height: 5000 }, bounds);
  check(tooSmall.width === 280 && tooSmall.height === 180 &&
    tooLarge.width === 1280 && tooLarge.height === 800,
    "geometry clamps minimum and viewport maximum dimensions");
  for (let i = 1; i < 8; i++) s = transitionWindowState(s, { type: "open", id: `app-${i}` }, bounds);
  check(throws(() => transitionWindowState(s, { type: "open", id: "app-last" }, bounds),
    "window_limit"), "window cap enforced");
  const snap = windowStateSnapshot(s);
  const restoredSession = restoreWindowState(snap, { width: 360, height: 240 });
  check(restoredSession.windows.every(x => x.rect.x >= 0 && x.rect.y >= 0 &&
    x.rect.width >= 280 && x.rect.height >= 180), "session restore clamps current bounds");
}

console.log("Registry:");
check(APP_REGISTRY.length === 14 && APP_REGISTRY.some(app => app.id === "fabric") &&
  validateAppRegistry() === APP_REGISTRY, "all desktop apps validate including Fabric");
check(throws(() => validateAppRegistry([{ id: "bad id", name: "x", icon: "x", mount() {} }]),
  "app_descriptor_invalid"), "bad app id rejected");
check(throws(() => validateAppRegistry([{ id: "unsafe", name: "Unsafe", icon: "x",
  capability: "host.shell", mount() {} }]), "app_capability_denied"),
"registry rejects capabilities outside the service allowlist");
check(throws(() => validateAppRegistry([{ id: "link", name: "Link", icon: "x",
  capability: "iteron.volume", href: "javascript:alert(1)" }]), "app_href_denied"),
"registry rejects arbitrary href navigation");
check(throws(() => validateAppRegistry([{ id: "missing", name: "Missing", icon: "x",
  capability: "iteron.volume", unavailable: "  " }]), "app_unavailable_invalid"),
"registry rejects blank unavailable explanations");

console.log("External app windows:");
{
  const el = () => ({ tag: "", className: "", children: [],
    append(...n) { this.children.push(...n); }, replaceChildren() { this.children = []; },
    setAttribute() {} });
  const doc = { createElement: t => { const e = el(); e.tag = t; return e; } };
  const root = el(); root.ownerDocument = doc;
  const ctx = { isCurrent: () => true };
  const realFetch = globalThis.fetch;

  check(EMBED_TARGETS.spaceagent.probe === "http://127.0.0.1:3100/api/health" &&
    EMBED_TARGETS.godseye.probe === "http://127.0.0.1:3200/index.html" &&
    !EMBED_TARGETS.godseye.url.includes("embed=1"),
  "embed targets use the standardized port map and the full interactive shell");

  globalThis.fetch = async () => new Response("ok");
  const cleanupUp = mountSpaceagent(root, ctx);
  await Promise.resolve(); await Promise.resolve();
  check(root.children[0].children[0].tag === "iframe" &&
    root.children[0].children[0].src === EMBED_TARGETS.spaceagent.url,
  "reachable runtime mounts the app iframe");
  check(typeof cleanupUp === "function", "embed mount returns a disposer");

  const root2 = el(); root2.ownerDocument = doc;
  let online = false;
  let retry;
  const timers = new Set();
  const pollCtx = {
    isCurrent: () => true,
    setInterval(fn, ms) { check(ms === 5000, "embed retry interval is five seconds"); retry = fn; timers.add(fn); return fn; },
    clearInterval(fn) { timers.delete(fn); },
  };
  globalThis.fetch = async () => {
    if (!online) throw new Error("refused");
    return new Response("ok");
  };
  const cleanupDown = mountGodseye(root2, pollCtx);
  await new Promise(r => setTimeout(r, 0));
  const panel = root2.children[0].children[0];
  check(panel.tag === "div" && panel.className === "embed-offline" &&
    panel.children.some(c => c.tag === "code" && c.textContent.includes("3200")),
  "unreachable runtime shows the honest start command");

  online = true;
  await retry(); await new Promise(r => setTimeout(r, 0));
  check(root2.children[0].children[0].tag === "iframe" &&
    root2.children[0].children[0].src === EMBED_TARGETS.godseye.url,
  "offline panel recovers to the iframe when the runtime starts");
  check(timers.size === 0, "successful embed probe stops the retry timer");

  const root3 = el(); root3.ownerDocument = doc;
  let releaseProbe;
  globalThis.fetch = () => new Promise(resolve => { releaseProbe = resolve; });
  let current = true;
  const staleTimer = () => {};
  const cleanupStale = mountSpaceagent(root3, {
    isCurrent: () => current,
    setInterval: fn => { retry = fn; return staleTimer; },
    clearInterval: () => {},
  });
  current = false;
  releaseProbe(new Response("ok"));
  await Promise.resolve(); await Promise.resolve();
  check(root3.children[0].children.length === 0,
    "completed probe does not attach a stale closed window");
  cleanupDown(); cleanupUp();
  cleanupStale();
  globalThis.fetch = realFetch;
}

console.log("Embed host-status panel:");
{
  const el = () => ({ tag: "", className: "", children: [], textContent: "",
    disabled: false, onclick: null,
    append(...n) { this.children.push(...n); }, replaceChildren() { this.children = []; },
    setAttribute() {} });
  const doc = { createElement: t => { const e = el(); e.tag = t; return e; } };
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("refused"); };

  const ensured = [];
  const host = {
    servicesStatus: async () => ({ services: { spaceagent: {
      state: "missing",
      detail: "no launchable runtime — /x: repo absent",
    } } }),
    ensureServices: args => { ensured.push(args); return Promise.resolve({}); },
  };
  const root = el(); root.ownerDocument = doc;
  const timers = new Set();
  mountSpaceagent(root, {
    isCurrent: () => true, os: { host },
    setInterval: fn => { timers.add(fn); return fn; },
    clearInterval: fn => timers.delete(fn),
  });
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  const panel = root.children[0].children[0];
  const texts = panel.children.map(c => c.textContent);
  check(panel.className === "embed-offline" &&
    texts[0].includes("not installed on this machine"),
  "host-reported missing runtime replaces the generic offline title");
  check(texts.some(t => t.includes("repo absent")),
    "supervisor detail surfaces in the offline panel");
  const button = panel.children.find(c => c.tag === "button");
  check(button && button.textContent === "Start runtime" && button.disabled === false,
    "panel offers a manual start action when the host can spawn");
  button.onclick();
  check(ensured.length === 1 && ensured[0].id === "spaceagent",
    "start action asks the host supervisor for that service only");

  host.servicesStatus = async () => ({ services: { spaceagent: { state: "starting" } } });
  const root2 = el(); root2.ownerDocument = doc;
  let retry2;
  mountSpaceagent(root2, {
    isCurrent: () => true, os: { host },
    setInterval: fn => { retry2 = fn; return fn; },
    clearInterval: () => {},
  });
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await retry2();
  await new Promise(r => setTimeout(r, 0));
  const panel2 = root2.children[0].children[0];
  check(panel2.children[0].textContent.includes("runtime is starting"),
    "panel reflects the supervisor's starting state on the next probe");
  check(panel2.children.find(c => c.tag === "button")?.disabled === true,
    "start button disables while the supervisor is starting");
  globalThis.fetch = realFetch2;
}

console.log("Fabric app host proxy:");
{
  const el = () => ({ tag: "", className: "", children: [], textContent: "",
    disabled: false, onclick: null,
    append(...n) { this.children.push(...n); }, replaceChildren() { this.children = []; },
    setAttribute() {} });
  const doc = { createElement: t => { const e = el(); e.tag = t; return e; } };
  const calls = [];
  const host = {
    fabricRequest: async args => {
      calls.push(args);
      const body = args.path.startsWith("/v1/status")
        ? { head: { id: "proxy-head" } }
        : args.path.startsWith("/v1/nodes") ? { nodes: [{}, {}] }
        : args.path.startsWith("/v1/jobs") ? { jobs: [] }
        : { verification: { valid: true }, entries: [] };
      return { status: 200, body: JSON.stringify(body) };
    },
  };
  const realFetch3 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("direct_fetch_must_not_run"); };
  const root = el(); root.ownerDocument = doc;
  const cleanup = mountFabric(root, { isCurrent: () => true, os: { host } });
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  check(calls.length === 4 && calls.every(c => c.method === "GET" &&
    c.path.startsWith("/v1/")),
    "fabric app reads status/nodes/jobs/journal through the host proxy");
  const statusLine = root.children[1];
  check(statusLine.textContent.includes("proxy-head") &&
    statusLine.textContent.includes("journal verified"),
    "fabric status line renders the proxied head identity");
  cleanup();
  globalThis.fetch = realFetch3;
}

console.log("Terminal and SKYLUM:");
{
  const calls = [];
  const memory = {
    list: () => [{ name: "a" }],
    read: async name => new TextEncoder().encode(name),
    alloc: async (...a) => calls.push(["alloc", ...a]),
    free: name => name === "a",
    write: async (...a) => calls.push(["write", ...a]),
    stage: async b => calls.push(["stage", b.length]),
    commit: async name => ({ size: name.length }),
    seal: async () => new Uint8Array([0xab, 0xcd]),
  };
  const os = {
    skylum: {
      memory,
      status: async () => ({ claims: [] }),
      save: async () => new Uint8Array([1, 2]),
      restore: async () => true,
      persist: { listVolumes: async () => ["state.skcs"], opfsSupported: () => false },
      seats: { seats: new Map(), submit: (...a) => calls.push(["submit", ...a]), tick: () => 1, run: () => ({ tick: 1 }) },
      bus: {
        send: async (bytes, id) => { calls.push(["door", id, bytes.length]); return new Uint8Array(42); },
        recv: async id => id === 7 ? new Uint8Array([0, 255, 1]) : new TextEncoder().encode("iface-json"),
        doors: new Map([
          [6, { id: 6, name: "mesh", enabled: true }],
          [9, { id: 9, name: "net-interfaces", enabled: false }],
        ]),
      },
      infer: { complete: async prompt => ({ text: prompt, seal: { fnv1a64: 1n, sha256: new Uint8Array(32) } }) },
      mesh: { peers: new Map(), offer: async id => ({ peerId: id }), answer: async id => ({ peerId: id }), acceptAnswer: async () => {}, send: async () => new Uint8Array(42), broadcast: async () => [] },
    },
    iteron: { reemit: () => "<html/>" },
    saveSession() {}, download() {},
  };
  const run = createTerminalDispatcher(os);
  check((await run("claims")).includes('"a"'), "claims command");
  check(await run("echo hello world") === "hello world", "echo command");
  check(await run("echo    preserve   interior spaces  ") === "preserve   interior spaces  ",
    "echo preserves trailing and repeated payload whitespace");
  check(await run("echo") === "", "empty echo payload is empty");
  check(await throws(() => run("alloc note -1"), "invalid_size"), "negative allocations rejected");
  check(await throws(() => run("doors send 256 hello"), "door_id_invalid"), "invalid door id rejected");
  check((await run("doors send 6 hello")).length === 84, "door command returns 42-byte receipt");
  check((await run("doors list")).includes("6 mesh enabled") &&
    (await run("doors list")).includes("9 net-interfaces disabled"),
    "doors list reports registered adapters and enabled state");
  check(await run("doors recv 9") === "iface-json", "doors recv decodes text payloads");
  check(await run("doors recv 7") === "00ff01", "doors recv falls back to hex for binary payloads");
  check(await throws(() => run("doors bogus 1"), "usage: doors list|send <id> <text>|recv <id> [maxBytes]"),
    "doors subcommand misuse fails closed");
  check((await run("infer hello")).startsWith("hello"), "inference command contract");
  check(await run("free a") === "freed a", "free routed through VSpace");
  await run("alloc note 16");
  await run("write note two words here");
  check(new TextDecoder().decode(calls.find(c => c[0] === "write")[2]) === "two words here",
    "write preserves whitespace in payload");
  await run("stage staged bytes");
  check(calls.some(c => c[0] === "stage" && c[1] === 12), "stage command dispatches payload");
  check((await run("persist")).includes('"opfs":false'), "persistence capability honestly reported");
  let unavailable = false;
  os.skylum.mesh.offer = async () => { throw new Error("WebRTC unavailable"); };
  try { await run("mesh offer peer"); } catch (e) { unavailable = e.message === "WebRTC unavailable"; }
  check(unavailable, "mesh unavailable propagates honestly");
}

console.log("Window lifecycle:");
{
  let resolveMount;
  let disposed = 0;
  const root = {
    ownerDocument: { defaultView: null },
    getBoundingClientRect: () => ({ width: 900, height: 640 }),
    children: [],
    addEventListener() {}, removeEventListener() {}, replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); },
  };
  const dock = {
    ownerDocument: { createElement: () => ({
      classList: { toggle() {} }, setAttribute() {}, addEventListener() {},
    }) },
    replaceChildren() {}, append() {},
  };
  const doc = {
    getElementById: id => id === "launcher" ? { hidden: false } :
      id === "launcher-search" ? { focus() {} } : null,
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({
      dataset: {}, style: {}, classList: { toggle() {} }, append() {},
      children: [], append(...nodes) { this.children.push(...nodes); },
      addEventListener() {}, setAttribute() {}, replaceChildren() { this.children = []; },
    }),
  };
  root.ownerDocument = { ...doc, defaultView: null, createElement: doc.createElement };
  const registry = new Map([["slow", {
    name: "Slow App", icon: "S",
    mount: () => new Promise(resolve => { resolveMount = resolve; }),
  }]]);
  let resizedBounds = { width: 900, height: 640 };
  root.getBoundingClientRect = () => resizedBounds;
  const wm = new WindowManager({ root, dock, registry, context: {} });
  wm.launch("slow");
  const generation = wm.generation("slow");
  check(wm.current("slow", generation), "mounted view generation is current");
  wm.dispatch({ type: "toggle-maximize", id: "slow" });
  resizedBounds = { width: 700, height: 500 };
  wm.resizeViewport();
  check(wm.state.windows[0].maximized && wm.state.windows[0].rect.width === 700 &&
    wm.state.windows[0].restoreRect.width <= 700,
    "viewport resize reclamps maximized and saved geometry");
  wm.close("slow");
  check(!wm.current("slow", generation), "closing a view invalidates its generation");
  resolveMount(() => { disposed++; });
  await Promise.resolve();
  await Promise.resolve();
  check(disposed === 1, "late mount cleanup is disposed instead of retained");
  wm.launch("slow");
  const destroyGeneration = wm.generation("slow");
  wm.destroy();
  check(!wm.current("slow", destroyGeneration), "destroy invalidates active app generations");
  wm.destroy();
  check(wm.destroyed && wm.views.size === 0, "window manager destroy is idempotent");
}

console.log("VSpace free/list:");
{
  const vs = new VSpace({});
  await vs.alloc("one", 8);
  check(vs.list()[0].name === "one", "list reflects claim records");
  check(vs.free("one") && !vs.get("one"), "free removes claim");
  check(!vs.free("missing"), "free missing is false");
  const first = vs.upsertMember("__desktop.json", new TextEncoder().encode("{}"), {
    kind: "manifest", media: "application/json",
  });
  const base = first.base;
  const second = vs.upsertMember("__desktop.json", new TextEncoder().encode('{"a":1}'), {
    kind: "manifest", media: "application/json",
  });
  check(second.base === base && second.size === 7 &&
    new TextDecoder().decode(second.member.data) === '{"a":1}',
    "session member updates in place without heap churn");
  check(throws(() => vs.upsertMember("__staging", new Uint8Array()), "claim_member_invalid"),
    "reserved staging member cannot be replaced");
  const fakeIteron = {
    stateBlob: new Uint8Array(),
    core: {
      skcsParse: () => ({ members: [] }),
      inflateMember: async member => member.data,
    },
    commit: async members => {
      const session = members.find(member => member.name === "__desktop.json");
      return session?.data.slice() ?? new Uint8Array();
    },
  };
  const os = new Skylum(fakeIteron, { doors: { webserial: false, download: false } });
  await os.memory.load({ members: [] });
  os.memory.upsertMember("__desktop.json", new TextEncoder().encode("{}"), {
    kind: "manifest", media: "application/json",
  });
  const savedState = await os.save();
  check(new TextDecoder().decode(savedState) === "{}",
    "SKYLUM save serializes the upserted desktop session claim");
}

console.log("Browser boot:");
{
  const root = new URL("../", import.meta.url).pathname;
  const source = readFileSync(join(root, "echo/main.js"), "utf8");
  const match = source.match(/const WASM_URL = "([^"]+)"/);
  check(match?.[1] === "/skyos/vendor/skc-wasm.wasm",
    "development boot resolves vendored wasm from the repository root");
}

console.log("Quine artifact:");
{
  const root = new URL("../", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "skyos-desktop-"));
  const artifact = join(dir, "desktop.html");
  const isolated = join(dir, "generator");
  mkdirSync(isolated);
  writeFileSync(join(isolated, "template.html"), readFileSync(join(root, "echo/template.html")));
  writeFileSync(join(isolated, "desktop.css"), readFileSync(join(root, "echo/desktop.css")));
  mkdirSync(join(isolated, "vendor"));
  writeFileSync(join(isolated, "vendor/globe.gl.min.js"),
    readFileSync(join(root, "echo/vendor/globe.gl.min.js")));
  try {
    const buildScript = `
import importlib.util, sys
from pathlib import Path
from unittest.mock import patch
module_path, state_path, out_path, isolated = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("desktop_generator", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with patch.object(module, "HERE", isolated), patch.object(module, "SKYLUM", state_path.parent):
    module.bundle_desktop_engine = lambda: "window.x=1;"
    module.make_desktop(state_path, out_path)
`;
    const built = spawnSync("python3", ["-c", buildScript, join(root, "echo/make_desktop.py"),
      join(root, "skylum/seed.skcs"), artifact, isolated], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`desktop_build_failed:${built.stderr}`);
    const html = readFileSync(artifact, "utf8");
    const slot = id => {
      const match = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
      if (!match) throw new Error(`missing_slot:${id}`);
      return match[1];
    };
    const wasmB64 = slot("iteron-wasm").trim();
    const stateB64 = slot("iteron-state").trim();
    const vendorB64 = slot("iteron-vendor").trim();
    const manifestStr = slot("iteron-manifest");
    const tmplB64 = slot("iteron-tmpl").trim();
    const engineSrc = slot("iteron-engine-src");
    const fullEngine = spawnSync("python3", ["-c",
      `import sys;sys.path.insert(0,${JSON.stringify(join(root, "echo"))});import make_desktop;print(make_desktop.bundle_desktop_engine())`],
      { encoding: "utf8" }).stdout;
    check(/window\.bootDesktopArtifact\s*=/.test(fullEngine),
      "desktop artifact bundles its boot entry point");
    check(/window\.IteronCore\s*=/.test(fullEngine) &&
      /window\.SKYLUM\s*=/.test(fullEngine),
      "desktop artifact bundles ITERON and SKYLUM globals");
    const template = Buffer.from(tmplB64, "base64").toString("utf8");
    const desktopBootSrc = html.match(/<script>\(function\(\)\{const boot=.*?<\/script>/)?.[0]
      ?.replace(/^<script>/, "").replace(/<\/script>$/, "") ?? "";
    const bytes = s => Uint8Array.from(Buffer.from(s, "base64"));
    const core = await IteronCore.create(bytes(wasmB64));
    const original = bytes(stateB64);
    const parsed = core.skcsParse(original);
    const members = [];
    for (const m of parsed.members)
      members.push({ ...m, data: await core.inflateMember(m), codec: "auto" });
    members.push({ name: "vendor/globe.gl.min.js", data: bytes(vendorB64),
      kind: "file", media: "text/javascript", codec: "auto" });
    const runtimeState = await core.skcsPack(members, parsed.flags);
    const iteron = new Iteron(core, runtimeState, JSON.parse(manifestStr), {
      wasmB64, stateB64, vendorB64, manifestStr, tmplB64, engineSrc, desktopBootSrc,
    });
    const first = iteron.reemit();
    check(first === html, "generated DESKTOP1 artifact re-emits byte-identically");
    check(iteron.reemit() === first, "consecutive re-emissions remain byte-identical");
    const state = core.skcsParse(runtimeState);
    check(state.members.some(m => m.name === "vendor/globe.gl.min.js"), "vendor payload is a sealed .skcs member at runtime");
    const vendor = state.members.find(m => m.name === "vendor/globe.gl.min.js");
    check((await core.inflateMember(vendor)).length === bytes(vendorB64).length, "vendor member inflates intact");
    check(!/<\/script/i.test(Buffer.from(vendorB64, "base64").toString("utf8")), "vendor has no executable closing-script sequence");
    check(JSON.parse(manifestStr).format === "DESKTOP1", "manifest identifies desktop quine tier");
    const guardedArtifact = join(dir, "guarded.html");
    const script = `
import importlib.util
from pathlib import Path
from unittest.mock import patch
import sys
module_path, root, state_path, out_path, isolated = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("desktop_generator", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with patch.object(module, "bundle_desktop_engine", lambda: "window.x=1;"), \\
     patch.object(module, "HERE", isolated), \\
     patch.object(module, "SKYLUM", root / "skylum"):
    vendor_path = isolated / "vendor/globe.gl.min.js"
    vendor_path.write_bytes(vendor_path.read_bytes() + b" </ScRiPt")
    module.make_desktop(state_path, out_path)
`;
    const rejected = spawnSync("python3", ["-c", script, join(root, "echo/make_desktop.py"),
      root, join(root, "skylum/seed.skcs"), guardedArtifact, isolated], {
      encoding: "utf8",
      input: undefined,
      env: process.env,
    });
    check(rejected.status !== 0 && rejected.stderr.includes("vendor contains a closing script sequence"),
      "generator rejects mixed-case executable vendor terminator");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`ECHO: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
