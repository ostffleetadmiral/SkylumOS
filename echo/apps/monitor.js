export function mountMonitor(root, ctx) {
  let active = true, generation = 0;
  const doc = root.ownerDocument;
  const refresh = async () => {
    const own = ++generation;
    try {
      const status = await ctx.os.skylum.status();
      if (!active || !ctx.isCurrent() || own !== generation) return;
      root.replaceChildren();
      const pre = doc.createElement("pre");
      pre.textContent = JSON.stringify({
        claims: status.claims, seats: status.seats, doors: status.doors,
        inference: status.infer, mesh: status.mesh, persistence: status.persist,
        tick: status.tick, wasmBytes: ctx.os.core.e.memory.buffer.byteLength,
      }, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
      root.append(pre);
    } catch (error) {
      if (active && ctx.isCurrent() && own === generation)
        root.textContent = `Monitor unavailable: ${error.message}`;
    }
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  return () => { active = false; generation++; clearInterval(timer); };
}
