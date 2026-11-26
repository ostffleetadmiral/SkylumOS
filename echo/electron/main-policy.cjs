const IPC_CHANNELS = Object.freeze([
  "skyos:status", "skyos:claims:list", "skyos:claims:read",
  "skyos:volumes:list", "skyos:volumes:load", "skyos:volumes:save",
  "skyos:volumes:delete", "skyos:infer", "skyos:door:send", "skyos:door:recv",
  "skyos:quine:reemit", "skyos:volume:export", "skyos:volume:import",
  "skyos:artifact:export", "skyos:bridge:enable", "skyos:bridge:status",
  "skyos:hw:probe", "skyos:optical:sources",
  "skyos:services:status", "skyos:services:ensure",
  "skyos:fabric:request",
]);

function validateSender(event, expectedWebContents, rendererUrl) {
  if (event.sender !== expectedWebContents) throw new Error("ipc_sender_denied");
  if (!event.senderFrame || event.senderFrame.url !== rendererUrl)
    throw new Error("ipc_frame_denied");
}

function registerHostHandlers(ipcMain, { webContents, actions, rendererUrl }) {
  if (!ipcMain || typeof ipcMain.handle !== "function" ||
      typeof ipcMain.removeHandler !== "function" || !webContents || !actions ||
      typeof rendererUrl !== "string")
    throw new Error("ipc_registration_invalid");
  for (const channel of IPC_CHANNELS) {
    const action = actions[channel];
    if (typeof action !== "function") throw new Error(`ipc_action_missing:${channel}`);
    ipcMain.handle(channel, async (event, input) => {
      validateSender(event, webContents, rendererUrl);
      return action(input);
    });
  }
  return () => {
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerHostHandlers, ELECTRON_IPC_CHANNELS: IPC_CHANNELS };
