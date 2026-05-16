import { describe, expect, test } from "vitest";
import { resolveTerminalOpenAction } from "./terminal-open-action.js";

describe("resolveTerminalOpenAction", () => {
  describe("externalEditor takes precedence for files", () => {
    test("file + simple binary spawns editor with path appended", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "code",
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({
        kind: "editor",
        parsed: { binary: "code", args: [] },
      });
    });

    test("file + editor with flags tokenises argv-style", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "code --wait",
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({
        kind: "editor",
        parsed: { binary: "code", args: ["--wait"] },
      });
    });

    test("file + quoted-path editor preserves the binary path with spaces", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: '"C:\\Program Files\\App\\editor.exe" --new-window',
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({
        kind: "editor",
        parsed: { binary: "C:\\Program Files\\App\\editor.exe", args: ["--new-window"] },
      });
    });

    test("directory + editor set still falls back to externalPathOpener", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: true,
        externalEditor: "code",
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({ kind: "system" });
    });

    test("directory + editor + opener mode=command honours the command branch", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: true,
        externalEditor: "code",
        externalPathOpener: { mode: "command", command: "explorer ${path}" },
      });
      expect(action).toEqual({ kind: "command", template: "explorer ${path}" });
    });

    test("file + editor wins over an opener mode=command", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "code",
        externalPathOpener: { mode: "command", command: "subl ${path}" },
      });
      expect(action).toEqual({
        kind: "editor",
        parsed: { binary: "code", args: [] },
      });
    });

    test("file + editor wins over an opener mode=internal", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "vim",
        externalPathOpener: { mode: "internal", command: "" },
      });
      expect(action).toEqual({
        kind: "editor",
        parsed: { binary: "vim", args: [] },
      });
    });
  });

  describe("externalEditor empty falls through to externalPathOpener", () => {
    test("empty string → system", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "",
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({ kind: "system" });
    });

    test("whitespace-only string is treated as empty", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "   ",
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({ kind: "system" });
    });

    test("empty editor + mode=command surfaces the template", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "",
        externalPathOpener: { mode: "command", command: "code -g ${path}:${line}" },
      });
      expect(action).toEqual({ kind: "command", template: "code -g ${path}:${line}" });
    });

    test("empty editor + mode=internal routes to the in-app viewer", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "",
        externalPathOpener: { mode: "internal", command: "" },
      });
      expect(action).toEqual({ kind: "internal" });
    });
  });

  describe("malformed editor template falls through, never silently no-ops", () => {
    test("unterminated quote → falls back to externalPathOpener", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: '"unterminated',
        externalPathOpener: { mode: "system", command: "" },
      });
      expect(action).toEqual({ kind: "system" });
    });

    test("unterminated quote + mode=command falls through to command", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: '"unterminated',
        externalPathOpener: { mode: "command", command: "code ${path}" },
      });
      expect(action).toEqual({ kind: "command", template: "code ${path}" });
    });
  });

  describe("defensive: unknown mode is treated as system", () => {
    test("garbage mode → system", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "",
        externalPathOpener: { mode: "garbage", command: "" },
      });
      expect(action).toEqual({ kind: "system" });
    });

    test("missing externalPathOpener entirely → system", () => {
      const action = resolveTerminalOpenAction({
        isDirectory: false,
        externalEditor: "",
        externalPathOpener: {},
      });
      expect(action).toEqual({ kind: "system" });
    });
  });
});
