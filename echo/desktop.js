import { createRegistry } from "./apps.mjs";
import { WindowManager } from "./wm.js";
import { mountTerminal } from "./term.js";
import { mountFiles } from "./apps/files.js";
import { mountMonitor } from "./apps/monitor.js";
import { mountInfer } from "./apps/infer.js";
import { mountMesh } from "./apps/mesh.js";
import { mountFabric } from "./apps/fabric.js";
import { mountGlobe } from "./apps/globe.js";
import { mountSky } from "./apps/sky.js";
import { mountGodseye, mountSpaceagent } from "./apps/embed.js";
import { mountOptical } from "./apps/optical.js";
import { mountInspector } from "./apps/inspector.js";
import { mountQuine } from "./apps/quine.js";
import { mountAbout } from "./apps/about.js";

export class Desktop {
  constructor(os, doc = document) {
    this.os = os;
    this.doc = doc;
    this.window = doc.defaultView ?? globalThis.window;
    this.destroyed = false;
    this.statusGeneration = 0;
    this.root = doc.getElementById("window-layer");
    this.dock = doc.getElementById("dock-apps");
    this.contextMenu = doc.getElementById("context-menu");
    this.registry = createRegistry({
      terminal: mountTerminal,
      files: mountFiles,
      monitor: mountMonitor,
      infer: mountInfer,
      mesh: mountMesh,
      fabric: mountFabric,
      globe: mountGlobe,
      sky: mountSky,
      godseye: mountGodseye,
      spaceagent: mountSpaceagent,
      optical: mountOptical,
      inspector: mountInspector,
      quine: mountQuine,
      about: mountAbout,
    });
    this.wm = new WindowManager({
      root: this.root,
      dock: this.dock,
      registry: this.registry,
      context: this.context(),
    });
    this.pendingFrames = new Set();
    this.onContextMenu = event => this.showContextMenu(event);
    this.onKeyDown = event => this.handleKeyDown(event);
    this.onGlobalClick = event => {
      if (!this.contextMenu.contains(event.target)) this.contextMenu.hidden = true;
      const power = this.doc.getElementById("power-menu");
      if (!power.contains(event.target) && event.target.id !== "power-button") power.hidden = true;
      const launcher = this.doc.getElementById("launcher");
      if (!launcher.contains(event.target) &&
          event.target.id !== "dock-launcher" &&
          event.target.id !== "activities-button") launcher.hidden = true;
    };
    this.doc.addEventListener("contextmenu", this.onContextMenu);
    this.doc.addEventListener("click", this.onGlobalClick);
    this.wireChrome();
    this.wm.render();
    this.updateStatus();
    this.clock = setInterval(() => this.updateStatus(), 1000);
  }

  context() {
    return {
      os: this.os,
      notify: message => this.notify(message),
      closeAbout: () => this.closeAbout(),
    };
  }

  showContextMenu(event) {
    if (!event.target.closest("#desktop-field") || event.target.closest(".window") ||
        event.target.closest("header") ||
        event.target.closest("#dock, #launcher, #power-menu, #context-menu, #app-modal")) return;
    event.preventDefault();
    this.contextMenu.hidden = false;
    const bounds = this.doc.getElementById("desktop-field").getBoundingClientRect();
    this.contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, bounds.width - 240))}px`;
    this.contextMenu.style.top = `${Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 150))}px`;
  }

  launch(id) {
    if (id === "about") {
      this.closeLauncher();
      return this.openAbout();
    }
    this.wm.launch(id);
    this.closeLauncher();
  }

  openAbout() {
    this.closeAbout();
    const modal = this.doc.getElementById("app-modal");
    const body = this.doc.getElementById("app-modal-body");
    this.doc.getElementById("app-modal-title").textContent = "About SkyOS";
    modal.hidden = false;
    const generation = this.aboutGeneration = (this.aboutGeneration ?? 0) + 1;
    try {
      const mounted = this.registry.get("about").mount(body, {
        ...this.context(),
        generation,
        isCurrent: () => !this.destroyed && !modal.hidden && this.aboutGeneration === generation,
      });
      if (typeof mounted === "function") this.aboutCleanup = mounted;
      else if (mounted?.then) {
        Promise.resolve(mounted).then(result => {
          const cleanup = typeof result === "function" ? result : result?.cleanup;
          if (typeof cleanup !== "function") return;
          if (!this.destroyed && !modal.hidden && this.aboutGeneration === generation)
            this.aboutCleanup = cleanup;
          else cleanup();
        }).catch(error => {
          if (!this.destroyed && !modal.hidden && this.aboutGeneration === generation)
            body.textContent = `About unavailable: ${error.message}`;
        });
      }
    } catch (error) {
      body.textContent = `About unavailable: ${error.message}`;
    }
  }

  closeAbout() {
    const modal = this.doc.getElementById("app-modal");
    modal.hidden = true;
    this.aboutGeneration = (this.aboutGeneration ?? 0) + 1;
    this.aboutCleanup?.();
    this.aboutCleanup = null;
    this.doc.getElementById("app-modal-body").replaceChildren();
  }

  wireChrome() {
    this.doc.getElementById("dock-launcher").addEventListener("click", () => this.toggleLauncher());
    this.doc.getElementById("activities-button").addEventListener("click", () => this.toggleLauncher());
    this.doc.getElementById("launcher-close").addEventListener("click", () => this.closeLauncher());
    this.doc.getElementById("app-modal-close").addEventListener("click", () => this.closeAbout());

    const grid = this.doc.getElementById("app-grid");
    for (const app of this.registry.values()) {
      if (app.id === "about") continue;
      const button = this.doc.createElement("button");
      button.type = "button";
      const icon = this.doc.createElement("span");
      icon.textContent = app.icon;
      const label = this.doc.createElement("b");
      label.textContent = app.name;
      button.append(icon, label);
      button.addEventListener("click", () => this.launch(app.id));
      grid.append(button);
    }

    const shortcuts = this.doc.getElementById("desktop-shortcuts");
    for (const app of this.registry.values()) {
      if (app.id === "about") continue;
      const button = this.doc.createElement("button");
      button.type = "button";
      button.textContent = `${app.icon} ${app.name}`;
      button.dataset.label = app.label ?? "Applications";
      button.addEventListener("click", () => this.launch(app.id));
      shortcuts.append(button);
    }

    this.doc.getElementById("power-button").addEventListener("click", () => {
      const menu = this.doc.getElementById("power-menu");
      menu.hidden = !menu.hidden;
    });
    this.doc.getElementById("status-line").addEventListener("click", () => this.launch("monitor"));
    this.doc.getElementById("save-opfs").addEventListener("click", async () => {
      try {
        await this.saveSession();
        this.os.iteron.stateBlob = await this.os.skylum.save("state.skcs");
        this.notify(this.os.host?.mode === "electron"
          ? "Saved state.skcs to host storage." : "Saved state.skcs to OPFS.");
      } catch (error) { this.notify(`Save failed: ${error.message}`); }
    });
    this.doc.getElementById("download-volume").addEventListener("click", async () => {
      try {
        await this.saveSession();
        const bytes = await this.os.skylum.save();
        this.os.iteron.stateBlob = bytes;
        const result = await this.os.download(bytes, "state.skcs");
        if (result?.canceled === false)
          this.notify(`Saved ${result.name} through the host file dialog.`);
      } catch (error) { this.notify(error.message); }
    });
    this.doc.getElementById("reemit-desktop").addEventListener("click", async () => {
      try {
        await this.saveState();
        if (this.os.host?.mode === "electron") {
          const bytes = await this.os.skylum.save();
          this.os.iteron.stateBlob = bytes;
          const result = await this.os.download(bytes, "state.skcs");
          if (!result?.canceled)
            this.notify("HTML quine re-emission uses the browser edition; exported state.skcs.");
        } else this.os.download(this.os.iteron.reemit(), "desktop.html", "text/html");
      } catch (error) { this.notify(error.message); }
    });
    this.doc.getElementById("reemit-iteron").addEventListener("click", () => {
      this.doc.getElementById("power-menu").hidden = true;
      try {
        if (this.os.host?.mode === "electron") this.notify("ITERON HTML re-emission is available from the browser quine edition.");
        else this.os.download(this.os.iteron.reemit(), "iteron.html", "text/html");
      }
      catch (error) { this.notify(error.message); }
    });
    this.doc.getElementById("reemit-skylum").addEventListener("click", async () => {
      this.doc.getElementById("power-menu").hidden = true;
      try {
        await this.saveState();
        await this.reemitLayer("skylum");
      } catch (error) { this.notify(error.message); }
    });
    this.doc.getElementById("about-system").addEventListener("click", () => {
      this.doc.getElementById("power-menu").hidden = true;
      this.launch("about");
    });
    for (const [id, action] of [
      ["context-terminal", () => this.launch("terminal")],
      ["context-inspector", () => this.launch("inspector")],
      ["context-save", async () => { await this.saveState(); this.notify("State saved."); }],
    ]) this.doc.getElementById(id).addEventListener("click", () => {
      this.contextMenu.hidden = true;
      Promise.resolve().then(action).catch(error => this.notify(`Action failed: ${error.message}`));
    });
    this.doc.getElementById("launcher-search").addEventListener("input", event => {
      const query = event.target.value.toLowerCase();
      for (const button of grid.children)
        button.hidden = !button.textContent.toLowerCase().includes(query);
    });
  }

  toggleLauncher() {
    this.wm.toggleLauncher();
  }

  closeLauncher() { this.wm.closeLauncher(); }

  handleKeyDown(event) {
    if (event.key === "Escape") {
      this.closeLauncher();
      this.closeAbout();
      this.doc.getElementById("power-menu").hidden = true;
      this.contextMenu.hidden = true;
    }
  }

  async reemitLayer(kind) {
    this.doc.getElementById("power-menu").hidden = true;
    if (kind === "iteron") {
      this.os.download(this.os.iteron.reemit(), "iteron.html", "text/html");
      return;
    }
    if (kind !== "skylum") throw new Error("layer_unknown");

    const frame = this.doc.createElement("iframe");
    let finished = false;
    let poll = null;
    let timeout = null;
    const cleanup = () => {
      if (finished) return false;
      finished = true;
      if (poll !== null) clearInterval(poll);
      if (timeout !== null) clearTimeout(timeout);
      this.pendingFrames.delete(cleanup);
      frame.remove();
      return true;
    };
    this.pendingFrames.add(cleanup);
    const deadline = Date.now() + 10000;
    const tryReemit = () => {
      try {
        const html = frame.contentWindow?.ITERON?.reemit?.();
        if (!html || !cleanup()) return false;
        this.os.download(html, "skylum.html", "text/html");
        return true;
      } catch (error) {
        if (cleanup()) this.notify(`SKYLUM re-emit failed: ${error.message}`);
        return true;
      }
    };
    poll = setInterval(() => {
      if (tryReemit()) return;
      if (Date.now() >= deadline && cleanup())
        this.notify("SKYLUM re-emitter did not become available.");
    }, 100);
    timeout = setTimeout(() => {
      if (cleanup()) this.notify("SKYLUM artifact did not become ready.");
    }, 10000);
    frame.onerror = () => {
      if (cleanup()) this.notify("SKYLUM artifact could not be loaded.");
    };
    frame.hidden = true;
    frame.src = "../skylum/skylum.html";
    this.doc.body.append(frame);
  }

  notify(message) {
    const toast = this.doc.getElementById("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  async saveSession() {
    const session = { version: 1, windows: this.wm.snapshot() };
    const data = new TextEncoder().encode(JSON.stringify(session));
    this.os.skylum.memory.upsertMember("__desktop.json", data, {
      kind: "manifest", media: "application/json",
    });
    return session;
  }

  async saveState() {
    await this.saveSession();
    this.os.iteron.stateBlob = await this.os.skylum.save();
    return this.os.iteron.stateBlob;
  }

  async updateStatus() {
    const generation = ++this.statusGeneration;
    const clock = this.doc.getElementById("clock");
    if (!this.destroyed) clock.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    try {
      const status = await this.os.skylum.status();
      if (this.destroyed || generation !== this.statusGeneration) return;
      this.doc.getElementById("boot-status").textContent =
        `${status.host?.runtime === "electron" ? "ELECTRON HOST" : "ECHO LIVE"} · ${status.claims.length} claims`;
      this.doc.getElementById("status-line").textContent =
        `${status.host?.runtime ? `HOST ${status.host.runtime.toUpperCase()} · ` : ""}` +
        `CLAIMS ${status.claims.length} · PEERS ${status.mesh.peers} · ` +
        `DOORS ${status.doors.filter(door => door.enabled).length}/${status.doors.length} · ` +
        `${status.persist.host ? "HOST FS ON" : `OPFS ${status.persist.opfs ? "ON" : "OFF"}`} · ` +
        `INFER ${status.infer.available ? "ON" : "OFF"}`;
    } catch {
      // Status can be unavailable while the underlying services are booting.
    }
  }

  async bootSession() {
    const saved = this.os.skylum.memory.get("__desktop.json");
    if (!saved) return false;
    this.restoreSession(saved.member.data);
    return true;
  }

  restoreSession(data) {
    try { this.wm.restore(JSON.parse(new TextDecoder().decode(data))); }
    catch (error) { this.notify(`Session ignored: ${error.message}`); }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.statusGeneration++;
    clearInterval(this.clock);
    clearTimeout(this.toastTimer);
    for (const cleanup of [...this.pendingFrames]) cleanup();
    this.wm.destroy();
    this.doc.removeEventListener("contextmenu", this.onContextMenu);
    this.doc.removeEventListener("click", this.onGlobalClick);
    this.closeAbout();
  }
}

if (typeof window !== "undefined") window.Desktop = Desktop;
