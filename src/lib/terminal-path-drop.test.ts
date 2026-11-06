import { describe, expect, it } from "vitest";
import {
  PATHS_MIME,
  formatDroppedPaths,
  quotePathForShell,
  readDragPaths,
  runtimeAbsolutePath,
  setDragPaths,
  terminalDropKind,
  windowsPathToWsl,
} from "./terminal-path-drop.js";

function fakeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) || "",
    store,
  };
}

describe("quotePathForShell", () => {
  it("leaves safe paths alone", () => {
    expect(quotePathForShell("C:\\work\\a.txt", "win32")).toBe("C:\\work\\a.txt");
    expect(quotePathForShell("/home/me/a-b_c.txt", "linux")).toBe("/home/me/a-b_c.txt");
    expect(quotePathForShell("/Users/me/a.txt", "darwin")).toBe("/Users/me/a.txt");
  });

  it("wraps win32 paths with spaces in double quotes", () => {
    expect(quotePathForShell("C:\\My Docs\\a b.txt", "win32")).toBe('"C:\\My Docs\\a b.txt"');
  });

  it("single-quotes posix paths and escapes embedded quotes", () => {
    expect(quotePathForShell("/home/me/it's here", "linux")).toBe(`'/home/me/it'\\''s here'`);
    expect(quotePathForShell("/Users/me/My Docs", "darwin")).toBe("'/Users/me/My Docs'");
  });

  it("quotes shell metacharacters on posix", () => {
    expect(quotePathForShell("/tmp/$HOME;rm", "linux")).toBe("'/tmp/$HOME;rm'");
    expect(quotePathForShell("/tmp/a\\b", "linux")).toBe("'/tmp/a\\b'");
  });

  it("quotes unicode names", () => {
    expect(quotePathForShell("/home/me/příliš.txt", "linux")).toBe("'/home/me/příliš.txt'");
    expect(quotePathForShell("C:\\Users\\Jarda\\žluťoučký.txt", "win32")).toBe('"C:\\Users\\Jarda\\žluťoučký.txt"');
  });
});

describe("PowerShell quoting", () => {
  it("single-quotes with doubled quotes so $ and backtick stay literal", () => {
    const result = formatDroppedPaths(["C:\\My $Docs\\it's `a`.txt", "C:\\ok.txt"], "win32", "powershell");
    expect(result).toEqual({ ok: true, text: "'C:\\My $Docs\\it''s `a`.txt' C:\\ok.txt " });
  });

  it("uses the same quoting for pwsh on posix", () => {
    const result = formatDroppedPaths(["/home/me/it's $x"], "linux", "powershell");
    expect(result).toEqual({ ok: true, text: "'/home/me/it''s $x' " });
  });
});

describe("windowsPathToWsl", () => {
  it("maps drive paths", () => {
    expect(windowsPathToWsl("C:\\work\\a b.txt")).toBe("/mnt/c/work/a b.txt");
    expect(windowsPathToWsl("D:/x/y")).toBe("/mnt/d/x/y");
    expect(windowsPathToWsl("E:\\")).toBe("/mnt/e");
  });

  it("maps WSL UNC paths back to their Linux path", () => {
    expect(windowsPathToWsl("\\\\wsl$\\Ubuntu\\home\\me\\a.txt")).toBe("/home/me/a.txt");
    expect(windowsPathToWsl("\\\\wsl.localhost\\Ubuntu")).toBe("/");
  });

  it("refuses paths WSL cannot reach", () => {
    expect(windowsPathToWsl("\\\\server\\share\\a.txt")).toBeNull();
    expect(windowsPathToWsl("relative\\a.txt")).toBeNull();
  });
});

describe("runtimeAbsolutePath", () => {
  it("joins with the runtime separator", () => {
    expect(runtimeAbsolutePath("C:\\repo", "src/a.ts", "win32")).toBe("C:\\repo\\src\\a.ts");
    expect(runtimeAbsolutePath("C:/repo/", "src/a.ts", "win32")).toBe("C:\\repo\\src\\a.ts");
    expect(runtimeAbsolutePath("/home/me/repo", "src/a.ts", "linux")).toBe("/home/me/repo/src/a.ts");
    expect(runtimeAbsolutePath("/repo", "", "darwin")).toBe("/repo");
  });
});

describe("formatDroppedPaths", () => {
  it("joins quoted paths with spaces and a trailing space, never Enter", () => {
    const result = formatDroppedPaths(["/a/b", "/a/c d"], "linux", "local");
    expect(result).toEqual({ ok: true, text: "/a/b '/a/c d' " });
  });

  it("uses win32 quoting for a local Windows terminal", () => {
    expect(formatDroppedPaths(["C:\\a b\\c.txt"], "win32", "local")).toEqual({ ok: true, text: '"C:\\a b\\c.txt" ' });
  });

  it("converts to POSIX paths for WSL", () => {
    expect(formatDroppedPaths(["C:\\a b\\c.txt"], "win32", "wsl")).toEqual({ ok: true, text: "'/mnt/c/a b/c.txt' " });
    expect(formatDroppedPaths(["C:\\a\\c.txt"], "win32", "wsl")).toEqual({ ok: true, text: "/mnt/c/a/c.txt " });
  });

  it("refuses a path WSL cannot map", () => {
    const result = formatDroppedPaths(["\\\\server\\share\\x"], "win32", "wsl");
    expect(result.ok).toBe(false);
  });

  it("refuses SSH terminals", () => {
    const result = formatDroppedPaths(["/a"], "linux", "ssh");
    expect(result.ok).toBe(false);
  });
});

describe("terminalDropKind", () => {
  const panel = (p: Record<string, unknown>) => ({ id: "p", title: "t", command: "", ...p }) as never;

  it("detects SSH panels on any platform", () => {
    expect(terminalDropKind(panel({ launch: { kind: "ssh" } }), "linux")).toBe("ssh");
    expect(terminalDropKind(panel({ launch: { kind: "ssh" } }), "win32")).toBe("ssh");
  });

  it("detects WSL on Windows only", () => {
    expect(terminalDropKind(panel({ command: "wsl -d Ubuntu" }), "win32")).toBe("wsl");
    expect(terminalDropKind(panel({ command: "wsl" }), "win32")).toBe("wsl");
    expect(terminalDropKind(panel({ launch: { file: "C:\\Windows\\System32\\wsl.exe" } }), "win32")).toBe("wsl");
    expect(terminalDropKind(panel({ command: "wsl" }), "linux")).toBe("local");
  });

  it("detects PowerShell launchers on any platform", () => {
    expect(terminalDropKind(panel({ command: "pwsh -NoLogo" }), "win32")).toBe("powershell");
    expect(terminalDropKind(panel({ command: "powershell.exe" }), "win32")).toBe("powershell");
    expect(terminalDropKind(panel({ launch: { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } }), "win32")).toBe(
      "powershell",
    );
    expect(terminalDropKind(panel({ launch: { command: "/usr/bin/pwsh" } }), "linux")).toBe("powershell");
    expect(terminalDropKind(panel({ command: "pwshx" }), "win32")).toBe("local");
    expect(terminalDropKind(panel({ command: "claude" }), "win32")).toBe("local");
  });

  it("treats everything else, and an unknown panel, as local", () => {
    expect(terminalDropKind(panel({ command: "wslpath x" }), "win32")).toBe("local");
    expect(terminalDropKind(null, "win32")).toBe("local");
  });
});

describe("drag payload", () => {
  it("round-trips paths through the custom mime and mirrors them to text/plain", () => {
    const dt = fakeDataTransfer();
    setDragPaths(dt as unknown as DataTransfer, ["/a", "/b c"]);
    expect(dt.effectAllowed).toBe("copyMove");
    expect(dt.store.get("text/plain")).toBe("/a\n/b c");
    expect(readDragPaths(dt as unknown as DataTransfer)).toEqual(["/a", "/b c"]);
    expect(dt.store.has(PATHS_MIME)).toBe(true);
  });

  it("returns null for missing or malformed payloads", () => {
    const dt = fakeDataTransfer();
    expect(readDragPaths(dt as unknown as DataTransfer)).toBeNull();
    dt.setData(PATHS_MIME, "nope");
    expect(readDragPaths(dt as unknown as DataTransfer)).toBeNull();
    dt.setData(PATHS_MIME, "[1,2]");
    expect(readDragPaths(dt as unknown as DataTransfer)).toBeNull();
  });
});
