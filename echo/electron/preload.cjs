const { contextBridge, ipcRenderer } = require("electron");

// Channel table must stay identical to ELECTRON_IPC_CHANNELS in
// main-policy.cjs — tests/host.test.mjs enforces that parity.
const CHANNELS = Object.freeze({
  status: "skyos:status",
  listClaims: "skyos:claims:list",
  readClaim: "skyos:claims:read",
  listVolumes: "skyos:volumes:list",
  loadVolume: "skyos:volumes:load",
  saveVolume: "skyos:volumes:save",
  deleteVolume: "skyos:volumes:delete",
  infer: "skyos:infer",
  sendDoor: "skyos:door:send",
  recvDoor: "skyos:door:recv",
  reemit: "skyos:quine:reemit",
  exportVolume: "skyos:volume:export",
  importVolume: "skyos:volume:import",
  exportArtifact: "skyos:artifact:export",
  setBridgeEnabled: "skyos:bridge:enable",
  bridgeStatus: "skyos:bridge:status",
  hwProbe: "skyos:hw:probe",
  opticalSources: "skyos:optical:sources",
  servicesStatus: "skyos:services:status",
  ensureServices: "skyos:services:ensure",
  fabricRequest: "skyos:fabric:request",
});

const api = Object.freeze(Object.fromEntries([
  ["mode", "electron"],
  ...Object.entries(CHANNELS).map(([method, channel]) => [
    method, input => ipcRenderer.invoke(channel, input),
  ]),
]));

contextBridge.exposeInMainWorld("skyosHost", api);
