import { autoUpdater, AppUpdater as ElectronAppUpdater } from "electron-updater";
import { shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import extract from "extract-zip";

// ── GitHub source of truth for code refreshes ──
// The packaged app ships with the compiled bot code in `dist/`. "Refreshing
// the code" pulls a newer compiled bundle (`dist.zip`) from the main branch
// and swaps it into a writable runtime folder, so users get the latest bot
// logic without reinstalling the whole app.
export const GITHUB_OWNER = "dupipcom";
export const GITHUB_REPO = "iris";
/** Name of the asset to pull from the main branch. */
export const CODE_ASSET_NAME = "dist.zip";

/**
 * Direct URL to the dist.zip committed on the main branch.
 * Using the raw main-branch file (instead of a GitHub Release asset) means
 * updates are available as soon as the zip is pushed — no release needed.
 */
export const CODE_ASSET_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/dist.zip`;

/**
 * GitHub API URL to get the latest commit SHA on main — used as the version
 * identifier so the updater knows whether the local copy is stale.
 */
export const CODE_VERSION_API_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/main`;

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
  /** Direct download URL for the app installer (set when update-available fires). */
  appDownloadUrl: string | null;
}

export interface RefreshDeps {
  isBotRunning: () => boolean;
  stopBot: () => Promise<void>;
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
      appDownloadUrl: null,
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
      // Capture the download URL so we can fetch manually (bypass sha512).
      const files = (info as any).files as Array<{ url: string }> | undefined;
      this.snapshot.appDownloadUrl = files?.[0]?.url ?? null;
      this.setState("app-available", `App update available: v${info.version}`);
    });
    autoUpdater.on("update-not-available", (info) => {
      this.snapshot.latestAppVersion = info.version;
      this.setState(
        "app-current",
        `You are on the latest app version (v${this.snapshot.appVersion}).`
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

  /**
   * Download the app installer manually (bypasses electron-updater's built-in
   * sha512 verification which can mismatch when the latest.yml was regenerated
   * without re-uploading all artifacts).
   */
  async downloadAppUpdate(): Promise<void> {
    const url = this.snapshot.appDownloadUrl;
    if (!url) {
      this.setState("error", "No app download URL available — check for updates first.");
      return;
    }

    this.setState("downloading-app", "Downloading app update…");
    this.snapshot.downloadPercent = 0;

    const tmpDir = path.join(this.runtimeCodeDir, ".app-update");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Derive the file extension from the URL so we support .exe, .dmg, .AppImage.
    const urlPath = new URL(url).pathname;
    const ext = path.extname(urlPath) || ".exe";
    // Remove query params that may be appended to the filename in the URL.
    const cleanExt = ext.split("?")[0];
    const installerPath = path.join(tmpDir, `installer${cleanExt}`);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Dupip-Invest-Connector" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed (HTTP ${res.status})`);
      }

      const total = Number(res.headers.get("content-length") || 0);
      let received = 0;
      const reader = res.body.getReader();
      const out = fs.createWriteStream(installerPath);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          out.write(Buffer.from(value));
          received += value.length;
          if (total > 0) {
            this.snapshot.downloadPercent = Math.min(100, Math.round((received / total) * 100));
            this.setState(
              "downloading-app",
              `Downloading app update… ${this.snapshot.downloadPercent}%`
            );
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });

      this.snapshot.downloadPercent = 100;
      this.setState(
        "app-downloaded",
        `App update v${this.snapshot.latestAppVersion ?? "?"} downloaded. Click “Install & Restart”.`
      );
    } catch (err) {
      // Clean up partial download
      try { fs.unlinkSync(installerPath); } catch { /* ok */ }
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `App download failed: ${msg}`);
    }
  }

  /**
   * Launch the downloaded installer. Uses shell.openPath which handles
   * .exe (NSIS on Windows), .dmg (macOS), and .AppImage (Linux).
   */
  installAppUpdate(): void {
    const tmpDir = path.join(this.runtimeCodeDir, ".app-update");
    if (!fs.existsSync(tmpDir)) {
      this.setState("error", "Installer not found — download it first.");
      return;
    }
    // Find the installer file (any extension).
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("installer"));
    if (files.length === 0) {
      this.setState("error", "Installer not found — download it first.");
      return;
    }
    const installerPath = path.join(tmpDir, files[0]);
    shell.openPath(installerPath).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `Failed to launch installer: ${msg}`);
    });
  }

  // ── Script code updates (GitHub dist.zip asset) ───

  /** Query GitHub for the latest main-branch commit SHA (used as version). */
  async checkCodeUpdate(): Promise<void> {
    this.setState("checking-code", "Checking for script code updates…");
    try {
      const latestSha = await this.fetchLatestMainSha();
      if (!latestSha) {
        this.setState(
          "error",
          "Could not determine latest main-branch commit — nothing to pull from."
        );
        return;
      }
      // Use the short SHA as the version tag.
      const tag = latestSha.slice(0, 7);
      this.snapshot.latestCodeVersion = tag;
      this.snapshot.codeAssetUrl = CODE_ASSET_URL;

      if (this.snapshot.codeVersion === tag) {
        this.setState(
          "code-current",
          `Script code is up to date (${tag}).`
        );
      } else {
        this.setState(
          "code-available",
          `Script code update available: ${tag}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState("error", `Could not check for code updates: ${msg}`);
    }
  }

  /**
   * Download the latest dist.zip from the main branch, atomically swap it
   * into the runtime folder, and (if the bot was running) restart it on the
   * new code.
   */
  async refreshCode(deps: RefreshDeps): Promise<{ ok: boolean; message: string }> {
    // Always resolve the URL fresh — it's the main-branch raw URL.
    const url = CODE_ASSET_URL;
    let tag = this.snapshot.latestCodeVersion;

    // If we haven't checked yet, fetch the latest SHA now.
    if (!tag) {
      await this.checkCodeUpdate();
      tag = this.snapshot.latestCodeVersion;
    }

    if (!url) {
      return {
        ok: false,
        message: `No ${CODE_ASSET_NAME} on main branch — push one first.`,
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

  private async fetchLatestMainSha(): Promise<string | null> {
    const res = await fetch(CODE_VERSION_API_URL, {
      headers: {
        "User-Agent": "Dupip-Invest-Connector",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return data?.sha || null;
  }
}
