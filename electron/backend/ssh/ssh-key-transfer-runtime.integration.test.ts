import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, Connection, ParsedKey, SFTPWrapper } from "ssh2";
import { createDefaultState, normalizeState } from "../default-state.js";
import { createRuntime } from "../runtime.js";
import type { CredentialStore } from "../shared/credential-store.js";
import type { SshAuthRequest, SshKeyTransferState } from "../../shared/types/ssh.js";
import { SshManager } from "./ssh-manager.js";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const windowId = "key-transfer-test-window";
const home = "/home/alice";
const sshDirectory = `${home}/.ssh`;
const authorizedKeysPath = `${sshDirectory}/authorized_keys`;
const hostPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const managedPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const managedPrivateKey = managedPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
function isParsedKey(value: ParsedKey | Error): value is ParsedKey {
  return "type" in value;
}
function parseTestKey(privateKey: string): ParsedKey {
  const parsed = utils.parseKey(privateKey);
  if (!isParsedKey(parsed)) throw new Error("Could not build transfer test key");
  return parsed;
}
const managedParsed = parseTestKey(managedPrivateKey);
const managedPublicKey = managedParsed.getPublicSSH();
const managedPublicLine = `${managedParsed.type} ${managedPublicKey.toString("base64")} runtime-test`;
const runtimeCleanups: Array<() => Promise<void>> = [];
const serverCleanups: Array<() => Promise<void>> = [];
const tempPaths: string[] = [];

afterEach(async () => {
  for (const cleanup of runtimeCleanups.splice(0).reverse()) await cleanup();
  for (const cleanup of serverCleanups.splice(0).reverse()) await cleanup();
  await Promise.all(tempPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

interface RemoteEntry {
  directory: boolean;
  mode: number;
  contents?: Buffer;
}

interface TransferServerOptions {
  existingKeys?: Buffer;
  acceptVerificationKey?: boolean;
}

async function startTransferServer(options: TransferServerOptions = {}) {
  const entries = new Map<string, RemoteEntry>([
    ["/", { directory: true, mode: 0o755 }],
    ["/home", { directory: true, mode: 0o755 }],
    [home, { directory: true, mode: 0o700 }],
  ]);
  if (options.existingKeys) {
    entries.set(sshDirectory, { directory: true, mode: 0o700 });
    entries.set(authorizedKeysPath, { directory: false, mode: 0o600, contents: Buffer.from(options.existingKeys) });
  }
  const connections = new Set<Connection>();
  const passwords: string[] = [];
  const authenticationMethods: string[] = [];
  let connectionCount = 0;
  let signatureAccepted = false;
  let shellRequests = 0;
  let execRequests = 0;
  let nextHandle = 0;
  const server = new Server({ hostKeys: [hostPrivateKey] }, (connection) => {
    connectionCount++;
    const thisConnection = connectionCount;
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context: AuthContext) => {
      authenticationMethods.push(context.method);
      if (context.method === "password") {
        passwords.push(context.password || "");
        if (context.password === "one-time-account-password") context.accept();
        else context.reject(["password"]);
        return;
      }
      if (context.method === "publickey" && context.key.data.equals(managedPublicKey)) {
        const authorized = entries
          .get(authorizedKeysPath)
          ?.contents?.toString("utf8")
          .split(/\r?\n/)
          .some((line) => {
            const fields = line.trim().split(/\s+/);
            const keyIndex = fields.findIndex((field) => field === managedParsed.type);
            return keyIndex >= 0 && fields[keyIndex + 1] === managedPublicKey.toString("base64");
          });
        if (thisConnection === 1 || options.acceptVerificationKey === false || !authorized) {
          context.reject(["password"]);
          return;
        }
        if (!context.signature) {
          context.accept();
          return;
        }
        if (managedParsed.verify(context.blob!, context.signature, context.hashAlgo) === true) {
          signatureAccepted = true;
          context.accept();
        } else context.reject(["publickey"]);
        return;
      }
      context.reject(["publickey", "password"]);
    });
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("shell", (acceptShell) => {
          shellRequests++;
          acceptShell().end();
        });
        session.on("exec", (acceptExec) => {
          execRequests++;
          acceptExec().end();
        });
        session.on("sftp", (acceptSftp) => serveSftp(acceptSftp(), entries, () => nextHandle++));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  serverCleanups.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: (server.address() as AddressInfo).port,
    entries,
    passwords,
    authenticationMethods,
    signatureAccepted: () => signatureAccepted,
    shellRequests: () => shellRequests,
    execRequests: () => execRequests,
    activeConnections: () => connections.size,
  };
}

function serveSftp(sftp: SFTPWrapper, entries: Map<string, RemoteEntry>, nextId: () => number) {
  const handles = new Map<number, { path: string; flags: number }>();
  const attrs = (entry: RemoteEntry) => ({
    mode: (entry.directory ? 0o040000 : 0o100000) | entry.mode,
    size: entry.contents?.length || 0,
    uid: 1000,
    gid: 1000,
    atime: 0,
    mtime: 0,
  });
  const pathFor = (remotePath: string) => remotePath.replaceAll("\\", "/");
  const handleId = (handle: Buffer) => handle.readUInt32BE(0);

  sftp.on("REALPATH", (requestId, remotePath) => {
    if (remotePath !== ".") return sftp.status(requestId, STATUS_CODE.FAILURE);
    sftp.name(requestId, [{ filename: home, longname: home, attrs: attrs(entries.get(home)!) }]);
  });
  sftp.on("LSTAT", (requestId, remotePath) => {
    const entry = entries.get(pathFor(remotePath));
    if (!entry) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(requestId, attrs(entry));
  });
  sftp.on("MKDIR", (requestId, remotePath, requested) => {
    const target = pathFor(remotePath);
    if (entries.has(target)) return sftp.status(requestId, STATUS_CODE.FAILURE);
    entries.set(target, { directory: true, mode: requested.mode || 0o777 });
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("SETSTAT", (requestId, remotePath, requested) => {
    const entry = entries.get(pathFor(remotePath));
    if (!entry) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    if (typeof requested.mode === "number") entry.mode = requested.mode & 0o7777;
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("OPEN", (requestId, remotePath, flags, requested) => {
    const target = pathFor(remotePath);
    let entry = entries.get(target);
    if (flags & OPEN_MODE.EXCL && entry) return sftp.status(requestId, STATUS_CODE.FAILURE);
    if (!entry && !(flags & OPEN_MODE.CREAT)) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    if (!entry) {
      entry = { directory: false, mode: requested.mode || 0o666, contents: Buffer.alloc(0) };
      entries.set(target, entry);
    }
    if (entry.directory) return sftp.status(requestId, STATUS_CODE.FAILURE);
    if (flags & OPEN_MODE.TRUNC) entry.contents = Buffer.alloc(0);
    const id = nextId();
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id);
    handles.set(id, { path: target, flags });
    sftp.handle(requestId, handle);
  });
  sftp.on("READ", (requestId, rawHandle, offset, length) => {
    const open = handles.get(handleId(rawHandle));
    const entry = open && entries.get(open.path);
    if (!entry?.contents) return sftp.status(requestId, STATUS_CODE.FAILURE);
    const chunk = entry.contents.subarray(offset, offset + length);
    if (!chunk.length) return sftp.status(requestId, STATUS_CODE.EOF);
    sftp.data(requestId, chunk);
  });
  sftp.on("WRITE", (requestId, rawHandle, offset, data) => {
    const open = handles.get(handleId(rawHandle));
    const entry = open && entries.get(open.path);
    if (!open || !entry || entry.directory || !(open.flags & OPEN_MODE.WRITE)) {
      return sftp.status(requestId, STATUS_CODE.FAILURE);
    }
    const start = open.flags & OPEN_MODE.APPEND ? entry.contents!.length : offset;
    const end = start + data.length;
    const next = Buffer.alloc(Math.max(entry.contents!.length, end));
    entry.contents!.copy(next);
    data.copy(next, start);
    entry.contents = next;
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("CLOSE", (requestId, rawHandle) => {
    handles.delete(handleId(rawHandle));
    sftp.status(requestId, STATUS_CODE.OK);
  });
}

async function createRuntimeFixture() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-key-transfer-"));
  tempPaths.push(userDataPath);
  let state = normalizeState({
    ...createDefaultState(),
    windowSlots: [{ id: windowId, profileId: "default", activeWorkspaceId: "" }],
  });
  const store = {
    getState: () => state,
    async mutate(
      labelOrMutator: string | ((_draft: typeof state) => void),
      maybeMutator?: (_draft: typeof state) => void,
    ) {
      const mutate = typeof labelOrMutator === "function" ? labelOrMutator : maybeMutator;
      const draft = structuredClone(state);
      mutate?.(draft);
      state = normalizeState(draft, { seedRestoreIdsFromSlots: false });
      return state;
    },
    async flush() {},
  };
  const secrets = new Map<string, string>([["saved-password", "must-not-be-sent"]]);
  const credentialStore: CredentialStore = {
    getSecret: (ref) => secrets.get(ref) || "",
    hasSecret: (ref) => secrets.has(ref),
    setSecret: async (ref, value) => void secrets.set(ref, value),
    deleteSecret: async (ref) => void secrets.delete(ref),
    listRefs: () => [...secrets.keys()],
    isEncryptionAvailable: () => true,
  };
  let sshManager!: SshManager;
  const TestSshManager = class extends SshManager {
    constructor(options: ConstructorParameters<typeof SshManager>[0]) {
      super(options);
      sshManager = this;
    }
  };
  const runtime = await createRuntime({
    userDataPath,
    deferInitialRefresh: true,
    dependencies: {
      createStore: async () => store,
      createCredentialStore: async () => credentialStore,
      SshManager: TestSshManager,
      createPluginManager: async () => ({
        getPlugins: () => [],
        getWorkspaceTemplate: () => null,
        stopAll: async () => {},
      }),
    },
  });
  runtimeCleanups.push(async () => runtime.stop());
  return { runtime, store, credentialStore, secrets, sshManager };
}

function waitForTransferState(runtime: Awaited<ReturnType<typeof createRuntime>>, operationId: string) {
  return new Promise<{ status: string; installed?: boolean; remoteMayHaveChanged?: boolean; error?: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for SSH key transfer state"));
      }, 12000);
      let unsubscribe = () => {};
      unsubscribe = runtime.on("ssh:key-transfer:state", (event: { operationId: string; status: string }) => {
        if (
          event.operationId !== operationId ||
          !["installed", "already-installed", "verification-failed", "error", "cancelled"].includes(event.status)
        )
          return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    },
  );
}

async function prepareTransfer(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, port: number) {
  await fixture.runtime["ssh:keys:import"]({ label: "Integration managed key", privateKey: managedPrivateKey });
  const keys = (await fixture.runtime["ssh:keys:list"]()) as Array<{ id: string }>;
  const key = keys[keys.length - 1]!;
  const host = await fixture.runtime["ssh:hosts:create"]({
    name: "Loopback transfer target",
    host: "127.0.0.1",
    port,
    username: "alice",
    auth: { methods: ["publickey"], passwordRef: "saved-password" },
    hostKeyPolicy: "accept-new",
    advanced: { launchVia: "ssh2" },
  });
  return { host: host as { id: string }, key };
}

async function runTransfer(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
  target: string | { draft: Record<string, unknown> },
  keyId: string,
) {
  const authPrompts: Array<{ sessionId: string; promptId: string; prompt: { prompts: Array<{ prompt: string }> } }> =
    [];
  const stateEvents: SshKeyTransferState[] = [];
  const unsubscribeState = fixture.runtime.on("ssh:key-transfer:state", (event: SshKeyTransferState) => {
    if (event.hostId) stateEvents.push(event);
  });
  const unsubscribePrompt = fixture.runtime.on("ssh:auth-prompt", (event: SshAuthRequest) => {
    authPrompts.push(event);
    void fixture.runtime["ssh:auth:answer"]({
      sessionId: event.sessionId,
      promptId: event.promptId,
      answers: ["one-time-account-password"],
    });
  });
  const targetPayload = typeof target === "string" ? { hostId: target } : target;
  const start = await fixture.runtime.sshKeysTransferStart({ profileId: "default", ...targetPayload, keyId }, windowId);
  const terminal = waitForTransferState(fixture.runtime, start.operationId);
  const result = await terminal;
  unsubscribePrompt();
  unsubscribeState();
  return { start, result, authPrompts, stateEvents };
}

function keyFields(contents: Buffer | undefined): string[] {
  return contents?.toString("utf8").trim().split(/\s+/).slice(0, 2) || [];
}

describe("managed SSH key transfer runtime over loopback SSH/SFTP", () => {
  test("prompts once, installs only the public line over SFTP, then verifies the selected key signature", async () => {
    const server = await startTransferServer();
    const fixture = await createRuntimeFixture();
    const { host, key } = await prepareTransfer(fixture, server.port);
    const referencesBefore = fixture.credentialStore.listRefs().sort();
    const workspacesBefore = structuredClone(fixture.store.getState().workspaces);
    const { start, result, authPrompts, stateEvents } = await runTransfer(fixture, host.id, key.id);

    expect(start.status).toBe("connecting");
    expect(result.status).toBe("installed");
    expect(result.installed).toBe(true);
    expect(stateEvents.map((event) => event.status)).toEqual(["connecting", "uploading", "verifying", "installed"]);
    expect(authPrompts).toHaveLength(1);
    expect(authPrompts[0]!.prompt.prompts[0]!.prompt.toLowerCase()).toContain("password");
    expect(server.passwords).toEqual(["one-time-account-password"]);
    expect(server.signatureAccepted()).toBe(true);
    expect(keyFields(server.entries.get(authorizedKeysPath)?.contents)).toEqual(
      managedPublicLine.split(" ").slice(0, 2),
    );
    expect(server.entries.get(authorizedKeysPath)?.contents?.toString("utf8").endsWith("\n")).toBe(true);
    expect(server.shellRequests()).toBe(0);
    expect(server.execRequests()).toBe(0);
    expect(fixture.credentialStore.listRefs().sort()).toEqual(referencesBefore);
    expect(fixture.credentialStore.getSecret("saved-password")).toBe("must-not-be-sent");
    expect(fixture.store.getState().ssh.hosts.find((entry) => entry.id === host.id)?.lastConnectedAt).toBeNull();
    expect(fixture.store.getState().workspaces).toEqual(workspacesBefore);
    expect(fixture.runtime.sshTestSessionOwner(start.operationId)).toBe(windowId);
    await fixture.runtime.sshKeysTransferStop({ operationId: start.operationId }, windowId);
    expect(fixture.runtime.sshTestSessionOwner(start.operationId)).toBeUndefined();
    expect(fixture.sshManager.activeSessions.size).toBe(0);
    expect(fixture.sshManager.pendingPrompts.size).toBe(0);
  });

  test("transfers from the current unsaved host draft without adding it to the host book", async () => {
    const server = await startTransferServer();
    const fixture = await createRuntimeFixture();
    await fixture.runtime["ssh:keys:import"]({ label: "Draft target key", privateKey: managedPrivateKey });
    const key = ((await fixture.runtime["ssh:keys:list"]()) as Array<{ id: string }>)[0]!;
    await fixture.runtime["ssh:hosts:create"]({
      name: "Existing saved target",
      host: "saved.example",
      port: 2222,
      username: "alice",
      auth: { methods: ["publickey"] },
      advanced: { launchVia: "ssh2" },
    });
    const hostsBefore = structuredClone(fixture.store.getState().ssh.hosts);
    const referencesBefore = fixture.credentialStore.listRefs().sort();
    const workspacesBefore = structuredClone(fixture.store.getState().workspaces);
    const draft = {
      name: "Unsaved edited target",
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      auth: { methods: ["publickey"], keyRef: "stale-selection", passwordRef: "saved-password" },
      hostKeyPolicy: "accept-new",
      advanced: { launchVia: "ssh2" },
    };
    const { start, result, authPrompts, stateEvents } = await runTransfer(fixture, { draft }, key.id);

    expect(result.status).toBe("installed");
    expect(stateEvents.map((event) => event.status)).toEqual(["connecting", "uploading", "verifying", "installed"]);
    expect(stateEvents[0]?.hostId).toMatch(/^ssh-transfer-draft:/);
    expect(authPrompts).toHaveLength(1);
    expect(authPrompts[0]!.prompt.prompts[0]!.prompt.toLowerCase()).toContain("password");
    expect(server.passwords).toEqual(["one-time-account-password"]);
    expect(server.signatureAccepted()).toBe(true);
    expect(keyFields(server.entries.get(authorizedKeysPath)?.contents)).toEqual(
      managedPublicLine.split(" ").slice(0, 2),
    );
    expect(server.authenticationMethods).toContain("password");
    expect(server.shellRequests()).toBe(0);
    expect(server.execRequests()).toBe(0);
    expect(fixture.store.getState().ssh.hosts).toEqual(hostsBefore);
    expect(fixture.credentialStore.listRefs().sort()).toEqual(referencesBefore);
    expect(fixture.credentialStore.getSecret("saved-password")).toBe("must-not-be-sent");
    expect(fixture.store.getState().workspaces).toEqual(workspacesBefore);
    expect(fixture.runtime.sshTestSessionOwner(start.operationId)).toBe(windowId);
    await fixture.runtime.sshKeysTransferStop({ operationId: start.operationId }, windowId);
    expect(fixture.sshManager.activeSessions.size).toBe(0);
  });

  test("keeps draft transfer bound to its desktop window and Built-in SSH", async () => {
    const fixture = await createRuntimeFixture();
    await expect(
      fixture.runtime.sshKeysTransferStart(
        {
          profileId: "default",
          keyId: "unused",
          draft: { host: "  ", username: "alice", advanced: { launchVia: "ssh2" } },
        },
        windowId,
      ),
    ).rejects.toThrow("Enter a host name or SSH alias");
    await expect(
      fixture.runtime.sshKeysTransferStart(
        {
          profileId: "default",
          keyId: "unused",
          draft: { host: "mini.local", username: "  ", advanced: { launchVia: "ssh2" } },
        },
        windowId,
      ),
    ).rejects.toThrow("Enter the remote username");
    await fixture.runtime["ssh:keys:import"]({ label: "Draft target key", privateKey: managedPrivateKey });
    const key = ((await fixture.runtime["ssh:keys:list"]()) as Array<{ id: string }>)[0]!;
    const payload = {
      profileId: "default",
      keyId: key.id,
      draft: {
        host: "mini.local",
        username: "alice",
        advanced: { launchVia: "system-ssh" },
      },
    };

    await expect(fixture.runtime.sshKeysTransferStart(payload, "another-window")).rejects.toThrow(
      "The active window profile changed",
    );
    await expect(fixture.runtime.sshKeysTransferStart(payload, windowId)).rejects.toThrow(
      "Public-key transfer requires Built-in SSH",
    );
    expect(fixture.store.getState().ssh.hosts).toEqual([]);
  });

  test("reports an existing key separately after proving it authenticates", async () => {
    const server = await startTransferServer({ existingKeys: Buffer.from(`${managedPublicLine}\n`) });
    const fixture = await createRuntimeFixture();
    const { host, key } = await prepareTransfer(fixture, server.port);
    const { result } = await runTransfer(fixture, host.id, key.id);

    expect(result.status).toBe("already-installed");
    expect(result.installed).toBe(true);
    expect(server.entries.get(authorizedKeysPath)?.contents?.toString("utf8")).toBe(`${managedPublicLine}\n`);
    expect(server.signatureAccepted()).toBe(true);
  });

  test("reports verification failure truthfully after the public key has been installed", async () => {
    const server = await startTransferServer({ acceptVerificationKey: false });
    const fixture = await createRuntimeFixture();
    const { host, key } = await prepareTransfer(fixture, server.port);
    const { result } = await runTransfer(fixture, host.id, key.id);

    expect(result.status).toBe("verification-failed");
    expect(result.installed).toBe(true);
    expect(keyFields(server.entries.get(authorizedKeysPath)?.contents)).toEqual(
      managedPublicLine.split(" ").slice(0, 2),
    );
    expect(server.shellRequests()).toBe(0);
    expect(server.execRequests()).toBe(0);
  });

  test("owner shutdown cancels a pending password prompt and releases the SSH generation", async () => {
    const server = await startTransferServer();
    const fixture = await createRuntimeFixture();
    const { host, key } = await prepareTransfer(fixture, server.port);
    let resolvePrompt!: (event: { sessionId: string; promptId: string }) => void;
    const passwordPrompt = new Promise<{ sessionId: string; promptId: string }>((resolve) => (resolvePrompt = resolve));
    const unsubscribePrompt = fixture.runtime.on("ssh:auth-prompt", (event: SshAuthRequest) => resolvePrompt(event));
    const started = await fixture.runtime.sshKeysTransferStart(
      { profileId: "default", hostId: host.id, keyId: key.id },
      windowId,
    );
    const cancelledState = waitForTransferState(fixture.runtime, started.operationId);
    const prompt = await passwordPrompt;
    expect(fixture.runtime.isPrivateSshOperationSession(prompt.sessionId)).toBe(true);
    await fixture.runtime.sshTestStopOwner(windowId);
    const terminal = await cancelledState;
    unsubscribePrompt();

    expect(terminal.status).toBe("cancelled");
    expect(fixture.runtime.isPrivateSshOperationSession(prompt.sessionId)).toBe(false);
    expect(fixture.runtime.sshTestSessionOwner(prompt.sessionId)).toBeUndefined();
    expect(fixture.sshManager.activeSessions.size).toBe(0);
    expect(fixture.sshManager.pendingPrompts.size).toBe(0);
    expect(server.passwords).toEqual([]);
  });
});
