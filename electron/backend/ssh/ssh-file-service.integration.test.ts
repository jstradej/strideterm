import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialStore } from "../shared/credential-store.js";
import {
  SSH_FILE_TRANSFER_FINISHED_CHANNEL,
  SSH_FILE_TRANSFER_PROGRESS_CHANNEL,
  type SshFileTransferFinished,
  type SshFileTransferProgress,
} from "../../shared/ssh-file-events.js";
import { SshFileError } from "./ssh-file-error.js";
import type { SshFileConnectOptions, SshFileTarget } from "./ssh-file-connections.js";
import { createSshFileService, SSH_FILE_MAX_LIST_ENTRIES } from "./ssh-file-service.js";
import { createProgressThrottle, type SshFileLocalPolicy } from "./ssh-file-transfers.js";
import { SshManager } from "./ssh-manager.js";
import { startSftpTestServer } from "./test-support/sftp-test-server.js";

const cleanups: Array<() => Promise<void>> = [];
const posixOnly = process.platform === "win32" ? test.skip : test;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const anyLocalPath: SshFileLocalPolicy = {
  assertReadable: async () => {},
  assertWritableDir: async () => {},
};

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `strideterm-sshfile-${label}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(options: { writeDelayMs?: number; savePassword?: boolean } = {}) {
  const remoteRoot = await tempDir("remote");
  const localRoot = await tempDir("local");
  const server = await startSftpTestServer({ rootDir: remoteRoot, writeDelayMs: options.writeDelayMs });
  cleanups.push(() => server.close());
  const secrets = new Map(options.savePassword === false ? [] : [["ssh:password:test", server.password]]);
  const credentials: CredentialStore = {
    getSecret: (ref) => secrets.get(ref) || "",
    hasSecret: (ref) => secrets.has(ref),
    setSecret: async (ref, value) => void secrets.set(ref, value),
    deleteSecret: async (ref) => void secrets.delete(ref),
    listRefs: () => [...secrets.keys()],
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
          auth:
            options.savePassword === false
              ? { methods: ["password"] }
              : { methods: ["password"], passwordRef: "ssh:password:test" },
          advanced: { launchVia: "ssh2" },
          hostKeyPolicy: "accept-new",
        },
        {
          id: "host-system",
          name: "System SSH host",
          host: "example.invalid",
          auth: { methods: ["publickey"] },
          advanced: { launchVia: "system-ssh" },
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
  const events: Array<{ channel: string; payload: unknown }> = [];
  const service = createSshFileService({
    sshManager,
    getEffectiveLaunchMode: (host) => (host.advanced?.launchVia === "system-ssh" ? "system-ssh" : "ssh2"),
    emit: (channel, payload) => events.push({ channel, payload }),
    idleCloseMs: 60_000,
  });
  cleanups.push(async () => {
    service.close();
    await Promise.all(
      [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
    );
  });
  const target = (hostId = "host-local"): SshFileTarget => ({
    hostId,
    hostLabel: hostId,
    own: { poolKey: hostId, hostId },
  });
  const connect: SshFileConnectOptions = { allowPrompts: true, ownerKey: "test-owner" };
  const transfer = async (
    request: {
      direction: "upload" | "download";
      sources: string[];
      destinationDir: string;
      conflict?: "fail" | "overwrite" | "skip";
      maxBytes?: number;
    },
    targetOverride: SshFileTarget = target(),
  ) => {
    const { transferId } = await service.startTransfer({
      direction: request.direction,
      sources: request.sources,
      destinationDir: request.destinationDir,
      conflict: request.conflict ?? "fail",
      profileId: "default",
      workspaceId: "ws-1",
      source: "ui",
      ownerKey: "test-owner",
      maxBytes: request.maxBytes,
      local: anyLocalPath,
      target: targetOverride,
      connect,
    });
    await service.transfers.idle();
    return service.transfers.get(transferId)!;
  };
  return { server, remoteRoot, localRoot, state, sshManager, service, events, target, connect, transfer };
}

async function write(file: string, content: string | Buffer, mtime?: Date): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mtime) await fs.utimes(file, mtime, mtime);
}

async function symlinkOrSkip(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

describe("SSH file service: browsing", () => {
  test("lists a remote directory with types, sizes and sorted names", async () => {
    const { remoteRoot, service, target, connect } = await setup();
    await write(path.join(remoteRoot, "docs", "b.txt"), "hello");
    await write(path.join(remoteRoot, "docs", "a.txt"), "");
    await fs.mkdir(path.join(remoteRoot, "docs", "sub"));

    const listing = await service.list(target(), connect, "/docs");

    expect(listing.path).toBe("/docs");
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((entry) => [entry.name, entry.type, entry.size])).toEqual([
      ["a.txt", "file", 0],
      ["b.txt", "file", 5],
      ["sub", "dir", expect.any(Number)],
    ]);
  });

  test("truncates a listing at the entry cap and says so", async () => {
    const { remoteRoot, service, target, connect } = await setup();
    const dir = path.join(remoteRoot, "many");
    await fs.mkdir(dir);
    await Promise.all(
      Array.from({ length: SSH_FILE_MAX_LIST_ENTRIES + 1 }, (_, index) =>
        fs.writeFile(path.join(dir, `f${String(index).padStart(5, "0")}`), ""),
      ),
    );

    const listing = await service.list(target(), connect, "/many");

    expect(listing.entries).toHaveLength(SSH_FILE_MAX_LIST_ENTRIES);
    expect(listing.truncated).toBe(true);
  }, 30_000);

  test("realpath defaults to the server's home directory", async () => {
    const { service, target, connect } = await setup();
    expect(await service.realpath(target(), connect)).toEqual({ path: "/" });
  });

  test("reports symbolic links with their target", async () => {
    const { remoteRoot, service, target, connect } = await setup();
    await write(path.join(remoteRoot, "real.txt"), "x");
    if (!(await symlinkOrSkip("real.txt", path.join(remoteRoot, "link.txt")))) return;

    const listing = await service.list(target(), connect, "/");

    expect(listing.entries.find((entry) => entry.name === "link.txt")).toMatchObject({
      type: "symlink",
      linkTarget: "real.txt",
    });
  });

  test("mkdir, rename (refusing an existing target) and recursive delete", async () => {
    const { remoteRoot, service, target, connect } = await setup();
    await service.mkdir(target(), connect, "/new");
    await write(path.join(remoteRoot, "new", "inner", "file.txt"), "data");
    await write(path.join(remoteRoot, "taken"), "t");

    await expect(service.rename(target(), connect, "/new", "/taken")).rejects.toMatchObject({ code: "conflict" });
    await service.rename(target(), connect, "/new", "/renamed");
    expect((await fs.stat(path.join(remoteRoot, "renamed", "inner"))).isDirectory()).toBe(true);

    await expect(service.remove(target(), connect, ["/renamed"], { recursive: false })).rejects.toThrow(/folder/);
    expect(await service.remove(target(), connect, ["/renamed", "/taken"], { recursive: true })).toEqual({
      deleted: 4,
    });
    expect(await fs.readdir(remoteRoot)).toEqual([]);
  });

  test("refuses to delete the root and relative paths", async () => {
    const { service, target, connect } = await setup();
    await expect(service.remove(target(), connect, ["/"], { recursive: true })).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(service.list(target(), connect, "relative/path")).rejects.toMatchObject({ code: "io" });
  });

  test("a missing directory is a not-found failure", async () => {
    const { service, target, connect } = await setup();
    await expect(service.list(target(), connect, "/nope")).rejects.toMatchObject({ code: "not-found" });
  });

  test("reuses one connection for repeated browsing", async () => {
    const { server, service, target, connect } = await setup();
    await service.list(target(), connect, "/");
    await service.list(target(), connect, "/");
    await service.mkdir(target(), connect, "/x");
    expect(server.stats.connections).toBe(1);
    expect(server.stats.sftpChannels).toBe(1);
  });
});

describe("SSH file service: connections", () => {
  test("refuses System SSH hosts", async () => {
    const { service, target, connect } = await setup();
    await expect(service.list(target("host-system"), connect, "/")).rejects.toMatchObject({
      code: "unsupported-host",
    });
  });

  test("without a live session or an own-connection permission it asks to connect the tab", async () => {
    const { service, connect } = await setup();
    await expect(
      service.list({ hostId: "host-local", hostLabel: "x", liveSessionId: "ws:panel" }, connect, "/"),
    ).rejects.toMatchObject({ code: "not-connected", message: "Connect the SSH tab first." });
  });

  test("aborts an own connection that needs a prompt when prompts are not allowed", async () => {
    const { service, target } = await setup({ savePassword: false });
    const error = await service
      .list(target(), { allowPrompts: false, ownerKey: "remote" }, "/")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SshFileError);
    expect((error as SshFileError).code).toBe("auth-required");
  });

  test("reuses the live session of an SSH tab instead of connecting again", async () => {
    const { server, service, sshManager, connect } = await setup();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const live = sshManager.createSession({
      sessionId: "ws-1:panel-1",
      hostId: "host-local",
      cols: 80,
      rows: 24,
      authOnly: true,
      authenticatedActionTimeoutMs: 0,
      onAuthenticated: () => hold,
    });
    live.catch(() => {});
    await new Promise<void>((resolve) => {
      const poll = () => (sshManager.activeSessions.get("ws-1:panel-1")?.ready ? resolve() : setTimeout(poll, 10));
      poll();
    });
    expect(server.stats.connections).toBe(1);

    const listing = await service.list(
      { hostId: "host-local", hostLabel: "x", liveSessionId: "ws-1:panel-1" },
      { ...connect, allowPrompts: false },
      "/",
    );

    expect(listing.path).toBe("/");
    expect(server.stats.connections).toBe(1);
    release();
    await live;
  });
});

describe("SSH file service: transfers", () => {
  test("uploads a file and a folder, preserving modification time", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    const mtime = new Date("2021-03-04T05:06:07Z");
    await write(path.join(localRoot, "one.txt"), "one", mtime);
    await write(path.join(localRoot, "tree", "a", "deep.txt"), "deep", mtime);
    await write(path.join(localRoot, "tree", "empty.bin"), "");
    await fs.mkdir(path.join(remoteRoot, "dest"));

    const run = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "one.txt"), path.join(localRoot, "tree")],
      destinationDir: "/dest",
    });

    expect(run).toMatchObject({ state: "succeeded", result: { files: 3, bytes: 7, skipped: [] } });
    expect(await fs.readFile(path.join(remoteRoot, "dest", "one.txt"), "utf8")).toBe("one");
    expect(await fs.readFile(path.join(remoteRoot, "dest", "tree", "a", "deep.txt"), "utf8")).toBe("deep");
    expect((await fs.stat(path.join(remoteRoot, "dest", "tree", "empty.bin"))).size).toBe(0);
    const uploaded = await fs.stat(path.join(remoteRoot, "dest", "one.txt"));
    expect(Math.floor(uploaded.mtimeMs / 1000)).toBe(Math.floor(mtime.getTime() / 1000));
    expect((await fs.readdir(path.join(remoteRoot, "dest"))).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  posixOnly("upload preserves the file mode and download restores it", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(localRoot, "script.sh"), "#!/bin/sh\n");
    await fs.chmod(path.join(localRoot, "script.sh"), 0o750);
    await fs.mkdir(path.join(remoteRoot, "dest"));
    await transfer({ direction: "upload", sources: [path.join(localRoot, "script.sh")], destinationDir: "/dest" });
    expect((await fs.stat(path.join(remoteRoot, "dest", "script.sh"))).mode & 0o777).toBe(0o750);

    const back = await tempDir("back");
    await transfer({ direction: "download", sources: ["/dest/script.sh"], destinationDir: back });
    expect((await fs.stat(path.join(back, "script.sh"))).mode & 0o777).toBe(0o750);
  });

  test("downloads a folder tree", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(remoteRoot, "pkg", "x.txt"), "xx");
    await write(path.join(remoteRoot, "pkg", "nested", "y.txt"), "yyy");

    const run = await transfer({ direction: "download", sources: ["/pkg"], destinationDir: localRoot });

    expect(run).toMatchObject({ state: "succeeded", result: { files: 2, bytes: 5 } });
    expect(await fs.readFile(path.join(localRoot, "pkg", "nested", "y.txt"), "utf8")).toBe("yyy");
  });

  test("conflict=fail reports the existing top-level targets before anything is written", async () => {
    const { remoteRoot, localRoot, service, target, connect } = await setup();
    await write(path.join(localRoot, "a.txt"), "new");
    await write(path.join(localRoot, "b.txt"), "new");
    await write(path.join(remoteRoot, "a.txt"), "old");

    const error = await service
      .startTransfer({
        direction: "upload",
        sources: [path.join(localRoot, "a.txt"), path.join(localRoot, "b.txt")],
        destinationDir: "/",
        conflict: "fail",
        profileId: "default",
        workspaceId: "ws-1",
        source: "ui",
        ownerKey: "o",
        local: anyLocalPath,
        target: target(),
        connect,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "conflict", conflicts: ["/a.txt"] });
    expect(await fs.readFile(path.join(remoteRoot, "a.txt"), "utf8")).toBe("old");
    expect(await fs.readdir(remoteRoot)).toEqual(["a.txt"]);
  });

  test("conflict=fail treats an existing top-level folder as a conflict", async () => {
    const { remoteRoot, localRoot, service, target, connect } = await setup();
    await write(path.join(localRoot, "tree", "a.txt"), "new");
    await write(path.join(localRoot, "tree", "b.txt"), "new");
    await fs.mkdir(path.join(remoteRoot, "dest"));
    await write(path.join(remoteRoot, "dest", "tree", "b.txt"), "old");

    await expect(
      service.startTransfer({
        direction: "upload",
        sources: [path.join(localRoot, "tree")],
        destinationDir: "/dest",
        conflict: "fail",
        profileId: "default",
        workspaceId: "ws-1",
        source: "ui",
        ownerKey: "o",
        local: anyLocalPath,
        target: target(),
        connect,
      }),
    ).rejects.toMatchObject({ code: "conflict", conflicts: ["/dest/tree"] });
  });

  test("overwrite replaces an existing file; skip keeps it and reports it", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(localRoot, "f.txt"), "NEW");
    await write(path.join(remoteRoot, "f.txt"), "old");

    const skipped = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "f.txt")],
      destinationDir: "/",
      conflict: "skip",
    });
    expect(skipped.result).toEqual({ files: 0, bytes: 0, skipped: [{ path: "/f.txt", reason: "already exists" }] });
    expect(await fs.readFile(path.join(remoteRoot, "f.txt"), "utf8")).toBe("old");

    const replaced = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "f.txt")],
      destinationDir: "/",
      conflict: "overwrite",
    });
    expect(replaced.state).toBe("succeeded");
    expect(await fs.readFile(path.join(remoteRoot, "f.txt"), "utf8")).toBe("NEW");
    expect((await fs.readdir(remoteRoot)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  test("download overwrite and skip on the local side", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(remoteRoot, "f.txt"), "REMOTE");
    await write(path.join(localRoot, "f.txt"), "local");

    await transfer({ direction: "download", sources: ["/f.txt"], destinationDir: localRoot, conflict: "skip" });
    expect(await fs.readFile(path.join(localRoot, "f.txt"), "utf8")).toBe("local");
    await transfer({ direction: "download", sources: ["/f.txt"], destinationDir: localRoot, conflict: "overwrite" });
    expect(await fs.readFile(path.join(localRoot, "f.txt"), "utf8")).toBe("REMOTE");
  });

  test("symbolic links inside a folder are skipped and reported, both ways", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(localRoot, "tree", "real.txt"), "r");
    const localLinked = await symlinkOrSkip("real.txt", path.join(localRoot, "tree", "link.txt"));
    if (!localLinked) return;
    await fs.mkdir(path.join(remoteRoot, "dest"));

    const up = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "tree")],
      destinationDir: "/dest",
    });
    expect(up.result?.skipped).toEqual([{ path: path.join(localRoot, "tree", "link.txt"), reason: "symbolic link" }]);
    expect(await fs.readdir(path.join(remoteRoot, "dest", "tree"))).toEqual(["real.txt"]);

    await symlinkOrSkip("real.txt", path.join(remoteRoot, "dest", "tree", "rlink.txt"));
    const back = await tempDir("back");
    const down = await transfer({ direction: "download", sources: ["/dest/tree"], destinationDir: back });
    expect(down.result?.skipped).toEqual([{ path: "/dest/tree/rlink.txt", reason: "symbolic link" }]);
    expect(await fs.readdir(path.join(back, "tree"))).toEqual(["real.txt"]);
  });

  test("a top-level symbolic link is refused", async () => {
    const { localRoot, service, target, connect } = await setup();
    await write(path.join(localRoot, "real.txt"), "r");
    if (!(await symlinkOrSkip("real.txt", path.join(localRoot, "link.txt")))) return;
    await expect(
      service.startTransfer({
        direction: "upload",
        sources: [path.join(localRoot, "link.txt")],
        destinationDir: "/",
        conflict: "fail",
        profileId: "default",
        workspaceId: "ws-1",
        source: "ui",
        ownerKey: "o",
        local: anyLocalPath,
        target: target(),
        connect,
      }),
    ).rejects.toMatchObject({ code: "io" });
  });

  test("cancel stops an upload and removes the temporary .part file", async () => {
    const { remoteRoot, localRoot, service, events, target, connect } = await setup({ writeDelayMs: 40 });
    await write(path.join(localRoot, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
    const { transferId } = await service.startTransfer({
      direction: "upload",
      sources: [path.join(localRoot, "big.bin")],
      destinationDir: "/",
      conflict: "fail",
      profileId: "default",
      workspaceId: "ws-1",
      source: "ui",
      ownerKey: "o",
      local: anyLocalPath,
      target: target(),
      connect,
    });
    await new Promise<void>((resolve) => {
      const poll = () =>
        events.some((event) => event.channel === SSH_FILE_TRANSFER_PROGRESS_CHANNEL) ||
        (service.transfers.get(transferId)?.bytesDone ?? 0) > 0
          ? resolve()
          : setTimeout(poll, 10);
      poll();
    });

    expect(service.transfers.cancel(transferId, { profileId: "default" })).toBe(true);
    await service.transfers.idle();

    expect(service.transfers.get(transferId)?.state).toBe("cancelled");
    const finished = events.filter((event) => event.channel === SSH_FILE_TRANSFER_FINISHED_CHANNEL);
    expect(finished).toHaveLength(1);
    expect((finished[0]!.payload as SshFileTransferFinished).state).toBe("cancelled");
    expect(await fs.readdir(remoteRoot)).toEqual([]);
  }, 30_000);

  test("cancel is scoped to the transfer's profile", async () => {
    const { localRoot, service, target, connect } = await setup({ writeDelayMs: 40 });
    await write(path.join(localRoot, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    const { transferId } = await service.startTransfer({
      direction: "upload",
      sources: [path.join(localRoot, "big.bin")],
      destinationDir: "/",
      conflict: "fail",
      profileId: "default",
      workspaceId: "ws-1",
      source: "ui",
      ownerKey: "o",
      local: anyLocalPath,
      target: target(),
      connect,
    });
    expect(service.transfers.cancel(transferId, { profileId: "other" })).toBe(false);
    expect(service.transfers.cancel(transferId, { profileId: "default" })).toBe(true);
    await service.transfers.idle();
  }, 30_000);

  test("emits progress and exactly one finished event, and lists the run in the payload", async () => {
    const { remoteRoot, localRoot, events, service, transfer } = await setup();
    await write(path.join(localRoot, "p.bin"), Buffer.alloc(100_000, 3));
    await fs.mkdir(path.join(remoteRoot, "d"));

    const run = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "p.bin")],
      destinationDir: "/d",
    });

    const progress = events
      .filter((event) => event.channel === SSH_FILE_TRANSFER_PROGRESS_CHANNEL)
      .map((event) => event.payload as SshFileTransferProgress);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({ bytesDone: 100_000, bytesTotal: 100_000, filesDone: 1, filesTotal: 1 });
    expect(events.filter((event) => event.channel === SSH_FILE_TRANSFER_FINISHED_CHANNEL)).toHaveLength(1);
    const payload = service.transfers.getPayload("default");
    expect(payload.running).toEqual([]);
    expect(payload.lastRuns.map((item) => item.transferId)).toEqual([run.transferId]);
    expect(service.transfers.getPayload("other")).toEqual({ running: [], lastRuns: [] });
  });

  test("a byte cap fails the run before any byte is sent", async () => {
    const { remoteRoot, localRoot, transfer } = await setup();
    await write(path.join(localRoot, "big.bin"), Buffer.alloc(2000));

    const run = await transfer({
      direction: "upload",
      sources: [path.join(localRoot, "big.bin")],
      destinationDir: "/",
      maxBytes: 1000,
    });

    expect(run).toMatchObject({ state: "failed", error: { code: "limit-exceeded" } });
    expect(await fs.readdir(remoteRoot)).toEqual([]);
  });

  test("a download of a missing remote path is refused at start", async () => {
    const { localRoot, service, target, connect } = await setup();
    await expect(
      service.startTransfer({
        direction: "download",
        sources: ["/missing"],
        destinationDir: localRoot,
        conflict: "fail",
        profileId: "default",
        workspaceId: "ws-1",
        source: "ui",
        ownerKey: "o",
        local: anyLocalPath,
        target: target(),
        connect,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  test("the local policy is consulted for the upload source and the download destination", async () => {
    const { localRoot, service, target, connect } = await setup();
    await write(path.join(localRoot, "f.txt"), "x");
    const denying: SshFileLocalPolicy = {
      assertReadable: async () => {
        throw new SshFileError("outside-roots", "no read");
      },
      assertWritableDir: async () => {
        throw new SshFileError("outside-roots", "no write");
      },
    };
    const base = {
      conflict: "fail" as const,
      profileId: "default",
      workspaceId: "ws-1",
      source: "ui" as const,
      ownerKey: "o",
      local: denying,
      target: target(),
      connect,
    };
    await expect(
      service.startTransfer({
        ...base,
        direction: "upload",
        sources: [path.join(localRoot, "f.txt")],
        destinationDir: "/",
      }),
    ).rejects.toMatchObject({ code: "outside-roots" });
    await expect(
      service.startTransfer({ ...base, direction: "download", sources: ["/x"], destinationDir: localRoot }),
    ).rejects.toMatchObject({ code: "outside-roots" });
  });
});

describe("progress throttle", () => {
  test("emits at most once per interval and flushes the latest value", () => {
    let clock = 0;
    const seen: number[] = [];
    const throttle = createProgressThrottle<number>(
      (value) => seen.push(value),
      () => clock,
      250,
    );
    throttle.push(1);
    clock = 100;
    throttle.push(2);
    clock = 200;
    throttle.push(3);
    clock = 260;
    throttle.push(4);
    clock = 300;
    throttle.push(5);
    throttle.flush();
    expect(seen).toEqual([1, 4, 5]);
  });
});
