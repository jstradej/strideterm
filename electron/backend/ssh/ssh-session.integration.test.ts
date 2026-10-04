import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect as connectSocket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, BaseAgent as BaseAgentType, Connection } from "ssh2";
import { SshManager } from "./ssh-manager.js";
import { SshSession } from "./ssh-session.js";
import type { CredentialStore } from "../shared/credential-store.js";

const { BaseAgent, Server, utils } = ssh2;

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(
  authenticate: (_context: AuthContext) => void,
  forwarding = false,
  onAgentForward?: () => void,
  onShell?: () => void,
) {
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", authenticate);
    connection.on("ready", () => {
      if (forwarding) {
        connection.on("tcpip", (accept, reject, info) => {
          if (info.destIP !== "127.0.0.1") return reject();
          const socket = connectSocket(info.destPort, info.destIP);
          const channel = accept();
          socket.on("error", () => channel.destroy());
          channel.on("error", () => socket.destroy());
          channel.on("close", () => socket.destroy());
          socket.pipe(channel).pipe(socket);
        });
      }
      connection.on("session", (accept) => {
        const session = accept();
        session.on("auth-agent", (acceptAgent) => {
          onAgentForward?.();
          acceptAgent();
        });
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          onShell?.();
          const stream = acceptShell();
          stream.on("error", () => {});
          stream.on("data", (data: Buffer) => stream.write(data));
        });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

function manager(initialSecrets: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(initialSecrets));
  const credentials: CredentialStore = {
    getSecret: (ref) => secrets.get(ref) || "",
    hasSecret: (ref) => secrets.has(ref),
    setSecret: async (ref, value) => void secrets.set(ref, value),
    deleteSecret: async (ref) => void secrets.delete(ref),
    listRefs: () => [...secrets.keys()],
    isEncryptionAvailable: () => true,
  };
  const state = { ssh: { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} } };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
  };
  const instance = new SshManager({ store, credentialStore: credentials });
  cleanups.push(async () => {
    const ids = new Set([...instance.activeSessions.keys(), ...instance.pendingPrompts.keys()]);
    await Promise.all([...ids].map((id) => instance.stop(id)));
  });
  return instance;
}

function connect(instance: SshManager, port: number, auth: Record<string, unknown>, sessionId = "loopback") {
  return instance.createSession({
    sessionId,
    inlineHost: {
      host: "127.0.0.1",
      port,
      username: "alice",
      auth,
      hostKeyPolicy: "accept-new",
      advanced: { launchVia: "ssh2" },
    },
    cols: 80,
    rows: 24,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the SSH connection to fail");
}

interface AuthEvent {
  sessionId: string;
  promptId: string;
  prompt: { prompts: { prompt: string; echo: boolean }[] };
}

describe("Built-in SSH over a real loopback connection", () => {
  test("explains a rejected password without guessing the cause or exposing its value", async () => {
    const port = await listen((context) => {
      if (context.method === "none") return context.reject(["password"]);
      context.reject(["password"]);
    });
    const instance = manager();
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.answerAuthPrompt(event.sessionId, ["diagnostic-secret"], event.promptId);
    });

    const failure = await rejectionOf(connect(instance, port, { methods: ["password"] }));
    expect(failure.message).toContain("Configured methods: password.");
    expect(failure.message).toContain("Methods rejected by the server: password.");
    expect(failure.message).toContain(
      "The server did not explain whether the rejected credentials or account policy caused the failure.",
    );
    expect(failure.message).not.toContain("diagnostic-secret");
    expect(instance.activeSessions.size).toBe(0);
    expect(instance.pendingPrompts.size).toBe(0);
  });

  test("reports when the server offers no method configured by the saved host", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const port = await listen((context) => context.reject(["keyboard-interactive"]));
    const instance = manager({ "ssh:key:diagnostic": privateKey });

    const failure = await rejectionOf(
      connect(instance, port, { methods: ["publickey"], keyRef: "ssh:key:diagnostic" }),
    );
    expect(failure.message).toContain("Configured methods: saved key.");
    expect(failure.message).toContain(
      "Server-advertised methods: keyboard-interactive (password or verification code).",
    );
    expect(failure.message).toContain("The server currently offers none of the configured authentication methods.");
    expect(failure.message).not.toContain(privateKey);
  });

  test("reports an actually attempted saved key without exposing key material or its reference", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const port = await listen((context) => context.reject(["publickey"]));
    const instance = manager({ "ssh:key:private-ref": privateKey });

    const failure = await rejectionOf(
      connect(instance, port, {
        methods: ["publickey"],
        keyRef: "ssh:key:private-ref",
      }),
    );

    expect(failure.message).toContain("Methods rejected by the server: saved key.");
    expect(failure.message).toContain("Server-advertised methods: public-key authentication.");
    expect(failure.message).toContain(
      "The server did not explain whether the rejected credentials or account policy caused the failure.",
    );
    expect(failure.message).not.toContain(privateKey);
    expect(failure.message).not.toContain("ssh:key:private-ref");
  });

  test("leaves non-authentication errors unchanged", async () => {
    const failure = await rejectionOf(connect(manager(), 1, { methods: ["password"] }));

    expect(failure.message).toMatch(/^connect ECONNREFUSED /);
    expect(failure.message).not.toContain("SSH authentication failed for");
    expect(failure.message).not.toContain("Configured methods:");
  });

  test("identifies selected methods whose local credentials did not resolve", async () => {
    const port = await listen((context) => context.reject(["publickey", "password"]));
    const instance = manager();

    const failure = await rejectionOf(
      connect(instance, port, {
        methods: ["publickey", "agent", "password"],
        keyRef: "ssh:key:missing",
        agent: "off",
        passwordRef: "ssh:password:missing",
      }),
    );
    expect(failure.message).toContain("No saved private key was resolved");
    expect(failure.message).toContain("The selected SSH agent is unavailable");
    expect(failure.message).toContain("No saved password was resolved");
    expect(failure.message).not.toContain("ssh:key:missing");
    expect(failure.message).not.toContain("ssh:password:missing");
  });

  test("identifies server-reported partial success without claiming the next factor was accepted", async () => {
    let passwordAccepted = false;
    const port = await listen((context) => {
      if (context.method === "none") return context.reject(["password"]);
      if (context.method === "password" && context.password === "first-factor-secret") {
        passwordAccepted = true;
        return context.reject(["keyboard-interactive"], true);
      }
      context.reject(["password"]);
    });
    const instance = manager();
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.answerAuthPrompt(event.sessionId, ["first-factor-secret"], event.promptId);
    });

    const failure = await rejectionOf(connect(instance, port, { methods: ["password"] }));
    expect(passwordAccepted).toBe(true);
    expect(failure.message).toContain("The server accepted an authentication factor and requires another.");
    expect(failure.message).toContain(
      "Server-advertised methods: keyboard-interactive (password or verification code).",
    );
    expect(failure.message).not.toContain("first-factor-secret");
  });

  test("an attached unsupported certificate never silently authenticates by another method", async () => {
    let authenticationRequests = 0;
    const port = await listen((context) => {
      authenticationRequests++;
      context.accept();
    });
    const instance = manager();
    await expect(connect(instance, port, { methods: ["password"], certRef: "ssh:cert:required" })).rejects.toThrow(
      /does not support.*certificates/i,
    );
    expect(authenticationRequests).toBe(0);
    expect(instance.pendingPrompts.size).toBe(0);
  });

  test.each([false, true])("agent forwarding is requested only when explicitly enabled (%s)", async (enabled) => {
    let forwardingRequests = 0;
    const port = await listen(
      (context) => {
        if (context.method === "password" && context.password === "account-secret") context.accept();
        else context.reject(["password"]);
      },
      false,
      () => forwardingRequests++,
    );
    class EmptyAgent extends BaseAgent {
      getIdentities(callback: Parameters<BaseAgentType["getIdentities"]>[0]): void {
        callback(undefined, []);
      }
      sign(): void {
        throw new Error("No test identity can sign");
      }
    }
    const session = new SshSession({
      host: { host: "127.0.0.1", port, username: "alice", advanced: { agentForward: enabled } },
      auth: { agent: new EmptyAgent() as unknown as string, promptPassword: true, methodOrder: ["password"] },
      onPasswordPrompt: (finish) => finish("account-secret"),
    });
    cleanups.push(() => session.stop());
    await session.start();
    expect(session.ready).toBe(true);
    expect(forwardingRequests).toBe(enabled ? 1 : 0);
  });

  test("queued first-connection trust cannot overwrite a successor generation", async () => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "account-secret") context.accept();
      else context.reject(["password"]);
    });
    const instance = manager();
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.answerAuthPrompt(event.sessionId, ["account-secret"], event.promptId);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const writes: Promise<unknown>[] = [];
    const mutate = instance.store.mutate;
    instance.store.mutate = (change) => {
      const write = gate.then(() => mutate(change));
      writes.push(write);
      return write;
    };
    expect((await connect(instance, port, { methods: ["password"] })).ready).toBe(true);
    const prior = instance.pendingPrompts.get("loopback")!;
    instance.pendingPrompts.set("loopback", { ...prior, promptId: "successor", activePromptId: "successor:1" });
    release();
    await Promise.all(writes);
    instance.store.mutate = mutate;
    expect(instance.store.getState().ssh!.knownHosts).toEqual({});
  });

  test("failed permanent trust persistence leaves the live decision available for retry", async () => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "account-secret") context.accept();
      else context.reject(["password"]);
    });
    const instance = manager();
    await instance.store.mutate((state) => {
      state.ssh!.knownHosts = {
        [`127.0.0.1:${port}`]: { fingerprint: "SHA256:old", keyType: "ssh-rsa", addedAt: "2026-01-01" },
      };
    });
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.answerAuthPrompt(event.sessionId, ["account-secret"], event.promptId);
    });
    const seen = once(instance, "ssh:host-key-change");
    const connecting = connect(instance, port, { methods: ["password"] });
    const [event] = (await seen) as [{ sessionId: string; promptId: string }];
    const mutate = instance.store.mutate;
    instance.store.mutate = async () => {
      throw new Error("Storage unavailable");
    };
    await expect(instance.acceptHostKey(event.sessionId, "permanent", event.promptId)).rejects.toThrow(
      "Storage unavailable",
    );
    expect(instance.pendingPrompts.get(event.sessionId)?.activePromptId).toBe(event.promptId);
    expect(instance.pendingPrompts.get(event.sessionId)?.acceptHostKeyCb).toBeTypeOf("function");
    instance.store.mutate = mutate;
    await instance.acceptHostKey(event.sessionId, "permanent", event.promptId);
    expect((await connecting).ready).toBe(true);
  });

  test("host-key acceptance queued before a reconnect cannot persist stale trust", async () => {
    const port = await listen((context) => context.reject(["password"]));
    const instance = manager();
    const knownHostId = `127.0.0.1:${port}`;
    const originalTrust = { fingerprint: "SHA256:original", keyType: "ssh-rsa", addedAt: "2026-01-01" };
    await instance.store.mutate((state) => {
      state.ssh!.knownHosts = { [knownHostId]: originalTrust };
    });
    const seen = once(instance, "ssh:host-key-change");
    const connecting = connect(instance, port, { methods: ["password"] }).catch((error: unknown) => error);
    const [event] = (await seen) as [{ sessionId: string; promptId: string }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mutate = instance.store.mutate;
    instance.store.mutate = async (mutator) => {
      await gate;
      return mutate(mutator);
    };
    const accepting = instance.acceptHostKey(event.sessionId, "permanent", event.promptId);
    const prior = instance.pendingPrompts.get(event.sessionId)!;
    instance.pendingPrompts.set(event.sessionId, {
      ...prior,
      promptId: "successor",
      activePromptId: "successor:1",
      acceptHostKeyCb: null,
    });
    release();
    await accepting;
    instance.store.mutate = mutate;
    expect(Object.entries(instance.store.getState().ssh!.knownHosts!).find(([id]) => id === knownHostId)?.[1]).toEqual(
      originalTrust,
    );
    await instance.stop(event.sessionId);
    await connecting;
  });

  test("jump host and target negotiate their own password prompts", async () => {
    const authenticate = (context: AuthContext) => {
      if (context.method === "password" && context.password === "account-secret") context.accept();
      else context.reject(["password"]);
    };
    const jumpPort = await listen(authenticate, true);
    const targetPort = await listen(authenticate);
    const instance = manager();
    const jump = await instance.createHost({
      name: "loopback jump",
      host: "127.0.0.1",
      port: jumpPort,
      username: "alice",
      auth: { methods: ["password"] },
      advanced: { launchVia: "ssh2" },
    });
    const prompts: AuthEvent[] = [];
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      prompts.push(event);
      instance.answerAuthPrompt(event.sessionId, ["account-secret"], event.promptId);
    });
    const session = await instance.createSession({
      sessionId: "jumped",
      inlineHost: {
        host: "127.0.0.1",
        port: targetPort,
        username: "alice",
        auth: { methods: ["password"] },
        jump: [jump.id],
        advanced: { launchVia: "ssh2" },
      },
      cols: 80,
      rows: 24,
    });
    expect(session.ready).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(new Set(prompts.map((prompt) => prompt.promptId)).size).toBe(2);
  });

  test("agent identities are tried before password fallback", async () => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "fallback-secret") context.accept();
      else context.reject(["publickey", "password"]);
    });
    let identitiesRequested = 0;
    class EmptyAgent extends BaseAgent {
      getIdentities(callback: Parameters<BaseAgentType["getIdentities"]>[0]): void {
        identitiesRequested++;
        callback(undefined, []);
      }
      sign(): void {
        throw new Error("No test identity can sign");
      }
    }
    const session = new SshSession({
      host: { host: "127.0.0.1", port, username: "alice" },
      auth: { agent: new EmptyAgent() as unknown as string, promptPassword: true },
      onPasswordPrompt: (finish) => finish("fallback-secret"),
    });
    cleanups.push(() => session.stop());
    await session.start();
    expect(session.ready).toBe(true);
    expect(identitiesRequested).toBe(1);
  });

  test("cancelling a password prompt aborts instead of authenticating with an empty password", async () => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "") context.accept();
      else context.reject(["password"]);
    });
    const instance = manager();
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.cancelAuthPrompt(event.sessionId, event.promptId);
    });
    await expect(connect(instance, port, { methods: ["password"] })).rejects.toThrow(
      "All configured authentication methods failed",
    );
    expect(instance.activeSessions.size).toBe(0);
    expect(instance.pendingPrompts.size).toBe(0);
  });

  test.each(["password", "keyboard-interactive"])("prompts for %s on a password-only server", async (method) => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "account-secret") context.accept();
      else context.reject(["password"]);
    });
    const instance = manager();
    const prompts: AuthEvent[] = [];
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      prompts.push(event);
      instance.answerAuthPrompt(event.sessionId, ["account-secret"], event.promptId);
    });
    const session = await connect(instance, port, { methods: [method] });
    expect(session.ready).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt.prompts[0]!.echo).toBe(false);
  });

  test.each(["password", "keyboard-interactive"] as const)(
    "a delayed %s answer pauses the readiness deadline for an ordinary shell session",
    async (method) => {
      let shellOpened = false;
      const port = await listen(
        (context) => {
          if (method === "password") {
            if (context.method === "password" && context.password === "slow-secret") context.accept();
            else context.reject(["password"]);
            return;
          }
          if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
          context.prompt([{ prompt: "Verification code:", echo: true }], (answers) => {
            if (answers[0] === "slow-secret") context.accept();
            else context.reject(["keyboard-interactive"]);
          });
        },
        false,
        undefined,
        () => (shellOpened = true),
      );
      const session = new SshSession({
        host: { host: "127.0.0.1", port, username: "alice" },
        auth:
          method === "password"
            ? { promptPassword: true, methodOrder: ["password"] }
            : { tryKeyboard: true, methodOrder: ["keyboard-interactive"] },
        readyTimeoutMs: 1500,
        onPasswordPrompt: (finish) => setTimeout(() => finish("slow-secret"), 1800),
        onAuthPrompt: (prompt) => setTimeout(() => prompt.finish(["slow-secret"]), 1800),
      });
      cleanups.push(() => session.stop());

      await session.start();
      expect(session.ready).toBe(true);
      expect(shellOpened).toBe(true);
    },
  );

  test("a delayed host-key decision pauses the readiness deadline before authentication", async () => {
    const port = await listen((context) => {
      if (context.method === "password" && context.password === "account-secret") context.accept();
      else context.reject(["password"]);
    });
    let shellOpened = false;
    const session = new SshSession({
      host: { host: "127.0.0.1", port, username: "alice" },
      auth: { password: "account-secret", methodOrder: ["password"] },
      verify: () => ({
        ok: false,
        mismatch: true,
        fingerprint: "SHA256:new-fingerprint",
        keyType: "ssh-rsa",
        previous: { fingerprint: "SHA256:old-fingerprint", keyType: "ssh-rsa", addedAt: "2026-01-01T00:00:00Z" },
      }),
      onHostKeyDecision: (_info, callback) => setTimeout(() => callback(true), 1800),
      onReady: () => (shellOpened = true),
      readyTimeoutMs: 1500,
    });
    cleanups.push(() => session.stop());

    await session.start();
    expect(session.ready).toBe(true);
    expect(shellOpened).toBe(true);
  });

  test("a delayed jump-host password pauses that client's readiness deadline", async () => {
    const authenticate = (secret: string) => (context: AuthContext) => {
      if (context.method === "password" && context.password === secret) context.accept();
      else context.reject(["password"]);
    };
    const jumpPort = await listen(authenticate("jump-secret"), true);
    const targetPort = await listen(authenticate("target-secret"));
    const session = new SshSession({
      host: { host: "127.0.0.1", port: targetPort, username: "alice" },
      auth: { password: "target-secret" },
      jumps: [
        {
          host: { host: "127.0.0.1", port: jumpPort, username: "alice" },
          auth: { promptPassword: true, methodOrder: ["password"] },
          verify: () => ({ ok: true, fingerprint: "SHA256:jump", keyType: "ssh-rsa" }),
          onPasswordPrompt: (finish) => setTimeout(() => finish("jump-secret"), 1800),
        },
      ],
      readyTimeoutMs: 1500,
    });
    cleanups.push(() => session.stop());

    await session.start();
    expect(session.ready).toBe(true);
  });

  test("the resumed readiness deadline still rejects a server that stalls after the answer", async () => {
    const port = await listen((context) => {
      if (context.method === "none") context.reject(["password"]);
      // Deliberately leave the password request unanswered after the client resumes its deadline.
    });
    const session = new SshSession({
      host: { host: "127.0.0.1", port, username: "alice" },
      auth: { promptPassword: true, methodOrder: ["password"] },
      readyTimeoutMs: 1500,
      onPasswordPrompt: (finish) => finish("slow-secret"),
    });
    cleanups.push(() => session.stop());

    await expect(session.start()).rejects.toThrow("Timed out while waiting for handshake");
  });

  test("stop while a user prompt is open prevents a late answer from rearming the deadline", async () => {
    const port = await listen((context) => {
      if (context.method === "none") context.reject(["password"]);
    });
    let finishPrompt: ((password: string | null) => void) | undefined;
    const session = new SshSession({
      host: { host: "127.0.0.1", port, username: "alice" },
      auth: { promptPassword: true, methodOrder: ["password"] },
      readyTimeoutMs: 1500,
      onPasswordPrompt: (finish) => (finishPrompt = finish),
    });
    cleanups.push(() => session.stop());
    const connecting = session.start();
    const failure = rejectionOf(connecting);
    const promptDeadline = Date.now() + 3000;
    while (!finishPrompt && Date.now() < promptDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finishPrompt).toBeTypeOf("function");
    const clientErrors: string[] = [];
    session.client!.on("error", (error: Error) => clientErrors.push(error.message));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await session.stop();
    finishPrompt!("late-secret");

    await expect(failure).resolves.toMatchObject({ message: "Connection closed before ready" });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(clientErrors).not.toContain("Timed out while waiting for handshake");
  });

  test("MFA keeps separate answers and tokens for password, passphrase and OTP rounds", async () => {
    const received: string[][] = [];
    const port = await listen((context) => {
      if (context.method !== "keyboard-interactive") return context.reject(["keyboard-interactive"]);
      context.prompt([{ prompt: "Password:", echo: false }], (password) => {
        received.push(password);
        context.prompt([{ prompt: "Server passphrase:", echo: false }], (passphrase) => {
          received.push(passphrase);
          context.prompt([{ prompt: "Verification code:", echo: true }], (otp) => {
            received.push(otp);
            if (password[0] === "account-secret" && passphrase[0] === "server-secret" && otp[0] === "123456") {
              context.accept();
            } else context.reject();
          });
        });
      });
    });
    const instance = manager();
    const prompts: AuthEvent[] = [];
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      prompts.push(event);
      const text = event.prompt.prompts[0]!.prompt;
      const answer =
        text === "Server passphrase:" ? "server-secret" : text === "Verification code:" ? "123456" : "account-secret";
      if (prompts.length > 1) instance.answerAuthPrompt(event.sessionId, ["stale-answer"], prompts[0]!.promptId);
      instance.answerAuthPrompt(event.sessionId, [answer], event.promptId);
    });
    expect((await connect(instance, port, { methods: ["keyboard-interactive"] })).ready).toBe(true);
    expect(received).toEqual([["account-secret"], ["server-secret"], ["123456"]]);
    expect(new Set(prompts.map((prompt) => prompt.promptId)).size).toBe(prompts.length);
    expect(prompts.at(-1)!.prompt.prompts[0]!.echo).toBe(true);
  });

  test("a rejected managed key falls back to negotiated password", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const attempted: string[] = [];
    const port = await listen((context) => {
      attempted.push(context.method);
      if (context.method === "password" && context.password === "fallback-secret") context.accept();
      else context.reject(["publickey", "password"]);
    });
    const instance = manager({ "ssh:key:test": key });
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      instance.answerAuthPrompt(event.sessionId, ["fallback-secret"], event.promptId);
    });
    expect((await connect(instance, port, { methods: ["publickey", "password"], keyRef: "ssh:key:test" })).ready).toBe(
      true,
    );
    expect(attempted.indexOf("publickey")).toBeGreaterThanOrEqual(0);
    expect(attempted.indexOf("password")).toBeGreaterThan(attempted.indexOf("publickey"));
  });

  test("an encrypted managed key requests its own passphrase and signs authentication", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encrypted = pair.privateKey
      .export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "key-secret" })
      .toString();
    const parsed = utils.parseKey(pair.privateKey.export({ type: "pkcs1", format: "pem" }));
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid test key");
    let signed = false;
    const port = await listen((context) => {
      if (context.method !== "publickey" || !context.key.data.equals(parsed.getPublicSSH()))
        return context.reject(["publickey"]);
      if (!context.signature) return context.accept();
      if (parsed.verify(context.blob!, context.signature, context.hashAlgo) === true) {
        signed = true;
        context.accept();
      } else context.reject();
    });
    const instance = manager({ "ssh:key:encrypted": encrypted });
    const prompts: AuthEvent[] = [];
    instance.on("ssh:auth-prompt", (event: AuthEvent) => {
      prompts.push(event);
      instance.answerAuthPrompt(event.sessionId, ["key-secret"], event.promptId);
    });
    expect((await connect(instance, port, { methods: ["publickey"], keyRef: "ssh:key:encrypted" })).ready).toBe(true);
    expect(signed).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt.prompts[0]!.prompt.toLowerCase()).toContain("passphrase");
  });
});
