export const APP_REGISTRY = Object.freeze([
  { id: "terminal", name: "Terminal", icon: ">_", capability: "skylum.seats", label: "Workstation" },
  { id: "files", name: "Claims & Files", icon: "▱", capability: "skylum.claims", label: "Volumes" },
  { id: "monitor", name: "System Monitor", icon: "▥", capability: "skylum.status", label: "Signals" },
  { id: "infer", name: "Inference Console", icon: "✳", capability: "skylum.infer",
    unavailable: "Inference unavailable: configure an OpenAI-compatible endpoint." },
  { id: "mesh", name: "Mesh Monitor", icon: "⌁", capability: "skylum.mesh",
    unavailable: "Mesh unavailable: this browser does not provide WebRTC." },
  { id: "fabric", name: "Skyloom Fabric", icon: "⌘", capability: "skylum.status",
    unavailable: "Fabric monitor unavailable: start the head on 127.0.0.1:8977 or set NEXT_PUBLIC_FABRIC_URL." },
  { id: "globe", name: "SkyOS Globe", icon: "◎", capability: "skylum.claims" },
  { id: "sky", name: "Celestial Sky", icon: "◐", capability: "skylum.claims" },
  { id: "godseye", name: "God's Eye View", icon: "◉", capability: "skylum.bridge" },
  { id: "spaceagent", name: "Space Agent", icon: "⌬", capability: "skylum.bridge" },
  { id: "optical", name: "Optical Receiver", icon: "▦", capability: "iteron.volume" },
  { id: "inspector", name: "Volume Inspector", icon: "⌕", capability: "iteron.volume" },
  { id: "quine", name: "Quine Studio", icon: "⟳", capability: "iteron.reemit" },
  { id: "about", name: "About SkyOS", icon: "S", capability: "iteron.volume", label: "System" },
]);

export const CAPABILITIES = new Set([
  "skylum.claims", "skylum.seats", "skylum.status", "skylum.infer",
  "skylum.mesh", "skylum.persist", "skylum.bridge", "iteron.volume", "iteron.reemit",
]);
export function validateAppRegistry(registry = APP_REGISTRY) {
  if (!Array.isArray(registry) || registry.length > 32) throw new Error("app_registry_invalid");
  const ids = new Set();
  for (const app of registry) {
    if (!app || typeof app.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(app.id) ||
        typeof app.name !== "string" || app.name.length < 1 || app.name.length > 80 ||
        typeof app.icon !== "string" || app.icon.length > 16 ||
        (app.label !== undefined && (typeof app.label !== "string" || app.label.length > 24)))
      throw new Error("app_descriptor_invalid");
    if (ids.has(app.id)) throw new Error("app_id_conflict");
    if (!CAPABILITIES.has(app.capability)) throw new Error("app_capability_denied");
    if (app.href !== undefined) throw new Error("app_href_denied");
    if (typeof app.unavailable !== "undefined" &&
        (typeof app.unavailable !== "string" || app.unavailable.trim().length === 0 ||
         app.unavailable.length > 240))
      throw new Error("app_unavailable_invalid");
    if (!app.mount && !app.capability && !app.unavailable) throw new Error("app_behavior_undefined");
    ids.add(app.id);
  }
  return registry;
}

export function createRegistry(mounts) {
  validateAppRegistry(APP_REGISTRY);
  const registry = new Map(APP_REGISTRY.map(app => [app.id, {
    ...app,
    mount: mounts[app.id] ?? ((root) => {
      root.textContent = app.unavailable ?? `${app.name}: service unavailable`;
    }),
  }]));
  return registry;
}
