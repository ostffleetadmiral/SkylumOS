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
      case "about": return "SkyOS ECHO terminal — commands route through SKYLUM/ITERON services; no host shell.";
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

export function mountTerminal(root, ctx) {
  const doc = root.ownerDocument;
  const output = doc.createElement("div"); output.className = "terminal-output";
  const form = doc.createElement("form"); form.className = "terminal-form";
  const prompt = doc.createElement("span"); prompt.textContent = "skyos $";
  const input = doc.createElement("input"); input.autocomplete = "off"; input.setAttribute("aria-label", "Terminal command");
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
