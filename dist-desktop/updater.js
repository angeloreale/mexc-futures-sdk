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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppUpdater = exports.CODE_ASSET_NAME = exports.GITHUB_REPO = exports.GITHUB_OWNER = void 0;
const electron_updater_1 = require("electron-updater");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const extract_zip_1 = __importDefault(require("extract-zip"));
// ── GitHub source of truth for code refreshes ──
// The packaged app ships with the compiled bot code in `dist/`. "Refreshing
// the code" pulls a newer compiled bundle (`dist.zip`) from a GitHub release
// and swaps it into a writable runtime folder, so users get the latest bot
// logic without reinstalling the whole app.
exports.GITHUB_OWNER = "dupipcom";
exports.GITHUB_REPO = "iris";
/** Name of the release asset that holds the compiled bot code. */
exports.CODE_ASSET_NAME = "dist.zip";
/**
 * Coordinates the two update mechanisms:
 *  1. Full-app updates via electron-updater (GitHub Releases).
 *  2. Script-code hot-swaps pulled from a `dist.zip` GitHub release asset.
 *
 * Emits a JSON `UpdateSnapshot` through the `send` callback on every change so
 * the renderer can render progress without polling.
 */
class AppUpdater {
    constructor(opts) {
        this.runtimeCodeDir = path.join(opts.userDataDir, "code");
        this.runtimeDistDir = path.join(this.runtimeCodeDir, "dist");
        this.versionFile = path.join(this.runtimeCodeDir, "version.json");
        this.send = opts.send;
        this.snapshot = {
            state: "idle",
            message: "Idle.",
            appVersion: opts.appVersion,
            latestAppVersion: null,
            codeVersion: this.readStoredCodeVersion(),
            latestCodeVersion: null,
            codeAssetUrl: null,
            downloadPercent: null,
        };
        this.configureAutoUpdater();
    }
    /** Current snapshot (a copy — callers can't mutate internal state). */
    getInfo() {
        return { ...this.snapshot };
    }
    /**
     * Absolute path of the writable folder the bot code is loaded from when a
     * refreshed bundle is installed; falls back to the bundled `dist/`.
     */
    static resolveBotCodeDir(userDataDir, bundledDir) {
        const runtime = path.join(userDataDir, "code", "dist");
        if (fs.existsSync(path.join(runtime, "bot", "config.js")))
            return runtime;
        return bundledDir;
    }
    /**
     * The bot's compiled code requires third-party packages (axios, telegraf,
     * …). When the code is loaded from the writable runtime folder it can't
     * resolve them itself, so we add the app's own bundled `node_modules` to
     * the module search path (NODE_PATH) and re-initialise the resolver cache.
     */
    static ensureNodeModulesPath(bundledNodeModulesDir) {
        const existing = process.env.NODE_PATH
            ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean)
            : [];
        if (!existing.includes(bundledNodeModulesDir)) {
            existing.push(bundledNodeModulesDir);
        }
        process.env.NODE_PATH = existing.join(path.delimiter);
        // NODE_PATH is cached at process start — make Node re-read it now.
        const Module = require("module");
        Module._initPaths?.();
    }
    // ── App updates (electron-updater) ────────────────
    configureAutoUpdater() {
        electron_updater_1.autoUpdater.autoDownload = false;
        electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
        electron_updater_1.autoUpdater.allowPrerelease = false;
        electron_updater_1.autoUpdater.logger = console;
        electron_updater_1.autoUpdater.on("checking-for-update", () => {
            this.setState("checking-app", "Checking for app updates…");
        });
        electron_updater_1.autoUpdater.on("update-available", (info) => {
            this.snapshot.latestAppVersion = info.version;
            this.setState("app-available", `App update available: v${info.version}`);
        });
        electron_updater_1.autoUpdater.on("update-not-available", (info) => {
            this.snapshot.latestAppVersion = info.version;
            this.setState("app-current", `You are on the latest app version (v${this.snapshot.appVersion}).`);
        });
        electron_updater_1.autoUpdater.on("download-progress", (p) => {
            this.snapshot.downloadPercent = Math.round(p.percent * 10) / 10;
            this.setState("downloading-app", `Downloading app update… ${this.snapshot.downloadPercent}%`);
        });
        electron_updater_1.autoUpdater.on("update-downloaded", (info) => {
            this.snapshot.downloadPercent = 100;
            this.setState("app-downloaded", `App update v${info.version} downloaded. Click “Install & Restart”.`);
        });
        electron_updater_1.autoUpdater.on("error", (err) => {
            const msg = err && err.message ? err.message : String(err);
            this.setState("error", `App update error: ${msg}`);
        });
    }
    /** Ask electron-updater to look for a newer app build on GitHub Releases. */
    async checkAppUpdate() {
        try {
            await electron_updater_1.autoUpdater.checkForUpdates();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState("error", `Could not check for app updates: ${msg}`);
        }
    }
    /** Start downloading the available app update (non-blocking). */
    downloadAppUpdate() {
        electron_updater_1.autoUpdater
            .downloadUpdate()
            .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState("error", `App download failed: ${msg}`);
        });
    }
    /** Quit and install the downloaded app update. */
    installAppUpdate() {
        electron_updater_1.autoUpdater.quitAndInstall(false, true);
    }
    // ── Script code updates (GitHub dist.zip asset) ───
    /** Query GitHub for the latest release and its dist.zip asset. */
    async checkCodeUpdate() {
        this.setState("checking-code", "Checking for script code updates…");
        try {
            const release = await this.fetchLatestRelease();
            if (!release) {
                this.setState("error", "No GitHub release found for this project — nothing to pull from.");
                return;
            }
            const tag = release.tag_name ? String(release.tag_name) : "";
            const asset = (release.assets || []).find((a) => a && a.name === exports.CODE_ASSET_NAME);
            this.snapshot.latestCodeVersion = tag || null;
            this.snapshot.codeAssetUrl = asset?.browser_download_url || null;
            if (this.snapshot.codeVersion === tag) {
                this.setState("code-current", `Script code is up to date (${tag || "latest"}).`);
            }
            else if (!asset) {
                this.setState("code-available", `Newer script code found (${tag || "latest"}) but no ${exports.CODE_ASSET_NAME} asset is attached to the release.`);
            }
            else {
                this.setState("code-available", `Script code update available: ${tag || "latest"}`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState("error", `Could not check for code updates: ${msg}`);
        }
    }
    /**
     * Download the latest dist.zip bundle, atomically swap it into the runtime
     * folder, and (if the bot was running) restart it on the new code.
     */
    async refreshCode(deps) {
        // Make sure we know the latest asset URL before downloading.
        if (!this.snapshot.codeAssetUrl) {
            await this.checkCodeUpdate();
        }
        const url = this.snapshot.codeAssetUrl;
        const tag = this.snapshot.latestCodeVersion;
        if (!url) {
            return {
                ok: false,
                message: `No ${exports.CODE_ASSET_NAME} bundle on the latest GitHub release — ` +
                    `publish one first (npm run dist:zip).`,
            };
        }
        const wasRunning = deps.isBotRunning();
        this.setState("refreshing-code", `Downloading script code${tag ? ` ${tag}` : ""}…`);
        // Stop the bot before swapping the code it is executing from.
        if (wasRunning) {
            await deps.stopBot();
        }
        const tmpRoot = path.join(this.runtimeCodeDir, `.staging-${Date.now()}`);
        const zipTmp = path.join(tmpRoot, "bundle.zip");
        const extractDir = path.join(tmpRoot, "extracted");
        fs.mkdirSync(extractDir, { recursive: true });
        try {
            // 1. Download the bundle with progress.
            const res = await fetch(url, {
                headers: { "User-Agent": "Dupip-Invest-Connector" },
            });
            if (!res.ok || !res.body) {
                throw new Error(`Download failed (HTTP ${res.status})`);
            }
            const total = Number(res.headers.get("content-length") || 0);
            let received = 0;
            const reader = res.body.getReader();
            const out = fs.createWriteStream(zipTmp);
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value) {
                    out.write(Buffer.from(value));
                    received += value.length;
                    if (total > 0) {
                        this.snapshot.downloadPercent = Math.min(100, Math.round((received / total) * 100));
                        this.setState("refreshing-code", `Downloading script code… ${this.snapshot.downloadPercent}%`);
                    }
                }
            }
            await new Promise((resolve, reject) => {
                out.end(() => resolve());
                out.on("error", reject);
            });
            // 2. Extract and verify the bundle shape.
            await (0, extract_zip_1.default)(zipTmp, { dir: extractDir });
            const candidate = path.join(extractDir, "dist", "bot", "config.js");
            if (!fs.existsSync(candidate)) {
                throw new Error("Downloaded bundle is invalid: missing dist/bot/config.js");
            }
            // 3. Atomic swap (keep a backup so a failed move can be rolled back).
            const newDist = path.join(extractDir, "dist");
            const backup = path.join(this.runtimeCodeDir, `.old-${Date.now()}`);
            let movedOld = false;
            try {
                if (fs.existsSync(this.runtimeDistDir)) {
                    fs.renameSync(this.runtimeDistDir, backup);
                    movedOld = true;
                }
                fs.renameSync(newDist, this.runtimeDistDir);
            }
            catch (swapErr) {
                if (movedOld &&
                    !fs.existsSync(this.runtimeDistDir) &&
                    fs.existsSync(backup)) {
                    fs.renameSync(backup, this.runtimeDistDir);
                }
                throw swapErr;
            }
            fs.rmSync(backup, { recursive: true, force: true });
            // 4. Persist which version is now running.
            fs.writeFileSync(this.versionFile, JSON.stringify({ version: tag || null, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
            this.snapshot.codeVersion = tag || null;
            this.snapshot.downloadPercent = 100;
            // 5. Cleanup and restart the bot if it was running.
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            this.setState("code-updated", `Script code refreshed to ${tag || "latest"}.`);
            if (wasRunning) {
                await deps.startBot().catch(() => {
                    /* bot start errors are surfaced on the Logs tab */
                });
            }
            return { ok: true, message: `Script code refreshed to ${tag || "latest"}.` };
        }
        catch (err) {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            const msg = err instanceof Error ? err.message : String(err);
            this.setState("error", `Code refresh failed: ${msg}`);
            return { ok: false, message: `Code refresh failed: ${msg}` };
        }
    }
    // ── Helpers ──────────────────────────────────────
    setState(state, message) {
        this.snapshot = { ...this.snapshot, state, message };
        this.send("update-event", JSON.stringify(this.snapshot));
    }
    readStoredCodeVersion() {
        try {
            if (fs.existsSync(this.versionFile)) {
                const data = JSON.parse(fs.readFileSync(this.versionFile, "utf-8"));
                if (data && typeof data.version === "string" && data.version) {
                    return data.version;
                }
            }
        }
        catch {
            /* corrupt or missing version file — treat as bundled */
        }
        return null;
    }
    async fetchLatestRelease() {
        const res = await fetch(`https://api.github.com/repos/${exports.GITHUB_OWNER}/${exports.GITHUB_REPO}/releases/latest`, {
            headers: {
                "User-Agent": "Dupip-Invest-Connector",
                Accept: "application/vnd.github+json",
            },
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
}
exports.AppUpdater = AppUpdater;
//# sourceMappingURL=updater.js.map