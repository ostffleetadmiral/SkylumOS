// globe.js — ECHO Spatial / God's-Eye View.
// Claims, mesh peers, and door sends are plotted on the vendored globe.gl
// globe (inflated from the sealed .skcs vendor member). The subsolar
// terminator is computed from real UTC astronomy — no simulated data.
// When the globe library is absent the view falls back to a structured
// digest-telemetry table rather than an empty panel.

import { subsolarPoint } from "../../skylum/astro.js";

const LIB_MEMBER = "vendor/globe.gl.min.js";

export { subsolarPoint };

const globeDigestCoord = (digest, name) => ({
  lat: Number(digest & 0xffffn) / 65535 * 140 - 70,
  lng: Number((digest >> 16n) & 0xffffn) / 65535 * 360 - 180,
  name,
});

// The terminator is the great circle of points p where sunVec·p = 0.
// Parameterize that circle in the sun-fixed frame and rotate back.
export function terminatorRing(sun, segments = 96) {
  const sunLat = sun.lat * Math.PI / 180;
  const sunLng = sun.lng * Math.PI / 180;
  const axis = [
    Math.cos(sunLat) * Math.cos(sunLng),
    Math.cos(sunLat) * Math.sin(sunLng),
    Math.sin(sunLat),
  ];
  const ref = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
  const u = norm(cross(axis, ref));
  const v = cross(axis, u);
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const t = 2 * Math.PI * i / segments;
    const p = u.map((x, k) => x * Math.cos(t) + v[k] * Math.sin(t));
    const lat = Math.asin(Math.max(-1, Math.min(1, p[2]))) * 180 / Math.PI;
    const lng = Math.atan2(p[1], p[0]) * 180 / Math.PI;
    ring.push([lat, ((lng + 540) % 360) - 180]);
  }
  return ring;
}

export async function mountGlobe(root, ctx) {
  let generation = 0;
  const own = ++generation;
  const doc = root.ownerDocument;
  const abortController = new AbortController();
  const status = doc.createElement("p");
  status.textContent = "Loading embedded globe renderer…";
  const hud = doc.createElement("div");
  hud.className = "globe-hud";
  const host = doc.createElement("div");
  host.className = "globe-host";
  root.append(status, hud, host);
  let objectUrl = null;
  let script = null;
  let globe = null;
  let refreshTimer = null;
  let destroyed = false;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    generation++;
    abortController.abort();
    if (refreshTimer !== null) clearInterval(refreshTimer);
    host.replaceChildren();
    script?.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    globe = null;
  };

  const telemetry = statusData => {
    const encode = new TextEncoder();
    const claims = statusData.claims.map(c => {
      const digest = ctx.os.core.fnv1a64(encode(c.name));
      return { ...globeDigestCoord(digest, c.name), size: c.size, seal: digest.toString(16) };
    });
    const peers = [...ctx.os.skylum.mesh.peers.keys()].map(id => {
      const digest = ctx.os.core.fnv1a64(encode(`peer:${id}`));
      return { ...globeDigestCoord(digest, id), peer: id };
    });
    const sends = ctx.os.skylum.bus.log.filter(entry => entry.dir === "tx")
      .slice(-64)
      .map((entry, index) => {
        const a = ctx.os.core.fnv1a64(encode(`${entry.door}:src`));
        const b = ctx.os.core.fnv1a64(encode(`${entry.door}:${entry.at}`));
        return {
          startLat: globeDigestCoord(a, "").lat, startLng: globeDigestCoord(a, "").lng,
          endLat: globeDigestCoord(b, "").lat, endLng: globeDigestCoord(b, "").lng,
          door: entry.door, bytes: entry.bytes,
        };
      });
    const sun = subsolarPoint();
    return { claims, peers, sends, sun, ring: terminatorRing(sun) };
  };

  const fallback = (title, data) => {
    const seal = ctx.os.core.fnv1a64(new TextEncoder()
      .encode(data.claims.map(c => c.name).sort().join(","))).toString(16);
    const rows = [
      `<b>${title}</b>`,
      `claims ${data.claims.length} · peers ${data.peers.length} · ` +
      `door sends ${data.sends.length} · view seal fnv1a64 ${seal}`,
      `subsolar ${data.sun.lat.toFixed(2)}°, ${data.sun.lng.toFixed(2)}°`,
      "",
      ...data.claims.map(c =>
        `${c.name}  @ ${c.lat.toFixed(1)},${c.lng.toFixed(1)}  ${c.size}B  seal ${c.seal}`),
      ...data.peers.map(p =>
        `peer ${p.peer}  @ ${p.lat.toFixed(1)},${p.lng.toFixed(1)}`),
    ];
    hud.textContent = "";
    const pre = doc.createElement("pre");
    pre.className = "globe-fallback";
    pre.textContent = rows.join("\n");
    hud.append(pre);
  };

  try {
    const member = (await ctx.os.iteron.inspect()).members.find(m => m.name === LIB_MEMBER);
    if (!ctx.isCurrent() || own !== generation) {
      cleanup();
      return cleanup;
    }
    if (!member) {
      status.textContent = "Globe lib member absent — digest telemetry fallback.";
      fallback("no vendor member", telemetry(await ctx.os.skylum.status()));
      return cleanup;
    }
    script = doc.createElement("script");
    objectUrl = URL.createObjectURL(new Blob([member.data], { type: "text/javascript" }));
    script.src = objectUrl;
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("globe_bundle_load_failed"));
      abortController.signal.addEventListener("abort", () => {
        script?.remove();
        reject(new Error("globe_bundle_load_aborted"));
      }, { once: true });
      doc.head.append(script);
    });
    if (!ctx.isCurrent() || own !== generation) {
      cleanup();
      return cleanup;
    }
    const GlobeFactory = doc.defaultView?.Globe;
    if (typeof GlobeFactory !== "function") throw new Error("globe_global_missing");
    const statusData = await ctx.os.skylum.status();
    if (!ctx.isCurrent() || own !== generation) {
      cleanup();
      return cleanup;
    }

    const data = telemetry(statusData);
    globe = GlobeFactory()(host)
      .backgroundColor("#071018")
      .pointsData([...data.claims, ...data.peers])
      .pointLat("lat").pointLng("lng").pointLabel("name")
      .pointColor(point => point.peer ? "#57d7ff" : "#ff6b35")
      .pointAltitude(0.02).pointRadius(0.45)
      .arcsData(data.sends)
      .arcStartLat("startLat").arcStartLng("startLng")
      .arcEndLat("endLat").arcEndLng("endLng")
      .arcColor(() => ["rgba(87,215,255,0.5)", "rgba(255,107,53,0.5)"])
      .arcStroke(0.5).arcDashLength(0.4).arcDashGap(0.6).arcDashAnimateTime(2400)
      .pathsData([{ coords: data.ring }])
      .pathPoints("coords").pathPointLat(p => p[0]).pathPointLng(p => p[1])
      .pathColor(() => "rgba(120,160,255,0.55)").pathStroke(0.6);

    const renderHud = () => {
      const now = subsolarPoint();
      hud.textContent =
        `CLAIMS ${data.claims.length} · PEERS ${data.peers.length} · ` +
        `SENDS ${data.sends.length} · SUBSOLAR ${now.lat.toFixed(1)}°,${now.lng.toFixed(1)}° ` +
        `· TERMINATOR ${data.ring.length - 1}pt`;
    };
    renderHud();
    refreshTimer = setInterval(renderHud, 60_000);
    status.textContent = "Claims ■ peers ■ door sends — sealed ITERON coordinates";
    return cleanup;
  } catch (e) {
    if (ctx.isCurrent() && own === generation) {
      status.textContent = `Globe renderer unavailable: ${e.message}`;
      try { fallback("renderer fallback", telemetry(await ctx.os.skylum.status())); }
      catch { /* status itself unavailable */ }
    }
    return cleanup;
  }
}
