import { describe, expect, test } from "vitest";
import { detectAppDistribution } from "./app-distribution.js";

// The variable names are the ones electron-builder 26 really sets:
//  - portable: app-builder-lib/templates/nsis/portable.nsi, `Kernel32::SetEnvironmentVariable` for
//    PORTABLE_EXECUTABLE_DIR ($EXEDIR), PORTABLE_EXECUTABLE_FILE ($EXEPATH) and
//    PORTABLE_EXECUTABLE_APP_FILENAME, all three before it starts the unpacked app;
//  - AppImage: the AppImage runtime's APPIMAGE (the .AppImage path), which electron-builder's AppRun
//    (app-builder-lib/out/targets/appimage/appImageUtil.js) reads to tell an AppImage launch apart.
const PORTABLE_ENV = {
  PORTABLE_EXECUTABLE_DIR: "D:\\Tools",
  PORTABLE_EXECUTABLE_FILE: "D:\\Tools\\strIDEterm-3.0.6-win-x64.exe",
  PORTABLE_EXECUTABLE_APP_FILENAME: "strIDEterm",
};
const APPIMAGE_ENV = { APPIMAGE: "/home/me/Apps/strIDEterm-3.0.6.AppImage", APPDIR: "/tmp/.mount_strIDEabc123" };

const packaged = { isPackaged: true, windowsStore: false, env: {} };

describe("detectAppDistribution", () => {
  test("an unpackaged run is development on every platform, whatever the environment says", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(
        detectAppDistribution({
          isPackaged: false,
          platform,
          windowsStore: true,
          env: { ...PORTABLE_ENV, ...APPIMAGE_ENV },
        }),
      ).toBe("development");
    }
  });

  test("Windows inside the Store container is the Microsoft Store build", () => {
    expect(detectAppDistribution({ ...packaged, platform: "win32", windowsStore: true })).toBe("microsoft-store");
  });

  test("Windows started by the portable launcher is the portable build", () => {
    expect(detectAppDistribution({ ...packaged, platform: "win32", env: PORTABLE_ENV })).toBe("portable");
    expect(
      detectAppDistribution({
        ...packaged,
        platform: "win32",
        env: { PORTABLE_EXECUTABLE_DIR: PORTABLE_ENV.PORTABLE_EXECUTABLE_DIR },
      }),
    ).toBe("portable");
    expect(
      detectAppDistribution({
        ...packaged,
        platform: "win32",
        env: { PORTABLE_EXECUTABLE_FILE: PORTABLE_ENV.PORTABLE_EXECUTABLE_FILE },
      }),
    ).toBe("portable");
  });

  test("any other packaged Windows build is the installer", () => {
    expect(detectAppDistribution({ ...packaged, platform: "win32" })).toBe("windows-installer");
    expect(detectAppDistribution({ ...packaged, platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "" } })).toBe(
      "windows-installer",
    );
    // AppImage's variable means nothing on Windows.
    expect(detectAppDistribution({ ...packaged, platform: "win32", env: APPIMAGE_ENV })).toBe("windows-installer");
  });

  test("a packaged macOS app is macos", () => {
    expect(detectAppDistribution({ ...packaged, platform: "darwin" })).toBe("macos");
    expect(detectAppDistribution({ ...packaged, platform: "darwin", env: { ...PORTABLE_ENV, ...APPIMAGE_ENV } })).toBe(
      "macos",
    );
  });

  test("Linux launched from an AppImage is appimage", () => {
    expect(detectAppDistribution({ ...packaged, platform: "linux", env: APPIMAGE_ENV })).toBe("appimage");
    expect(detectAppDistribution({ ...packaged, platform: "linux", env: { APPIMAGE: APPIMAGE_ENV.APPIMAGE } })).toBe(
      "appimage",
    );
  });

  test("any other packaged Linux build is a Linux package", () => {
    expect(detectAppDistribution({ ...packaged, platform: "linux" })).toBe("linux-package");
    // APPDIR alone is not an AppImage launch: electron-builder's AppRun computes it for an unpacked AppDir too.
    expect(detectAppDistribution({ ...packaged, platform: "linux", env: { APPDIR: APPIMAGE_ENV.APPDIR } })).toBe(
      "linux-package",
    );
    expect(detectAppDistribution({ ...packaged, platform: "linux", env: PORTABLE_ENV })).toBe("linux-package");
  });
});
