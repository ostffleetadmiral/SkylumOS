export function mountFiles(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const render = async () => {
    ++generation;
    const claims = ctx.os.skylum.memory.list();
    root.replaceChildren();
    const toolbar = doc.createElement("div"); toolbar.className = "toolbar";
    const importInput = doc.createElement("input"); importInput.type = "file"; importInput.multiple = true;
    importInput.setAttribute("aria-label", "Import claim files");
    const save = doc.createElement("button"); save.textContent = "Save .skcs";
    save.onclick = async () => {
      const own = ++generation;
      try {
        const bytes = await ctx.os.skylum.save();
        if (!ctx.isCurrent() || own !== generation) return;
        ctx.os.download(bytes, "state.skcs");
      } catch (e) {
        if (ctx.isCurrent() && own === generation) ctx.notify(e.message);
      }
    };
    const reload = doc.createElement("button"); reload.textContent = "Refresh"; reload.onclick = render;
    toolbar.append(importInput, save, reload); root.append(toolbar);
    const table = doc.createElement("div"); table.className = "claim-list"; root.append(table);
    importInput.onchange = async () => {
      const operation = ++generation;
      const files = [...importInput.files];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!ctx.isCurrent() || operation !== generation) return;
        if (bytes.length > 1 << 20) { ctx.notify(`${f.name}: exceeds 1 MiB staging capacity`); continue; }
        try {
          await ctx.os.skylum.memory.stage(bytes);
          if (!ctx.isCurrent() || operation !== generation) return;
          await ctx.os.skylum.memory.commit(f.name, { media: f.type });
          if (!ctx.isCurrent() || operation !== generation) return;
        } catch (error) {
          if (ctx.isCurrent() && operation === generation) ctx.notify(`${f.name}: ${error.message}`);
        }
      }
      if (ctx.isCurrent()) render();
    };
    for (const c of claims) {
      const row = doc.createElement("article"); row.className = "claim-row";
      const info = doc.createElement("div");
      const title = doc.createElement("strong"); title.textContent = c.name;
      const meta = doc.createElement("small"); meta.textContent = `${c.kind} · ${c.size}B · ${c.perms}`;
      info.append(title, meta);
      const actions = doc.createElement("div");
      const view = doc.createElement("button"); view.textContent = "Inspect";
      view.onclick = async () => {
        const op = ++generation;
        try {
          const bytes = await ctx.os.skylum.memory.read(c.name);
          if (!ctx.isCurrent() || op !== generation) return;
          const seal = await ctx.os.skylum.memory.seal(c.name);
          if (!ctx.isCurrent() || op !== generation) return;
          const details = doc.createElement("pre");
          details.textContent = `${c.name}\n${bytes.length} bytes\nSHA-256 ${[...seal].map(x => x.toString(16).padStart(2,"0")).join("")}\n\n${new TextDecoder().decode(bytes.slice(0,4096))}`;
          table.replaceChildren(details);
        } catch (e) { if (ctx.isCurrent() && op === generation) ctx.notify(e.message); }
      };
      const remove = doc.createElement("button"); remove.textContent = "Free";
      remove.onclick = () => {
        generation++;
        ctx.os.skylum.memory.free(c.name);
        render().catch(error => { if (ctx.isCurrent()) root.textContent = error.message; });
      };
      actions.append(view, remove); row.append(info, actions); table.append(row);
    }
  };
  render().catch(e => { if (ctx.isCurrent()) root.textContent = e.message; });
  return () => { generation++; };
}
