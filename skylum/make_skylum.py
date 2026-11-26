"""SKYLUM quine generator — iteron.html + OS services layer.

Same slot law as ITERON (LAYERS.md §4); the engine bundle additionally
contains the SKYLUM modules (memory/seats/doors/infer/mesh/persist/state)
and __EXTRA_BOOT__ initializes window.SKYLUM after ITERON boots.

CLI: python -m skyos.skylum.make_skylum payload.skcs -o skylum.html
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ITERON = HERE.parent / "iteron"
sys.path.insert(0, str(ITERON))  # for `import make_quine`

# SKYLUM module order: dependencies first (all import-stripped into one
# classic-script scope; iteron-core/iteron come first via iteron bundle).
# doors.js precedes mesh.js since MeshNode.send() receipts via DOOR.mesh.
SKYLUM_MODULES = [
    "state.js", "memory.js", "persist.js", "seats.js", "optical.js",
    "astro.js", "audio.js", "doors.js", "infer.js", "mesh.js", "fabric.js", "index.js",
]

EXTRA_BOOT = r"""
// SKYLUM boot — runs after ITERON's slots are parsed (window.ITERON set
// by the boot harness below; we poll briefly since script order puts
// this block before the harness's DOMContentLoaded callback)
(function () {
  const tryBoot = () => {
    if (!window.ITERON) { setTimeout(tryBoot, 50); return; }
    const log = m => { const el = document.getElementById('log'); if (el) el.textContent += m + '\n'; };
    try {
      window.SKYLUM = new Skylum(window.ITERON, {});
      window.SKYLUM.loadState().then(async () => {
        const st = await window.SKYLUM.status();
        log('SKYLUM online — claims=' + st.claims.length +
            ' seats=' + st.seats.length + ' doors=' + st.doors.length +
            ' mesh=' + (st.mesh.supported ? 'rtc' : 'off') +
            ' opfs=' + st.persist.opfs);
        window.__SKYLUM_STATUS = st;
      }).catch(e => log('SKYLUM loadState: ' + e));
    } catch (err) { log('SKYLUM boot error: ' + (err.stack || err)); }
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', tryBoot);
  else tryBoot();
})();
"""

ENGINE_FOOTER = """
// skylum globals for boot harness / console
window.Skylum = Skylum;
window.VSpace = VSpace;
window.Scheduler = Scheduler;
window.Seat = Seat;
window.InferenceDoor = InferenceDoor;
window.MeshNode = MeshNode;
window.meshSupported = meshSupported;
window.FabricClient = FabricClient;
window.createFabricClient = createFabricClient;
window.meshSignal = { encodeSignal, decodeSignal };
window.persist = persist;
window.DoorBus = DoorBus;
window.DOOR = DOOR;
window.claimMember = claimMember;
window.claimMeta = claimMeta;
window.CLAIM_KIND = CLAIM_KIND;
window.ClaimSpace = ClaimSpace;
"""


def bundle_skylum_engine() -> str:
    """iteron engine bundle + skylum modules, all ESM-stripped."""
    from make_quine import bundle_engine  # iteron/make_quine.py
    parts = [bundle_engine()]
    for name in SKYLUM_MODULES:
        src = (HERE / name).read_text()
        src = re.sub(r"^import .*\n", "", src, flags=re.M)
        src = re.sub(r"^export ", "", src, flags=re.M)
        parts.append(f"// ---- skylum/{name} ----\n" + src)
    return "\n".join(parts) + ENGINE_FOOTER


def make_skylum(state_path: str, out_html: str, *, wasm_path=None,
                extra_manifest: dict | None = None) -> dict:
    import make_quine as mq
    tmpl = (ITERON / "template.html").read_text()
    state_b64 = base64.b64encode(Path(state_path).read_bytes()).decode()
    resolved_wasm = wasm_path or Path(os.environ.get("SKYOS_SKC_WASM", mq.DEFAULT_WASM))
    wasm_b64 = base64.b64encode(resolved_wasm.read_bytes()).decode()
    tmpl_b64 = base64.b64encode(tmpl.encode()).decode()
    engine = bundle_skylum_engine()
    if "</script" in engine.lower():
        raise RuntimeError("engine source contains </script — cannot embed")
    if "</script" in EXTRA_BOOT.lower():
        raise RuntimeError("EXTRA_BOOT contains </script — cannot embed")
    manifest = {
        "format": "SKYLUM1",
        "state": Path(state_path).name,
        "state_bytes": len(base64.b64decode(state_b64)),
        "wasm": resolved_wasm.name,
        "engine_bytes": len(engine.encode()),
        "layers": ["iteron", "skylum"],
    }
    if extra_manifest:
        manifest.update(extra_manifest)
    manifest_str = json.dumps(manifest).replace("<", "\\u003c")
    html = (tmpl
            .replace("__WASM_B64__", wasm_b64)
            .replace("__STATE_B64__", state_b64)
            .replace("__MANIFEST__", manifest_str)
            .replace("__TEMPLATE_B64__", tmpl_b64)
            .replace("__EXTRA_BOOT__", EXTRA_BOOT)
            .replace("__ENGINE__", engine))
    Path(out_html).write_text(html)
    return {"html": out_html, "bytes": len(html), "manifest": manifest}


def main() -> int:
    ap = argparse.ArgumentParser(prog="make_skylum")
    ap.add_argument("state", help=".skcs state volume")
    ap.add_argument("-o", "--out", default="skylum.html")
    ap.add_argument("--wasm", type=Path, default=None)
    args = ap.parse_args()
    r = make_skylum(args.state, args.out, wasm_path=args.wasm)
    print(f"wrote {r['html']} ({r['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
