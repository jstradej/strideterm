import { describe, expect, test, vi } from "vitest";
import { createAppUpdateController, supportsAppUpdates } from "./app-update-controller.js";
import type { AppDistribution } from "../shared/app-distribution.js";
import type { AppUpdateStatus } from "../shared/app-update.js";

describe("desktop update eligibility", () => {
  for (const distribution of ["windows-installer", "macos", "appimage"] as const) {
    test(`supports stable ${distribution} builds with a feed`, () => {
      expect(supportsAppUpdates({ distribution, version: "3.4.0", hasFeed: true })).toBe(true);
      expect(supportsAppUpdates({ distribution, version: "3.4.0", hasFeed: false })).toBe(false);
      expect(supportsAppUpdates({ distribution, version: "3.4.0-nightly.1", hasFeed: true })).toBe(false);
    });
  }
  test.each<AppDistribution>(["development", "microsoft-store", "portable", "linux-package"])(
    "keeps %s on its distribution's update path",
    (distribution) => expect(supportsAppUpdates({ distribution, version: "3.4.0", hasFeed: true })).toBe(false),
  );
});

function fixture(enabled = true) {
  const statuses: AppUpdateStatus[] = [];
  let progress: ((percent: number) => void) | undefined;
  const driver = {
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "3.5.0" } })),
    downloadUpdate: vi.fn(async () => ["/cache/installer"]),
    onProgress: vi.fn((handler: (percent: number) => void) => {
      progress = handler;
    }),
  };
  const loadDriver = vi.fn(() => driver);
  const logFailure = vi.fn();
  const controller = createAppUpdateController({
    enabled,
    currentVersion: "3.4.0",
    loadDriver,
    publishStatus: (status) => statuses.push(status),
    logFailure,
  });
  return { controller, driver, loadDriver, logFailure, statuses, progress: (value: number) => progress?.(value) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("only one check and download runs, with progress and the ready state visible to every caller", async () => {
  const { controller, driver, statuses, progress } = fixture();
  const download = deferred<string[]>();
  driver.downloadUpdate.mockReturnValue(download.promise);
  const firstRequest = controller.checkAndDownload();
  const secondRequest = controller.checkAndDownload();
  const installEarly = vi.fn(async () => true);
  await controller.restart(installEarly);
  expect(installEarly).not.toHaveBeenCalled();
  expect(controller.getStatus()).toEqual({ phase: "downloading", version: "3.5.0", percent: 0 });

  progress(44.6);
  progress(42);
  download.resolve(["/cache/installer"]);
  await Promise.all([firstRequest, secondRequest]);
  await controller.checkAndDownload();

  expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(driver.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(statuses).toEqual([
    { phase: "checking" },
    { phase: "downloading", version: "3.5.0", percent: 0 },
    { phase: "downloading", version: "3.5.0", percent: 44 },
    { phase: "ready", version: "3.5.0" },
  ]);
  expect(controller.getStatus()).toEqual({ phase: "ready", version: "3.5.0" });
});

test("one restart can be pending and cancelling preserves the same downloaded update", async () => {
  const { controller } = fixture();
  await controller.checkAndDownload();

  const confirm = deferred<boolean>();
  const install = vi.fn(() => confirm.promise);
  const pending = controller.restart(install);
  await controller.restart(install);
  expect(install).toHaveBeenCalledExactlyOnceWith("/cache/installer");
  expect(controller.getStatus()).toEqual({ phase: "restarting", version: "3.5.0" });

  confirm.resolve(false);
  await pending;
  expect(controller.getStatus()).toEqual({ phase: "ready", version: "3.5.0" });
  const approved = vi.fn(async () => true);
  await controller.restart(approved);
  expect(approved).toHaveBeenCalledExactlyOnceWith("/cache/installer");
});

test("a reported downgrade or prerelease never starts a download", async () => {
  const { controller, driver } = fixture();
  driver.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: "3.2.0" } });
  await controller.checkAndDownload();
  expect(controller.getStatus()).toEqual({ phase: "current" });

  driver.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: "3.5.0-beta.1" } });
  await controller.checkAndDownload();
  expect(controller.getStatus()).toMatchObject({ phase: "failed" });
  expect(driver.downloadUpdate).not.toHaveBeenCalled();
});

test("failures expose a safe message and allow a new check", async () => {
  const { controller, driver, logFailure } = fixture();
  const credentialsInError = new Error("Network error on https://example.test/?token=SECRET");
  driver.downloadUpdate.mockRejectedValueOnce(credentialsInError);

  await controller.checkAndDownload();
  expect(controller.getStatus()).toEqual({
    phase: "failed",
    message: "Could not check for or download the update. Try again or download it from GitHub.",
    retryable: true,
  });
  expect(logFailure).toHaveBeenCalledWith("downloading", credentialsInError);

  await controller.checkAndDownload();
  expect(controller.getStatus()).toEqual({ phase: "ready", version: "3.5.0" });
});

test("unsupported builds never load an update driver", async () => {
  const { controller, loadDriver } = fixture(false);
  const install = vi.fn(async () => true);
  await controller.checkAndDownload();
  await controller.restart(install);
  expect(controller.getStatus()).toEqual({ phase: "unsupported" });
  expect(loadDriver).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});
