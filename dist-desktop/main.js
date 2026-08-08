"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const updater_1 = require("./updater");
// ── Paths (lazy-initialized after app is ready) ──
let USER_DATA_DIR = "";
let CONFIG_PATH = "";
let STATE_PATH = "";
let LOG_DIR = "";
function initPaths() {
    USER_DATA_DIR = electron_1.app.getPath("userData");
    CONFIG_PATH = path.join(USER_DATA_DIR, "bot-config.json");
    STATE_PATH = path.join(USER_DATA_DIR, "bot-state.json");
    LOG_DIR = path.join(USER_DATA_DIR, "logs");
}
/**
 * Where to load the bot code from: the writable runtime folder (if a code
 * refresh has been installed) or the app's own bundled dist/. Resolved fresh
 * on every start so a refresh is picked up immediately on restart.
 */
function getRuntimeDistDir() {
    return updater_1.AppUpdater.resolveBotCodeDir(USER_DATA_DIR, path.join(__dirname, "..", "dist"));
}
let mainWindow = null;
let botInstance = null;
let botRunning = false;
let updater = null;
function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        }
    }
    catch { /* ignore */ }
    return {};
}
function saveConfig(config) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
// ── Log capture ──────────────────────────────────
// Intercept console output and forward to the renderer's log panel.
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const origInfo = console.info;
function hookConsole() {
    console.log = (...args) => {
        const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        sendToRenderer("log", text);
        origLog.apply(console, args);
    };
    console.error = (...args) => {
        const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        sendToRenderer("log", `[error] ${text}`);
        origError.apply(console, args);
    };
    console.warn = (...args) => {
        const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        sendToRenderer("log", `[warn] ${text}`);
        origWarn.apply(console, args);
    };
    console.info = (...args) => {
        const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        sendToRenderer("log", text);
        origInfo.apply(console, args);
    };
}
function unhookConsole() {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
}
// ── Window ───────────────────────────────────────
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
        electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}
// ── Bot Lifecycle ────────────────────────────────
async function startBot() {
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
        updater_1.AppUpdater.ensureNodeModulesPath(path.join(__dirname, "..", "node_modules"));
        // Dynamically import the bot module (runs in-process)
        const { loadConfig } = require(path.join(codeDir, "bot", "config"));
        const { SignalBot } = require(path.join(codeDir, "bot", "bot"));
        const botConfig = loadConfig();
        const bot = new SignalBot(botConfig);
        await bot.start();
        botInstance = bot;
        botRunning = true;
        sendToRenderer("status", "running");
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendToRenderer("log", `❌ Failed to start: ${msg}`);
        sendToRenderer("status", "error");
        unhookConsole();
    }
}
async function stopBot() {
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
    if (bot && typeof bot.stop === "function") {
        try {
            await bot.stop();
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            sendToRenderer("log", `⚠️ Error while stopping: ${msg}`);
        }
    }
    sendToRenderer("status", "stopped");
}
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bot-event", { channel, data });
    }
}
// ── IPC Handlers ─────────────────────────────────
function setupIPC() {
    electron_1.ipcMain.handle("get-config", () => getConfig());
    electron_1.ipcMain.handle("save-config", (_event, config) => {
        saveConfig(config);
        return { ok: true };
    });
    electron_1.ipcMain.handle("start-bot", async () => {
        await startBot();
        return { ok: true };
    });
    electron_1.ipcMain.handle("stop-bot", async () => {
        await stopBot();
        return { ok: true };
    });
    electron_1.ipcMain.handle("get-bot-status", () => {
        return botRunning ? "running" : "stopped";
    });
    electron_1.ipcMain.handle("open-log-dir", () => {
        electron_1.shell.openPath(LOG_DIR);
    });
    electron_1.ipcMain.handle("open-config-dir", () => {
        electron_1.shell.openPath(USER_DATA_DIR);
    });
    // ── Update IPC ────────────────────────────────────
    electron_1.ipcMain.handle("get-update-info", () => updater?.getInfo() ?? null);
    electron_1.ipcMain.handle("check-app-update", async () => {
        await updater?.checkAppUpdate();
        return updater?.getInfo() ?? null;
    });
    electron_1.ipcMain.handle("download-app-update", () => {
        updater?.downloadAppUpdate();
        return updater?.getInfo() ?? null;
    });
    electron_1.ipcMain.handle("install-app-update", () => {
        updater?.installAppUpdate();
        return { ok: true };
    });
    electron_1.ipcMain.handle("check-code-update", async () => {
        await updater?.checkCodeUpdate();
        return updater?.getInfo() ?? null;
    });
    electron_1.ipcMain.handle("refresh-code", async () => {
        if (!updater)
            return { ok: false, message: "Updater not initialised.", info: null };
        const res = await updater.refreshCode({
            isBotRunning: () => botRunning,
            stopBot,
            startBot,
        });
        return { ...res, info: updater.getInfo() };
    });
}
// ── App Lifecycle ────────────────────────────────
electron_1.app.whenReady().then(() => {
    initPaths();
    setupIPC();
    updater = new updater_1.AppUpdater({
        userDataDir: USER_DATA_DIR,
        appVersion: electron_1.app.getVersion(),
        send: (channel, data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("update-event", { channel, data });
            }
        },
    });
    createWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", () => {
    void stopBot();
});
//# sourceMappingURL=main.js.map