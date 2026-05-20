import { describe, test, expect } from "vitest";
import { tryDirectShellSpawn } from "./direct-shell-spawn.js";

describe("tryDirectShellSpawn — recognised shells", () => {
  test("bare wsl on win32 gets .exe suffix", () => {
    expect(tryDirectShellSpawn("wsl", { win32: true })).toEqual({
      file: "wsl.exe",
      args: [],
    });
  });

  test("wsl with distro + bash -lic preserves the quoted inner command", () => {
    const out = tryDirectShellSpawn(
      `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/kamil && claude --dangerously-skip-permissions"`,
      { win32: true },
    );
    expect(out).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu-22.04", "--", "bash", "-lic", "cd /home/kamil && claude --dangerously-skip-permissions"],
    });
  });

  test("pwsh with flags", () => {
    expect(tryDirectShellSpawn("pwsh -NoLogo", { win32: true })).toEqual({
      file: "pwsh.exe",
      args: ["-NoLogo"],
    });
  });

  test("powershell -Command with double-quoted argument", () => {
    expect(tryDirectShellSpawn(`powershell -Command "Get-Process | Out-Null"`, { win32: true })).toEqual({
      file: "powershell.exe",
      args: ["-Command", "Get-Process | Out-Null"],
    });
  });

  test("cmd /K bare", () => {
    expect(tryDirectShellSpawn("cmd /K", { win32: true })).toEqual({
      file: "cmd.exe",
      args: ["/K"],
    });
  });

  test("bash on linux keeps name without .exe", () => {
    expect(tryDirectShellSpawn("bash --login", { win32: false })).toEqual({
      file: "bash",
      args: ["--login"],
    });
  });

  test("explicit .exe suffix is not double-appended", () => {
    expect(tryDirectShellSpawn("wsl.exe -d Ubuntu", { win32: true })).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu"],
    });
  });

  test("case-insensitive shell name; preserve original casing for spawn", () => {
    expect(tryDirectShellSpawn("WSL -d Ubuntu", { win32: true })).toEqual({
      file: "WSL.exe",
      args: ["-d", "Ubuntu"],
    });
  });

  test("zsh / fish / sh are accepted", () => {
    expect(tryDirectShellSpawn("zsh -l", { win32: false })?.file).toBe("zsh");
    expect(tryDirectShellSpawn("fish", { win32: false })?.file).toBe("fish");
    expect(tryDirectShellSpawn("sh -c", { win32: false })?.file).toBe("sh");
  });
});

describe("tryDirectShellSpawn — rejections", () => {
  test("null / empty / whitespace returns null", () => {
    expect(tryDirectShellSpawn(null)).toBeNull();
    expect(tryDirectShellSpawn(undefined)).toBeNull();
    expect(tryDirectShellSpawn("")).toBeNull();
    expect(tryDirectShellSpawn("   ")).toBeNull();
  });

  test("non-allowlisted commands return null", () => {
    expect(tryDirectShellSpawn("docker run --rm alpine")).toBeNull();
    expect(tryDirectShellSpawn("npm test")).toBeNull();
    expect(tryDirectShellSpawn("./run.sh")).toBeNull();
  });

  test("top-level && rejects", () => {
    expect(tryDirectShellSpawn("bash --login && exit", { win32: false })).toBeNull();
  });

  test("top-level pipe rejects", () => {
    expect(tryDirectShellSpawn("bash | tee log", { win32: false })).toBeNull();
  });

  test("top-level semicolon rejects", () => {
    expect(tryDirectShellSpawn("bash; ls", { win32: false })).toBeNull();
  });

  test("top-level redirection rejects", () => {
    expect(tryDirectShellSpawn("bash > out.txt", { win32: false })).toBeNull();
    expect(tryDirectShellSpawn("bash < in.txt", { win32: false })).toBeNull();
  });

  test("top-level background rejects", () => {
    expect(tryDirectShellSpawn("bash &", { win32: false })).toBeNull();
  });

  test("top-level backtick rejects", () => {
    expect(tryDirectShellSpawn("bash `cmd`", { win32: false })).toBeNull();
  });

  test("unterminated quote rejects", () => {
    expect(tryDirectShellSpawn(`wsl -- bash -lic "cd /tmp`, { win32: true })).toBeNull();
    expect(tryDirectShellSpawn(`wsl -- bash -lic 'cd /tmp`, { win32: true })).toBeNull();
  });
});

describe("tryDirectShellSpawn — operators inside quotes are fine", () => {
  test("&& inside double quotes is preserved as part of the argument", () => {
    expect(tryDirectShellSpawn(`bash -lic "ls && pwd"`, { win32: false })).toEqual({
      file: "bash",
      args: ["-lic", "ls && pwd"],
    });
  });

  test("| inside single quotes is preserved", () => {
    expect(tryDirectShellSpawn(`bash -c 'echo a | grep a'`, { win32: false })).toEqual({
      file: "bash",
      args: ["-c", "echo a | grep a"],
    });
  });

  test("backslash-escaped double quote inside double quotes", () => {
    expect(tryDirectShellSpawn(`bash -c "echo \\"hi\\""`, { win32: false })).toEqual({
      file: "bash",
      args: ["-c", `echo "hi"`],
    });
  });
});
