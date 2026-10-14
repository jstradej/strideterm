import { beforeEach, describe, expect, test, vi } from "vitest";

const { execFileMock, runningDistrosMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  runningDistrosMock: vi.fn(async (): Promise<string[] | null> => ["Ubuntu"]),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("./ssh-wsl.js", () => ({
  detectWslDistros: vi.fn(async () => ({ installed: true, distros: ["Ubuntu"], default: "Ubuntu" })),
  listRunningWslDistros: runningDistrosMock,
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
    runningDistrosMock.mockReset();
    runningDistrosMock.mockResolvedValue(["Ubuntu"]);
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
    expect(result.capabilities.wsl?.sshUnknownDistros).toEqual([]);
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

  test("a timed-out probe is unavailable for the system binary but UNKNOWN inside WSL", async () => {
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
    // A distribution that did not answer in time has not said it lacks ssh. Reporting `false` made the
    // quick-connect dialog refuse ("SSH is not installed in WSL distribution …") a working setup.
    expect(result.capabilities.wsl?.sshAvailableByDistro).toEqual({});
    expect(result.capabilities.wsl?.sshUnknownDistros).toEqual(["Ubuntu"]);
  });

  test("a WSL distribution whose ssh is missing is reported unavailable", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (file === "wsl.exe") {
          callback(Object.assign(new Error("exit 127"), { code: 127 }), { stdout: "", stderr: "ssh: not found" });
        } else {
          callback(null, { stdout: "OpenSSH_9.8", stderr: "" });
        }
      },
    );
    const result = await runPlatformPreflight({ safeStorageAvailable: true });
    expect(result.capabilities.wsl?.sshAvailableByDistro).toEqual({ Ubuntu: false });
    expect(result.capabilities.wsl?.sshUnknownDistros).toEqual([]);
  });

  test.each([
    ["stopped", [] as string[]],
    ["not listable", null],
  ])("never boots a %s WSL distribution to ask it, and reports it unknown", async (_case, running) => {
    runningDistrosMock.mockResolvedValue(running);
    returnResult(null, "OpenSSH_9.8");
    const result = await runPlatformPreflight({ safeStorageAvailable: true });
    expect(execFileMock.mock.calls.some(([file]) => file === "wsl.exe")).toBe(false);
    expect(result.capabilities.wsl?.sshAvailableByDistro).toEqual({});
    expect(result.capabilities.wsl?.sshUnknownDistros).toEqual(["Ubuntu"]);
  });

  test("starts every probe before waiting for any of them", async () => {
    const pending: Array<() => void> = [];
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        pending.push(() => callback(null, { stdout: "OpenSSH_9.8", stderr: "" }));
      },
    );
    const preflight = runPlatformPreflight({ safeStorageAvailable: true, systemSshPath: "C:/tools/ssh.exe" });
    await vi.waitFor(() => {
      const spawned = execFileMock.mock.calls.map(([file]) => file);
      expect(spawned).toEqual(expect.arrayContaining(["ssh-keygen", "C:/tools/ssh.exe", "wsl.exe"]));
    });
    pending.forEach((answer) => answer());
    expect((await preflight).capabilities.systemSsh).toBe(true);
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
