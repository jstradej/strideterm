import type { AppDistribution } from "../shared/app-distribution.js";
import type { AppUpdateStatus } from "../shared/app-update.js";
import { compareVersions, parseVersion } from "./version-checker.js";

export function supportsAppUpdates({
  distribution,
  version,
  hasFeed,
}: {
  distribution: AppDistribution;
  version: string;
  hasFeed: boolean;
}): boolean {
  return (
    hasFeed &&
    parseVersion(version) !== null &&
    (distribution === "windows-installer" || distribution === "macos" || distribution === "appimage")
  );
}

interface UpdateDriver {
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<string[]>;
  onProgress(handler: (percent: number) => void): void;
}

export class AppUpdateFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function createAppUpdateController({
  enabled,
  currentVersion,
  loadDriver,
  publishStatus,
  logFailure,
}: {
  enabled: boolean;
  currentVersion: string;
  loadDriver: () => UpdateDriver;
  publishStatus: (status: AppUpdateStatus) => void;
  logFailure: (phase: AppUpdateStatus["phase"], error: unknown) => void;
}) {
  let status: AppUpdateStatus = { phase: enabled ? "idle" : "unsupported" };
  let driver: UpdateDriver | undefined;
  let downloadedFile: string | undefined;

  function setStatus(next: AppUpdateStatus): void {
    status = next;
    publishStatus(next);
  }

  function fail(error: unknown, message: string): void {
    logFailure(status.phase, error);
    setStatus({
      phase: "failed",
      message: error instanceof AppUpdateFailure ? error.message : message,
      retryable: error instanceof AppUpdateFailure ? error.retryable : true,
    });
  }

  return {
    getStatus: () => status,

    async checkAndDownload(): Promise<void> {
      if (status.phase !== "idle" && status.phase !== "current" && status.phase !== "failed") return;
      if (status.phase === "failed" && !status.retryable) return;
      downloadedFile = undefined;
      setStatus({ phase: "checking" });
      try {
        if (!driver) {
          driver = loadDriver();
          driver.onProgress((value) => {
            if (status.phase !== "downloading" || !Number.isFinite(value)) return;
            const percent = Math.max(status.percent, Math.min(100, Math.floor(value)));
            if (percent !== status.percent) setStatus({ ...status, percent });
          });
        }
        const update = await driver.checkForUpdates();
        if (!update) throw new Error("Updater returned no release information");
        const { version } = update.updateInfo;
        if (!parseVersion(version)) throw new Error("Update feed returned a version outside the stable channel");
        if (!update.isUpdateAvailable || compareVersions(version, currentVersion) <= 0) {
          setStatus({ phase: "current" });
          return;
        }
        setStatus({ phase: "downloading", version, percent: 0 });
        [downloadedFile] = await driver.downloadUpdate();
        if (!downloadedFile) throw new Error("Updater returned no downloaded file");
        setStatus({ phase: "ready", version });
      } catch (error) {
        fail(error, "Could not check for or download the update. Try again or download it from GitHub.");
      }
    },

    async restart(install: (downloadedFile: string) => Promise<boolean>): Promise<void> {
      if (status.phase !== "ready" || !downloadedFile) return;
      const ready = status;
      setStatus({ phase: "restarting", version: ready.version });
      try {
        if (!(await install(downloadedFile))) setStatus(ready);
      } catch (error) {
        fail(error, "Could not install the update. Restart strIDEterm and try again, or download it from GitHub.");
      }
    },
  };
}
