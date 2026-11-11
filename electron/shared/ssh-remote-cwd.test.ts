import { describe, expect, test } from "vitest";
import { normalizeRemoteCwd, quoteRemoteCwd, remoteStartupCommand } from "./ssh-remote-cwd.js";

describe("SSH remote directory", () => {
  test("normalizes to a trimmed path and refuses what could end the typed command", () => {
    expect(normalizeRemoteCwd("  ~/projects/app  ")).toBe("~/projects/app");
    expect(normalizeRemoteCwd("")).toBe("");
    expect(normalizeRemoteCwd(42)).toBe("");
    expect(normalizeRemoteCwd("/srv\nrm -rf ~")).toBe("");
    expect(normalizeRemoteCwd("/srv\rx")).toBe("");
    expect(normalizeRemoteCwd("x".repeat(501))).toBe("");
  });

  test("quotes for a Unix shell and keeps the home directory expandable", () => {
    expect(quoteRemoteCwd("~")).toBe("~");
    expect(quoteRemoteCwd("~/")).toBe("~/");
    expect(quoteRemoteCwd("~/my projects/app")).toBe("~/'my projects/app'");
    expect(quoteRemoteCwd("/srv/it's here")).toBe(String.raw`'/srv/it'\''s here'`);
    expect(quoteRemoteCwd("/tmp/$(id)")).toBe("'/tmp/$(id)'");
  });

  test("runs the command only after the directory change succeeded", () => {
    expect(remoteStartupCommand("~/app", "claude", { keepShell: true })).toBe("cd ~/'app' && claude");
    expect(remoteStartupCommand("/srv", "  ", { keepShell: false })).toBe("cd '/srv'");
    expect(remoteStartupCommand("/srv", "", { keepShell: true })).toBe(`cd '/srv' && exec "$SHELL" -l`);
  });
});
