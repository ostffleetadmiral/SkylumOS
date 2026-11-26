"""ITERON quine generator — emits a self-contained iteron.html.

Artifact anatomy (LAYERS.md §4):
  template.html slots: __WASM_B64__ __STATE_B64__ __MANIFEST__
                       __TEMPLATE_B64__ __ENGINE__
  __ENGINE__ = iteron-core.js + iteron.js concatenated, ESM syntax
               stripped (import lines dropped, `export ` prefixes removed)
               so it runs as a classic <script> under file://.
  __TEMPLATE_B64__ = base64(template.html raw bytes) — preserves the
               literal markers for reemit().

CLI: python -m skyos.iteron.make_quine payload.skcs -o iteron.html
     [--wasm skc-wasm.wasm] [--manifest extra.json]
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
DEFAULT_WASM = Path(os.environ.get(
    "SKYOS_SKC_WASM",
    HERE.parent / "vendor" / "skc-wasm.wasm",
))

ENGINE_FOOTER = """
// engine globals for the boot harness
window.IteronCore = IteronCore;
window.Iteron = Iteron;
window.SKC = { KIND, CODEC, CARRIER, FRAME_CODEC, SKCF_VERDICT,
               crc32, zipStore, sniff, deflateRaw, inflateRaw, b64encode };
"""


def bundle_engine() -> str:
    """Concat iteron-core.js + iteron.js, strip ESM syntax -> classic script."""
    core = (HERE / "iteron-core.js").read_text()
    iteron = (HERE / "iteron.js").read_text()
    # drop import lines, strip `export ` prefixes
    core = re.sub(r"^import .*\n", "", core, flags=re.M)
    iteron = re.sub(r"^import .*\n", "", iteron, flags=re.M)
    core = re.sub(r"^export ", "", core, flags=re.M)
    iteron = re.sub(r"^export ", "", iteron, flags=re.M)
    return core + "\n" + iteron + ENGINE_FOOTER


def make_quine(state_path: str, out_html: str, *, wasm_path: Path | None = None,
               extra_manifest: dict | None = None, extra_boot: str = "") -> dict:
    tmpl = (HERE / "template.html").read_text()
    state_b64 = base64.b64encode(Path(state_path).read_bytes()).decode()
    wasm_b64 = base64.b64encode((wasm_path or DEFAULT_WASM).read_bytes()).decode()
    tmpl_b64 = base64.b64encode(tmpl.encode()).decode()
    engine = bundle_engine()
    if "</script" in engine.lower():
        raise RuntimeError("engine source contains </script — cannot embed")
    if "</script" in extra_boot.lower():
        raise RuntimeError("extra_boot contains </script — cannot embed")
    manifest = {
        "format": "ITERON1",
        "state": Path(state_path).name,
        "state_bytes": len(base64.b64decode(state_b64)),
        "wasm": (wasm_path or DEFAULT_WASM).name,
        "wasm_bytes": len(base64.b64decode(wasm_b64)),
        "engine_bytes": len(engine.encode()),
    }
    if extra_manifest:
        manifest.update(extra_manifest)
    manifest_str = json.dumps(manifest).replace("<", "\\u003c")
    html = (tmpl
            .replace("__WASM_B64__", wasm_b64)
            .replace("__STATE_B64__", state_b64)
            .replace("__MANIFEST__", manifest_str)
            .replace("__TEMPLATE_B64__", tmpl_b64)
            .replace("__EXTRA_BOOT__", extra_boot)
            .replace("__ENGINE__", engine))
    Path(out_html).write_text(html)
    return {"html": out_html, "bytes": len(html), "manifest": manifest}


def main() -> int:
    ap = argparse.ArgumentParser(prog="make_quine")
    ap.add_argument("state", help=".skcs state volume (or any file)")
    ap.add_argument("-o", "--out", default="iteron.html")
    ap.add_argument("--wasm", type=Path, default=None)
    ap.add_argument("--extra-boot", type=Path, default=None,
                    help="JS file substituted into the __EXTRA_BOOT__ slot")
    args = ap.parse_args()
    if not (HERE / "template.html").exists():
        print("template.html missing", file=sys.stderr)
        return 1
    extra_boot = args.extra_boot.read_text() if args.extra_boot else ""
    r = make_quine(args.state, args.out, wasm_path=args.wasm, extra_boot=extra_boot)
    print(f"wrote {r['html']} ({r['bytes']} bytes, state={r['manifest']['state_bytes']}B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
