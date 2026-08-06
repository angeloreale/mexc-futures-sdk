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
    // ── Updates ──────────────────────────────────────
    /** Current update snapshot (app version, latest versions, state) */
    getUpdateInfo: () => electron_1.ipcRenderer.invoke("get-update-info"),
    /** Check GitHub Releases for a newer app build */
    checkAppUpdate: () => electron_1.ipcRenderer.invoke("check-app-update"),
    /** Start downloading the available app update */
    downloadAppUpdate: () => electron_1.ipcRenderer.invoke("download-app-update"),
    /** Quit and install the downloaded app update */
    installAppUpdate: () => electron_1.ipcRenderer.invoke("install-app-update"),
    /** Check GitHub for a newer script-code bundle (dist.zip) */
    checkCodeUpdate: () => electron_1.ipcRenderer.invoke("check-code-update"),
    /** Download + swap in the latest script code, restarting the bot if running */
    refreshCode: () => electron_1.ipcRenderer.invoke("refresh-code"),
    /** Listen for update progress/status events */
    onUpdateEvent: (callback) => {
        const handler = (_event, payload) => callback(payload);
        electron_1.ipcRenderer.on("update-event", handler);
        // Return an unsubscribe function
        return () => electron_1.ipcRenderer.removeListener("update-event", handler);
    },
});
//# sourceMappingURL=preload.js.map