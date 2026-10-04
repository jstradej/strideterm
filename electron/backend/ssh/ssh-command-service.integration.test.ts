import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { AuthContext, Connection, ServerChannel } from "ssh2";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialStore } from "../shared/credential-store.js";
import { createSshCommandService } from "./ssh-command-service.js";
import { SshManager } from "./ssh-manager.js";

const { Server } = ssh2;
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(
  authenticate: (_context: AuthContext) => void,
  onExec?: (_stream: ServerChannel, _command: string) => void,
): Promise<number> {
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", authenticate);
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptChannel, _reject, info) => {
          const channel = acceptChannel();
          onExec?.(channel, info.command);
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

function fixture(port: number, hostKeyPolicy = "accept-new", secret = "ssh-password") {
  const secrets = new Map([["ssh:password:test", secret]]);
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
          port,
          username: "alice",
          auth: { methods: ["password"], passwordRef: "ssh:password:test" },
          advanced: { launchVia: "ssh2" },
          hostKeyPolicy,
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
  };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
  };
  const sshManager = new SshManager({ store, credentialStore: credentials });
  const service = createSshCommandService({
    sshManager,
    getEffectiveLaunchMode: (host) => (host.advanced?.launchVia === "system-ssh" ? "system-ssh" : "ssh2"),
  });
  cleanups.push(async () => {
    service.close();
    await Promise.all(
      [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
    );
  });
  return { state, sshManager, service };
}

function passwordAuth(context: AuthContext): void {
  if (context.method === "password" && context.username === "alice" && context.password === "ssh-password")
    context.accept();
  else context.reject(["password"]);
}

describe("Built-in SSH command service", () => {
  test("lists only Built-in hosts and omits credential references", async () => {
    const port = await listen(passwordAuth);
    const { service } = fixture(port);

    expect(service.listHosts()).toEqual([
      {
        id: "host-local",
        name: "Local test host",
        host: "127.0.0.1",
        username: "alice",
        port,
        methods: ["password"],
      },
    ]);
    expect(JSON.stringify(service.listHosts())).not.toContain("ssh:password:test");
  });

  test("executes on a saved host using current accept-new trust policy and returns streams and exit code", async () => {
    const seenCommands: string[] = [];
    const port = await listen(passwordAuth, (stream, command) => {
      seenCommands.push(command);
      stream.write("stdout data\n");
      stream.stderr.write("stderr data\n");
      stream.exit(7);
      stream.end();
      stream.close();
    });
    const { service } = fixture(port);

    const result = await service.runCommand({ hostId: "host-local", command: "printf hello" });

    expect(seenCommands).toEqual(["printf hello"]);
    expect(result).toMatchObject({
      hostId: "host-local",
      stdout: "stdout data\n",
      stderr: "stderr data\n",
      exitCode: 7,
      signal: null,
      timedOut: false,
      truncated: false,
    });
  });

  test("does not execute when strict host-key policy requires a user decision", async () => {
    let commandCount = 0;
    const port = await listen(passwordAuth, () => commandCount++);
    const { service } = fixture(port, "strict");

    await expect(
      service.runCommand({ hostId: "host-local", command: "touch /tmp/should-not-run" }),
    ).rejects.toMatchObject({
      code: "setup_required",
      message: expect.stringContaining("Host key must be verified"),
    });
    expect(commandCount).toBe(0);
  });

  test("does not execute when a saved host presents a changed host key", async () => {
    let commandCount = 0;
    const port = await listen(passwordAuth, () => commandCount++);
    const { state, service } = fixture(port);
    state.ssh.knownHosts[`127.0.0.1:${port}`] = {
      fingerprint: "SHA256:previous-host-key",
      keyType: "ssh-rsa",
      addedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(service.runCommand({ hostId: "host-local", command: "id" })).rejects.toMatchObject({
      code: "setup_required",
      message: expect.stringContaining("Host key must be verified"),
    });
    expect(commandCount).toBe(0);
  });

  test("turns a password prompt into setup guidance and cancels the pending connection", async () => {
    const port = await listen(passwordAuth);
    const { state, service } = fixture(port);
    state.ssh.hosts[0]!.auth.passwordRef = undefined;

    await expect(service.runCommand({ hostId: "host-local", command: "id" })).rejects.toMatchObject({
      code: "setup_required",
      message: expect.stringContaining("Complete the connection test"),
    });
  });

  test("bounds each output stream independently and marks truncation", async () => {
    const oversized = "x".repeat(140 * 1024);
    const port = await listen(passwordAuth, (stream) => {
      stream.write(oversized);
      stream.stderr.write(oversized);
      stream.exit(0);
      stream.end();
      stream.close();
    });
    const { service } = fixture(port);

    const result = await service.runCommand({ hostId: "host-local", command: "large-output" });

    expect(Buffer.byteLength(result.stdout)).toBe(128 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBe(128 * 1024);
    expect(result.truncated).toBe(true);
  });

  test("returns bounded timeout status and stops the SSH session", async () => {
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => (commandStarted = resolve));
    const port = await listen(passwordAuth, () => commandStarted());
    const { service, sshManager } = fixture(port);

    const resultPromise = service.runCommand({ hostId: "host-local", command: "sleep forever", timeoutMs: 80 });
    await started;
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(sshManager.activeSessions.size).toBe(0);
    expect(sshManager.pendingPrompts.size).toBe(0);
  });

  test("cancels an in-flight command when its request is aborted", async () => {
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => (commandStarted = resolve));
    const port = await listen(passwordAuth, () => commandStarted());
    const { service, sshManager } = fixture(port);
    const controller = new AbortController();

    const result = service.runCommand({ hostId: "host-local", command: "sleep forever", signal: controller.signal });
    await started;
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(sshManager.activeSessions.size).toBe(0);
    expect(sshManager.pendingPrompts.size).toBe(0);
  });

  test("rejects unsupported launch modes before opening a connection", async () => {
    const { service } = fixture(22);

    await expect(service.runCommand({ hostId: "host-system", command: "id" })).rejects.toMatchObject({
      code: "unsupported_host",
      message: expect.stringContaining("Built-in SSH hosts only"),
    });
  });
});
