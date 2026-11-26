import { sniff } from "../../iteron/iteron-core.js";

export function mountInspector(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const pick = doc.createElement("input"); pick.type = "file"; pick.accept = ".skcs,.skcf,.skc,.zip";
  const out = doc.createElement("div");
  root.append(pick, out);
  pick.onchange = async () => {
    const own = ++generation, file = pick.files?.[0];
    if (!file) return;
    out.textContent = "Reading volume…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!ctx.isCurrent() || own !== generation) return;
      const kind = sniff(bytes).format;
      if (kind === "skcs") {
        const core = await ctx.os.getCore();
        const parsed = core.skcsParse(bytes);
        if (!parsed) throw new Error("malformed_skcs");
        const rows = [];
        for (const member of parsed.members) {
          const raw = await core.inflateMember(member);
          if (!ctx.isCurrent() || own !== generation) return;
          const seal = core.sha256(raw);
          rows.push(`${member.name} · ${member.kindName} · ${raw.length}B · sha256 ${[...seal].map(b => b.toString(16).padStart(2,"0")).join("")}`);
        }
        out.textContent = rows.join("\n") || "Empty .skcs volume";
      } else if (kind === "skcf") {
        const core = await ctx.os.getCore();
        if (!ctx.isCurrent() || own !== generation) return;
        out.textContent = JSON.stringify(core.skcfParse(bytes), (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
      } else out.textContent = `${file.name}: ${kind}, ${bytes.length} bytes`;
    } catch (e) { if (ctx.isCurrent() && own === generation) out.textContent = `Inspect failed: ${e.message}`; }
  };
  return () => { generation++; };
}
