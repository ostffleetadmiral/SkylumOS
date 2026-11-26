export function mountQuine(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const target = doc.createElement("select");
  for (const [label, path] of [
    ["ITERON core", "../iteron/iteron.html"], ["SKYLUM OS", "../skylum/skylum.html"],
    ["ECHO desktop", "./desktop.html"],
  ]) { const option = doc.createElement("option"); option.textContent = label; option.value = path; target.append(option); }
  const open = doc.createElement("button"); open.textContent = "Open";
  const reemit = doc.createElement("button"); reemit.textContent = "Re-emit desktop";
  const frame = doc.createElement("iframe"); frame.title = "Quine artifact";
  open.onclick = () => { generation++; frame.src = target.value; };
  reemit.onclick = async () => {
    const own = ++generation;
    try {
      await ctx.os.saveSession();
      if (!ctx.isCurrent() || own !== generation) return;
      ctx.os.iteron.stateBlob = await ctx.os.skylum.save();
      if (!ctx.isCurrent() || own !== generation) return;
      const html = ctx.os.iteron.reemit();
      if (!ctx.isCurrent() || own !== generation) return;
      ctx.os.download(html, "desktop.html", "text/html");
    } catch (e) { if (ctx.isCurrent() && own === generation) ctx.notify(e.message); }
  };
  root.append(target, open, reemit, frame);
  frame.src = target.value;
  return () => { generation++; frame.src = "about:blank"; };
}
