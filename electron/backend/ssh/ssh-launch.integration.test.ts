import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

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
}: {
  hostPatch?: Record<string, unknown>;
  settingsSsh?: Record<string, unknown>;
} = {}) {
  const host = {
    id: "host-a",
    host: "prod-alias",
    advanced: { launchVia: "default" },
    ...hostPatch,
  };
  const sshManager = {
    getHost: vi.fn(() => host),
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
            launch: { kind: "ssh", sshHostId: "host-a" },
          },
        ],
      },
    ],
  };
  return { manager, state, sessionId };
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

  const [{ stdout: whoami }, { stdout: icacls }] = await Promise.all([
    promisify(execFile)("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 }),
    promisify(execFile)("icacls.exe", [file], { windowsHide: true, timeout: 5000 }),
  ]);
  const identity = whoami.match(/"([^"]+)","(S-1-[0-9-]+)"/);
  expect(identity, `Could not read current Windows user SID: ${whoami}`).not.toBeNull();
  const [account, sid] = identity!.slice(1);
  const keyAcl = icacls.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(file.toLowerCase()));
  expect(keyAcl?.toLowerCase()).toContain(`${account.toLowerCase()}:(f)`);
  expect(sid).toMatch(/^S-1-/);
  expect(keyAcl).not.toMatch(/(?:Everyone|Users|Authenticated Users|S-1-1-0|S-1-5-32-545|S-1-5-11)\s*:/i);
}

describe("SessionManager real System SSH launch lifecycle", () => {
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
