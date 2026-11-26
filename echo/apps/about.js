export function mountAbout(root, ctx) {
  let generation = 0;
  const own = ++generation;
  const doc = root.ownerDocument;
  const heading = doc.createElement("h2");
  heading.textContent = "SkyOS · ECHO";
  const summary = doc.createElement("p");
  summary.textContent = "A browser-native desktop over ITERON and SKYLUM.";
  const details = doc.createElement("pre");
  let active = true;
  const refresh = async () => {
    const status = await ctx.os.skylum.status();
    if (!active || own !== generation || !ctx.isCurrent()) return;
    details.textContent = JSON.stringify({
      tier: ctx.os.iteron.manifest?.format ?? "DESKTOP1",
      layers: ctx.os.iteron.manifest?.layers ?? ["iteron", "skylum", "echo"],
      claims: status.claims.length,
      doors: status.doors.length,
      peers: status.mesh.peers,
      inference: status.infer.available ? "available" : "not configured",
      opfs: status.persist.opfs ? "available" : "unavailable",
    }, null, 2);
  };
  root.append(heading, summary, details);
  refresh().catch(error => {
    if (active && own === generation && ctx.isCurrent())
      details.textContent = `Status unavailable: ${error.message}`;
  });
  return () => { active = false; generation++; };
}
