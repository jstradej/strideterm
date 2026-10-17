import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInternalMcpBroker, type InternalMcpGrantContext } from "./internal-mcp/internal-mcp-broker.js";
import { InternalMcpError } from "./internal-mcp/errors.js";
import { createInternalMcpStdioHandlers, readInternalMcpStdioConfig } from "./internal-mcp/internal-mcp-stdio.js";
import { INTERNAL_MCP_CAPABILITY_ENV, INTERNAL_MCP_URL_ENV } from "../shared/internal-mcp.js";

const stdioEntry = fileURLToPath(new URL("./internal-mcp-stdio-entry.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const context: InternalMcpGrantContext = {
  sessionId: "parent:agent",
  profileId: "profile-a",
  workspaceId: "parent",
  panelId: "agent",
  command: "claude",
};

function createService() {
  return {
    prepare: vi.fn(async (_scope: unknown, input: { assignment?: string }) => ({ echoed: input.assignment ?? null })),
    start: vi.fn(async () => {
      throw new InternalMcpError("needs_reprepare", "Show the user the current summary again.");
    }),
    operationGet: vi.fn(async () => ({ status: "running" })),
    taskList: vi.fn(() => ({ tasks: [], nextCursor: null })),
    taskGet: vi.fn(async () => ({ state: "idle" })),
  };
}

async function startBroker(service = createService(), isGrantLive: () => boolean = () => true) {
  const broker = createInternalMcpBroker({ service: service as never, isGrantLive });
  await broker.start();
  cleanups.push(() => broker.close());
  return { broker, service, grant: broker.mintGrant(context) };
}

function toolText(result: unknown): { text: string; isError: boolean } {
  const typed = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  return { text: typed.content?.find((item) => item.type === "text")?.text ?? "", isError: typed.isError === true };
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", stdioEntry, "--internal-mcp"],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "internal-mcp-integration-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(async () => client.close());
  return client;
}

describe("internal MCP stdio end-to-end", () => {
  test("exposes exactly the five task tools and carries calls to the broker", async () => {
    const { service, grant } = await startBroker();
    const client = await connect({
      [INTERNAL_MCP_URL_ENV]: grant.url,
      [INTERNAL_MCP_CAPABILITY_ENV]: grant.capability,
    });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "operation_get",
      "task_get",
      "task_list",
      "task_prepare",
      "task_start",
    ]);
    const prepared = toolText(await client.callTool({ name: "task_prepare", arguments: { assignment: "Do it" } }));
    expect(prepared.isError).toBe(false);
    expect(JSON.parse(prepared.text)).toEqual({ echoed: "Do it" });
    expect(service.prepare).toHaveBeenCalledWith(
      { profileId: "profile-a", workspaceId: "parent" },
      { assignment: "Do it" },
    );
    expect(toolText(await client.callTool({ name: "task_list", arguments: {} })).isError).toBe(false);
  });

  test("a broker refusal reaches the agent as a stable error code, not a crash", async () => {
    const { grant } = await startBroker();
    const client = await connect({
      [INTERNAL_MCP_URL_ENV]: grant.url,
      [INTERNAL_MCP_CAPABILITY_ENV]: grant.capability,
    });
    const refused = toolText(
      await client.callTool({
        name: "task_start",
        arguments: { preparationId: "prep-1", approvedInputHash: "a".repeat(64), idempotencyKey: "key-12345678" },
      }),
    );
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text)).toEqual({
      error: { code: "needs_reprepare", message: "Show the user the current summary again." },
    });
  });

  test("a revoked grant stops later calls", async () => {
    const { broker, grant } = await startBroker();
    const client = await connect({
      [INTERNAL_MCP_URL_ENV]: grant.url,
      [INTERNAL_MCP_CAPABILITY_ENV]: grant.capability,
    });
    expect(toolText(await client.callTool({ name: "task_list", arguments: {} })).isError).toBe(false);
    broker.revokeSession(context.sessionId);
    const rejected = toolText(await client.callTool({ name: "task_list", arguments: {} }));
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.text).error.code).toBe("unauthorized");
  });

  test("a grant whose terminal or opt-in is gone is refused and dropped", async () => {
    let live = true;
    const { grant } = await startBroker(createService(), () => live);
    const client = await connect({
      [INTERNAL_MCP_URL_ENV]: grant.url,
      [INTERNAL_MCP_CAPABILITY_ENV]: grant.capability,
    });
    live = false;
    const rejected = toolText(await client.callTool({ name: "task_list", arguments: {} }));
    expect(JSON.parse(rejected.text).error.code).toBe("grant_expired");
    live = true;
    expect(JSON.parse(toolText(await client.callTool({ name: "task_list", arguments: {} })).text).error.code).toBe(
      "unauthorized",
    );
  });

  test("the bridge reports an unreachable broker as data", async () => {
    const handlers = createInternalMcpStdioHandlers({
      config: { url: "http://127.0.0.1:1/internal-mcp", capability: "c".repeat(43) },
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never,
    });
    const result = toolText(await handlers.send({ operation: "task_list", input: {} }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).error.code).toBe("broker_unreachable");
  });

  test("the entry refuses to start without a valid connection", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", stdioEntry, "--internal-mcp"], {
      env: { ...process.env, [INTERNAL_MCP_URL_ENV]: "", [INTERNAL_MCP_CAPABILITY_ENV]: "" },
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Missing or invalid internal MCP connection environment");
    const noFlag = spawnSync(process.execPath, ["--import", "tsx", stdioEntry], { encoding: "utf8" });
    expect(noFlag.stderr).toContain("Missing --internal-mcp");
  });
});

describe("internal MCP connection environment", () => {
  const capability = "A".repeat(43);

  test("accepts only the loopback broker route", () => {
    const env = (url: string, cap = capability) => ({
      [INTERNAL_MCP_URL_ENV]: url,
      [INTERNAL_MCP_CAPABILITY_ENV]: cap,
    });
    expect(readInternalMcpStdioConfig(env("http://127.0.0.1:4010/internal-mcp"))).toEqual({
      url: "http://127.0.0.1:4010/internal-mcp",
      capability,
    });
    for (const bad of [
      "https://127.0.0.1:4010/internal-mcp",
      "http://localhost:4010/internal-mcp",
      "http://10.0.0.5:4010/internal-mcp",
      "http://127.0.0.1:4010/ssh-mcp",
      "http://user:pw@127.0.0.1:4010/internal-mcp",
      "http://127.0.0.1:4010/internal-mcp?x=1",
      "not a url",
    ]) {
      expect(readInternalMcpStdioConfig(env(bad)), bad).toBeNull();
    }
    expect(readInternalMcpStdioConfig(env("http://127.0.0.1:4010/internal-mcp", "short"))).toBeNull();
    expect(readInternalMcpStdioConfig({})).toBeNull();
  });
});

describe("internal MCP source shape", () => {
  const read = (relative: string) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  test("the bridge and broker never import Electron or the renderer", () => {
    for (const file of [
      "./internal-mcp/internal-mcp-stdio.ts",
      "./internal-mcp/internal-mcp-broker.ts",
      "./internal-mcp/task-service.ts",
      "./operation-registry.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/from "electron"/);
      expect(source, file).not.toMatch(/from "\.\.\/\.\.\/src|from "vue"/);
    }
  });

  test("a tool argument cannot name a profile: the request schemas are strict and carry no profile field", () => {
    const shared = read("../shared/internal-mcp.ts");
    expect(shared).not.toMatch(/profileId:\s*z\./);
    expect((shared.match(/\.strict\(\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  test("the capability is passed by name to Codex and never serialized into arguments", () => {
    const helper = read("./agent-mcp-launch.ts");
    expect(helper).toContain("env_vars");
    expect(helper).not.toContain("CAPABILITY_ENV]:");
  });
});
