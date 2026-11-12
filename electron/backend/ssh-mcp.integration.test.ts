import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { AuthContext, Connection, ServerChannel } from "ssh2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CredentialStore } from "./shared/credential-store.js";
import { SSH_MCP_CAPABILITY_ENV, SSH_MCP_URL_ENV } from "../shared/agent-ssh.js";
import { createSshCommandService } from "./ssh/ssh-command-service.js";
import { createSshMcpBroker } from "./ssh/ssh-mcp-broker.js";
import { SshManager } from "./ssh/ssh-manager.js";
import { createSshFileHandlers } from "./ssh/runtime-ssh-file-handlers.js";
import { startSftpTestServer } from "./ssh/test-support/sftp-test-server.js";
import type { AppState } from "../shared/types/state.js";

const { Server } = ssh2;
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const stdioEntry = fileURLToPath(new URL("./ssh-mcp-stdio-entry.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(
  authenticate: (_context: AuthContext) => void,
  onExec?: (_stream: ServerChannel, _command: string) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", authenticate);
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptChannel, _reject, info) => onExec?.(acceptChannel(), info.command));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return { port, close };
}

function createFixture(
  port: number,
  isGrantLive: (_grant: {
    sessionId: string;
    profileId: string;
    workspaceId: string;
    panelId: string;
    command: string;
  }) => boolean = () => true,
) {
  const secrets = new Map([["ssh:password:test", "integration-password"]]);
  const credentialStore: CredentialStore = {
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
          id: "mini-host",
          name: "mini.local",
          host: "127.0.0.1",
          port,
          username: "agent",
          auth: { methods: ["password"], passwordRef: "ssh:password:test" },
          advanced: { launchVia: "ssh2" },
          hostKeyPolicy: "accept-new",
        },
      ],
      keys: [],
      certificates: [],
      knownHosts: {},
      settings: {},
    },
    settings: { ssh: { defaultLaunchVia: "ssh2" as const } },
  };
  const store = {
    getState: () => state,
    mutate: async (mutator: (_draft: typeof state) => void) => mutator(state),
  };
  const sshManager = new SshManager({ store, credentialStore });
  const service = createSshCommandService({
    sshManager,
    getEffectiveLaunchMode: (host) => (host.advanced?.launchVia === "system-ssh" ? "system-ssh" : "ssh2"),
  });
  const broker = createSshMcpBroker({ service, isGrantLive });
  cleanups.push(async () => {
    await broker.close();
    service.close();
    await Promise.all(
      [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
    );
  });
  return { sshManager, service, broker };
}

function authenticate(context: AuthContext): void {
  if (context.method === "password" && context.username === "agent" && context.password === "integration-password") {
    context.accept();
  } else {
    context.reject(["password"]);
  }
}

function parseToolText(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP result did not contain a text payload.");
  return JSON.parse(text);
}

async function connectClient(env: NodeJS.ProcessEnv): Promise<{ client: Client; readStderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", stdioEntry, "--ssh-mcp"],
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
  const client = new Client({ name: "strideterm-ssh-integration-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, readStderr: () => stderr };
}

describe("SSH MCP stdio end-to-end", () => {
  test("lists saved hosts and executes a real remote command through MCP", async () => {
    const commands: string[] = [];
    const server = await listen(authenticate, (stream, command) => {
      commands.push(command);
      stream.write("remote stdout\n");
      stream.stderr.write("remote stderr\n");
      stream.exit(9);
      stream.end();
      stream.close();
    });
    const { broker } = createFixture(server.port);
    await broker.start();
    const grant = broker.mintGrant({
      sessionId: "workspace:agent-panel",
      profileId: "profile-a",
      workspaceId: "workspace",
      panelId: "agent-panel",
      command: "claude",
    });
    const { client } = await connectClient({
      [SSH_MCP_URL_ENV]: grant.url,
      [SSH_MCP_CAPABILITY_ENV]: grant.capability,
    });
    cleanups.push(async () => client.close());

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "download_from_ssh_host",
      "list_ssh_files",
      "list_ssh_hosts",
      "run_ssh_command",
      "ssh_transfer_status",
      "upload_to_ssh_host",
    ]);
    const hosts = await client.callTool({ name: "list_ssh_hosts", arguments: {} });
    expect(parseToolText(hosts as never)).toMatchObject({
      hosts: [
        {
          id: "mini-host",
          name: "mini.local",
          host: "127.0.0.1",
          username: "agent",
          port: server.port,
          methods: ["password"],
        },
      ],
    });

    const result = await client.callTool({
      name: "run_ssh_command",
      arguments: { hostId: "mini-host", command: "printf integration" },
    });
    expect(parseToolText(result as never)).toMatchObject({
      hostId: "mini-host",
      stdout: "remote stdout\n",
      stderr: "remote stderr\n",
      exitCode: 9,
      timedOut: false,
    });
    expect(commands).toEqual(["printf integration"]);
  });

  test("surfaces an expired capability through MCP without running another command", async () => {
    let commandCount = 0;
    const server = await listen(authenticate, (stream) => {
      commandCount += 1;
      stream.exit(0);
      stream.end();
      stream.close();
    });
    const { broker } = createFixture(server.port);
    await broker.start();
    const context = {
      sessionId: "workspace:revoked-panel",
      profileId: "profile-a",
      workspaceId: "workspace",
      panelId: "revoked-panel",
      command: "codex",
    };
    const grant = broker.mintGrant(context);
    const { client } = await connectClient({
      [SSH_MCP_URL_ENV]: grant.url,
      [SSH_MCP_CAPABILITY_ENV]: grant.capability,
    });
    cleanups.push(async () => client.close());

    const first = await client.callTool({
      name: "run_ssh_command",
      arguments: { hostId: "mini-host", command: "true" },
    });
    expect((first as { isError?: boolean }).isError).not.toBe(true);
    broker.revokeSession(context.sessionId);
    const rejected = await client.callTool({
      name: "run_ssh_command",
      arguments: { hostId: "mini-host", command: "touch never" },
    });

    expect((rejected as { isError?: boolean }).isError).toBe(true);
    expect(commandCount).toBe(1);
  });

  test("closing the MCP client cancels its active remote SSH command", async () => {
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => (commandStarted = resolve));
    const server = await listen(authenticate, (stream) => {
      stream.write("started\n");
      commandStarted();
    });
    const { broker, sshManager } = createFixture(server.port);
    await broker.start();
    const grant = broker.mintGrant({
      sessionId: "workspace:long-command-panel",
      profileId: "profile-a",
      workspaceId: "workspace",
      panelId: "long-command-panel",
      command: "claude",
    });
    const { client, readStderr } = await connectClient({
      [SSH_MCP_URL_ENV]: grant.url,
      [SSH_MCP_CAPABILITY_ENV]: grant.capability,
    });

    const pending = client.callTool({
      name: "run_ssh_command",
      arguments: { hostId: "mini-host", command: "long-running" },
    });
    await started;
    await client.close();
    await expect(pending).rejects.toBeDefined();
    expect(readStderr()).not.toContain("Assertion failed");
    await vi.waitFor(() => {
      expect(sshManager.activeSessions.size).toBe(0);
      expect(sshManager.pendingPrompts.size).toBe(0);
    });
  });

  test("the stdio entrypoint fails clearly without its per-tab environment or explicit flag", async () => {
    const run = (args: string[], env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, ["--import", "tsx", stdioEntry, ...args], {
        cwd: process.cwd(),
        windowsHide: process.platform === "win32",
        env: { ...process.env, [SSH_MCP_URL_ENV]: "", [SSH_MCP_CAPABILITY_ENV]: "", ...env },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.stdin?.end();
      return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, stderr }));
      });
    };

    const missingEnv = await run(["--ssh-mcp"], {});
    expect(missingEnv.code).toBe(1);
    expect(missingEnv.stderr).toContain("Missing or invalid per-tab SSH MCP connection environment");
    const missingFlag = await run([], {
      [SSH_MCP_URL_ENV]: "http://127.0.0.1:12345/ssh-mcp",
      [SSH_MCP_CAPABILITY_ENV]: "x".repeat(43),
    });
    expect(missingFlag.code).toBe(1);
    expect(missingFlag.stderr).toContain("Missing --ssh-mcp");
  });
});

describe("SSH MCP file tools end-to-end", () => {
  test("lists a host directory, uploads a workspace file and reports the transfer through MCP", async () => {
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mcp-remote-"));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mcp-workspace-"));
    cleanups.push(async () => {
      await fs.rm(remoteRoot, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(remoteRoot, "srv"));
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "from the agent");
    const sftp = await startSftpTestServer({ rootDir: remoteRoot });
    cleanups.push(() => sftp.close());

    const secrets = new Map([["ssh:password:test", sftp.password]]);
    const credentialStore: CredentialStore = {
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
            id: "mini-host",
            name: "mini.local",
            host: "127.0.0.1",
            port: sftp.port,
            username: "alice",
            auth: { methods: ["password"], passwordRef: "ssh:password:test" },
            advanced: { launchVia: "ssh2" },
            hostKeyPolicy: "accept-new",
          },
        ],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: {},
      },
      settings: { ssh: {} },
      workspaces: [{ id: "workspace", name: "W", profileId: "profile-a", cwd: workspaceRoot, panels: [] }],
    };
    const store = { getState: () => state, mutate: async (mutator: (_draft: typeof state) => void) => mutator(state) };
    const sshManager = new SshManager({ store, credentialStore });
    const handlers = createSshFileHandlers({
      sshManager,
      getState: () => state as unknown as AppState,
      emit: () => {},
      getWindowProfileId: () => "profile-a",
      getEffectiveLaunchMode: () => "ssh2",
      createSessionId: (workspaceId, panelId) => `${workspaceId}:${panelId}`,
      rootsForProfile: () => [],
    });
    const broker = createSshMcpBroker({
      service: { listHosts: () => [], runCommand: async () => ({}) } as never,
      files: handlers.sshFileAgent,
      isGrantLive: () => true,
    });
    await broker.start();
    cleanups.push(async () => {
      await broker.close();
      handlers.close();
      await Promise.all(
        [...sshManager.activeSessions.keys(), ...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)),
      );
    });
    const grant = broker.mintGrant({
      sessionId: "workspace:agent-panel",
      profileId: "profile-a",
      workspaceId: "workspace",
      panelId: "agent-panel",
      command: "claude",
    });
    const { client } = await connectClient({
      [SSH_MCP_URL_ENV]: grant.url,
      [SSH_MCP_CAPABILITY_ENV]: grant.capability,
    });
    cleanups.push(async () => client.close());

    const listing = await client.callTool({ name: "list_ssh_files", arguments: { hostId: "mini-host", path: "/srv" } });
    expect(parseToolText(listing as never)).toMatchObject({ path: "/srv", entries: [], truncated: false });

    const started = parseToolText(
      (await client.callTool({
        name: "upload_to_ssh_host",
        arguments: { hostId: "mini-host", localPath: "note.txt", remoteDir: "/srv" },
      })) as never,
    ) as { transferId: string };
    expect(started.transferId).toEqual(expect.any(String));
    await handlers.service.transfers.idle();

    const status = await client.callTool({
      name: "ssh_transfer_status",
      arguments: { transferId: started.transferId },
    });
    expect(parseToolText(status as never)).toMatchObject({
      state: "succeeded",
      result: { files: 1, bytes: 14, skipped: [] },
    });
    expect(await fs.readFile(path.join(remoteRoot, "srv", "note.txt"), "utf8")).toBe("from the agent");

    const outside = await client.callTool({
      name: "upload_to_ssh_host",
      arguments: {
        hostId: "mini-host",
        localPath: path.join(os.tmpdir(), "not-in-the-workspace.txt"),
        remoteDir: "/srv",
      },
    });
    expect((outside as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(outside)).toContain("outside");
  }, 30_000);
});
