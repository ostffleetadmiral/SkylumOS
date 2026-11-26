"""Build DESKTOP1: a self-contained ITERON + SKYLUM + ECHO quine artifact."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKYLUM = HERE.parent / "skylum"
ITERON = HERE.parent / "iteron"
sys.path.insert(0, str(SKYLUM))
import make_skylum as ms

DESKTOP_MODULES = [
    "apps.mjs", "wm.js", "term.js", "apps/files.js", "apps/monitor.js",
    "apps/infer.js", "apps/mesh.js", "apps/fabric.js", "apps/globe.js", "apps/sky.js",
    "apps/optical.js", "../host/services.mjs", "apps/embed.js",
    "apps/inspector.js",
    "apps/quine.js", "apps/about.js", "desktop.js",
]

_TOP_DECL = re.compile(
    r"^(?:const|let|var|function\*?|async\s+function\*?|class)\s+"
    r"([A-Za-z_$][\w$]*)",
    re.M,
)

def _strip_module(src: str) -> str:
    src = re.sub(r"^import .*\n", "", src, flags=re.M)
    src = re.sub(r"^export ", "", src, flags=re.M)
    return src

def _top_level_names(src: str) -> set[str]:
    # All concatenated parts share one script scope, so a top-level name
    # declared by two modules is a SyntaxError (or silent overwrite for
    # var/function). Fail the build instead of shipping a dead artifact.
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return set(_TOP_DECL.findall(src))

def _check_scope_collisions(parts: list[tuple[str, str]]) -> None:
    owners: dict[str, str] = {}
    for label, src in parts:
        for name in _top_level_names(src):
            if name in owners and owners[name] != label:
                raise RuntimeError(
                    f"top-level name {name!r} declared by both "
                    f"{owners[name]} and {label}; rename one"
                )
            owners[name] = label

def bundle_desktop_engine() -> str:
    from make_quine import ENGINE_FOOTER, bundle_engine
    iteron_engine = bundle_engine()
    iteron_engine = re.sub(
        r"(?m)^[ \t]*//.*(?:__WASM_B64__|__STATE_B64__|__TEMPLATE_B64__).*$",
        "",
        iteron_engine,
    )
    parts = [("iteron/engine", iteron_engine)]
    for rel in ms.SKYLUM_MODULES:
        src = (SKYLUM / rel).read_text()
        parts.append((f"skylum/{rel}", _strip_module(src)))
    parts.append(("iteron/footer", ENGINE_FOOTER))
    for rel in DESKTOP_MODULES:
        path = HERE / rel
        src = path.read_text()
        label = rel[3:] if rel.startswith("../") else f"echo/{rel}"
        parts.append((label, _strip_module(src)))
    parts.append(("echo/boot", """
window.Desktop = Desktop;
window.WindowManager = WindowManager;
window.ECHO = { APP_REGISTRY, CAPABILITIES, validateAppRegistry, createRegistry,
  createWindowState, clampWindowRect, transitionWindowState, windowStateSnapshot,
  restoreWindowState, createTerminalDispatcher };
window.bootDesktopArtifact = async function() {
  const status = document.getElementById("boot-status");
  try {
    const b64 = s => Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0));
    const wasmText = document.getElementById("iteron-wasm").textContent.trim();
    const stateText = document.getElementById("iteron-state").textContent.trim();
    const vendorText = document.getElementById("iteron-vendor").textContent.trim();
    const manifestText = document.getElementById("iteron-manifest").textContent;
    const tmplText = document.getElementById("iteron-tmpl").textContent.trim();
    const engineText = document.getElementById("iteron-engine-src").textContent;
    const core = await IteronCore.create(b64(wasmText));
    let stateBlob = b64(stateText);
    const parsed = core.skcsParse(stateBlob);
    if (!parsed) throw new Error("malformed_state_volume");
    const members = [];
    for (const member of parsed.members)
      members.push({ ...member, data: await core.inflateMember(member), codec: "auto" });
    if (vendorText) members.push({ name: "vendor/globe.gl.min.js", data: b64(vendorText),
      kind: "file", media: "text/javascript", codec: "auto" });
    stateBlob = await core.skcsPack(members, parsed.flags);
    const manifest = JSON.parse(manifestText);
    const iteron = new Iteron(core, stateBlob, manifest, {
      wasmB64: wasmText, stateB64: stateText, vendorB64: vendorText,
      manifestStr: manifestText, tmplB64: tmplText, engineSrc: engineText,
    });
    window.ITERON = iteron;
    const skylum = new Skylum(iteron, {});
    await skylum.loadState();
    window.SKYLUM = skylum;
    let desktop = null;
    const os = {
      core, iteron, skylum,
      getCore: async () => core,
      download(data, name, type = "application/octet-stream") {
        const url = URL.createObjectURL(new Blob([data], { type }));
        const a = document.createElement("a"); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      saveSession: async () => desktop?.saveSession?.(),
    };
    desktop = new Desktop(os);
    window.OS = os;
    window.DESKTOP = desktop;
    try { await desktop.bootSession(); }
    catch (error) { desktop.destroy(); throw error; }
    status.textContent = "Quine desktop ready · " + skylum.memory.claims.size + " claims";
    return { os, desktop };
  } catch (error) {
    status.textContent = "Boot failed: " + error.message;
    throw error;
  }
};
"""))
    _check_scope_collisions(parts)
    return "\n".join(
        src if label in {"iteron/engine", "iteron/footer"}
        else f"// ---- {label} ----\n{src}"
        for label, src in parts
    )

def make_desktop(state_path: Path, out_html: Path, wasm_path: Path | None = None) -> dict:
    mq = __import__("make_quine")
    template = (HERE / "template.html").read_text()
    css = (HERE / "desktop.css").read_text()
    engine = bundle_desktop_engine()
    state = state_path.read_bytes()
    resolved_wasm = wasm_path or Path(os.environ.get("SKYOS_SKC_WASM", mq.DEFAULT_WASM))
    wasm = resolved_wasm.read_bytes()
    # The library is a .skcs member, not executable HTML source. Still scan it
    # explicitly to preserve the invariant if a donor version changes.
    vendor_path = HERE / "vendor" / "globe.gl.min.js"
    vendor = vendor_path.read_bytes()
    if b"</script" in vendor.lower():
        raise RuntimeError("vendor contains a closing script sequence")
    vendor_b64 = base64.b64encode(vendor).decode()
    vendor_member = {
        "name": "vendor/globe.gl.min.js",
        "sha256": hashlib.sha256(vendor).hexdigest(),
        "bytes": len(vendor),
    }
    for label, value in (("engine", engine), ("css", css)):
        if "</script" in value.lower():
            raise RuntimeError(f"{label} contains </script")
    css_marker = "__DESKTOP_CSS__"
    if css_marker not in template:
        raise RuntimeError("template missing desktop CSS slot")
    if template.count(css_marker) != 1:
        raise RuntimeError("template has ambiguous desktop CSS slots")
    # The embedded template is the canonical source with all quine markers
    # intact; otherwise reemit() cannot reconstruct the artifact.
    canonical = template.replace(css_marker, css)
    quine_template = canonical
    manifest = {
        "format": "DESKTOP1", "state": state_path.name,
        "state_bytes": len(state), "wasm": resolved_wasm.name,
        "engine_bytes": len(engine.encode()),
        "layers": ["iteron", "skylum", "echo"],
        "session_member": "__desktop.json",
        "vendor": vendor_member,
    }
    executable_template = quine_template.replace(
        '<script type="application/octet-stream" class="blob" id="iteron-engine-src">',
        '<script id="iteron-engine-src">',
    ).replace('<script id="iteron-extra-boot">__EXTRA_BOOT__</script>\n', "")
    script_slots = re.findall(r"<script\b[^>]*>([\s\S]*?)</script\s*>",
                              executable_template, flags=re.IGNORECASE)
    if len(script_slots) != 7 or any(
        "</script" in content.lower() for content in script_slots
        if content not in {"__ENGINE__", "__DESKTOP_BOOT__"}
    ):
        raise RuntimeError("template contains unsafe script content")
    manifest_str = json.dumps(manifest).replace("<", "\\u003c")
    executable_template = executable_template.replace("__MANIFEST__", manifest_str)
    tmpl_b64 = base64.b64encode(executable_template.encode()).decode()
    html = (executable_template
            .replace("__VENDOR_B64__", vendor_b64)
            .replace("__WASM_B64__", base64.b64encode(wasm).decode())
            .replace("__STATE_B64__", base64.b64encode(state).decode())
            .replace("__TEMPLATE_B64__", tmpl_b64)
            .replace("__ENGINE__", engine))
    boot_script = ('<script>(function(){const boot=()=>window.bootDesktopArtifact();'
                   'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});'
                   'else boot();})();</script>')
    desktop_boot_script = '<script>' + "__DESKTOP_" + "BOOT__" + '</script>'
    if html.count(desktop_boot_script) != 1:
        raise RuntimeError("desktop boot slot missing or ambiguous")
    html = html.replace(desktop_boot_script, boot_script)
    script_contents = re.findall(r"<script\b[^>]*>([\s\S]*?)</script\s*>",
                                 html, flags=re.IGNORECASE)
    if len(script_contents) != 7 or any(
        "</script" in content.lower() for content in script_contents
    ):
        raise RuntimeError("generated artifact contains unsafe script content")
    for marker in ("__WASM_B64__", "__VENDOR_B64__", "__STATE_B64__",
                   "__DESKTOP_CSS__", "__DESKTOP_BOOT__"):
        if marker in html:
            raise RuntimeError(f"unresolved quine slot: {marker}")
    out_html.write_text(html)
    return {"html": str(out_html), "bytes": len(html), "manifest": manifest}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("state", nargs="?", type=Path, default=SKYLUM / "seed.skcs")
    parser.add_argument("-o", "--out", type=Path, default=HERE / "desktop.html")
    parser.add_argument("--wasm", type=Path, default=None)
    args = parser.parse_args()
    result = make_desktop(args.state, args.out, args.wasm)
    print(f"wrote {result['html']} ({result['bytes']} bytes)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
