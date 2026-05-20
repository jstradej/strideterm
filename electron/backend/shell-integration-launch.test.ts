import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyShellIntegrationLaunch, ensureZshLoaderDir, __test } from "./shell-integration-launch.js";

const SCRIPT_PATH = "/opt/strideterm/config/shell-integration/pwsh.ps1";

let dataDir = "";
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sit-launch-test-"));
  originalDataDir = process.env.STRIDETERM_DATA_DIR;
  process.env.STRIDETERM_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.STRIDETERM_DATA_DIR;
  else process.env.STRIDETERM_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("applyShellIntegrationLaunch — bash / sh", () => {
  test("bash with BASH_ENV is left untouched (env-based init is invisible already)", () => {
    const launcher = { file: "/bin/bash", args: ["--login"] };
    const env = {
      STRIDETERM_SHELL_INTEGRATION: "1",
      BASH_ENV: "/opt/strideterm/config/shell-integration/bash.sh",
      PROMPT_COMMAND: 'source "/opt/.../bash.sh"',
    };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.launcher).toEqual(launcher);
    expect(result.env).toEqual(env);
    expect(result.skipTypedSource).toBe(true);
  });

  test("sh is treated like bash", () => {
    const launcher = { file: "/bin/sh", args: [] };
    const env = { STRIDETERM_SHELL_INTEGRATION: "1", BASH_ENV: "/x.sh" };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.launcher).toEqual(launcher);
    expect(result.skipTypedSource).toBe(true);
  });
});

describe("applyShellIntegrationLaunch — zsh", () => {
  test("sets ZDOTDIR to the loader dir and writes the loader .zshrc", () => {
    const launcher = { file: "/bin/zsh", args: ["-l"] };
    const env = {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: "/opt/.../zsh.sh",
    };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.launcher).toEqual(launcher);
    expect(result.env.ZDOTDIR).toBe(path.join(dataDir, "runtime", "zsh-init"));
    expect(result.skipTypedSource).toBe(true);
    const loader = readFileSync(path.join(result.env.ZDOTDIR, ".zshrc"), "utf8");
    // Sanity: the loader sources both user's .zshrc and our integration.
    expect(loader).toContain('source "$_strideterm_user_zdotdir/.zshrc"');
    expect(loader).toContain('source "$STRIDETERM_SHELL_INTEGRATION_SCRIPT"');
  });

  test("preserves __STRIDETERM_ORIGINAL_ZDOTDIR carried in env", () => {
    const launcher = { file: "/bin/zsh", args: [] };
    const env = {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: "/x.sh",
      __STRIDETERM_ORIGINAL_ZDOTDIR: "/home/user/.config/zsh",
    };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.env.__STRIDETERM_ORIGINAL_ZDOTDIR).toBe("/home/user/.config/zsh");
  });
});

describe("applyShellIntegrationLaunch — pwsh / powershell", () => {
  function envForPwsh() {
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: SCRIPT_PATH,
    };
  }

  test("pwsh.exe gets -NoExit -Command appended", () => {
    const launcher = { file: "pwsh.exe", args: [] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-NoExit", "-Command", `& '${SCRIPT_PATH}'`]);
    expect(result.skipTypedSource).toBe(true);
  });

  test("powershell (Windows PowerShell 5.1) is treated the same", () => {
    const launcher = { file: "powershell.exe", args: ["-NoLogo"] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-NoLogo", "-NoExit", "-Command", `& '${SCRIPT_PATH}'`]);
  });

  test("respects user-supplied -Command — no injection", () => {
    const launcher = { file: "pwsh.exe", args: ["-Command", "Get-ChildItem"] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-Command", "Get-ChildItem"]);
    expect(result.skipTypedSource).toBe(true);
  });

  test("respects user-supplied -File", () => {
    const launcher = { file: "pwsh.exe", args: ["-File", "C:\\scripts\\go.ps1"] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-File", "C:\\scripts\\go.ps1"]);
  });

  test("respects short -c", () => {
    const launcher = { file: "pwsh", args: ["-c", "Write-Host hi"] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-c", "Write-Host hi"]);
  });

  test("respects -EncodedCommand", () => {
    const launcher = { file: "pwsh.exe", args: ["-EncodedCommand", "Vw=="] };
    const result = applyShellIntegrationLaunch(launcher, envForPwsh());
    expect(result.launcher.args).toEqual(["-EncodedCommand", "Vw=="]);
  });

  test("escapes single quotes in the script path", () => {
    const launcher = { file: "pwsh.exe", args: [] };
    const env = {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: "C:\\path\\with'quote\\pwsh.ps1",
    };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.launcher.args[2]).toBe(`& 'C:\\path\\with''quote\\pwsh.ps1'`);
  });
});

describe("applyShellIntegrationLaunch — no-op cases", () => {
  test("empty integration env returns launcher unchanged", () => {
    const launcher = { file: "/bin/bash", args: [] };
    const result = applyShellIntegrationLaunch(launcher, {});
    expect(result.launcher).toEqual(launcher);
    expect(result.skipTypedSource).toBe(true);
  });

  test("unknown shell with integration env falls back to typed-source", () => {
    const launcher = { file: "/bin/fish", args: [] };
    const env = { STRIDETERM_SHELL_INTEGRATION: "1", STRIDETERM_SHELL_INTEGRATION_SCRIPT: "/x.sh" };
    const result = applyShellIntegrationLaunch(launcher, env);
    expect(result.launcher).toEqual(launcher);
    expect(result.skipTypedSource).toBe(false);
  });
});

describe("pwshHasOwnEntryPoint", () => {
  test("detects -Command, -c, -com, -File, -f, -EncodedCommand, -ec (case-insensitive)", () => {
    expect(__test.pwshHasOwnEntryPoint(["-Command", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-c", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-com", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-File", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-f", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-fil", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-EncodedCommand", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-ec", "x"])).toBe(true);
    expect(__test.pwshHasOwnEntryPoint(["-eNcodEdCommanD", "x"])).toBe(true);
  });

  test("ignores cosmetic flags", () => {
    expect(__test.pwshHasOwnEntryPoint(["-NoLogo"])).toBe(false);
    expect(__test.pwshHasOwnEntryPoint(["-NoExit"])).toBe(false);
    expect(__test.pwshHasOwnEntryPoint(["-NoProfile"])).toBe(false);
  });
});

describe("ensureZshLoaderDir", () => {
  test("creates the dir and writes a valid .zshrc", () => {
    const dir = ensureZshLoaderDir();
    expect(existsSync(path.join(dir, ".zshrc"))).toBe(true);
    const contents = readFileSync(path.join(dir, ".zshrc"), "utf8");
    expect(contents).toContain('export ZDOTDIR="$__STRIDETERM_ORIGINAL_ZDOTDIR"');
    expect(contents).toContain('source "$STRIDETERM_SHELL_INTEGRATION_SCRIPT"');
  });

  test("is idempotent (writes deterministic content)", () => {
    const a = ensureZshLoaderDir();
    const first = readFileSync(path.join(a, ".zshrc"), "utf8");
    const b = ensureZshLoaderDir();
    expect(b).toBe(a);
    const second = readFileSync(path.join(b, ".zshrc"), "utf8");
    expect(second).toBe(first);
  });
});
