import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import { AppUpdater } from "./updater";

// ── Paths (lazy-initialized after app is ready) ──
let USER_DATA_DIR = "";
let CONFIG_PATH = "";
let STATE_PATH = "";
let LOG_DIR = "";

function initPaths(): void {
  USER_DATA_DIR = app.getPath("userData");
  CONFIG_PATH = path.join(USER_DATA_DIR, "bot-config.json");
  STATE_PATH = path.join(USER_DATA_DIR, "bot-state.json");
  LOG_DIR = path.join(USER_DATA_DIR, "logs");
}

/**
 * Where to load the bot code from: the writable runtime folder (if a code
 * refresh has been installed) or the app's own bundled dist/. Resolved fresh
 * on every start so a refresh is picked up immediately on restart.
 */
function getRuntimeDistDir(): string {
  return AppUpdater.resolveBotCodeDir(
    USER_DATA_DIR,
    path.join(__dirname, "..", "dist")
  );
}

let mainWindow: BrowserWindow | null = null;
let botInstance: { stop?: () => void } | null = null;
let botRunning = false;
let updater: AppUpdater | null = null;

function getConfig(): Record<string, string> {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(config: Record<string, string>): void {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ── Log capture ──────────────────────────────────
// Intercept console output and forward to the renderer's log panel.
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const origInfo = console.info;

function hookConsole(): void {
  console.log = (...args: unknown[]) => {
    const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    sendToRenderer("log", text);
    origLog.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    sendToRenderer("log", `[error] ${text}`);
    origError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    sendToRenderer("log", `[warn] ${text}`);
    origWarn.apply(console, args);
  };
  console.info = (...args: unknown[]) => {
    const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    sendToRenderer("log", text);
    origInfo.apply(console, args);
  };
}

function unhookConsole(): void {
  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
  console.info = origInfo;
}

// ── Window ───────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    title: "Dupip Crypto Connector",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "desktop", "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Bot Lifecycle ────────────────────────────────
async function startBot(): Promise<void> {
  if (botRunning) {
    sendToRenderer("log", "⚠️  Already running.");
    return;
  }

  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN) {
    sendToRenderer("log", "❌ Cannot start: TELEGRAM_BOT_TOKEN is not set.");
    sendToRenderer("status", "missing-config");
    return;
  }
  if (!config.MEXC_KEY && !config.MEXC_AUTH_TOKEN) {
    sendToRenderer("log", "❌ Cannot start: MEXC_KEY or MEXC_AUTH_TOKEN is not set.");
    sendToRenderer("status", "missing-config");
    return;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Inject env vars that the bot's loadConfig() reads from process.env
  for (const [key, value] of Object.entries(config)) {
    process.env[key] = value;
  }
  process.env.STATE_FILE_PATH = STATE_PATH;
  process.env.LOG_DIR = LOG_DIR;

  hookConsole();
  sendToRenderer("log", "🚀 Starting Dupip Crypto Connector...");
  const codeDir = getRuntimeDistDir();
  if (codeDir !== path.join(__dirname, "..", "dist")) {
    sendToRenderer("log", `📦 Running script code from: ${codeDir}`);
  }
  sendToRenderer("status", "starting");

  try {
    // Make the bot's third-party deps (axios, telegraf, …) resolvable even
    // when its code lives in the writable runtime folder instead of the asar.
    AppUpdater.ensureNodeModulesPath(path.join(__dirname, "..", "node_modules"));

    // Dynamically import the bot module (runs in-process)
    const { loadConfig } = require(path.join(codeDir, "bot", "config"));
    const { SignalBot } = require(path.join(codeDir, "bot", "bot"));

    const botConfig = loadConfig();
    const bot = new SignalBot(botConfig);
    await bot.start();

    botInstance = bot;
    botRunning = true;
    sendToRenderer("status", "running");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendToRenderer("log", `❌ Failed to start: ${msg}`);
    sendToRenderer("status", "error");
    unhookConsole();
  }
}

async function stopBot(): Promise<void> {
  if (!botRunning) {
    sendToRenderer("log", "⚠️  Not running.");
    return;
  }

  sendToRenderer("log", "🛑 Stopping...");
  sendToRenderer("status", "stopping");

  // Clear state immediately so a rapid re-start/refresh can't double-stop,
  // then actually shut the bot down (stops Telegram polling + monitors).
  const bot = botInstance;
  botInstance = null;
  botRunning = false;
  unhookConsole();

  if (bot && typeof (bot as any).stop === "function") {
    try {
      await (bot as any).stop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendToRenderer("log", `⚠️ Error while stopping: ${msg}`);
    }
  }

  sendToRenderer("status", "stopped");
}

function sendToRenderer(channel: string, data: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bot-event", { channel, data });
  }
}

// ── IPC Handlers ─────────────────────────────────
function setupIPC(): void {
  ipcMain.handle("get-config", () => getConfig());

  ipcMain.handle("save-config", (_event, config: Record<string, string>) => {
    saveConfig(config);
    return { ok: true };
  });

  ipcMain.handle("start-bot", async () => {
    await startBot();
    return { ok: true };
  });

  ipcMain.handle("stop-bot", async () => {
    await stopBot();
    return { ok: true };
  });

  ipcMain.handle("get-bot-status", () => {
    return botRunning ? "running" : "stopped";
  });

  ipcMain.handle("open-log-dir", () => {
    shell.openPath(LOG_DIR);
  });

  ipcMain.handle("open-config-dir", () => {
    shell.openPath(USER_DATA_DIR);
  });

  // ── Update IPC ────────────────────────────────────
  ipcMain.handle("get-update-info", () => updater?.getInfo() ?? null);

  ipcMain.handle("check-app-update", async () => {
    await updater?.checkAppUpdate();
    return updater?.getInfo() ?? null;
  });

  ipcMain.handle("download-app-update", () => {
    updater?.downloadAppUpdate();
    return updater?.getInfo() ?? null;
  });

  ipcMain.handle("install-app-update", () => {
    updater?.installAppUpdate();
    return { ok: true };
  });

  ipcMain.handle("check-code-update", async () => {
    await updater?.checkCodeUpdate();
    return updater?.getInfo() ?? null;
  });

  ipcMain.handle("refresh-code", async () => {
    if (!updater) return { ok: false, message: "Updater not initialised.", info: null };
    const res = await updater.refreshCode({
      isBotRunning: () => botRunning,
      stopBot,
      startBot,
    });
    return { ...res, info: updater.getInfo() };
  });
}

// ── App Lifecycle ────────────────────────────────
app.whenReady().then(() => {
  initPaths();
  setupIPC();

  updater = new AppUpdater({
    userDataDir: USER_DATA_DIR,
    appVersion: app.getVersion(),
    send: (channel, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-event", { channel, data });
      }
    },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void stopBot();
});
