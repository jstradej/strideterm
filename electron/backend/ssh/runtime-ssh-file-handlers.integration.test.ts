import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppState } from "../../shared/types/state.js";
import type { CredentialStore } from "../shared/credential-store.js";
import { createSshFileHandlers } from "./runtime-ssh-file-handlers.js";
import { SshManager } from "./ssh-manager.js";
import { startSftpTestServer } from "./test-support/sftp-test-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DESKTOP = "win-1";
const REMOTE = "remote:s1";
const REMOTE_OTHER_PROFILE = "remote:s2";
const profiles: Record<string, string> = {
  [DESKTOP]: "default",
  [REMOTE]: "default",
  [REMOTE_OTHER_PROFILE]: "other",
};

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `strideterm-sshfile-h-${label}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup() {
  const remoteRoot = await tempDir("remote");
  const workspaceRoot = await tempDir("workspace");
  const outsideRoot = await tempDir("outside");
  await fs.mkdir(path.join(remoteRoot, "docs"));
  const server = await startSftpTestServer({ rootDir: remoteRoot });
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
  const host = (id: string, launchVia = "ssh2") => ({
    id,
    name: id === "host-local" ? "Local test host" : "System host",
    host: "127.0.0.1",
    port: server.port,
    username: "alice",
    auth: { methods: ["password"], passwordRef: "ssh:password:test" },
    advanced: { launchVia },
    hostKeyPolicy: "accept-new",
  });
  const sshTab = (id: string, hostId: string) => ({
    id,
    title: id,
    command: "",
    launch: { kind: "ssh", sshHostId: hostId, remoteCwd: "/docs" },
  });
  const state = {
    ssh: {
      hosts: [host("host-local"), host("host-system", "system-ssh")],
      keys: [],
      certificates: [],
      knownHosts: {},
      settings: {},
    },
    settings: { ssh: {} },
    workspaces: [
      {
        id: "ws-1",
        name: "Workspace one",
        profileId: "default",
        panels: [
          sshTab("tab-ssh", "host-local"),
          sshTab("tab-system", "host-system"),
          { id: "tab-shell", title: "Shell", command: "" },
          { id: "tab-sftp", title: "Files", command: "__sftp__", sftp: { sourcePanelId: "tab-ssh" } },
          {
            id: "tab-sftp-orphan",
            title: "Files",
            command: "__sftp__",
            sftp: { sshHostId: "host-local", path: "/docs" },
          },
        ],
      },
      { id: "ws-2", name: "Workspace two", profileId: "other", panels: [sshTab("tab-ssh", "host-local")] },
    ],
  };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
  };
  const sshManager = new SshManager({ store, credentialStore: credentials });
  const events = new EventEmitter();
  const handlers = createSshFileHandlers({
    sshManager,
    getState: () => state as unknown as AppState,
    emit: (channel, payload) => events.emit(channel, payload),
    getWindowProfileId: (windowId) => (windowId ? (profiles[windowId] ?? null) : null),
    getEffectiveLaunchMode: (record) => (record.advanced?.launchVia === "system-ssh" ? "system-ssh" : "ssh2"),
    createSessionId: (workspaceId, panelId) => `${workspaceId}:${panelId}`,
    rootsForProfile: (profileId) => (profileId === "default" ? [workspaceRoot] : []),
  });
  cleanups.push(async () => {
    handlers.close();
    await Promise.all(
      [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
    );
  });

  /** Connects the SSH tab the way the terminal does: a held, authenticated ssh2 session under the tab's session id. */
  async function connectTab(panelId = "tab-ssh") {
    const sessionId = `ws-1:${panelId}`;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const running = sshManager.createSession({
      sessionId,
      hostId: "host-local",
      cols: 80,
      rows: 24,
      authOnly: true,
      authenticatedActionTimeoutMs: 0,
      onAuthenticated: () => hold,
    });
    running.catch(() => {});
    await new Promise<void>((resolve) => {
      const poll = () => (sshManager.activeSessions.get(sessionId)?.ready ? resolve() : setTimeout(poll, 10));
      poll();
    });
    cleanups.push(async () => release());
  }

  const tabRef = { workspaceId: "ws-1", panelId: "tab-ssh" };
  return { server, remoteRoot, workspaceRoot, outsideRoot, handlers, state, connectTab, tabRef, events, sshManager };
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe("SSH file access policy", () => {
  test("desktop: uses the live session of the SSH tab when it is connected", async () => {
    const { server, handlers, connectTab, tabRef } = await setup();
    await connectTab();
    expect(server.stats.connections).toBe(1);

    const listing = await handlers.sshFileList({ ...tabRef, path: "/docs" }, DESKTOP);

    expect(listing.path).toBe("/docs");
    expect(server.stats.connections).toBe(1);
  });

  test("desktop: connects on its own when the tab is not connected", async () => {
    const { server, handlers, tabRef } = await setup();
    await handlers.sshFileList({ ...tabRef, path: "/docs" }, DESKTOP);
    expect(server.stats.connections).toBe(1);
  });

  test("desktop: an SFTP tab resolves through its source tab, and falls back to the saved host", async () => {
    const { handlers, remoteRoot } = await setup();
    await write(path.join(remoteRoot, "docs", "a.txt"), "a");

    const viaSource = await handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-sftp", path: "/docs" }, DESKTOP);
    const viaHost = await handlers.sshFileList(
      { workspaceId: "ws-1", panelId: "tab-sftp-orphan", path: "/docs" },
      DESKTOP,
    );

    expect(viaSource.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    expect(viaHost.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  test("the browser starts in the tab's remote directory when no path is named", async () => {
    const { handlers, tabRef } = await setup();
    expect(await handlers.sshFileRealpath(tabRef, DESKTOP)).toEqual({ path: "/docs" });
  });

  test("a remote directory of ~/x resolves against the home directory, and a missing one falls back to it", async () => {
    const { handlers, state, tabRef } = await setup();
    const launch = (state.workspaces[0]!.panels[0] as { launch: { remoteCwd: string } }).launch;

    launch.remoteCwd = "~/docs";
    expect(await handlers.sshFileRealpath(tabRef, DESKTOP)).toEqual({ path: "/docs" });
    launch.remoteCwd = "~/missing";
    expect(await handlers.sshFileRealpath(tabRef, DESKTOP)).toEqual({ path: "/" });
    launch.remoteCwd = "relative/dir";
    expect(await handlers.sshFileRealpath(tabRef, DESKTOP)).toEqual({ path: "/" });
  });

  test("remote client: works through the live session of an SSH tab in its profile", async () => {
    const { server, handlers, connectTab, tabRef } = await setup();
    await connectTab();

    const listing = await handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE);

    expect(listing.path).toBe("/docs");
    expect(server.stats.connections).toBe(1);
  });

  test("remote client: opens its own connection to the tab's saved host when the tab is not connected", async () => {
    const { server, handlers, tabRef } = await setup();

    const listing = await handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE);
    expect(listing.path).toBe("/docs");
    expect(server.stats.connections).toBe(1);

    await handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-sftp-orphan", path: "/docs" }, REMOTE);
  });

  test("remote client: own connections are pooled per viewer, never shared with another viewer or a window", async () => {
    const { server, handlers, tabRef } = await setup();
    profiles["remote:s3"] = "default";
    try {
      await handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE);
      await handlers.sshFileList({ ...tabRef, path: "/" }, REMOTE);
      expect(server.stats.connections).toBe(1);

      await handlers.sshFileList({ ...tabRef, path: "/docs" }, "remote:s3");
      expect(server.stats.connections).toBe(2);

      await handlers.sshFileList({ ...tabRef, path: "/docs" }, DESKTOP);
      expect(server.stats.connections).toBe(3);

      handlers.sshFileCloseViewer("remote:s3");
      await handlers.sshFileList({ ...tabRef, path: "/docs" }, "remote:s3");
      expect(server.stats.connections).toBe(4);
    } finally {
      delete profiles["remote:s3"];
    }
  });

  test("remote client: cannot name a host, and a tab without a usable SSH host reaches none", async () => {
    const { server, handlers, tabRef } = await setup();

    await expect(
      handlers.sshFileList({ ...tabRef, path: "/docs", hostId: "host-system" }, REMOTE),
    ).rejects.toBeTruthy();
    await expect(handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-shell" }, REMOTE)).rejects.toMatchObject({
      code: "io",
    });
    await expect(handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-system" }, REMOTE)).rejects.toMatchObject({
      code: "unsupported-host",
    });
    expect(server.stats.connections).toBe(0);
  });

  test("remote client: a password prompt is owned by that viewer and answering it completes the connect", async () => {
    const { server, handlers, state, tabRef, sshManager } = await setup();
    (state.ssh.hosts[0] as { auth: unknown }).auth = { methods: ["password"] };
    const prompted: Array<{ sessionId: string; owner: string | undefined }> = [];
    sshManager.on("ssh:auth-prompt", (event: { sessionId: string; promptId: string }) => {
      prompted.push({ sessionId: event.sessionId, owner: handlers.sshFileSessionOwner(event.sessionId) });
      sshManager.answerAuthPrompt(event.sessionId, [server.password], event.promptId);
    });

    const listing = await handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE);

    expect(listing.path).toBe("/docs");
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.sessionId).toMatch(/^ssh-file:/);
    expect(prompted[0]!.owner).toBe(REMOTE);
    expect(handlers.sshFileSessionOwner(prompted[0]!.sessionId)).toBeUndefined();
  });

  test("remote client: cancelling the prompt, or the viewer going away, fails the request without a hang", async () => {
    const { handlers, state, tabRef, sshManager } = await setup();
    (state.ssh.hosts[0] as { auth: unknown }).auth = { methods: ["password"] };
    sshManager.once("ssh:auth-prompt", (event: { sessionId: string; promptId: string }) =>
      sshManager.cancelAuthPrompt(event.sessionId, event.promptId),
    );
    await expect(handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE)).rejects.toMatchObject({
      code: "not-connected",
    });

    const waiting = new Promise<string>((resolve) =>
      sshManager.once("ssh:auth-prompt", (event: { sessionId: string }) => resolve(event.sessionId)),
    );
    const rejected = expect(handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE)).rejects.toMatchObject({
      code: "not-connected",
    });
    expect(handlers.sshFileSessionOwner(await waiting)).toBe(REMOTE);
    handlers.sshFileCloseViewer(REMOTE);
    await rejected;
  });

  test("remote client: another profile's workspace is refused", async () => {
    const { handlers, connectTab } = await setup();
    await connectTab();
    await expect(
      handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-ssh", path: "/" }, REMOTE_OTHER_PROFILE),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      handlers.sshFileList({ workspaceId: "ws-2", panelId: "tab-ssh", path: "/" }, REMOTE),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  test("a client that is not bound to a profile gets nothing", async () => {
    const { handlers, tabRef } = await setup();
    await expect(handlers.sshFileList(tabRef, "remote:unknown")).rejects.toMatchObject({ code: "permission-denied" });
    await expect(handlers.sshFileList(tabRef, undefined)).rejects.toMatchObject({ code: "permission-denied" });
  });

  test("a tab that is not an SSH tab, and a System SSH tab, are refused", async () => {
    const { handlers } = await setup();
    await expect(handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-shell" }, DESKTOP)).rejects.toMatchObject({
      code: "io",
    });
    await expect(handlers.sshFileList({ workspaceId: "ws-1", panelId: "tab-system" }, DESKTOP)).rejects.toMatchObject({
      code: "unsupported-host",
    });
  });

  test("desktop upload accepts any absolute local path the user chose", async () => {
    const { handlers, outsideRoot, remoteRoot, tabRef } = await setup();
    await write(path.join(outsideRoot, "picked.txt"), "picked");

    const { transferId } = await handlers.sshFileUpload(
      { ...tabRef, localPaths: [path.join(outsideRoot, "picked.txt")], remoteDir: "/docs" },
      DESKTOP,
    );
    await handlers.service.transfers.idle();

    expect(handlers.service.transfers.get(transferId)?.state).toBe("succeeded");
    expect(await fs.readFile(path.join(remoteRoot, "docs", "picked.txt"), "utf8")).toBe("picked");
  });

  test("remote upload is limited to the profile's workspace roots", async () => {
    const { handlers, connectTab, outsideRoot, workspaceRoot, remoteRoot, tabRef } = await setup();
    await connectTab();
    await write(path.join(outsideRoot, "secret.txt"), "secret");
    await write(path.join(workspaceRoot, "src", "ok.txt"), "ok");

    await expect(
      handlers.sshFileUpload(
        { ...tabRef, localPaths: [path.join(outsideRoot, "secret.txt")], remoteDir: "/docs" },
        REMOTE,
      ),
    ).rejects.toMatchObject({ code: "outside-roots" });

    const { transferId } = await handlers.sshFileUpload(
      { ...tabRef, localPaths: [path.join(workspaceRoot, "src")], remoteDir: "/docs" },
      REMOTE,
    );
    await handlers.service.transfers.idle();
    expect(handlers.service.transfers.get(transferId)?.state).toBe("succeeded");
    expect(await fs.readFile(path.join(remoteRoot, "docs", "src", "ok.txt"), "utf8")).toBe("ok");
    expect(await fs.readdir(path.join(remoteRoot, "docs"))).not.toContain("secret.txt");
  });

  test("remote upload cannot escape the roots with ..", async () => {
    const { handlers, connectTab, outsideRoot, workspaceRoot, tabRef } = await setup();
    await connectTab();
    await write(path.join(outsideRoot, "secret.txt"), "secret");
    const sneaky = path.join(workspaceRoot, "..", path.basename(outsideRoot), "secret.txt");

    await expect(
      handlers.sshFileUpload({ ...tabRef, localPaths: [sneaky], remoteDir: "/docs" }, REMOTE),
    ).rejects.toMatchObject({ code: "outside-roots" });
  });

  test("remote upload cannot follow a symbolic link out of the roots", async () => {
    const { handlers, connectTab, outsideRoot, workspaceRoot, tabRef } = await setup();
    await connectTab();
    await write(path.join(outsideRoot, "secret.txt"), "secret");
    try {
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "escape"), "junction");
    } catch {
      return;
    }

    await expect(
      handlers.sshFileUpload(
        { ...tabRef, localPaths: [path.join(workspaceRoot, "escape", "secret.txt")], remoteDir: "/docs" },
        REMOTE,
      ),
    ).rejects.toMatchObject({ code: "outside-roots" });
  });

  test("remote download writes only inside the profile's roots", async () => {
    const { handlers, connectTab, outsideRoot, workspaceRoot, remoteRoot, tabRef } = await setup();
    await connectTab();
    await write(path.join(remoteRoot, "docs", "r.txt"), "remote");

    await expect(
      handlers.sshFileDownload({ ...tabRef, remotePaths: ["/docs/r.txt"], localDir: outsideRoot }, REMOTE),
    ).rejects.toMatchObject({ code: "outside-roots" });

    const { transferId } = await handlers.sshFileDownload(
      { ...tabRef, remotePaths: ["/docs/r.txt"], localDir: workspaceRoot },
      REMOTE,
    );
    await handlers.service.transfers.idle();
    expect(handlers.service.transfers.get(transferId)?.state).toBe("succeeded");
    expect(await fs.readFile(path.join(workspaceRoot, "r.txt"), "utf8")).toBe("remote");
  });

  test("a mobile session may upload but never download", async () => {
    const { handlers, connectTab, workspaceRoot, remoteRoot, tabRef } = await setup();
    await connectTab();
    await write(path.join(workspaceRoot, "from-phone.txt"), "p");
    await write(path.join(remoteRoot, "docs", "r.txt"), "remote");

    const { transferId } = await handlers.sshFileUpload(
      { ...tabRef, localPaths: [path.join(workspaceRoot, "from-phone.txt")], remoteDir: "/docs" },
      REMOTE,
      { mobile: true },
    );
    await handlers.service.transfers.idle();
    expect(handlers.service.transfers.get(transferId)?.state).toBe("succeeded");

    await expect(
      handlers.sshFileDownload({ ...tabRef, remotePaths: ["/docs/r.txt"], localDir: workspaceRoot }, REMOTE, {
        mobile: true,
      }),
    ).rejects.toMatchObject({ code: "denied-for-mobile" });
    expect(await fs.readdir(workspaceRoot)).toEqual(["from-phone.txt"]);
  });

  test("remote-side mutations act through the live tab for a remote client", async () => {
    const { handlers, connectTab, remoteRoot, tabRef } = await setup();
    await connectTab();

    await handlers.sshFileMkdir({ ...tabRef, path: "/docs/new" }, REMOTE);
    await handlers.sshFileRename({ ...tabRef, from: "/docs/new", to: "/docs/renamed" }, REMOTE);
    expect(await fs.readdir(path.join(remoteRoot, "docs"))).toEqual(["renamed"]);
    expect(await handlers.sshFileDelete({ ...tabRef, paths: ["/docs/renamed"], recursive: true }, REMOTE)).toEqual({
      deleted: 1,
    });
  });

  test("onResolved names the host for the mobile audit trail", async () => {
    const { handlers, connectTab, tabRef } = await setup();
    await connectTab();
    const labels: string[] = [];
    await handlers.sshFileList({ ...tabRef, path: "/docs" }, REMOTE, {
      mobile: true,
      onResolved: (info) => labels.push(info.hostLabel),
    });
    expect(labels).toEqual(["Local test host"]);
  });

  test("a transfer can only be cancelled from its own profile", async () => {
    const { handlers, workspaceRoot, tabRef, connectTab } = await setup();
    await connectTab();
    await fs.writeFile(path.join(workspaceRoot, "big.bin"), Buffer.alloc(1024));
    const { transferId } = await handlers.sshFileUpload(
      { ...tabRef, localPaths: [path.join(workspaceRoot, "big.bin")], remoteDir: "/docs" },
      REMOTE,
    );
    await handlers.service.transfers.idle();
    await expect(handlers.sshFileTransferCancel({ transferId }, REMOTE_OTHER_PROFILE)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  test("request schemas reject unknown keys", async () => {
    const { handlers, tabRef } = await setup();
    await expect(handlers.sshFileList({ ...tabRef, extra: 1 }, DESKTOP)).rejects.toThrow(/IPC validation failed/);
    await expect(
      handlers.sshFileUpload({ ...tabRef, localPaths: ["/x"], remoteDir: "/docs", conflict: "maybe" }, DESKTOP),
    ).rejects.toThrow(/IPC validation failed/);
  });

  test("the payload lists a profile's transfers and no other profile's", async () => {
    const { handlers, workspaceRoot, tabRef, connectTab } = await setup();
    await connectTab();
    await fs.writeFile(path.join(workspaceRoot, "a.txt"), "a");
    const { transferId } = await handlers.sshFileUpload(
      { ...tabRef, localPaths: [path.join(workspaceRoot, "a.txt")], remoteDir: "/docs" },
      REMOTE,
    );
    await handlers.service.transfers.idle();

    expect(handlers.sshFileTransfersPayload("default").lastRuns.map((run) => run.transferId)).toEqual([transferId]);
    expect(handlers.sshFileTransfersPayload("other")).toEqual({ running: [], lastRuns: [] });
  });
});
