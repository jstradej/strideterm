import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SrtBackend } from "./backend-srt.js";
import { SANDBOX_LAUNCHER_HASH, SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import type { SandboxEnvironment, SandboxSpec } from "./types.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sbx-srt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    os: "linux",
    home: "/home/dev",
    roots: ["/work/app"],
    gitDirs: [],
    readPaths: [],
    readWritePaths: [],
    agent: null,
    toolchains: [],
    cacheRoot: "/var/tmp/cache",
    workspaceDomains: [],
    sessionId: "w1:p1",
    workspaceId: "w1",
    profileId: "default",
    command: ["bash", "-l"],
    cwd: "/work/app",
    env: { TERM: "xterm", STRIDETERM_SESSION_TOKEN: "tok" },
    toolFiles: [],
    ...overrides,
  };
}

const linux: SandboxEnvironment = {
  os: "linux",
  platform: "linux",
  home: "/home/dev",
  nodePath: "/usr/bin/node",
  srtModule: "/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
};

describe("SrtBackend", () => {
  it("runs the launcher with the generated config and the spec's environment, never the config on the command line", () => {
    const sessionsDir = temp();
    const backend = new SrtBackend({ sessionsDir, launcherPath: path.join(sessionsDir, "launcher.mjs") });
    const launch = backend.buildLaunch(spec(), linux);
    expect(launch).toMatchObject({ file: "/usr/bin/node", cwd: "/work/app" });
    expect(launch.args).toEqual([
      path.join(sessionsDir, "launcher.mjs"),
      path.join(sessionsDir, "w1_p1", "launch.json"),
    ]);
    expect(launch.env).toEqual({ TERM: "xterm", STRIDETERM_SESSION_TOKEN: "tok" });
    expect(launch.args.join(" ")).not.toContain("tok");
    const config = JSON.parse(readFileSync(launch.args[1], "utf8"));
    expect(config).toMatchObject({
      sessionId: "w1_p1",
      command: ["bash", "-l"],
      unsetEnv: expect.arrayContaining(["ELECTRON_RUN_AS_NODE"]),
      denialsFile: path.join(sessionsDir, "w1_p1", "denials.jsonl"),
    });
    expect(JSON.stringify(config)).not.toContain("tok");
  });

  it("starts the launcher through a login shell in WSL and carries the environment by name, not by value", () => {
    const sessionsDir = "C:\\Users\\dev\\.strideterm\\sandbox\\sessions";
    const writes = new Map<string, string>();
    const backend = new SrtBackend({
      sessionsDir,
      launcherPath: "C:\\Users\\dev\\.strideterm\\sandbox\\launcher.mjs",
      writeFile: (file, content) => void writes.set(file, content),
      makeDir: () => undefined,
      hostEnv: { SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", GITHUB_TOKEN: "host-secret" },
    });
    const launch = backend.buildLaunch(
      spec({
        cwd: "/home/dev/app",
        env: { TERM: "xterm", STRIDETERM_SESSION_TOKEN: "tok", ELECTRON_RUN_AS_NODE: "1" },
      }),
      { ...linux, platform: "win32", distro: "Ubuntu" },
    );
    expect(launch.file).toBe("wsl.exe");
    expect(launch.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/dev/app",
      "-e",
      "bash",
      "-lc",
      'exec "$@"',
      "strideterm-sandbox",
      "/usr/bin/node",
      "/mnt/c/Users/dev/.strideterm/sandbox/launcher.mjs",
      "/mnt/c/Users/dev/.strideterm/sandbox/sessions/w1_p1/launch.json".replace(/\//gu, "/"),
    ]);
    expect(launch.args.join(" ")).not.toContain("tok");
    expect(launch.env.WSLENV).toBe("TERM:STRIDETERM_SESSION_TOKEN");
    expect(launch.env.STRIDETERM_SESSION_TOKEN).toBe("tok");
    expect(launch.env.SystemRoot).toBe("C:\\Windows");
    expect(launch.env.windir).toBe("C:\\Windows");
    expect(launch.env.GITHUB_TOKEN).toBeUndefined();
    const config = JSON.parse([...writes.entries()].find(([file]) => file.endsWith("launch.json"))![1]);
    expect(config.denialsFile).toBe("/mnt/c/Users/dev/.strideterm/sandbox/sessions/w1_p1/denials.jsonl");
  });

  it("passes the gateway relay to the launcher only when the sandbox needs one", () => {
    const sessionsDir = temp();
    const backend = new SrtBackend({ sessionsDir, launcherPath: path.join(sessionsDir, "l.mjs") });
    const launch = backend.buildLaunch(spec({ gateway: { relay: { tcpHost: "172.20.0.1", tcpPort: 4000 } } }), linux);
    const config = JSON.parse(readFileSync(launch.args[1], "utf8"));
    expect(config.relay).toEqual({ tcpHost: "172.20.0.1", tcpPort: 4000 });
    expect(config.runtime.network.mitmProxy).toEqual({ domains: ["gateway.strideterm.internal"] });
  });

  it("names the gateway socket itself when there is no relay", () => {
    const sessionsDir = temp();
    const backend = new SrtBackend({ sessionsDir, launcherPath: path.join(sessionsDir, "l.mjs") });
    const launch = backend.buildLaunch(spec({ gateway: { socketPath: "/tmp/gw.sock" } }), linux);
    const config = JSON.parse(readFileSync(launch.args[1], "utf8"));
    expect(config.relay).toBeUndefined();
    expect(config.runtime.network.mitmProxy).toEqual({
      socketPath: "/tmp/gw.sock",
      domains: ["gateway.strideterm.internal"],
    });
  });
});

describe("launcher script", () => {
  it("is valid ESM with a stable hash", () => {
    const dir = temp();
    const file = path.join(dir, "launcher.mjs");
    writeFileSync(file, SANDBOX_LAUNCHER_SOURCE);
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
    expect(SANDBOX_LAUNCHER_HASH).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("refuses to start without a readable config instead of running unisolated", () => {
    const dir = temp();
    const file = path.join(dir, "launcher.mjs");
    writeFileSync(file, SANDBOX_LAUNCHER_SOURCE);
    for (const args of [[], [path.join(dir, "missing.json")]]) {
      const result = spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
      expect(result.status).toBe(125);
      expect(result.stderr).toContain("strIDEterm sandbox:");
    }
  });

  it("refuses to start when the sandbox runtime cannot be loaded", () => {
    const dir = temp();
    const file = path.join(dir, "launcher.mjs");
    writeFileSync(file, SANDBOX_LAUNCHER_SOURCE);
    const config = path.join(dir, "launch.json");
    writeFileSync(
      config,
      JSON.stringify({
        srtModule: path.join(dir, "no-such-runtime", "index.js"),
        sessionId: "s",
        askTimeoutMs: 100,
        denialsFile: path.join(dir, "d.jsonl"),
        decisionsDir: path.join(dir, "dec"),
        ensureDirs: [],
        toolFiles: [],
        optional: {},
        command: ["echo", "hi"],
        runtimeBase: temp(),
        runtime: {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        },
      }),
    );
    const result = spawnSync(process.execPath, [file, config], { encoding: "utf8" });
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("cannot be loaded");
    expect(result.stdout).not.toContain("hi");
  });
});
