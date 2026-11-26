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
});

function createPreloadApi(invoke) {
  if (typeof invoke !== "function") throw new TypeError("ipc_invoke_required");
  return Object.freeze(Object.fromEntries([
    ["mode", "electron"],
    ...Object.entries(CHANNELS).map(([method, channel]) => [
      method, input => invoke(channel, input),
    ]),
  ]));
}

module.exports = { createPreloadApi, PRELOAD_CHANNELS: CHANNELS };
