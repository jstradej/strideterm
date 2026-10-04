import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, Connection } from "ssh2";
import { SshManager } from "./ssh-manager.js";
import type { CredentialStore } from "../shared/credential-store.js";

const { Server } = ssh2;
const privateHostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function startServer() {
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [privateHostKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context: AuthContext) => {
      if (context.method === "password" && context.password === "secret") context.accept();
      else context.reject(["password"]);
    });
    connection.on("ready", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: (server.address() as AddressInfo).port,
    disconnect() {
      for (const connection of connections) connection.end();
    },
  };
}

function createManager() {
  const secrets = new Map([["account-password", "secret"]]);
  const credentialStore: CredentialStore = {
    getSecret: (ref) => secrets.get(ref) || "",
    hasSecret: (ref) => secrets.has(ref),
    setSecret: async (ref, value) => void secrets.set(ref, value),
    deleteSecret: async (ref) => void secrets.delete(ref),
    listRefs: () => [...secrets.keys()],
    isEncryptionAvailable: () => true,
  };
  const state = { ssh: { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} }, settings: { ssh: {} } };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_state: typeof state) => void) => mutator(state),
  };
  return new SshManager({ store, credentialStore });
}

function connected(manager: SshManager, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    manager.on("ssh:connection-state", function onState(payload: { sessionId: string; status: string }) {
      if (payload.sessionId === sessionId && payload.status === "connected") {
        manager.off("ssh:connection-state", onState);
        resolve();
      }
    });
  });
}

function connect(manager: SshManager, port: number, sessionId: string, authenticatedActionTimeoutMs?: number) {
  return manager.createSession({
    sessionId,
    inlineHost: {
      host: "127.0.0.1",
      port,
      username: "tester",
      hostKeyPolicy: "accept-new",
      auth: { methods: ["password"], passwordRef: "account-password" },
    },
    cols: 80,
    rows: 24,
    authOnly: true,
    authenticatedActionTimeoutMs,
    onAuthenticated: () => new Promise<void>(() => {}),
  });
}

describe("SSH authenticated follow-up actions", () => {
  test("times out a stalled post-authentication action after SSH readiness", async () => {
    const server = await startServer();
    const manager = createManager();
    const sessionId = "follow-up-timeout";
    const ready = connected(manager, sessionId);
    const sessionStart = connect(manager, server.port, sessionId, 100);
    await ready;
    await expect(sessionStart).rejects.toThrow("SSH post-authentication operation timed out");
    expect(manager.activeSessions.has(sessionId)).toBe(false);
    expect(manager.pendingPrompts.has(sessionId)).toBe(false);
  });

  test("stop rejects a pending post-authentication action without waiting for its deadline", async () => {
    const server = await startServer();
    const manager = createManager();
    const sessionId = "follow-up-stop";
    const ready = connected(manager, sessionId);
    const sessionStart = connect(manager, server.port, sessionId, 10000);
    await ready;
    await manager.stop(sessionId);
    await expect(sessionStart).rejects.toThrow("SSH post-authentication operation was stopped");
    expect(manager.activeSessions.has(sessionId)).toBe(false);
    expect(manager.pendingPrompts.has(sessionId)).toBe(false);
  });

  test("rejects a stalled authenticated action when the SSH peer disconnects", async () => {
    const server = await startServer();
    const manager = createManager();
    const sessionId = "follow-up-disconnect";
    const ready = connected(manager, sessionId);
    const sessionStart = connect(manager, server.port, sessionId, 10000);
    await ready;
    server.disconnect();
    await expect(sessionStart).rejects.toThrow("SSH connection closed during the post-authentication operation");
    expect(manager.activeSessions.has(sessionId)).toBe(false);
    expect(manager.pendingPrompts.has(sessionId)).toBe(false);
  });
});
