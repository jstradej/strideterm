import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildSshTmuxAttachCommand } from "../../shared/ssh-tmux.js";

const spawnCalls: Array<{ file: string; args: string[] }> = [];
let spawnError: Error | null = null;
const liveManagers: Array<{ manager: SessionManager; sessionId: string }> = [];

class FakePty {
  private exitHandlers: Array<(info: { exitCode: number }) => void> = [];

  onData(): void {}
  onExit(handler: (info: { exitCode: number }) => void): void {
    this.exitHandlers.push(handler);
  }
  resize(): void {}
  write(): void {}
  kill(): void {
    queueMicrotask(() => this.exitHandlers.forEach((handler) => handler({ exitCode: 0 })));
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file: string, args: string[]) => {
      spawnCalls.push({ file, args });
      if (spawnError) throw spawnError;
      return new FakePty();
    }),
  },
}));

vi.mock("./ssh-wsl.js", () => ({
  detectWslDistros: async () => ({ installed: true, distros: ["Ubuntu"], default: "Ubuntu" }),
}));

import { SessionManager } from "../session-manager.js";

const tempFiles: string[] = [];

afterEach(async () => {
  for (const { manager, sessionId } of liveManagers.splice(0)) manager.removeSession(sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  spawnCalls.length = 0;
  spawnError = null;
  await Promise.all(tempFiles.splice(0).map((file) => rm(file, { force: true })));
});

function createSetup({
  hostPatch = {},
  settingsSsh = {},
  launch = { kind: "ssh", sshHostId: "host-a" },
}: {
  hostPatch?: Record<string, unknown>;
  settingsSsh?: Record<string, unknown>;
  launch?: Record<string, unknown>;
} = {}) {
  const host = {
    id: "host-a",
    host: "prod-alias",
    advanced: { launchVia: "default" },
    ...hostPatch,
  };
  const sshManager = {
    getHost: vi.fn(() => host),
    createSession: vi.fn(),
    stop: vi.fn(async () => {}),
    credentialStore: {
      getSecret: vi.fn((ref: string) => (ref === "ssh:key:test" ? "test private key material\n" : "")),
    },
  };
  const manager = new SessionManager({ sshManager: sshManager as never });
  const sessionId = "workspace-ssh:remote";
  liveManagers.push({ manager, sessionId });
  const state = {
    activeWorkspaceId: "workspace-ssh",
    settings: { ssh: { defaultLaunchVia: "ssh2", ...settingsSsh } },
    workspaces: [
      {
        id: "workspace-ssh",
        cwd: os.tmpdir(),
        panels: [
          {
            id: "remote",
            title: "Remote",
            command: "ssh",
            startup: "default",
            launch,
          },
        ],
      },
    ],
  };
  return { manager, sshManager, state, sessionId };
}

function identityFile(args: string[]): string {
  const index = args.indexOf("-i");
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1]!;
}

async function expectPathRemoved(file: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await access(file);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected temporary SSH key to be removed: ${file}`);
}

async function inspectPrivateKeyPermissions(file: string): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    return;
  }

  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const [{ stdout: whoami }, { stdout: icacls }] = await Promise.all([
    promisify(execFile)(path.join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
      timeout: 5000,
    }),
    promisify(execFile)(path.join(system32, "icacls.exe"), [file], { windowsHide: true, timeout: 5000 }),
  ]);
  const identity = whoami.match(/"([^"]+)","(S-1-[0-9-]+)"/);
  expect(identity, `Could not read current Windows user SID: ${whoami}`).not.toBeNull();
  const [account, sid] = identity!.slice(1);
  const lines = icacls.split(/\r?\n/);
  const start = lines.findIndex((line) => line.toLowerCase().startsWith(file.toLowerCase()));
  expect(start, `icacls did not list ${file}: ${icacls}`).toBeGreaterThanOrEqual(0);
  // icacls prints the first ACE after the path and every further ACE on its own
  // indented line; the user's ACE is not necessarily first (e.g. after SYSTEM).
  const aces = [lines[start]!.slice(file.length).trim()];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    aces.push(line.trim());
  }
  const keyAcl = aces.join("\n");
  expect(keyAcl.toLowerCase()).toContain(`${account.toLowerCase()}:(f)`);
  expect(sid).toMatch(/^S-1-/);
  expect(keyAcl).not.toMatch(/(?:Everyone|Users|Authenticated Users|S-1-1-0|S-1-5-32-545|S-1-5-11)\s*:/i);
}

describe("SessionManager real System SSH launch lifecycle", () => {
  test.each(["system-ssh", "wsl"] as const)("reattaches the same exact tmux session over %s", async (mode) => {
    const platform = process.platform;
    if (mode === "wsl") Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const target = { name: " work ' %h ", readOnly: true };
      const advanced = {
        launchVia: mode,
        command: "host-startup",
        wsl: { distro: "Ubuntu", user: "alice", exec: "/usr/bin/ssh" },
      };
      const { manager, state, sessionId } = createSetup({
        hostPatch: { advanced },
        launch:
          mode === "wsl"
            ? { kind: "ssh", sshInline: { host: "inline-alias", advanced }, tmux: target, remoteCwd: "/remote/cwd" }
            : { kind: "ssh", sshHostId: "host-a", tmux: target, remoteCwd: "/remote/cwd" },
      });

      const attached = await manager.ensureSession(state as never, sessionId, { sshPasswordSignIn: true });
      expect(attached?.kind).toBe(mode === "wsl" ? "ssh-wsl" : "ssh-system");
      const first = spawnCalls[0]!;
      expect(first.args).toContain("-tt");
      expect(first.args).toContain("RemoteCommand=none");
      expect(first.args).toContain("PubkeyAuthentication=no");
      expect(first.args.slice(-3)).toEqual([
        "--",
        mode === "wsl" ? "inline-alias" : "prod-alias",
        buildSshTmuxAttachCommand(target),
      ]);
      expect(first.args.at(-1)).not.toMatch(/host-startup|remote\/cwd/);
      if (mode === "wsl") {
        expect(first.file).toBe("wsl.exe");
        expect(first.args.slice(0, 6)).toEqual(["-d", "Ubuntu", "-u", "alice", "--", "/usr/bin/ssh"]);
      }

      manager.removeSession(sessionId);
      await manager.ensureSession(state as never, sessionId, { sshPasswordSignIn: true });
      expect(spawnCalls).toEqual([first, first]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  test("passes a dedicated tmux command to Built-in SSH for an inline host", async () => {
    const sshInline = { host: "inline-alias", advanced: { launchVia: "ssh2", command: "host-startup" } };
    const tmux = { name: "ops" };
    const { manager, sshManager, state, sessionId } = createSetup({
      launch: { kind: "ssh", sshInline, tmux, remoteCwd: "/remote/cwd" },
    });

    expect((await manager.ensureSession(state as never, sessionId))?.kind).toBe("ssh");
    const [options] = sshManager.createSession.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options).toMatchObject({ inlineHost: sshInline, terminalCommand: buildSshTmuxAttachCommand(tmux) });
    expect(options).not.toHaveProperty("startupCommand");
  });

  test("reports an invalid target without starting an SSH shell or startup command", async () => {
    const { manager, state, sessionId } = createSetup({
      hostPatch: { advanced: { launchVia: "system-ssh", command: "host-startup" } },
      launch: { kind: "ssh", sshHostId: "host-a", tmux: { name: "" } },
    });
    const output = vi.fn();
    manager.on("terminal:data", output);
    await expect(manager.ensureSession(state as never, sessionId)).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(output).toHaveBeenCalledWith({ sessionId, data: expect.stringContaining("Invalid tmux session name") });
  });

  test("a canceled tmux launch cannot spawn a PTY or cancel its queued reconnect", async () => {
    const { manager, state, sessionId } = createSetup({
      hostPatch: { advanced: { launchVia: "system-ssh" } },
      launch: { kind: "ssh", sshHostId: "host-a", tmux: { name: "ops" } },
    });
    const initial = manager.ensureSession(state as never, sessionId);
    manager.removeSession(sessionId);
    const reconnect = manager.ensureSession(state as never, sessionId);
    await expect(initial).resolves.toBeNull();
    expect((await reconnect)?.kind).toBe("ssh-system");
    expect(spawnCalls).toHaveLength(1);
  });
  test("uses the stored System default, inherits absent user/port/config, and honors a custom binary path", async () => {
    const customBinary = path.join(os.tmpdir(), "ssh custom binary.exe");
    const { manager, state, sessionId } = createSetup({
      settingsSsh: { defaultLaunchVia: "system-ssh", systemSshPath: customBinary },
    });

    const session = await manager.ensureSession(state as never, sessionId);

    expect(session?.kind).toBe("ssh-system");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe(customBinary);
    expect(spawnCalls[0]?.args).toContain("prod-alias");
    expect(spawnCalls[0]?.args).toContain("--");
    expect(spawnCalls[0]?.args).not.toContain("-l");
    expect(spawnCalls[0]?.args).not.toContain("-p");
    expect(spawnCalls[0]?.args).not.toContain("-F");
    manager.removeSession(sessionId);
  });

  test("passes explicit SSH overrides and secures then removes a real temporary managed-key file", async () => {
    const { manager, state, sessionId } = createSetup({
      hostPatch: {
        port: 22,
        auth: { methods: ["publickey"], keyRef: "ssh:key:test" },
        advanced: {
          launchVia: "system-ssh",
          keepaliveIntervalMs: 30_000,
          keepaliveCountMax: 4,
          agentForward: true,
        },
      },
    });

    await manager.ensureSession(state as never, sessionId);

    const args = spawnCalls[0]!.args;
    const keyFile = identityFile(args);
    tempFiles.push(keyFile);
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("22");
    expect(args).toContain("-A");
    expect(args).toContain("-o");
    expect(args).toContain("ServerAliveInterval=30");
    expect(args).toContain("ServerAliveCountMax=4");
    expect(args).toContain("-i");

    expect(await readFile(keyFile, "utf8")).toBe("test private key material\n");
    await inspectPrivateKeyPermissions(keyFile);

    manager.removeSession(sessionId);
    await expectPathRemoved(keyFile);
  });

  test("removes a managed-key file when PTY spawning fails", async () => {
    spawnError = new Error("fake PTY spawn failure");
    const { manager, state, sessionId } = createSetup({
      hostPatch: { auth: { methods: ["publickey"], keyRef: "ssh:key:test" }, advanced: { launchVia: "system-ssh" } },
    });

    await expect(manager.ensureSession(state as never, sessionId)).resolves.toBeNull();

    const keyFile = identityFile(spawnCalls[0]!.args);
    tempFiles.push(keyFile);
    await expectPathRemoved(keyFile);
    expect(manager.sessions.has(sessionId)).toBe(false);
  });
});
