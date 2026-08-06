import { autoUpdater } from "electron-updater";
import * as fs from "fs";
import * as path from "path";
import extract from "extract-zip";

// ── GitHub source of truth for code refreshes ──
// The packaged app ships with the compiled bot code in `dist/`. "Refreshing
// the code" pulls a newer compiled bundle (`dist.zip`) from a GitHub release
// and swaps it into a writable runtime folder, so users get the latest bot
// logic without reinstalling the whole app.
export const GITHUB_OWNER = "dupipcom";
export const GITHUB_REPO = "iris";
/** Name of the release asset that holds the compiled bot code. */
export const CODE_ASSET_NAME = "dist.zip";

/** Well-known states the update UI reacts to. */
export type UpdateState =
  | "idle"
  | "checking-app"
  | "app-available"
  | "app-current"
  | "downloading-app"
  | "app-downloaded"
  | "checking-code"
  | "code-available"
  | "code-current"
  | "refreshing-code"
  | "code-updated"
  | "error";

/** Serializable snapshot pushed to the renderer. */
export interface UpdateSnapshot {
  state: UpdateState;
  message: string;
  /** Version of the running desktop app (from package.json). */
  appVersion: string;
  /** Latest app version reported by electron-updater (GitHub Releases). */
  latestAppVersion: string | null;
  /** Version of the running script code, or null when using the bundled code. */
  codeVersion: string | null;
  /** Latest script code version (GitHub release tag), or null when unknown. */
  latestCodeVersion: string | null;
  /** Direct download URL of the dist.zip asset on the latest release. */
  codeAssetUrl: string | null;
  /** Download progress 0–100 for either update type. */
  downloadPercent: number | null;
}

export interface RefreshDeps {
  isBotRunning: () => boolean;
  stopBot: () => void;
  startBot: () => Promise<void>;
}

/**
 * Coordinates the two update mechanisms:
 *  1. Full-app updates via electron-updater (GitHub Releases).
 *  2. Script-code hot-swaps pulled from a `dist.zip` GitHub release asset.
 *
 * Emits a JSON `UpdateSnapshot` through the `send` callback on every change so
 * the renderer can render progress without polling.
 */
export class AppUpdater {
  readonly runtimeCodeDir: string;
  readonly runtimeDistDir: string;
  private readonly versionFile: string;
  private readonly send: (channel: string, data: string) => void;
  private snapshot: UpdateSnapshot;

  constructor(opts: {
    userDataDir: string;
    appVersion: string;
    send: (channel: string, data: string) => void;
  }) {
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
  getInfo(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Absolute path of the writable folder the bot code is loaded from when a
   * refreshed bundle is installed; falls back to the bundled `dist/`.
   */
  static resolveBotCodeDir(userDataDir: string, bundledDir: string): string {
    const runtime = path.join(userDataDir, "code", "dist");
    if (fs.existsSync(path.join(runtime, "bot", "config.js"))) return runtime;
    return bundledDir;
  }

  /**
   * The bot's compiled code requires third-party packages (axios, telegraf,
   * …). When the code is loaded from the writable runtime folder it can't
   * resolve them itself, so we add the app's own bundled `node_modules` to
   * the module search path (NODE_PATH) and re-initialise the resolver cache.
   */
  static ensureNodeModulesPath(bundledNodeModulesDir: string): void {
    const existing = process.env.NODE_PATH
      ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean)
      : [];
    if (!existing.includes(bundledNodeModulesDir)) {
      existing.push(bundledNodeModulesDir);
    }
    process.env.NODE_PATH = existing.join(path.delimiter);
    // NODE_PATH is cached at process start — make Node re-read it now.
    const Module = require("module") as { _initPaths?: () => void };
    Module._initPaths?.();
  }

  // ── App updates (electron-updater) ────────────────

  private configureAutoUpdater(): void {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = console;

    autoUpdater.on("checking-for-update", () => {
      this.setState("checking-app", "Checking for app updates…");
    });
    autoUpdater.on("update-available", (info) => {
      this.snapshot.latestAppVersion = info.version;
      this.setState("app-available", `App update available: v${info.version}`);
    });
    autoUpdater.on("update-not-available", (info) => {
      this.snapshot.latestAppVersion = info.version;
      this.setState(
        "app-current",
        `You are on the latest app version (v${this.snapshot.appVersion}).`
      );
    });
    autoUpdater.on("download-progress", (p) => {
      this.snapshot.downloadPercent = Math.round(p.percent * 10) / 10;
      this.setState(
        "downloading-app",
        `Downloading app update… ${this.snapshot.downloadPercent}%`
      );
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.snapshot.downloadPercent = 100;
      this.setState(
        "app-downloaded",
        `App update v${info.version} downloaded. Click “Install & Restart”.`
      );
    });
    autoUpdater.on("error", (err) => {
      const msg = err && (err as Error).message ? (err as Error).message : String(err);
      this.setState("error", `App update error: ${msg}`);
    });
  }

  /** Ask electron-updater to look for a newer app build on GitHub Releases. */
  async checkAppUpdate(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `Could not check for app updates: ${msg}`);
    }
  }

  /** Start downloading the available app update (non-blocking). */
  downloadAppUpdate(): void {
    autoUpdater
      .downloadUpdate()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.setState("error", `App download failed: ${msg}`);
      });
  }

  /** Quit and install the downloaded app update. */
  installAppUpdate(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  // ── Script code updates (GitHub dist.zip asset) ───

  /** Query GitHub for the latest release and its dist.zip asset. */
  async checkCodeUpdate(): Promise<void> {
    this.setState("checking-code", "Checking for script code updates…");
    try {
      const release = await this.fetchLatestRelease();
      if (!release) {
        this.setState(
          "error",
          "No GitHub release found for this project — nothing to pull from."
        );
        return;
      }
      const tag = release.tag_name ? String(release.tag_name) : "";
      const asset = (release.assets || []).find(
        (a: { name?: string }) => a && a.name === CODE_ASSET_NAME
      );
      this.snapshot.latestCodeVersion = tag || null;
      this.snapshot.codeAssetUrl = asset?.browser_download_url || null;

      if (this.snapshot.codeVersion === tag) {
        this.setState(
          "code-current",
          `Script code is up to date (${tag || "latest"}).`
        );
      } else if (!asset) {
        this.setState(
          "code-available",
          `Newer script code found (${tag || "latest"}) but no ${CODE_ASSET_NAME} asset is attached to the release.`
        );
      } else {
        this.setState(
          "code-available",
          `Script code update available: ${tag || "latest"}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `Could not check for code updates: ${msg}`);
    }
  }

  /**
   * Download the latest dist.zip bundle, atomically swap it into the runtime
   * folder, and (if the bot was running) restart it on the new code.
   */
  async refreshCode(deps: RefreshDeps): Promise<{ ok: boolean; message: string }> {
    // Make sure we know the latest asset URL before downloading.
    if (!this.snapshot.codeAssetUrl) {
      await this.checkCodeUpdate();
    }
    const url = this.snapshot.codeAssetUrl;
    const tag = this.snapshot.latestCodeVersion;

    if (!url) {
      return {
        ok: false,
        message:
          `No ${CODE_ASSET_NAME} bundle on the latest GitHub release — ` +
          `publish one first (npm run dist:zip).`,
      };
    }

    const wasRunning = deps.isBotRunning();
    this.setState("refreshing-code", `Downloading script code${tag ? ` ${tag}` : ""}…`);

    // Stop the bot before swapping the code it is executing from.
    if (wasRunning) {
      deps.stopBot();
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
        if (done) break;
        if (value) {
          out.write(Buffer.from(value));
          received += value.length;
          if (total > 0) {
            this.snapshot.downloadPercent = Math.min(
              100,
              Math.round((received / total) * 100)
            );
            this.setState(
              "refreshing-code",
              `Downloading script code… ${this.snapshot.downloadPercent}%`
            );
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });

      // 2. Extract and verify the bundle shape.
      await extract(zipTmp, { dir: extractDir });
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
      } catch (swapErr) {
        if (
          movedOld &&
          !fs.existsSync(this.runtimeDistDir) &&
          fs.existsSync(backup)
        ) {
          fs.renameSync(backup, this.runtimeDistDir);
        }
        throw swapErr;
      }
      fs.rmSync(backup, { recursive: true, force: true });

      // 4. Persist which version is now running.
      fs.writeFileSync(
        this.versionFile,
        JSON.stringify(
          { version: tag || null, updatedAt: new Date().toISOString() },
          null,
          2
        ),
        "utf-8"
      );
      this.snapshot.codeVersion = tag || null;
      this.snapshot.downloadPercent = 100;

      // 5. Cleanup and restart the bot if it was running.
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      this.setState(
        "code-updated",
        `Script code refreshed to ${tag || "latest"}.`
      );
      if (wasRunning) {
        await deps.startBot().catch(() => {
          /* bot start errors are surfaced on the Logs tab */
        });
      }
      return { ok: true, message: `Script code refreshed to ${tag || "latest"}.` };
    } catch (err) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `Code refresh failed: ${msg}`);
      return { ok: false, message: `Code refresh failed: ${msg}` };
    }
  }

  // ── Helpers ──────────────────────────────────────

  private setState(state: UpdateState, message: string): void {
    this.snapshot = { ...this.snapshot, state, message };
    this.send("update-event", JSON.stringify(this.snapshot));
  }

  private readStoredCodeVersion(): string | null {
    try {
      if (fs.existsSync(this.versionFile)) {
        const data = JSON.parse(fs.readFileSync(this.versionFile, "utf-8"));
        if (data && typeof data.version === "string" && data.version) {
          return data.version;
        }
      }
    } catch {
      /* corrupt or missing version file — treat as bundled */
    }
    return null;
  }

  private async fetchLatestRelease(): Promise<{
    tag_name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  } | null> {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          "User-Agent": "Dupip-Invest-Connector",
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
  }
}
