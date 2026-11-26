// Pure window-state reducer and DOM-backed manager for ECHO applications.
const MAX_WINDOWS = 8;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 180;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 4096;

export function clampWindowRect(rect, bounds) {
  if (!rect || !["x", "y", "width", "height"].every(key => Number.isFinite(rect[key])))
    throw new Error("window_rect_invalid");
  if (!bounds || !Number.isSafeInteger(bounds.width) || !Number.isSafeInteger(bounds.height) ||
      bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT)
    throw new Error("window_bounds_invalid");
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.min(Math.round(rect.width), bounds.width)));
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.min(Math.round(rect.height), bounds.height)));
  return {
    x: Math.min(Math.max(0, bounds.width - width), Math.max(0, Math.round(rect.x))),
    y: Math.min(Math.max(0, bounds.height - height), Math.max(0, Math.round(rect.y))),
    width,
    height,
  };
}

const ordered = windows => [...windows].sort((a, b) => a.z - b.z);
const clone = window => ({
  ...window,
  rect: { ...window.rect },
  restoreRect: window.restoreRect ? { ...window.restoreRect } : null,
});

export function createWindowState() {
  return { windows: [], nextZ: 1, focusedId: null };
}

export function transitionWindowState(state, action, bounds) {
  if (!state || !Array.isArray(state.windows) || !action || typeof action.type !== "string")
    throw new Error("window_state_invalid");
  if (!bounds || !Number.isSafeInteger(bounds.width) || !Number.isSafeInteger(bounds.height) ||
      bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) throw new Error("window_bounds_invalid");

  const windows = state.windows.map(clone);
  const index = windows.findIndex(window => window.id === action.id);
  const nextZ = Math.max(1, state.nextZ);
  if (action.type === "open") {
    if (typeof action.id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(action.id))
      throw new Error("window_id_invalid");
    if (index !== -1) throw new Error("window_id_conflict");
    if (windows.length >= MAX_WINDOWS) throw new Error("window_limit");
    const rect = clampWindowRect(action.rect ?? {
      x: 24 + windows.length * 24, y: 24 + windows.length * 20, width: 640, height: 440,
    }, bounds);
    windows.push({ id: action.id, rect, restoreRect: null, maximized: false, minimized: false, z: nextZ });
    return { windows, nextZ: nextZ + 1, focusedId: action.id };
  }
  if (index < 0) throw new Error("window_not_found");

  const window = windows[index];
  if (action.type === "focus" || action.type === "restore") {
    window.minimized = false;
    window.z = nextZ;
    return { windows, nextZ: nextZ + 1, focusedId: window.id };
  }
  if (action.type === "minimize") {
    window.minimized = true;
    const focusedId = ordered(windows.filter(item => !item.minimized && item.id !== window.id)).at(-1)?.id ?? null;
    return { windows, nextZ: state.nextZ, focusedId: state.focusedId === window.id ? focusedId : state.focusedId };
  }
  if (action.type === "toggle-maximize") {
    if (window.maximized) {
      window.rect = clampWindowRect(window.restoreRect ?? window.rect, bounds);
      window.restoreRect = null;
      window.maximized = false;
    } else {
      window.restoreRect = clampWindowRect(window.rect, bounds);
      window.rect = { x: 0, y: 0, width: bounds.width, height: bounds.height };
      window.maximized = true;
    }
    window.z = nextZ;
    return { windows, nextZ: nextZ + 1, focusedId: window.id };
  }
  if (action.type === "restore-geometry") {
    window.rect = clampWindowRect(action.rect, bounds);
    window.restoreRect = null;
    window.maximized = false;
    return { windows, nextZ: state.nextZ, focusedId: state.focusedId };
  }
  if (action.type === "move" || action.type === "resize") {
    window.rect = clampWindowRect(action.rect, bounds);
    window.maximized = false;
    window.restoreRect = null;
    window.minimized = false;
    window.z = nextZ;
    return { windows, nextZ: nextZ + 1, focusedId: window.id };
  }
  if (action.type === "close") {
    windows.splice(index, 1);
    const focusedId = state.focusedId === window.id
      ? ordered(windows.filter(item => !item.minimized)).at(-1)?.id ?? null : state.focusedId;
    return { windows, nextZ: state.nextZ, focusedId };
  }
  throw new Error("window_action_invalid");
}

export function windowStateSnapshot(state) {
  return {
    focusedId: state.focusedId,
    windows: ordered(state.windows).map(window => ({
      id: window.id, minimized: window.minimized, maximized: window.maximized,
      rect: { ...window.rect },
      restoreRect: window.restoreRect ? { ...window.restoreRect } : null,
      z: window.z,
    })),
  };
}

export function restoreWindowState(snapshot, bounds) {
  let state = createWindowState();
  for (const saved of (Array.isArray(snapshot?.windows) ? snapshot.windows : []).slice(0, MAX_WINDOWS)) {
    state = transitionWindowState(state, { type: "open", id: saved.id, rect: saved.rect }, bounds);
    if (saved.maximized) {
      const current = state.windows.find(window => window.id === saved.id);
      current.restoreRect = clampWindowRect(saved.restoreRect ?? saved.rect, bounds);
      current.rect = { x: 0, y: 0, width: bounds.width, height: bounds.height };
      current.maximized = true;
    }
    if (saved.minimized) state = transitionWindowState(state, { type: "minimize", id: saved.id }, bounds);
  }
  if (snapshot?.focusedId && state.windows.some(window => window.id === snapshot.focusedId))
    state = transitionWindowState(state, { type: "focus", id: snapshot.focusedId }, bounds);
  return state;
}

export class WindowManager {
  constructor({ root, dock, registry, context }) {
    this.root = root;
    this.dock = dock;
    this.registry = registry;
    this.context = context;
    this.state = createWindowState();
    this.views = new Map();
    this.generations = new Map();
    this.destroyed = false;
    this.window = root.ownerDocument.defaultView ?? globalThis.window;
    this.bounds = this.measure();
    this.drag = null;
    this.onKeyDown = event => {
      if (event.key === "Escape") this.closeLauncher();
      if (event.altKey && event.key.toLowerCase() === "f") this.toggleLauncher();
    };
    this.onPointerMove = event => this.onMove(event);
    this.onPointerEnd = event => this.onEnd(event);
    this.onViewportResize = () => this.resizeViewport();
    root.addEventListener("pointermove", this.onPointerMove);
    root.addEventListener("pointerup", this.onPointerEnd);
    root.addEventListener("pointercancel", this.onPointerEnd);
    this.window?.addEventListener("resize", this.onViewportResize);
    root.ownerDocument.addEventListener("keydown", this.onKeyDown);
  }

  measure() {
    const rect = this.root.getBoundingClientRect();
    return {
      width: Math.max(320, Math.floor(rect.width || this.window?.innerWidth || 320)),
      height: Math.max(240, Math.floor(rect.height || this.window?.innerHeight || 240)),
    };
  }

  dispatch(action) {
    this.state = transitionWindowState(this.state, action, this.bounds);
    this.render();
  }

  launch(id) {
    if (!this.registry.has(id)) throw new Error("app_not_found");
    if (this.state.windows.some(window => window.id === id))
      return this.dispatch({ type: "restore", id });
    this.dispatch({ type: "open", id });
  }

  toggleLauncher() {
    const launcher = this.root.ownerDocument.getElementById("launcher");
    launcher.hidden = !launcher.hidden;
    if (!launcher.hidden) this.root.ownerDocument.getElementById("launcher-search").focus();
  }

  closeLauncher() {
    this.root.ownerDocument.getElementById("launcher").hidden = true;
  }

  generation(id) { return this.generations.get(id) ?? 0; }

  current(id, generation) {
    return !this.destroyed && this.generation(id) === generation && this.views.has(id);
  }

  disposeView(id) {
    const view = this.views.get(id);
    this.views.delete(id);
    this.generations.set(id, this.generation(id) + 1);
    try { view?.cleanup?.(); }
    catch (error) { this.context.notify?.(`App cleanup failed: ${error.message}`); }
  }

  close(id) {
    if (!this.state.windows.some(window => window.id === id)) return;
    this.disposeView(id);
    this.dispatch({ type: "close", id });
  }

  resizeViewport() {
    this.bounds = this.measure();
    const snapshot = windowStateSnapshot(this.state);
    this.state = createWindowState();
    for (const saved of snapshot.windows) {
      this.state = transitionWindowState(this.state, { type: "open", id: saved.id, rect: saved.rect }, this.bounds);
      const current = this.state.windows.find(window => window.id === saved.id);
      const restoreRect = saved.restoreRect ?? saved.rect;
      current.rect = saved.maximized
        ? { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height }
        : clampWindowRect(saved.rect, this.bounds);
      current.restoreRect = saved.maximized ? clampWindowRect(restoreRect, this.bounds) : null;
      current.maximized = Boolean(saved.maximized);
      current.minimized = Boolean(saved.minimized);
    }
    this.state.focusedId = snapshot.focusedId && this.state.windows.some(window => window.id === snapshot.focusedId)
      ? snapshot.focusedId : null;
    this.render();
  }

  render() {
    const live = new Set(this.state.windows.map(window => window.id));
    for (const id of this.views.keys()) if (!live.has(id)) this.disposeView(id);
    this.root.replaceChildren();
    for (const item of ordered(this.state.windows)) {
      const app = this.registry.get(item.id);
      if (!app) continue;
      const doc = this.root.ownerDocument;
      const node = doc.createElement("section");
      node.className = `window${this.state.focusedId === item.id ? " focused" : ""}`;
      node.dataset.id = item.id;
      node.hidden = item.minimized;
      Object.assign(node.style, {
        left: `${item.rect.x}px`, top: `${item.rect.y}px`,
        width: `${item.rect.width}px`, height: `${item.rect.height}px`, zIndex: item.z,
      });
      const titlebar = doc.createElement("header");
      titlebar.className = "window-titlebar";
      const title = doc.createElement("strong");
      title.textContent = app.name;
      titlebar.append(title);
      const controls = doc.createElement("span");
      for (const [label, text, action] of [
        ["Minimize", "−", () => this.dispatch({ type: "minimize", id: item.id })],
        [item.maximized ? "Restore" : "Maximize", "□", () => this.dispatch({ type: "toggle-maximize", id: item.id })],
        ["Close", "×", () => this.close(item.id)],
      ]) {
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", action);
        controls.append(button);
      }
      titlebar.append(controls);
      titlebar.addEventListener("pointerdown", event => this.startDrag(event, item.id, node));
      node.addEventListener("pointerdown", () => {
        if (this.state.focusedId !== item.id) this.dispatch({ type: "focus", id: item.id });
      });
      const body = doc.createElement("div");
      body.className = "window-body";
      let view = this.views.get(item.id);
      if (!view) {
        view = { node: doc.createElement("div"), cleanup: null };
        view.node.className = "app-view";
        this.views.set(item.id, view);
        const generation = this.generation(item.id);
        try {
          const mounted = app.mount(view.node, {
            ...this.context,
            wm: this,
            appId: item.id,
            generation,
            isCurrent: () => this.current(item.id, generation),
          });
          if (typeof mounted === "function") view.cleanup = mounted;
          else if (mounted && typeof mounted.then === "function") {
            Promise.resolve(mounted).then(result => {
              const disposer = typeof result === "function" ? result : result?.cleanup;
              if (typeof disposer !== "function") return;
              if (this.current(item.id, generation)) view.cleanup = disposer;
              else disposer();
            }).catch(error => {
              if (this.current(item.id, generation))
                view.node.textContent = `App failed: ${error.message}`;
            });
          }
        } catch (error) {
          view.node.textContent = `App failed: ${error.message}`;
        }
      }
      body.append(view.node);
      const resize = doc.createElement("button");
      resize.className = "resize-handle";
      resize.type = "button";
      resize.setAttribute("aria-label", `Resize ${app.name}`);
      resize.addEventListener("pointerdown", event => this.startResize(event, item.id, node));
      node.append(titlebar, body, resize);
      this.root.append(node);
    }
    this.renderDock();
  }

  renderDock() {
    this.dock.replaceChildren();
    for (const app of this.registry.values()) {
      const button = this.dock.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = app.icon;
      button.title = app.name;
      button.setAttribute("aria-label", `Open ${app.name}`);
      button.classList.toggle("running", this.state.windows.some(window => window.id === app.id));
      button.addEventListener("click", () => this.launch(app.id));
      this.dock.append(button);
    }
  }

  startDrag(event, id, node) {
    if (event.target.closest("button") || this.state.windows.find(window => window.id === id)?.maximized) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    this.drag = { id, mode: "move", pointerId: event.pointerId,
      x: event.clientX - rect.left, y: event.clientY - rect.top };
    node.setPointerCapture?.(event.pointerId);
  }

  startResize(event, id, node) {
    event.preventDefault();
    event.stopPropagation();
    const rect = node.getBoundingClientRect();
    const current = this.state.windows.find(window => window.id === id);
    if (!current || current.maximized) return;
    this.drag = { id, mode: "resize", pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      rect: { x: current.rect.x, y: current.rect.y, width: rect.width, height: rect.height } };
    node.setPointerCapture?.(event.pointerId);
  }

  onMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rootRect = this.root.getBoundingClientRect();
    const current = this.state.windows.find(window => window.id === drag.id);
    if (!current) return;
    if (drag.mode === "move") {
      this.dispatch({ type: "move", id: drag.id, rect: {
        ...current.rect,
        x: event.clientX - rootRect.left - drag.x,
        y: event.clientY - rootRect.top - drag.y,
      } });
    } else {
      this.dispatch({ type: "resize", id: drag.id, rect: {
        ...drag.rect,
        width: drag.rect.width + event.clientX - drag.x,
        height: drag.rect.height + event.clientY - drag.y,
      } });
    }
  }

  onEnd(event) {
    if (this.drag?.pointerId === event.pointerId) this.drag = null;
  }

  snapshot() { return windowStateSnapshot(this.state); }

  restore(snapshot) {
    for (const id of [...this.views.keys()]) this.disposeView(id);
    this.state = restoreWindowState(snapshot, this.bounds);
    this.render();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerEnd);
    this.root.removeEventListener("pointercancel", this.onPointerEnd);
    this.window?.removeEventListener("resize", this.onViewportResize);
    this.root.ownerDocument.removeEventListener("keydown", this.onKeyDown);
    for (const id of [...this.views.keys()]) this.disposeView(id);
    this.root.replaceChildren();
    this.dock.replaceChildren();
    this.state = createWindowState();
  }
}
