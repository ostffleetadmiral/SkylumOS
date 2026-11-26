// sky.js — ECHO Celestial / space-agent view: the local sky dome as seen
// by an observer, computed by SKYLUM's astro service (solarState,
// lunarState, STARS, altAz). Polar alt-az projection — zenith at center,
// horizon at the rim; compass az from north. Observer defaults to the
// first claim's sealed fnv coordinate (same derivation as globe.js);
// lat/lon are editable. Nothing is simulated: every position is real
// astronomy over the wall clock.

import { observerSky, STARS } from "../../skylum/astro.js";

const skyDigestCoord = digest => ({
  lat: Number(digest & 0xffffn) / 65535 * 140 - 70,
  lng: Number((digest >> 16n) & 0xffffn) / 65535 * 360 - 180,
});

const fmt = (v, d = 1) => v.toFixed(d);

export function mountSky(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const encode = new TextEncoder();
  const first = ctx.os.skylum.memory.claims.keys().next().value;
  const seed = first ? skyDigestCoord(ctx.os.core.fnv1a64(encode(first))) : { lat: 0, lng: 0 };

  const bar = doc.createElement("div");
  bar.className = "sky-bar";
  const latIn = doc.createElement("input");
  latIn.value = fmt(seed.lat, 2); latIn.title = "Observer latitude";
  const lonIn = doc.createElement("input");
  lonIn.value = fmt(seed.lng, 2); lonIn.title = "Observer longitude (east +)";
  latIn.size = lonIn.size = 7;
  const live = doc.createElement("input");
  live.type = "checkbox"; live.checked = true; live.title = "Refresh every minute";
  const refresh = doc.createElement("button"); refresh.textContent = "Refresh";
  const info = doc.createElement("span"); info.className = "sky-info";
  bar.append("lat", latIn, "lon", lonIn, "live", live, refresh, info);

  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 560;
  canvas.className = "sky-canvas";
  root.append(bar, canvas);
  const g = canvas.getContext("2d");

  const parse = (el, min, max) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null;
  };

  const project = (alt, az, cx, cy, R) => {
    if (alt <= 0) return null;
    const r = (90 - alt) / 90 * R, a = az * Math.PI / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };

  function paint() {
    const lat = parse(latIn, -90, 90), lon = parse(lonIn, -180, 180);
    const now = new Date();
    g.fillStyle = "#0b0e14"; g.fillRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2, cy = canvas.height / 2, R = canvas.width / 2 - 24;
    g.strokeStyle = "#2a3140"; g.fillStyle = "#5b6577";
    g.font = "11px monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const rAlt of [30, 60]) {
      g.beginPath(); g.arc(cx, cy, R * (90 - rAlt) / 90, 0, 7); g.stroke();
    }
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
    for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const a = deg * Math.PI / 180;
      g.fillText(label, cx + (R + 12) * Math.sin(a), cy - (R + 12) * Math.cos(a));
    }
    if (lat === null || lon === null) {
      info.textContent = "enter a valid lat/lon"; return;
    }
    const sky = observerSky(now, lat, lon);

    for (const s of sky.stars) {
      const p = project(s.alt, s.az, cx, cy, R);
      if (!p) continue;
      const r = Math.max(0.8, 3.2 - s.mag * 1.2);
      g.fillStyle = `rgba(220,230,255,${Math.min(1, 1.1 - s.mag * 0.25)})`;
      g.beginPath(); g.arc(p[0], p[1], r, 0, 7); g.fill();
      if (s.mag < 1.0) { g.fillStyle = "#8fa2c8"; g.fillText(s.name, p[0], p[1] - 8); }
    }

    const mp = project(sky.moon.alt, sky.moon.az, cx, cy, R);
    if (mp) {
      g.fillStyle = "#39404f"; g.beginPath(); g.arc(mp[0], mp[1], 9, 0, 7); g.fill();
      const dAz = (sky.sun.az - sky.moon.az) * Math.PI / 180;
      const am = sky.moon.alt * Math.PI / 180, as = sky.sun.alt * Math.PI / 180;
      const theta = Math.atan2(Math.sin(dAz) * Math.cos(as),
        Math.cos(am) * Math.sin(as) - Math.sin(am) * Math.cos(as) * Math.cos(dAz));
      const amr = sky.moon.az * Math.PI / 180;
      const dx = Math.sin(amr) * Math.cos(theta) + Math.cos(amr) * Math.sin(theta);
      const dy = -Math.cos(amr) * Math.cos(theta) + Math.sin(amr) * Math.sin(theta);
      const c = Math.cos(sky.moon.phase * Math.PI / 180);
      g.save(); g.translate(mp[0], mp[1]); g.rotate(Math.atan2(dy, dx));
      g.fillStyle = "#cfd6e4";
      g.beginPath(); g.arc(0, 0, 9, -Math.PI / 2, Math.PI / 2);
      g.ellipse(0, 0, 9 * Math.abs(c), 9, 0, Math.PI / 2, -Math.PI / 2, c < 0);
      g.fill(); g.restore();
      g.fillStyle = "#aeb8cf"; g.fillText("moon", mp[0], mp[1] + 16);
    }

    const sp = project(sky.sun.alt, sky.sun.az, cx, cy, R);
    if (sp) {
      const grad = g.createRadialGradient(sp[0], sp[1], 1, sp[0], sp[1], 16);
      grad.addColorStop(0, "#ffd766"); grad.addColorStop(1, "rgba(255,215,102,0)");
      g.fillStyle = grad; g.beginPath(); g.arc(sp[0], sp[1], 16, 0, 7); g.fill();
      g.fillStyle = "#ffd766"; g.beginPath(); g.arc(sp[0], sp[1], 8, 0, 7); g.fill();
      g.fillText("sun", sp[0], sp[1] + 22);
    }

    const visStars = sky.stars.filter(s => s.alt > 0).length;
    info.textContent =
      ` ${now.toISOString().slice(11, 19)}Z · sun ${fmt(sky.sun.alt)}° az ${fmt(sky.sun.az)}°` +
      ` · moon ${fmt(sky.moon.alt)}° illum ${fmt(sky.moon.illum * 100, 0)}%` +
      ` · ${visStars}/${STARS.length} catalog stars up`;
  }

  let timer = setInterval(() => live.checked && paint(), 60000);
  refresh.onclick = paint;
  latIn.onchange = lonIn.onchange = paint;
  paint();
  return () => { generation++; clearInterval(timer); };
}
