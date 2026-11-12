import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialStore } from "../shared/credential-store.js";
import { createSshFileConnections, ownerForLog } from "./ssh-file-connections.js";
import { SshFileError } from "./ssh-file-error.js";
import { SshManager } from "./ssh-manager.js";
import { startSftpTestServer } from "./test-support/sftp-test-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("ownerForLog", () => {
  test("replaces the session id of a remote client with a stable digest", () => {
    const logged = ownerForLog("viewer:remote:session-cookie-value-1234");
    expect(logged).toMatch(/^viewer:remote:#[0-9a-f]{8}$/);
    expect(logged).not.toContain("session-cookie-value");
    expect(ownerForLog("viewer:remote:session-cookie-value-1234")).toBe(logged);
    expect(ownerForLog("viewer:remote:another-session")).not.toBe(logged);
  });

  test("covers the window form of a remote owner too", () => {
    const logged = ownerForLog("window:remote:session-cookie-value-1234");
    expect(logged).toMatch(/^window:remote:#[0-9a-f]{8}$/);
    expect(logged).not.toContain("session-cookie-value");
  });

  test("leaves keys without a remote session unchanged", () => {
    expect(ownerForLog("window:2")).toBe("window:2");
    expect(ownerForLog("grant:pty-session-1")).toBe("grant:pty-session-1");
  });

  test("is empty for a missing owner", () => {
    expect(ownerForLog(undefined)).toBe("");
  });
});

describe("own connection prompt timeout", () => {
  test("an unanswered sign-in prompt of a remote client ends with a message that says why", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-sshfile-prompt-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));
    const server = await startSftpTestServer({ rootDir });
    cleanups.push(() => server.close());

    const credentials: CredentialStore = {
      getSecret: () => "",
      hasSecret: () => false,
      setSecret: async () => {},
      deleteSecret: async () => {},
      listRefs: () => [],
      isEncryptionAvailable: () => true,
    };
    const state = {
      ssh: {
        hosts: [
          {
            id: "host-local",
            name: "Local test host",
            host: "127.0.0.1",
            port: server.port,
            username: "alice",
            auth: { methods: ["password"] },
            advanced: { launchVia: "ssh2" },
            hostKeyPolicy: "accept-new",
          },
        ],
        keys: [],
        certificates: [],
        knownHosts: {} as Record<string, unknown>,
        settings: {},
      },
      settings: { ssh: {} },
    };
    const store = {
      getState: () => state,
      mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
    };
    const sshManager = new SshManager({ store, credentialStore: credentials });
    const connections = createSshFileConnections({
      sshManager,
      getEffectiveLaunchMode: () => "ssh2",
      idleCloseMs: 60_000,
      remotePromptTimeoutMs: 100,
    });
    cleanups.push(async () => {
      connections.closeAll();
      await Promise.all(
        [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
      );
    });

    const error = await connections
      .acquire(
        { hostId: "host-local", hostLabel: "Local test host", own: { poolKey: "host-local", hostId: "host-local" } },
        { allowPrompts: true, ownerKey: "viewer:remote:session-1", ownerWindowId: "remote:session-1" },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(SshFileError);
    expect(error).toMatchObject({ code: "auth-required" });
    expect((error as Error).message).toContain("sign-in prompt");
    expect((error as Error).message).toContain("in time");
  });
});
