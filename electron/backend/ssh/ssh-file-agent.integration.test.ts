import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppState } from "../../shared/types/state.js";
import type { CredentialStore } from "../shared/credential-store.js";
import { createSshFileHandlers } from "./runtime-ssh-file-handlers.js";
import { createSshMcpBroker, SSH_MCP_BROKER_ROUTE } from "./ssh-mcp-broker.js";
import { SshManager } from "./ssh-manager.js";
import { startSftpTestServer } from "./test-support/sftp-test-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(label: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `strideterm-sshfile-agent-${label}-`)));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const grantA = {
  sessionId: "ws-a:agent",
  profileId: "default",
  workspaceId: "ws-a",
  panelId: "agent",
  command: "claude",
};
const grantB = {
  sessionId: "ws-b:agent",
  profileId: "default",
  workspaceId: "ws-b",
  panelId: "agent",
  command: "claude",
};

async function setup(options: { writeDelayMs?: number } = {}) {
  const remoteRoot = await tempDir("remote");
  const workspaceRoot = await tempDir("workspace");
  const otherWorkspaceRoot = await tempDir("other-workspace");
  const outsideRoot = await tempDir("outside");
  await fs.mkdir(path.join(remoteRoot, "srv"));
  const server = await startSftpTestServer({ rootDir: remoteRoot, writeDelayMs: options.writeDelayMs });
  cleanups.push(() => server.close());
  const secrets = new Map([["ssh:password:test", server.password]]);
  const credentials: CredentialStore = {
    getSecret: (ref) => secrets.get(ref) || "",
    hasSecret: (ref) => secrets.has(ref),
    setSecret: async (ref, value) => void secrets.set(ref, value),
    deleteSecret: async (ref) => void secrets.delete(ref),
    listRefs: () => [...secrets.keys()],
    isEncryptionAvailable: () => true,
  };
  const host = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    host: "127.0.0.1",
    port: server.port,
    username: "alice",
    auth: { methods: ["password"], passwordRef: "ssh:password:test" },
    advanced: { launchVia: "ssh2" },
    hostKeyPolicy: "accept-new",
    ...extra,
  });
  const state = {
    ssh: {
      hosts: [
        host("box"),
        host("prompting", { auth: { methods: ["password"] } }),
        host("system", { advanced: { launchVia: "system-ssh" } }),
      ],
      keys: [],
      certificates: [],
      knownHosts: {},
      settings: {},
    },
    settings: { ssh: {} },
    profiles: [{ id: "default" }],
    workspaces: [
      { id: "ws-a", name: "A", profileId: "default", cwd: workspaceRoot, panels: [] },
      { id: "ws-b", name: "B", profileId: "default", cwd: otherWorkspaceRoot, panels: [] },
    ],
  };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
  };
  const sshManager = new SshManager({ store, credentialStore: credentials });
  const handlers = createSshFileHandlers({
    sshManager,
    getState: () => state as unknown as AppState,
    emit: (channel, payload) => new EventEmitter().emit(channel, payload),
    getWindowProfileId: () => "default",
    getEffectiveLaunchMode: (record) => (record.advanced?.launchVia === "system-ssh" ? "system-ssh" : "ssh2"),
    createSessionId: (workspaceId, panelId) => `${workspaceId}:${panelId}`,
    rootsForProfile: () => [],
  });
  let live = true;
  const broker = createSshMcpBroker({
    service: { listHosts: () => [], runCommand: async () => ({}) } as never,
    files: handlers.sshFileAgent,
    isGrantLive: () => live,
  });
  await broker.start();
  const tokenA = broker.mintGrant(grantA);
  const tokenB = broker.mintGrant(grantB);
  cleanups.push(async () => {
    await broker.close();
    handlers.close();
    await Promise.all(
      [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
    );
  });

  async function call(token: { url: string; capability: string }, body: Record<string, unknown>) {
    const response = await fetch(token.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as { result: Record<string, any>; error?: { code: string; message: string } },
    };
  }

  return {
    remoteRoot,
    workspaceRoot,
    otherWorkspaceRoot,
    outsideRoot,
    handlers,
    broker,
    tokenA,
    tokenB,
    call,
    revoke: () => {
      live = false;
    },
  };
}

async function finished(handlers: Awaited<ReturnType<typeof setup>>["handlers"]) {
  await handlers.service.transfers.idle();
}

describe("agent SSH file tools", () => {
  test("the broker route is the one the stdio server talks to", () => {
    expect(SSH_MCP_BROKER_ROUTE).toBe("/ssh-mcp");
  });

  test("lists a directory of a saved Built-in host", async () => {
    const { remoteRoot, call, tokenA } = await setup();
    await write(path.join(remoteRoot, "srv", "app.log"), "log");

    const result = await call(tokenA, { operation: "list-files", hostId: "box", path: "/srv" });

    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({ path: "/srv", truncated: false });
    expect(result.body.result.entries.map((entry: { name: string }) => entry.name)).toEqual(["app.log"]);
  });

  test("an unknown host and a System SSH host are refused as unsupported", async () => {
    const { call, tokenA } = await setup();
    for (const hostId of ["nope", "system"]) {
      const result = await call(tokenA, { operation: "list-files", hostId, path: "/srv" });
      expect(result.status, hostId).toBe(422);
      expect(result.body.error?.code).toBe("unsupported_host");
    }
  });

  test("a host that needs a prompt is a setup problem, never a question to the user", async () => {
    const { call, tokenA, handlers } = await setup();
    const result = await call(tokenA, { operation: "list-files", hostId: "prompting", path: "/srv" });
    expect(result.status).toBe(502);
    expect(result.body.error?.code).toBe("setup_required");
    expect(handlers.service.connections.size()).toBe(0);
  });

  test("uploads a workspace file given relative to the workspace folder", async () => {
    const { workspaceRoot, remoteRoot, call, tokenA, handlers } = await setup();
    await write(path.join(workspaceRoot, "dist", "app.txt"), "payload");

    const started = await call(tokenA, {
      operation: "upload",
      hostId: "box",
      localPath: "dist",
      remoteDir: "/srv",
    });
    expect(started.status).toBe(200);
    await finished(handlers);

    expect(await fs.readFile(path.join(remoteRoot, "srv", "dist", "app.txt"), "utf8")).toBe("payload");
    const status = await call(tokenA, { operation: "transfer-status", transferId: started.body.result.transferId });
    expect(status.body.result).toMatchObject({
      state: "succeeded",
      direction: "upload",
      source: "mcp",
      result: { files: 1, bytes: 7, skipped: [] },
    });
  });

  test("local paths outside the grant workspace's folders are refused, however they are spelled", async () => {
    const { workspaceRoot, otherWorkspaceRoot, outsideRoot, call, tokenA } = await setup();
    await write(path.join(outsideRoot, "secret.txt"), "secret");
    await write(path.join(otherWorkspaceRoot, "other.txt"), "other");
    const attempts = [
      path.join(outsideRoot, "secret.txt"),
      path.join(otherWorkspaceRoot, "other.txt"),
      path.join("..", path.basename(outsideRoot), "secret.txt"),
      path.relative(workspaceRoot, path.join(outsideRoot, "secret.txt")),
    ];
    for (const localPath of attempts) {
      const result = await call(tokenA, { operation: "upload", hostId: "box", localPath, remoteDir: "/srv" });
      expect(result.status, localPath).toBe(403);
      expect(result.body.error?.code).toBe("outside_roots");
    }
  });

  test("a symbolic link out of the workspace cannot be followed", async () => {
    const { workspaceRoot, outsideRoot, call, tokenA } = await setup();
    await write(path.join(outsideRoot, "secret.txt"), "secret");
    try {
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "escape"), "junction");
    } catch {
      return;
    }
    const result = await call(tokenA, {
      operation: "upload",
      hostId: "box",
      localPath: "escape/secret.txt",
      remoteDir: "/srv",
    });
    expect(result.status).toBe(403);
  });

  test("an existing remote file is not replaced unless overwrite is asked for", async () => {
    const { workspaceRoot, remoteRoot, call, tokenA, handlers } = await setup();
    await write(path.join(workspaceRoot, "a.txt"), "NEW");
    await write(path.join(remoteRoot, "srv", "a.txt"), "old");

    const refused = await call(tokenA, { operation: "upload", hostId: "box", localPath: "a.txt", remoteDir: "/srv" });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("conflict");
    expect(refused.body.error?.message).toContain("/srv/a.txt");
    expect(await fs.readFile(path.join(remoteRoot, "srv", "a.txt"), "utf8")).toBe("old");

    const accepted = await call(tokenA, {
      operation: "upload",
      hostId: "box",
      localPath: "a.txt",
      remoteDir: "/srv",
      overwrite: true,
    });
    expect(accepted.status).toBe(200);
    await finished(handlers);
    expect(await fs.readFile(path.join(remoteRoot, "srv", "a.txt"), "utf8")).toBe("NEW");
  });

  test("downloads into a workspace folder", async () => {
    const { workspaceRoot, remoteRoot, call, tokenA, handlers } = await setup();
    await write(path.join(remoteRoot, "srv", "report.txt"), "report");
    await fs.mkdir(path.join(workspaceRoot, "incoming"));

    const started = await call(tokenA, {
      operation: "download",
      hostId: "box",
      remotePath: "/srv/report.txt",
      localDir: "incoming",
    });
    expect(started.status).toBe(200);
    await finished(handlers);

    expect(await fs.readFile(path.join(workspaceRoot, "incoming", "report.txt"), "utf8")).toBe("report");
  });

  test("a download never writes into a .git directory, by target or by name", async () => {
    const { workspaceRoot, remoteRoot, call, tokenA, handlers } = await setup();
    await write(path.join(remoteRoot, "srv", "hook.sh"), "#!/bin/sh");
    await write(path.join(remoteRoot, "srv", "tree", ".git", "config"), "[core]");
    await write(path.join(remoteRoot, "srv", "tree", "keep.txt"), "keep");
    await fs.mkdir(path.join(workspaceRoot, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "out"));

    for (const localDir of [".git/hooks", ".git", path.join(workspaceRoot, ".GIT")]) {
      const result = await call(tokenA, {
        operation: "download",
        hostId: "box",
        remotePath: "/srv/hook.sh",
        localDir,
      });
      expect(result.status, localDir).toBe(403);
    }
    expect(await fs.readdir(path.join(workspaceRoot, ".git", "hooks"))).toEqual([]);

    const named = await call(tokenA, {
      operation: "download",
      hostId: "box",
      remotePath: "/srv/tree/.git",
      localDir: "out",
    });
    expect(named.status).toBe(403);

    const nested = await call(tokenA, {
      operation: "download",
      hostId: "box",
      remotePath: "/srv/tree",
      localDir: "out",
    });
    expect(nested.status).toBe(200);
    await finished(handlers);
    const status = await call(tokenA, { operation: "transfer-status", transferId: nested.body.result.transferId });
    expect(status.body.result.result.skipped).toEqual([
      { path: "/srv/tree/.git", reason: "Downloads never create a .git directory." },
    ]);
    expect(await fs.readdir(path.join(workspaceRoot, "out", "tree"))).toEqual(["keep.txt"]);
  });

  test("a download target that reaches .git through a link is refused", async () => {
    const { workspaceRoot, remoteRoot, call, tokenA } = await setup();
    await write(path.join(remoteRoot, "srv", "hook.sh"), "#!/bin/sh");
    await fs.mkdir(path.join(workspaceRoot, ".git", "hooks"), { recursive: true });
    await fs.symlink(path.join(workspaceRoot, ".git", "hooks"), path.join(workspaceRoot, "hooks-link"), "junction");

    const result = await call(tokenA, {
      operation: "download",
      hostId: "box",
      remotePath: "/srv/hook.sh",
      localDir: "hooks-link",
    });

    expect(result.status).toBe(403);
    expect(await fs.readdir(path.join(workspaceRoot, ".git", "hooks"))).toEqual([]);
  });

  test("a transfer is only known to the tab that started it", async () => {
    const { workspaceRoot, call, tokenA, tokenB, handlers } = await setup();
    await write(path.join(workspaceRoot, "a.txt"), "a");
    const started = await call(tokenA, { operation: "upload", hostId: "box", localPath: "a.txt", remoteDir: "/srv" });
    await finished(handlers);

    const foreign = await call(tokenB, { operation: "transfer-status", transferId: started.body.result.transferId });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error?.code).toBe("not_found");
    const unknown = await call(tokenA, { operation: "transfer-status", transferId: "nope" });
    expect(unknown.status).toBe(404);
  });

  test("at most two transfers run at once for one tab, and revoking the grant does not stop a started one", async () => {
    const { workspaceRoot, otherWorkspaceRoot, remoteRoot, call, tokenA, tokenB, broker, handlers } = await setup({
      writeDelayMs: 40,
    });
    for (const name of ["one", "two", "three"]) {
      await fs.writeFile(path.join(workspaceRoot, `${name}.bin`), Buffer.alloc(2 * 1024 * 1024, 1));
    }

    const first = await call(tokenA, { operation: "upload", hostId: "box", localPath: "one.bin", remoteDir: "/srv" });
    const second = await call(tokenA, { operation: "upload", hostId: "box", localPath: "two.bin", remoteDir: "/srv" });
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await call(tokenA, { operation: "upload", hostId: "box", localPath: "three.bin", remoteDir: "/srv" });
    expect(third.status).toBe(429);
    expect(third.body.error?.code).toBe("limit_exceeded");
    // The limit is per grant: another tab is not held up by this one.
    await fs.writeFile(path.join(otherWorkspaceRoot, "b.bin"), Buffer.alloc(1024));
    const other = await call(tokenB, { operation: "upload", hostId: "box", localPath: "b.bin", remoteDir: "/srv" });
    expect(other.status).toBe(200);

    broker.revokeSession(grantA.sessionId);
    await finished(handlers);

    expect((await fs.stat(path.join(remoteRoot, "srv", "one.bin"))).size).toBe(2 * 1024 * 1024);
    expect((await fs.stat(path.join(remoteRoot, "srv", "two.bin"))).size).toBe(2 * 1024 * 1024);
    expect(handlers.service.transfers.getPayload("default").lastRuns.map((run) => run.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  }, 30_000);

  test("a revoked grant is refused before anything runs", async () => {
    const { call, tokenA, revoke } = await setup();
    revoke();
    const result = await call(tokenA, { operation: "list-files", hostId: "box", path: "/srv" });
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("grant_expired");
  });

  test("the request schema is strict", async () => {
    const { call, tokenA } = await setup();
    for (const body of [
      { operation: "upload", hostId: "box", localPath: "a", remoteDir: "/srv", sneaky: true },
      { operation: "download", hostId: "box", remotePath: "/a" },
      { operation: "transfer-status" },
    ]) {
      expect((await call(tokenA, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});
