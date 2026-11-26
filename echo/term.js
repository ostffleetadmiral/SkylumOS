const encode = s => new TextEncoder().encode(s);
const decode = b => new TextDecoder().decode(b);
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export function createTerminalDispatcher(os) {
  return async function dispatch(line) {
    const source = String(line);
    const leading = source.match(/^\s*/)?.[0].length ?? 0;
    const command = source.slice(leading).match(/^\S+/)?.[0] ?? "";
    const argsText = source.slice(leading + command.length).trim();
    const args = argsText ? argsText.split(/\s+/) : [];
    const rawPayload = source.slice(leading + command.length).replace(/^\s+/, "");
    const rest = rawPayload.trimEnd();
    switch (command.toLowerCase()) {
      case "": return "";
      case "help": return "help about status claims cat alloc free stage commit seal save load volumes seats doors infer mesh persist reemit echo clear\n  doors list|send <id> <text>|recv <id> [maxBytes]";
      case "about": return "SkyOS console — commands route through SKYLUM/ITERON services. For a POSIX shell use the Shell view (host PTY) or `cli.js --mode shell`.";
      case "status": return JSON.stringify(await os.skylum.status(), (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
      case "claims": return JSON.stringify(os.skylum.memory.list(), null, 2);
      case "cat": {
        if (!args[0]) throw new Error("usage: cat <claim>");
        const bytes = await os.skylum.memory.read(args[0]);
        return decode(bytes.slice(0, 16384));
      }
      case "alloc": {
        if (!args[0]) throw new Error("usage: alloc <claim> <size>");
        const size = Number(args[1]);
        if (!Number.isSafeInteger(size) || size < 0 || size > (1 << 20)) throw new Error("invalid_size");
        await os.skylum.memory.alloc(args[0], size);
        return `allocated ${args[0]} ${size}B`;
      }
      case "free": {
        if (!args[0]) throw new Error("usage: free <claim>");
        return os.skylum.memory.free(args[0]) ? `freed ${args[0]}` : `no claim ${args[0]}`;
      }
      case "write": {
        const name = args[0], content = name ? rest.slice(name.length).trimStart() : "";
        if (!name) throw new Error("usage: write <claim> <text>");
        await os.skylum.memory.write(name, encode(content));
        return `wrote ${encode(content).length}B to ${name}`;
      }
      case "stage": {
        const data = encode(rest);
        await os.skylum.memory.stage(data);
        return `staged ${data.length}B`;
      }
      case "commit": {
        if (!args[0]) throw new Error("usage: commit <claim>");
        const c = await os.skylum.memory.commit(args[0]);
        return `committed ${args[0]} ${c.size}B`;
      }
      case "seal": {
        if (!args[0]) throw new Error("usage: seal <claim>");
        return hex(await os.skylum.memory.seal(args[0]));
      }
      case "save": {
        const blob = await os.skylum.save(args[0] || null);
        return `saved ${blob.length}B`;
      }
      case "load": return await os.skylum.restore(args[0] || "state.skcs") ? "restored" : "volume not found";
      case "volumes": return (await os.skylum.persist.listVolumes()).join("\n");
      case "seats": return JSON.stringify([...os.skylum.seats.seats.values()].map(s => ({
        id: s.id, steps: s.steps, fuel: s.fuel, done: s.done,
      })), null, 2);
      case "seat": {
        if (args[0] !== "submit") throw new Error("usage: seat submit <id> <steps>");
        const id = args[1], steps = Number(args[2]);
        if (!id || !Number.isSafeInteger(steps) || steps < 0 || steps > 100000) throw new Error("invalid_seat");
        os.skylum.seats.submit(id, function* () { for (let i = 0; i < steps; i++) yield i; }, steps + 1);
        return `submitted ${id} (${steps} steps)`;
      }
      case "tick": return `ran ${os.skylum.seats.tick()} seat(s)`;
      case "run": {
        const ticks = args[0] === undefined ? 1000 : Number(args[0]);
        if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 100000)
          throw new Error("invalid_ticks");
        return JSON.stringify(os.skylum.seats.run(ticks));
      }
      case "doors": {
        if (args[0] === "list")
          return [...os.skylum.bus.doors.values()]
            .map(d => `${d.id} ${d.name} ${d.enabled ? "enabled" : "disabled"}`).join("\n");
        if (args[0] !== "send" && args[0] !== "recv")
          throw new Error("usage: doors list|send <id> <text>|recv <id> [maxBytes]");
        const id = Number(args[1]);
        if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("door_id_invalid");
        if (args[0] === "send") {
          if (!args[2]) throw new Error("usage: doors send <id> <text>");
          return hex(await os.skylum.bus.send(encode(args.slice(2).join(" ")), id));
        }
        const bytes = await os.skylum.bus.recv(id, args[2] ? Number(args[2]) : 1 << 20);
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return hex(bytes); }
      }
      case "infer": {
        if (!rest.trim()) throw new Error("usage: infer <prompt>");
        const result = await os.skylum.infer.complete(rest);
        return `${result.text}\nseal ${result.seal.fnv1a64.toString(16)} ${hex(result.seal.sha256)}`;
      }
      case "mesh": {
        const [sub, ...tail] = args;
        if (sub === "peers") return [...os.skylum.mesh.peers.keys()].join("\n") || "no peers";
        if (sub === "send") {
          if (!tail[0] || !tail.slice(1).length) throw new Error("usage: mesh send <peer> <text>");
          return hex(await os.skylum.mesh.send(tail[0], encode(tail.slice(1).join(" "))));
        }
        if (sub === "bcast") return JSON.stringify(await os.skylum.mesh.broadcast(encode(tail.join(" "))));
        if (sub === "offer") {
          if (!tail[0]) throw new Error("usage: mesh offer <peer>");
          return JSON.stringify(await os.skylum.mesh.offer(tail[0]));
        }
        if (sub === "answer") {
          if (!tail[0] || !tail.slice(1).length) throw new Error("usage: mesh answer <peer> <offer>");
          return JSON.stringify(await os.skylum.mesh.answer(tail[0], tail.slice(1).join(" ")));
        }
        if (sub === "accept") {
          if (!tail[0] || !tail.slice(1).length) throw new Error("usage: mesh accept <peer> <answer>");
          return await os.skylum.mesh.acceptAnswer(tail[0], tail.slice(1).join(" ")) ?? "accepted";
        }
        throw new Error("usage: mesh offer|answer|accept|send|bcast|peers");
      }
      case "persist": return JSON.stringify({ opfs: os.skylum.persist.opfsSupported() });
      case "reemit": {
        await os.saveSession();
        os.iteron.stateBlob = await os.skylum.save();
        const html = os.iteron.reemit();
        if (args[0] === "download") os.download(html, "desktop.html", "text/html");
        return `${html.length} chars`;
      }
      case "echo": return rawPayload;
      case "clear": return "\x1b[clear]";
      default: throw new Error(`command_not_found: ${cmd}`);
    }
  };
}

// Real interactive shell: xterm.js frontend bound to a host-owned tmux PTY
// (host/shell-node.mjs). The vendored engine loads lazily; when the host
// cannot provide a PTY the app falls back to the SkyOS console honestly.
const XTERM_DIR = "vendor/xterm/";
let xtermLoad = null;

function loadScript(doc, src) {
  return new Promise((resolve, reject) => {
    const s = doc.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error(`xterm_load_failed:${src}`));
    doc.head.append(s);
  });
}

function ensureXterm(doc, base) {
  xtermLoad ??= (async () => {
    if (!globalThis.Terminal || !globalThis.FitAddon) {
      await loadScript(doc, base + "xterm.js");
      await loadScript(doc, base + "addon-fit.js");
    }
    if (typeof globalThis.Terminal !== "function" ||
        typeof globalThis.FitAddon !== "function")
      throw new Error("xterm_load_failed");
    if (!doc.getElementById("skyos-xterm-css")) {
      const css = await (await fetch(base + "xterm.css")).text();
      const style = doc.createElement("style");
      style.id = "skyos-xterm-css"; style.textContent = css;
      doc.head.append(style);
    }
    return { Terminal: globalThis.Terminal, FitAddon: globalThis.FitAddon };
  })().catch(e => { xtermLoad = null; throw e; });
  return xtermLoad;
}

function b64ToString(b64) {
  const bin = atob(b64);
  let out = "";
  for (let i = 0; i < bin.length; i += 8192)
    out += String.fromCharCode(...bin.slice(i, i + 8192).split("").map(c => c.charCodeAt(0)));
  return out;
}

const SHELL_METHODS = ["termSpawn", "termWrite", "termRead", "termResize", "termKill"];

function hostCanShell(host) {
  return !!host && SHELL_METHODS.every(m => typeof host[m] === "function");
}

function mountConsole(root, ctx) {
  const doc = root.ownerDocument;
  const output = doc.createElement("div"); output.className = "terminal-output";
  const form = doc.createElement("form"); form.className = "terminal-form";
  const prompt = doc.createElement("span"); prompt.textContent = "skyos $";
  const input = doc.createElement("input"); input.autocomplete = "off"; input.setAttribute("aria-label", "SkyOS console command");
  form.append(prompt, input); root.append(output, form);
  const run = createTerminalDispatcher(ctx.os);
  const history = []; let cursor = 0; let generation = 0;
  const append = (text, cls = "") => {
    const row = doc.createElement("pre"); row.className = cls; row.textContent = text;
    output.append(row); output.scrollTop = output.scrollHeight;
  };
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const line = input.value; if (!line.trim()) return;
    input.value = ""; history.push(line); cursor = history.length;
    append(`skyos $ ${line}`, "command");
    const own = ++generation;
    try {
      const result = await run(line);
      if (!ctx.isCurrent() || own !== generation) return;
      if (result === "\x1b[clear]") output.replaceChildren();
      else if (result) append(String(result));
    } catch (error) {
      if (ctx.isCurrent() && own === generation) append(error.message, "error");
    }
  });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); input.value = history[cursor] ?? ""; }
    if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(history.length, cursor + 1); input.value = history[cursor] ?? ""; }
  });
  input.focus();
  return () => { generation++; };
}

async function mountShellPane(pane, ctx, host) {
  const doc = pane.ownerDocument;
  const status = doc.createElement("div");
  status.className = "term-status"; status.textContent = "loading terminal engine…";
  pane.append(status);
  const base = host.mode === "electron" ? "../vendor/xterm/" : "vendor/xterm/";
  const { Terminal, FitAddon } = await ensureXterm(doc, base);
  status.remove();
  const holder = doc.createElement("div");
  holder.className = "term-xterm";
  pane.append(holder);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    theme: { background: "#0d1117", foreground: "#e6edf3",
      cursor: "#58a6ff", selectionBackground: "#264f78" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(holder);
  fit.fit();
  const spawned = await host.termSpawn({ cols: term.cols, rows: term.rows });
  const id = spawned.id;
  let dead = false, reading = false, disposed = false;
  term.onData(data => { if (!dead) host.termWrite({ id, data }).catch(() => {}); });
  const pushSize = () => {
    if (!dead) host.termResize({ id, cols: term.cols, rows: term.rows }).catch(() => {});
  };
  const ro = new ResizeObserver(() => {
    if (disposed || dead || !holder.clientWidth) return;
    try { fit.fit(); pushSize(); } catch {}
  });
  ro.observe(holder);
  const poll = setInterval(async () => {
    if (reading || dead || disposed) return;
    reading = true;
    try {
      const r = await host.termRead({ id, maxBytes: 256 * 1024 });
      if (disposed) return;
      if (r.data) term.write(b64ToString(r.data));
      if (!r.alive) {
        dead = true;
        term.write("\r\n\x1b[90m[shell exited — close and reopen Terminal to start a new session]\x1b[0m\r\n");
      }
    } catch { /* transient read error — next tick retries */ }
    finally { reading = false; }
  }, 60);
  const note = doc.createElement("div");
  note.className = "term-status";
  note.textContent = `host shell · ${host.mode ?? "node"} · ${id}`;
  pane.append(note);
  return () => {
    disposed = true;
    clearInterval(poll);
    ro.disconnect();
    term.dispose();
    if (!dead) host.termKill({ id }).catch(() => {});
  };
}

export function mountTerminal(root, ctx) {
  const doc = root.ownerDocument;
  const host = ctx?.os?.host;
  if (!hostCanShell(host)) return mountConsole(root, ctx);

  const wrap = doc.createElement("div"); wrap.className = "term-shell-wrap";
  const bar = doc.createElement("div"); bar.className = "term-shell-bar";
  const makeBtn = label => {
    const b = doc.createElement("button");
    b.type = "button"; b.className = "term-mode"; b.textContent = label;
    return b;
  };
  const shellBtn = makeBtn("Shell");
  const consoleBtn = makeBtn("SkyOS");
  bar.append(shellBtn, consoleBtn);
  const shellPane = doc.createElement("div"); shellPane.className = "term-pane";
  const consolePane = doc.createElement("div"); consolePane.className = "term-pane";
  consolePane.hidden = true;
  wrap.append(bar, shellPane, consolePane);
  root.append(wrap);

  let cleanups = [];
  let shellCleanup = null, consoleCleanup = null, shellReady = null, mode = "shell";
  const setMode = next => {
    if (mode === next || !ctx.isCurrent()) return;
    mode = next;
    shellBtn.classList.toggle("active", mode === "shell");
    consoleBtn.classList.toggle("active", mode === "console");
    shellPane.hidden = mode !== "shell";
    consolePane.hidden = mode !== "console";
    if (mode === "console" && !consoleCleanup)
      consoleCleanup = mountConsole(consolePane, ctx);
    if (mode === "shell") {
      shellReady ??= mountShellPane(shellPane, ctx, host)
        .then(c => { shellCleanup = c; }).catch(e => {
          const d = doc.createElement("div");
          d.className = "term-status error";
          d.textContent = `host shell unavailable: ${e.message}`;
          shellPane.append(d);
        });
    }
  };
  shellBtn.addEventListener("click", () => setMode("shell"));
  consoleBtn.addEventListener("click", () => setMode("console"));
  setMode("shell");
  return () => {
    for (const c of cleanups.splice(0)) c();
    shellCleanup?.(); consoleCleanup?.();
    shellReady = null;
  };
}
