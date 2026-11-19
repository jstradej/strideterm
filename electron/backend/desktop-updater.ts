import { app, autoUpdater as nativeUpdater } from "electron";
import updater from "electron-updater";
import { chmodSync, constants, copyFileSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import type { AppDistribution } from "../shared/app-distribution.js";
import { AppUpdateFailure } from "./app-update-controller.js";
import { getLogger } from "./logger.js";

const log = getLogger("app-update");

function appImageFile(): string {
  const file = process.env.APPIMAGE;
  if (!file || !path.isAbsolute(file)) throw new Error("AppImage launcher path is missing or invalid");
  return file;
}

class RestartableAppImageUpdater extends updater.AppImageUpdater {
  protected override doInstall(): boolean {
    const downloadedFile = this.installerPath;
    if (!downloadedFile) throw new Error("No downloaded AppImage");
    const installedFile = appImageFile();
    const mode = statSync(installedFile).mode & 0o777;
    // The upstream installer deletes the old image before moving the download. Stage within
    // the installation directory so rename is atomic even if the download cache is on another volume.
    const stagingDir = mkdtempSync(path.join(path.dirname(installedFile), ".strideterm-update-"));
    try {
      const stagedFile = path.join(stagingDir, "strIDEterm.AppImage");
      copyFileSync(downloadedFile, stagedFile, constants.COPYFILE_FICLONE);
      chmodSync(stagedFile, mode);
      renameSync(stagedFile, installedFile);
    } finally {
      try {
        rmSync(stagingDir, { force: true, recursive: true });
      } catch (error) {
        log.warn("Could not remove AppImage staging directory", { stagingDir, error });
      }
    }
    // Electron starts the new image after this instance has released its single-instance lock.
    app.relaunch({ execPath: installedFile, args: process.argv.slice(1) });
    return true;
  }
}

export function createDesktopUpdater(distribution: AppDistribution) {
  const driver = distribution === "appimage" ? new RestartableAppImageUpdater() : updater.autoUpdater;
  driver.autoDownload = false;
  driver.autoInstallOnAppQuit = false;
  driver.allowPrerelease = false;
  driver.allowDowngrade = false;
  driver.disableWebInstaller = true;
  driver.logger = {
    info: (message) => log.info(String(message)),
    warn: (message) => log.warn(String(message)),
    error: (message) => log.error(String(message)),
  };

  return {
    checkForUpdates: () => driver.checkForUpdates(),
    downloadUpdate: () => driver.downloadUpdate(),
    onProgress: (handler: (percent: number) => void) =>
      driver.on("download-progress", ({ percent }) => handler(percent)),

    async preflight(downloadedFile: string): Promise<void> {
      await access(downloadedFile, constants.R_OK);
      if (distribution !== "appimage") return;
      try {
        const file = appImageFile();
        if (!(await lstat(file)).isFile()) throw new Error("AppImage launcher path is not a regular file");
        await access(file, constants.W_OK | constants.X_OK);
        await access(path.dirname(file), constants.W_OK | constants.X_OK);
      } catch (cause) {
        throw new AppUpdateFailure("Move the AppImage to a writable folder and launch it again.", false, { cause });
      }
    },

    async prepareInstall(): Promise<void> {
      if (distribution !== "macos") return;
      // MacUpdater has only cached the ZIP so far. Let Squirrel validate and stage it
      // after confirmation, while the runtime is still available if validation fails.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          nativeUpdater.removeListener("update-downloaded", success);
          nativeUpdater.removeListener("update-not-available", unavailable);
          nativeUpdater.removeListener("error", failure);
        };
        const success = () => {
          cleanup();
          resolve();
        };
        const failure = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const unavailable = () => failure(new Error("Squirrel could not find the downloaded update"));
        const timer = setTimeout(() => failure(new Error("Squirrel did not finish validating the update")), 120000);
        nativeUpdater.once("update-downloaded", success);
        nativeUpdater.once("update-not-available", unavailable);
        nativeUpdater.once("error", failure);
        try {
          nativeUpdater.checkForUpdates();
        } catch (error) {
          failure(error);
        }
      });
    },

    async quitAndInstall(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          nativeUpdater.removeListener("before-quit-for-update", success);
          driver.removeListener("error", failure);
        };
        const success = () => {
          cleanup();
          resolve();
        };
        const failure = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => failure(new Error("The installer did not request a restart")), 10000);
        nativeUpdater.once("before-quit-for-update", success);
        driver.once("error", failure);
        try {
          driver.quitAndInstall(true, true);
        } catch (error) {
          failure(error);
        }
      });
    },
  };
}
