/**
 * Which build of strIDEterm is running. It decides where updates come from: a Microsoft Store install
 * is updated by the Store, every other packaged build by a new download from GitHub releases.
 *
 * Decided once in the Electron main process (`electron/main.ts`) and handed to the runtime, which
 * cannot import Electron; it reaches every client — desktop and remote — as `meta.distribution`.
 */
export type AppDistribution =
  "microsoft-store" | "portable" | "windows-installer" | "macos" | "appimage" | "linux-package" | "development";

export interface AppDistributionInput {
  /** Electron's `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.platform`. */
  platform: string;
  /** Electron's `process.windowsStore`: true inside the Store's AppX container. */
  windowsStore: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Launcher variables the detection reads. Inherited by every child process, so session-manager.ts
 * strips them from terminals: a strIDEterm started from one would otherwise take itself for portable
 * or an AppImage.
 */
export const DISTRIBUTION_LAUNCHER_ENV = Object.freeze([
  "PORTABLE_EXECUTABLE_DIR",
  "PORTABLE_EXECUTABLE_FILE",
  "PORTABLE_EXECUTABLE_APP_FILENAME",
  "APPIMAGE",
] as const);

export function detectAppDistribution({
  isPackaged,
  platform,
  windowsStore,
  env,
}: AppDistributionInput): AppDistribution {
  if (!isPackaged) return "development";
  if (platform === "win32") {
    if (windowsStore) return "microsoft-store";
    // electron-builder's portable launcher sets these before it starts the unpacked app
    // (app-builder-lib/templates/nsis/portable.nsi, `SetEnvironmentVariable`).
    if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return "portable";
    return "windows-installer";
  }
  if (platform === "darwin") return "macos";
  // The AppImage runtime exports the .AppImage file's path as APPIMAGE; electron-builder's AppRun
  // treats its absence as "not running from within an AppImage" (app-builder-lib appImageUtil.js).
  if (env.APPIMAGE) return "appimage";
  return "linux-package";
}

/**
 * What the update check reports for a Microsoft Store install instead of a GitHub comparison: GitHub
 * publishes a release before Microsoft has certified it, so "N updates behind" would announce a
 * version the Store cannot deliver yet, and its download would install a second copy beside the
 * Store one.
 */
export interface MicrosoftStoreUpdateStatus {
  updateChannel: "microsoft-store";
  storeUrl: string;
}
