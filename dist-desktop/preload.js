"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
/**
 * Secure bridge: exposes only the specific APIs the renderer needs.
 * The renderer never has direct access to Node.js or Electron APIs.
 */
electron_1.contextBridge.exposeInMainWorld("botAPI", {
    /** Load saved configuration from disk */
    getConfig: () => electron_1.ipcRenderer.invoke("get-config"),
    /** Persist configuration to disk */
    saveConfig: (config) => electron_1.ipcRenderer.invoke("save-config", config),
    /** Start the bot subprocess */
    startBot: () => electron_1.ipcRenderer.invoke("start-bot"),
    /** Stop the running bot subprocess */
    stopBot: () => electron_1.ipcRenderer.invoke("stop-bot"),
    /** Current bot status: "stopped" | "starting" | "running" | "stopping" | "error" */
    getBotStatus: () => electron_1.ipcRenderer.invoke("get-bot-status"),
    /** Open the logs folder in the OS file manager */
    openLogDir: () => electron_1.ipcRenderer.invoke("open-log-dir"),
    /** Open the config folder in the OS file manager */
    openConfigDir: () => electron_1.ipcRenderer.invoke("open-config-dir"),
    /** Listen for bot log output and status changes */
    onBotEvent: (callback) => {
        const handler = (_event, payload) => callback(payload);
        electron_1.ipcRenderer.on("bot-event", handler);
        // Return an unsubscribe function
        return () => electron_1.ipcRenderer.removeListener("bot-event", handler);
    },
});
//# sourceMappingURL=preload.js.map