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
});
