import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, Connection, Prompt } from "ssh2";
import { createDefaultState, normalizeState } from "../default-state.js";
import { createRuntime } from "../runtime.js";
import type { SshTestPtySpawn } from "../session-manager.js";
import { SessionManager } from "../session-manager.js";
import { SshManager } from "./ssh-manager.js";
import type { CredentialStore } from "../shared/credential-store.js";

const { Server, utils } = ssh2;
const windowId = "ssh-test-window";
const runtimeCleanups: Array<() => Promise<void>> = [];
const serverCleanups: Array<() => Promise<void>> = [];
const tempPaths: string[] = [];

afterEach(async () => {
  for (const cleanup of runtimeCleanups.splice(0).reverse()) await cleanup();
  for (const cleanup of serverCleanups.splice(0).reverse()) await cleanup();
  await Promise.all(tempPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function createServer(
  authenticate: (_context: AuthContext) => void,
  probeResult: { marker?: string; exitCode?: number; hold?: boolean } = {},
) {
  const connections = new Set<Connection>();
  const counts = {
    authentication: 0,
    pty: 0,
    shell: 0,
    exec: [] as string[],
    activeConnections: 0,
    shellInput: [] as string[],
  };
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  });
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    counts.activeConnections++;
    connection.on("error", () => {});
    connection.on("close", () => {
      connections.delete(connection);
      counts.activeConnections--;
    });
    connection.on("authentication", (context) => {
      counts.authentication++;
      authenticate(context);
    });
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => {
          counts.pty++;
          acceptPty();
        });
        session.on("shell", (acceptShell) => {
          counts.shell++;
          const channel = acceptShell();
          channel.on("error", () => {});
          channel.write("NATIVE_SSH_SHELL_READY\r\n");
          channel.on("data", (data: Buffer) => {
            counts.shellInput.push(data.toString("utf8"));
            channel.write(data);
          });
        });
        session.on("exec", (acceptExec, _rejectExec, info) => {
          counts.exec.push(info.command);
          const channel = acceptExec();
          channel.on("error", () => {});
          if (probeResult.hold) return;
          const marker =
            probeResult.marker === "from-command" && info.command.startsWith("echo ")
              ? info.command.slice("echo ".length)
              : probeResult.marker;
          if (marker) channel.write(`${marker}\r\n`);
          else channel.write("\r\n");
          channel.exit(probeResult.exitCode ?? 0);
          channel.end();
        });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  serverCleanups.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, counts };
}

interface SystemPreparationGate {
  wait: Promise<void>;
  entered(): void;
}

async function createRuntimeFixture(
  privateKey = "",
  ptySpawn?: SshTestPtySpawn,
  extraSecrets: Record<string, string> = {},
  systemPreparationGate?: SystemPreparationGate,
) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-ssh-test-"));
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
  const secrets = new Map<string, string>([
    ...(privateKey ? [["ssh:key:integration", privateKey] as const] : []),
    ...Object.entries(extraSecrets),
  ]);
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
  let sessionManager!: SessionManager;
  const TestSessionManager = class extends SessionManager {
    constructor(options: ConstructorParameters<typeof SessionManager>[0]) {
      super(options);
      sessionManager = this;
    }

    override ensureSystemSshSession(...args: Parameters<SessionManager["ensureSystemSshSession"]>) {
      if (systemPreparationGate) {
        systemPreparationGate.entered();
        return systemPreparationGate.wait.then(() => super.ensureSystemSshSession(...args));
      }
      return super.ensureSystemSshSession(...args);
    }
  };
  const runtime = await createRuntime({
    userDataPath,
    deferInitialRefresh: true,
    dependencies: {
      createStore: async () => store,
      createCredentialStore: async () => credentialStore,
      SessionManager: TestSessionManager,
      SshManager: TestSshManager,
      ...(ptySpawn ? { sshTestPtySpawn: ptySpawn } : {}),
      createPluginManager: async () => ({
        getPlugins: () => [],
        getWorkspaceTemplate: () => null,
        stopAll: async () => {},
      }),
    },
  });
  runtimeCleanups.push(async () => runtime.stop());
  return { runtime, store, credentialStore, sshManager, sessionManager };
}

type TestStateEvent = { sessionId: string; status: string; mode: string; error?: string };
type AuthEvent = {
  sessionId: string;
  promptId: string;
  prompt: { prompts: Prompt[] };
};

function waitFor<T>(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  eventName: string,
  predicate: (_event: T) => boolean,
  timeoutMs = 5000,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    let unsubscribe = () => {};
    const listener = (event: T) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    };
    unsubscribe = runtime.on(eventName, listener);
  });
}

function draft(port: number, auth: Record<string, unknown>, command: string) {
  return {
    name: "Unsaved loopback host",
    host: "127.0.0.1",
    port,
    username: "alice",
    auth,
    hostKeyPolicy: "accept-new",
    advanced: { launchVia: "ssh2", command },
  };
}

async function waitForConnectionsToClose(counts: { activeConnections: number }) {
  const deadline = Date.now() + 5000;
  while (counts.activeConnections && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(counts.activeConnections).toBe(0);
}

function createNativeOpenSshPty(
  configPath: string,
  captureSpawn?: (_file: string, _args: string[], _launchedArgs: string[]) => void,
  remoteTty = true,
): SshTestPtySpawn {
  return (file, args, options) => {
    const ptyArgs = Array.isArray(args) ? args : [args];
    const separator = ptyArgs.indexOf("--");
    if (separator < 0) throw new Error("Expected the SSH host separator in OpenSSH arguments");
    const launchedArgs = [
      ...ptyArgs.slice(0, separator),
      "-F",
      configPath,
      ...(remoteTty ? ["-tt"] : []),
      ...ptyArgs.slice(separator),
    ];
    captureSpawn?.(file, ptyArgs, launchedArgs);
    const child = spawn(file, launchedArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    type ChildExit = { exitCode: number; signal?: number };
    let childExit: ChildExit | undefined;
    const exitListeners = new Set<(_event: ChildExit) => void>();
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      childExit = { exitCode: code ?? 0, ...(signal ? { signal: signal.length } : {}) };
      for (const listener of exitListeners) listener(childExit);
      exitListeners.clear();
    });
    return {
      pid: child.pid || 0,
      cols: options.cols,
      rows: options.rows,
      process: file,
      handleFlowControl: false,
      onData: (handler: (_data: string) => void) => {
        const stdout = (chunk: Buffer) => handler(chunk.toString("utf8"));
        const stderr = (chunk: Buffer) => handler(chunk.toString("utf8"));
        child.stdout.on("data", stdout);
        child.stderr.on("data", stderr);
        return {
          dispose: () => {
            child.stdout.off("data", stdout);
            child.stderr.off("data", stderr);
          },
        };
      },
      onExit: (handler: (_event: ChildExit) => void) => {
        if (childExit) {
          queueMicrotask(() => handler(childExit!));
          return { dispose: () => {} };
        }
        exitListeners.add(handler);
        return { dispose: () => exitListeners.delete(handler) };
      },
      resize: () => {},
      clear: () => {},
      write: (data: string | Buffer) => void child.stdin.write(data),
      kill: () => {
        child.kill();
      },
      pause: () => {
        child.stdout.pause();
        child.stderr.pause();
      },
      resume: () => {
        child.stdout.resume();
        child.stderr.resume();
      },
    } as unknown as ReturnType<SshTestPtySpawn>;
  };
}

async function expectPathRemoved(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Expected temporary SSH key to be removed: ${file}`);
}

async function expectTestSessionRemoved(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  sessionManager: SessionManager,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!runtime.isSshTestSession(sessionId) && !sessionManager.sessions.has(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(runtime.isSshTestSession(sessionId)).toBe(false);
  expect(sessionManager.sessions.has(sessionId)).toBe(false);
}

const systemSshBinary = process.platform === "win32" ? "ssh.exe" : "ssh";
const systemSshProbe = spawnSync(systemSshBinary, ["-V"], { windowsHide: true, timeout: 3000 });
const systemSshMissing = (systemSshProbe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

describe("runtime SSH connection tests against a real loopback server", () => {
  test("managed public key authenticates, then disconnects without requesting a shell or mutating host/workspace state", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const publicKey = utils.parseKey(privateKey);
    if (publicKey instanceof Error || Array.isArray(publicKey)) throw new Error("Invalid integration test key");
    let signed = false;
    const server = await createServer((context) => {
      if (context.method !== "publickey" || !context.key.data.equals(publicKey.getPublicSSH())) {
        context.reject(["publickey"]);
        return;
      }
      if (!context.signature) {
        context.accept();
        return;
      }
      const verified = publicKey.verify(context.blob!, context.signature, context.hashAlgo);
      if (verified) {
        signed = true;
        context.accept();
      } else context.reject(["publickey"]);
    });
    const { runtime, store, sshManager } = await createRuntimeFixture(privateKey);
    const savedHost = await runtime["ssh:hosts:create"]({
      name: "Saved before test",
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      auth: { methods: ["publickey"], keyRef: "ssh:key:integration" },
      hostKeyPolicy: "accept-new",
      advanced: { launchVia: "ssh2" },
    });
    const hostsBefore = structuredClone(store.getState().ssh.hosts);
    const workspacesBefore = structuredClone(store.getState().workspaces);
    const authenticated = waitFor<TestStateEvent>(
      runtime,
      "ssh:test:state",
      (event) => event.status === "authenticated",
    );

    const started = await runtime.sshTestStart(
      {
        profileId: "default",
        draft: draft(server.port, { methods: ["publickey"], keyRef: "ssh:key:integration" }, "should-not-run"),
      },
      windowId,
    );
    expect(started.mode).toBe("ssh2");
    const event = await authenticated;
    expect(event.sessionId).toBe(started.sessionId);
    expect(signed).toBe(true);
    await waitForConnectionsToClose(server.counts);
    expect(server.counts.shell).toBe(0);
    expect(server.counts.pty).toBe(0);
    expect(store.getState().ssh.hosts).toEqual(hostsBefore);
    expect(store.getState().workspaces).toEqual(workspacesBefore);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
    await expect(runtime.sshTestStop({ sessionId: started.sessionId }, windowId)).resolves.toEqual({ ok: true });
    await expect(runtime.sshTestStop({ sessionId: started.sessionId }, windowId)).resolves.toEqual({ ok: true });
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);

    const updatedHost = await runtime["ssh:hosts:update"]({ id: savedHost.id, patch: { name: "Saved after test" } });
    expect(updatedHost.id).toBe(savedHost.id);
    expect(updatedHost.name).toBe("Saved after test");
    expect(store.getState().ssh.hosts.find((host) => host.id === savedHost.id)?.name).toBe("Saved after test");
  });

  test("keyboard-interactive MFA answers every real server challenge before authenticated disconnect", async () => {
    const received: string[][] = [];
    const server = await createServer((context) => {
      if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
      const ask = (prompt: string, expected: string, next: () => void) => {
        context.prompt([{ prompt, echo: prompt === "Verification code:" }], (answers) => {
          received.push(answers);
          if (answers[0] !== expected) return context.reject();
          next();
        });
      };
      ask("Password:", "account-secret", () =>
        ask("Server passphrase:", "second-factor-secret", () =>
          ask("Verification code:", "123456", () => context.accept()),
        ),
      );
    });
    const { runtime, store, sshManager } = await createRuntimeFixture();
    const hostsBefore = structuredClone(store.getState().ssh.hosts);
    const workspacesBefore = structuredClone(store.getState().workspaces);
    const prompts: AuthEvent[] = [];
    runtime.on("ssh:auth-prompt", (event: AuthEvent) => {
      prompts.push(event);
      const prompt = event.prompt.prompts[0]?.prompt;
      const answer =
        prompt === "Server passphrase:"
          ? "second-factor-secret"
          : prompt === "Verification code:"
            ? "123456"
            : "account-secret";
      void runtime["ssh:auth:answer"]({ sessionId: event.sessionId, answers: [answer], promptId: event.promptId });
    });
    const authenticated = waitFor<TestStateEvent>(
      runtime,
      "ssh:test:state",
      (event) => event.status === "authenticated",
    );
    const started = await runtime.sshTestStart(
      { profileId: "default", draft: draft(server.port, { methods: ["keyboard-interactive"] }, "do-not-run") },
      windowId,
    );
    const event = await authenticated;
    expect(event.sessionId).toBe(started.sessionId);
    await waitForConnectionsToClose(server.counts);
    expect(received).toEqual([["account-secret"], ["second-factor-secret"], ["123456"]]);
    expect(new Set(prompts.map((prompt) => prompt.promptId)).size).toBe(3);
    expect(server.counts.shell).toBe(0);
    expect(store.getState().ssh.hosts).toEqual(hostsBefore);
    expect(store.getState().workspaces).toEqual(workspacesBefore);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
  });

  test("canceling a live authentication prompt clears the prompt and pending test session", async () => {
    const server = await createServer((context) => {
      if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
      context.prompt([{ prompt: "Verification code:", echo: true }], () => context.reject());
    });
    const { runtime, sshManager } = await createRuntimeFixture();
    const promptSeen = waitFor<AuthEvent>(runtime, "ssh:auth-prompt", () => true);
    const started = await runtime.sshTestStart(
      { profileId: "default", draft: draft(server.port, { methods: ["keyboard-interactive"] }, "never-run") },
      windowId,
    );
    const prompt = await promptSeen;
    expect(prompt.sessionId).toBe(started.sessionId);
    await runtime.sshTestStop({ sessionId: started.sessionId }, windowId);
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
    await waitForConnectionsToClose(server.counts);
    expect(server.counts.shell).toBe(0);
  });

  test("runtime shutdown cancels an unanswered auth prompt and closes its loopback session", async () => {
    const server = await createServer((context) => {
      if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
      context.prompt([{ prompt: "Verification code:", echo: true }], () => context.reject());
    });
    const { runtime, sshManager } = await createRuntimeFixture();
    const promptSeen = waitFor<AuthEvent>(runtime, "ssh:auth-prompt", () => true);
    const cancelled = waitFor<TestStateEvent>(runtime, "ssh:test:state", (event) => event.status === "cancelled");
    const started = await runtime.sshTestStart(
      { profileId: "default", draft: draft(server.port, { methods: ["keyboard-interactive"] }, "never-run") },
      windowId,
    );
    const prompt = await promptSeen;
    expect(prompt.sessionId).toBe(started.sessionId);
    await runtime.stop();
    const state = await cancelled;
    expect(state.sessionId).toBe(started.sessionId);
    await waitForConnectionsToClose(server.counts);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);
  });

  test("switching the owner window profile cancels its live auth prompt and leaves no session behind", async () => {
    const server = await createServer((context) => {
      if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
      context.prompt([{ prompt: "Verification code:", echo: true }], () => context.reject());
    });
    const { runtime, sshManager } = await createRuntimeFixture();
    await runtime.saveProfile({ id: "second", name: "Second", workspaceIds: [] });
    await expect(
      runtime.sshTestStart(
        { profileId: "second", draft: draft(server.port, { methods: ["keyboard-interactive"] }, "never-run") },
        windowId,
      ),
    ).rejects.toThrow(/profile changed/i);

    const promptSeen = waitFor<AuthEvent>(runtime, "ssh:auth-prompt", () => true);
    const cancelled = waitFor<TestStateEvent>(runtime, "ssh:test:state", (event) => event.status === "cancelled");
    const started = await runtime.sshTestStart(
      { profileId: "default", draft: draft(server.port, { methods: ["keyboard-interactive"] }, "never-run") },
      windowId,
    );
    const prompt = await promptSeen;
    expect(prompt.sessionId).toBe(started.sessionId);
    await runtime.activateProfileInWindow("second", windowId);
    const state = await cancelled;
    expect(state.sessionId).toBe(started.sessionId);
    await waitForConnectionsToClose(server.counts);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);
    await expect(runtime.sshTestStop({ sessionId: started.sessionId }, windowId)).resolves.toEqual({ ok: true });
  });

  test("rejected saved password reports failure and releases the test session", async () => {
    const server = await createServer((context) => context.reject(["password"]));
    const { runtime, sshManager, store } = await createRuntimeFixture("", undefined, {
      "ssh:password:integration": "wrong-password",
    });
    const hostsBefore = structuredClone(store.getState().ssh.hosts);
    const workspacesBefore = structuredClone(store.getState().workspaces);
    const failed = waitFor<TestStateEvent>(runtime, "ssh:test:state", (event) => event.status === "error");
    const started = await runtime.sshTestStart(
      {
        profileId: "default",
        draft: draft(server.port, { methods: ["password"], passwordRef: "ssh:password:integration" }, "never-run"),
      },
      windowId,
    );
    const failure = await failed;
    expect(failure.sessionId).toBe(started.sessionId);
    expect(failure.error).toMatch(/authentication/i);
    await waitForConnectionsToClose(server.counts);
    expect(server.counts.shell).toBe(0);
    expect(sshManager.activeSessions.has(started.sessionId)).toBe(false);
    expect(sshManager.pendingPrompts.has(started.sessionId)).toBe(false);
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);
    expect(store.getState().ssh.hosts).toEqual(hostsBefore);
    expect(store.getState().workspaces).toEqual(workspacesBefore);
  });

  test("runtime shutdown during deferred System SSH preparation prevents a later process spawn", async () => {
    let enterPreparation!: () => void;
    let releasePreparation!: () => void;
    const entered = new Promise<void>((resolve) => (enterPreparation = resolve));
    const wait = new Promise<void>((resolve) => (releasePreparation = resolve));
    const spawns: string[] = [];
    const ptySpawn: SshTestPtySpawn = (file) => {
      spawns.push(file);
      throw new Error("The stopped SSH test must not spawn");
    };
    const { runtime, sessionManager } = await createRuntimeFixture(
      "",
      ptySpawn,
      {},
      {
        wait,
        entered: enterPreparation,
      },
    );
    const started = await runtime.sshTestStart(
      {
        profileId: "default",
        draft: {
          ...draft(22, { methods: ["agent"] }, "never-run"),
          advanced: { launchVia: "system-ssh", sshPath: systemSshBinary },
        },
      },
      windowId,
    );
    await entered;
    await runtime.stop();
    releasePreparation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawns).toEqual([]);
    expect(sessionManager.sessions.has(started.sessionId)).toBe(false);
    expect(runtime.isSshTestSession(started.sessionId)).toBe(false);
  });

  test.skipIf(systemSshMissing)(
    "native OpenSSH verifies the unsaved connection with a controlled remote command",
    async () => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
      const publicKey = utils.parseKey(privateKey);
      if (publicKey instanceof Error || Array.isArray(publicKey)) throw new Error("Invalid integration test key");
      let signed = false;
      const probeBehavior: { marker?: string; exitCode?: number } = { marker: "from-command", exitCode: 0 };
      const server = await createServer((context) => {
        if (context.method !== "publickey" || !context.key.data.equals(publicKey.getPublicSSH())) {
          context.reject(["publickey"]);
          return;
        }
        if (!context.signature) return context.accept();
        if (publicKey.verify(context.blob!, context.signature, context.hashAlgo)) {
          signed = true;
          context.accept();
        } else context.reject(["publickey"]);
      }, probeBehavior);
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-openssh-config-"));
      tempPaths.push(configDir);
      const knownHosts = path.join(configDir, "known_hosts");
      const configPath = path.join(configDir, "config");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is created inside this test's private temp directory.
      await fs.writeFile(
        configPath,
        [
          `Host *`,
          `  UserKnownHostsFile "${knownHosts}"`,
          `  GlobalKnownHostsFile "${knownHosts}.global"`,
          `  BatchMode yes`,
          `  IdentitiesOnly yes`,
          `  RemoteCommand=echo CONFIG_COMMAND_MUST_NOT_RUN`,
          `  RequestTTY force`,
          "",
        ].join("\n"),
        "utf8",
      );
      let launchedFile = "";
      let launchedArgs: string[] = [];
      const ptySpawn = createNativeOpenSshPty(
        configPath,
        (file, _args, actualArgs) => {
          launchedFile = file;
          launchedArgs = actualArgs;
        },
        false,
      );
      const { runtime, store, sessionManager } = await createRuntimeFixture(privateKey, ptySpawn);
      const hostsBefore = structuredClone(store.getState().ssh.hosts);
      const workspacesBefore = structuredClone(store.getState().workspaces);
      const statuses: Array<TestStateEvent & { observedAt: number }> = [];
      const exits: Array<{ sessionId: string; exitCode?: number }> = [];
      let testSessionId = "";
      let terminalOutput = "";
      runtime.on("ssh:test:state", (event: TestStateEvent) => statuses.push({ ...event, observedAt: Date.now() }));
      runtime.on("terminal:exit", (event: { sessionId: string; exitCode?: number }) => exits.push(event));
      runtime.on("terminal:data", (event: { sessionId: string; data: string }) => {
        if (event.sessionId === testSessionId) terminalOutput = `${terminalOutput}${event.data}`.slice(-4000);
      });
      const outcome = waitFor<TestStateEvent>(
        runtime,
        "ssh:test:state",
        (event) => event.status === "authenticated" || event.status === "error",
        20000,
      ).then(
        (event) => ({ event }),
        (error: Error) => ({ error }),
      );
      const started = await runtime.sshTestStart(
        {
          profileId: "default",
          draft: {
            ...draft(
              server.port,
              { methods: ["publickey"], keyRef: "ssh:key:integration", agent: "off" },
              "should-not-run",
            ),
            advanced: {
              launchVia: "system-ssh",
              sshPath: systemSshBinary,
              command: "should-not-run",
            },
          },
        },
        windowId,
      );
      testSessionId = started.sessionId;
      expect(started.mode).toBe("system-ssh");
      const result = await outcome;
      if ("error" in result) {
        throw new Error(
          `${result.error.message}; native state events: ${JSON.stringify(statuses)}; terminal output: ${JSON.stringify(terminalOutput)}; launched: ${launchedFile}`,
        );
      }
      const verified = result.event;
      if (verified.status !== "authenticated") {
        throw new Error(
          `Native SSH verification failed: ${verified.error || verified.status}; native state events: ${JSON.stringify(statuses)}; terminal output: ${JSON.stringify(terminalOutput)}`,
        );
      }
      expect(verified.sessionId).toBe(started.sessionId);
      const keyIndex = launchedArgs.indexOf("-i");
      expect(launchedFile).toBe(systemSshBinary);
      expect(launchedArgs).toContain("-F");
      expect(launchedArgs[launchedArgs.indexOf("-F") + 1]).toBe(configPath);
      expect(keyIndex).toBeGreaterThanOrEqual(0);
      const managedKeyPath = launchedArgs[keyIndex + 1]!;
      expect(launchedArgs).toContain("-T");
      expect(launchedArgs).not.toContain("-tt");
      expect(launchedArgs).toContain("-o");
      const remoteCommand = launchedArgs.find((arg) => arg.startsWith("RemoteCommand=echo STRIDETERM_SSH_TEST_"));
      expect(remoteCommand).toMatch(/^RemoteCommand=echo STRIDETERM_SSH_TEST_[a-f0-9]{32}$/);
      expect(signed).toBe(true);
      expect(server.counts.pty).toBe(0);
      expect(server.counts.shell).toBe(0);
      expect(server.counts.exec).toEqual([`echo ${remoteCommand!.slice("RemoteCommand=echo ".length)}`]);
      expect(server.counts.exec.join(" ")).not.toContain("CONFIG_COMMAND_MUST_NOT_RUN");
      expect(server.counts.exec.join(" ")).not.toContain("should-not-run");
      expect(store.getState().ssh.hosts).toEqual(hostsBefore);
      expect(store.getState().workspaces).toEqual(workspacesBefore);

      await expectPathRemoved(managedKeyPath);
      await expectTestSessionRemoved(runtime, sessionManager, started.sessionId);
      await waitForConnectionsToClose(server.counts);
      expect(statuses.some((event) => event.sessionId === started.sessionId && event.status === "authenticated")).toBe(
        true,
      );
      await expect(runtime.sshTestStop({ sessionId: started.sessionId }, windowId)).resolves.toEqual({ ok: true });

      probeBehavior.marker = undefined;
      terminalOutput = "";
      const noMarkerError = waitFor<TestStateEvent>(
        runtime,
        "ssh:test:state",
        (event) => event.status === "error",
        20000,
      ).then(
        (event) => ({ event }),
        (error: Error) => ({ error }),
      );
      const noMarker = await runtime.sshTestStart(
        {
          profileId: "default",
          draft: {
            ...draft(
              server.port,
              { methods: ["publickey"], keyRef: "ssh:key:integration", agent: "off" },
              "should-not-run",
            ),
            advanced: {
              launchVia: "system-ssh",
              sshPath: systemSshBinary,
              command: "should-not-run",
            },
          },
        },
        windowId,
      );
      testSessionId = noMarker.sessionId;
      const noMarkerResult = await noMarkerError;
      if ("error" in noMarkerResult) {
        throw new Error(
          `Markerless native test: ${noMarkerResult.error.message}; native state events: ${JSON.stringify(statuses)}; terminal exits: ${JSON.stringify(exits)}; process status: ${sessionManager.sessions.get(noMarker.sessionId)?.status}; execs: ${JSON.stringify(server.counts.exec)}; probe: ${JSON.stringify(probeBehavior)}; terminal output: ${JSON.stringify(terminalOutput)}; launched: ${launchedFile}`,
        );
      }
      const failed = noMarkerResult.event;
      expect(failed.sessionId).toBe(noMarker.sessionId);
      expect(failed.error).toContain("without returning the verification marker");
      const failureKeyIndex = launchedArgs.indexOf("-i");
      expect(failureKeyIndex).toBeGreaterThanOrEqual(0);
      const failedManagedKeyPath = launchedArgs[failureKeyIndex + 1]!;
      await expectPathRemoved(failedManagedKeyPath);
      await expectTestSessionRemoved(runtime, sessionManager, noMarker.sessionId);
      expect(statuses.some((event) => event.sessionId === noMarker.sessionId && event.status === "authenticated")).toBe(
        false,
      );
      await expect(runtime.sshTestStop({ sessionId: noMarker.sessionId }, windowId)).resolves.toEqual({ ok: true });

      probeBehavior.marker = "from-command";
      probeBehavior.exitCode = 7;
      terminalOutput = "";
      const nonzeroError = waitFor<TestStateEvent>(
        runtime,
        "ssh:test:state",
        (event) => event.status === "error",
        20000,
      ).then(
        (event) => ({ event }),
        (error: Error) => ({ error }),
      );
      const nonzero = await runtime.sshTestStart(
        {
          profileId: "default",
          draft: {
            ...draft(
              server.port,
              { methods: ["publickey"], keyRef: "ssh:key:integration", agent: "off" },
              "should-not-run",
            ),
            advanced: {
              launchVia: "system-ssh",
              sshPath: systemSshBinary,
              command: "should-not-run",
            },
          },
        },
        windowId,
      );
      testSessionId = nonzero.sessionId;
      const nonzeroResult = await nonzeroError;
      if ("error" in nonzeroResult) {
        throw new Error(
          `Nonzero native test: ${nonzeroResult.error.message}; native state events: ${JSON.stringify(statuses)}; terminal output: ${JSON.stringify(terminalOutput)}; launched: ${launchedFile}`,
        );
      }
      const nonzeroFailure = nonzeroResult.event;
      expect(nonzeroFailure.sessionId).toBe(nonzero.sessionId);
      expect(nonzeroFailure.error).toContain("exited with code 7");
      const nonzeroKeyIndex = launchedArgs.indexOf("-i");
      expect(nonzeroKeyIndex).toBeGreaterThanOrEqual(0);
      await expectPathRemoved(launchedArgs[nonzeroKeyIndex + 1]!);
      await expectTestSessionRemoved(runtime, sessionManager, nonzero.sessionId);
      expect(statuses.some((event) => event.sessionId === nonzero.sessionId && event.status === "authenticated")).toBe(
        false,
      );
      await expect(runtime.sshTestStop({ sessionId: nonzero.sessionId }, windowId)).resolves.toEqual({ ok: true });
      await waitForConnectionsToClose(server.counts);
    },
  );
});
