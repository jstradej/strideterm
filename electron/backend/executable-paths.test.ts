import { describe, expect, test } from "vitest";
import { isRiskyExecutable } from "./executable-paths.js";

describe("isRiskyExecutable", () => {
  test.each([
    "C:\\Users\\me\\AppData\\Local\\Temp\\report.exe",
    "C:\\temp\\install.msi",
    "C:\\temp\\setup.bat",
    "C:\\temp\\run.cmd",
    "C:\\temp\\thing.scr",
    "C:\\temp\\payload.vbs",
    "C:\\temp\\payload.hta",
    "C:\\temp\\tool.jar",
    // Indirection formats — what actually runs isn't visible in the link text.
    "C:\\Users\\me\\Desktop\\Innocent.lnk",
    "C:\\temp\\bookmark.url",
    "/Applications/Calculator.app",
    "/Users/me/scripts/deploy.command",
    "/home/me/.local/share/applications/thing.desktop",
    "/home/me/Downloads/Editor.AppImage",
  ])("flags %s", (candidate) => {
    expect(isRiskyExecutable(candidate)).toBe(true);
  });

  test.each([
    // Source files: their paths are in every stack trace, so the narrow list
    // deliberately leaves them alone.
    "/repo/src/index.js",
    "/repo/src/main.ts",
    "/repo/scripts/build.py",
    "/repo/scripts/deploy.sh",
    "C:\\repo\\src\\App.vue",
    "/repo/README.md",
    "/repo/package.json",
    // Plain directories still open the file manager.
    "/repo/src",
    "C:\\repo\\src",
    // A dotfile is not an extension.
    "/home/me/.bashrc",
    "/home/me/.command",
  ])("leaves %s alone", (candidate) => {
    expect(isRiskyExecutable(candidate)).toBe(false);
  });

  test("matches regardless of case", () => {
    expect(isRiskyExecutable("C:\\temp\\SETUP.EXE")).toBe(true);
    expect(isRiskyExecutable("C:\\temp\\Setup.Exe")).toBe(true);
  });

  // .app bundles are directories, so they arrive with a trailing separator
  // from anything that normalises directory paths.
  test("matches a bundle written with a trailing separator", () => {
    expect(isRiskyExecutable("/Applications/Calculator.app/")).toBe(true);
    expect(isRiskyExecutable("C:\\Apps\\Thing.app\\")).toBe(true);
  });

  test("is not fooled by a dot in a parent directory", () => {
    expect(isRiskyExecutable("/repo/v1.0/README")).toBe(false);
    expect(isRiskyExecutable("/repo/build.exe/notes.txt")).toBe(false);
  });

  test("handles empty input", () => {
    expect(isRiskyExecutable("")).toBe(false);
  });
});
