import { beforeEach, describe, expect, test, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("./ssh-wsl.js", () => ({
  detectWslDistros: vi.fn(async () => ({ distros: ["Ubuntu"], defaultDistro: "Ubuntu" })),
}));

import { runPlatformPreflight } from "./ssh-platform.js";

function returnResult(error: Error | null, stdout = "", stderr = "") {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(error, { stdout, stderr });
    },
  );
}

describe("SSH platform capability probes", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test("probes the configured system binary and selected WSL ssh executable", async () => {
    returnResult(null, "OpenSSH_9.8");
    const result = await runPlatformPreflight({
      safeStorageAvailable: true,
      systemSshPath: "C:/tools/ssh.exe",
      wslSshExec: "/opt/ssh-custom",
    });

    expect(result.capabilities.systemSsh).toBe(true);
    expect(result.capabilities.wsl?.sshAvailableByDistro).toEqual({ Ubuntu: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "C:/tools/ssh.exe",
      ["-V"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", "Ubuntu", "--", "/opt/ssh-custom", "-V"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  test("treats missing WSL ssh and timeout failures as unavailable", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const err = Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT", killed: true });
        callback(err, { stdout: "", stderr: "" });
      },
    );
    const result = await runPlatformPreflight({ safeStorageAvailable: true, systemSshPath: "ssh-custom" });
    expect(result.capabilities.systemSsh).toBe(false);
    expect(result.capabilities.wsl?.sshAvailableByDistro).toEqual({ Ubuntu: false });
  });

  test("does not treat an executable's nonzero ssh exit as available", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const err = Object.assign(new Error("ssh missing"), { code: 127 });
        callback(err, { stdout: "", stderr: "command not found" });
      },
    );
    const result = await runPlatformPreflight({ safeStorageAvailable: true, systemSshPath: "broken-ssh" });
    expect(result.capabilities.systemSsh).toBe(false);
  });
});
