import { contextBridge, ipcRenderer } from "electron";

/**
 * Secure bridge: exposes only the specific APIs the renderer needs.
 * The renderer never has direct access to Node.js or Electron APIs.
 */
contextBridge.exposeInMainWorld("botAPI", {
  /** Load saved configuration from disk */
  getConfig: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke("get-config"),

  /** Persist configuration to disk */
  saveConfig: (config: Record<string, string>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("save-config", config),

  /** Start the bot subprocess */
  startBot: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("start-bot"),

  /** Stop the running bot subprocess */
  stopBot: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("stop-bot"),

  /** Current bot status: "stopped" | "starting" | "running" | "stopping" | "error" */
  getBotStatus: (): Promise<string> =>
    ipcRenderer.invoke("get-bot-status"),

  /** Open the logs folder in the OS file manager */
  openLogDir: (): Promise<void> =>
    ipcRenderer.invoke("open-log-dir"),

  /** Open the config folder in the OS file manager */
  openConfigDir: (): Promise<void> =>
    ipcRenderer.invoke("open-config-dir"),

  /** Listen for bot log output and status changes */
  onBotEvent: (callback: (event: { channel: string; data: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { channel: string; data: string }) => callback(payload);
    ipcRenderer.on("bot-event", handler);
    // Return an unsubscribe function
    return () => ipcRenderer.removeListener("bot-event", handler);
  },

  // ── Updates ──────────────────────────────────────
  /** Current update snapshot (app version, latest versions, state) */
  getUpdateInfo: (): Promise<object | null> =>
    ipcRenderer.invoke("get-update-info"),

  /** Check GitHub Releases for a newer app build */
  checkAppUpdate: (): Promise<object | null> =>
    ipcRenderer.invoke("check-app-update"),

  /** Start downloading the available app update */
  downloadAppUpdate: (): Promise<object | null> =>
    ipcRenderer.invoke("download-app-update"),

  /** Quit and install the downloaded app update */
  installAppUpdate: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("install-app-update"),

  /** Check GitHub for a newer script-code bundle (dist.zip) */
  checkCodeUpdate: (): Promise<object | null> =>
    ipcRenderer.invoke("check-code-update"),

  /** Download + swap in the latest script code, restarting the bot if running */
  refreshCode: (): Promise<{ ok: boolean; message: string; info: object | null }> =>
    ipcRenderer.invoke("refresh-code"),

  /** Listen for update progress/status events */
  onUpdateEvent: (callback: (event: { channel: string; data: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { channel: string; data: string }) => callback(payload);
    ipcRenderer.on("update-event", handler);
    // Return an unsubscribe function
    return () => ipcRenderer.removeListener("update-event", handler);
  },
});
