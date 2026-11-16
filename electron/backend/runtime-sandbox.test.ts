import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registrySecretRef, type RegistryConnection } from "../shared/registry.js";
import { SANDBOX_SRT_VERSION } from "../shared/sandbox.js";
import { SANDBOX_DENIED_CHANNEL, SANDBOX_DENIED_SETTLED_CHANNEL } from "../shared/sandbox-events.js";
import { createRuntimeSandbox, SANDBOX_PROXY_ENV_NAMES, type RuntimeSandbox } from "./runtime-sandbox.js";

const READY = `home=/home/dev
node=/usr/bin/node
agent_claude=/usr/bin/claude
agent_codex=/usr/bin/codex
agent_copilot=/usr/bin/copilot
agent_opencode=/usr/bin/opencode
agent_gemini=/usr/bin/gemini
bwrap=/usr/bin/bwrap
socat=/usr/bin/socat
rg=/usr/bin/rg
srt_module=/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js
srt_version=${SANDBOX_SRT_VERSION}
`;

interface FakeState {
  workspaces: Array<{
    id: string;
    profileId: string;
    cwd: string;
    sandboxAllowedDomains?: string[];
    sandboxEnabled?: boolean;
  }>;
  settings: { integrations: { registry?: { connections: RegistryConnection[] } } };
}

describe("runtime sandbox", () => {
  const dirs: string[] = [];
  let state: FakeState;
  let secrets: Map<string, string>;
  let setSecret: Mock<(ref: string, value: string, opts?: { requireEncryptedStorage?: boolean }) => Promise<void>>;
  let events: Array<{ channel: string; payload: unknown }>;
  let broadcasts: number;
  let sandbox: RuntimeSandbox;
  let fetchImpl: ReturnType<typeof vi.fn>;

  const temp = (name: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `rt-sbx-${name}-`));
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    const workspaceDir = temp("ws");
    state = {
      workspaces: [{ id: "w1", profileId: "p1", cwd: workspaceDir, sandboxEnabled: true }],
      settings: { integrations: {} },
    };
    secrets = new Map();
    setSecret = vi.fn(async (ref: string, value: string) => void secrets.set(ref, value));
    events = [];
    broadcasts = 0;
    fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    sandbox = createRuntimeSandbox({
      dataDir: temp("data"),
      auditDir: temp("audit"),
      getState: () => state as never,
      mutate: async (fn) => fn(state as never),
      credentialStore: {
        setSecret,
        getSecret: (ref: string) => secrets.get(ref) ?? "",
        deleteSecret: async (ref: string) => void secrets.delete(ref),
      },
      getWindowProfileId: (windowId) => (windowId === "win-p2" ? "p2" : "p1"),
      emit: (channel, payload) => events.push({ channel, payload }),
      broadcastState: () => void (broadcasts += 1),
      platform: "linux",
      run: async () => ({ code: 0, stdout: READY, stderr: "" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tmpDir: temp("tmp"),
    });
  });

  afterEach(async () => {
    await sandbox.shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    id: "r1",
    label: "Corp",
    kind: "maven",
    url: "https://repo.corp.example/maven/",
    mode: "mirror",
    authKind: "basic",
    username: "svc",
    npmScope: "",
    secret: "token",
    ...overrides,
  });

  describe("registry connections", () => {
    it("stores the connection in the settings and its secret under a reference derived from the id", async () => {
      await sandbox.saveRegistry(input(), "win-p1");
      expect(state.settings.integrations.registry?.connections).toEqual([
        expect.objectContaining({
          id: "r1",
          profileId: "p1",
          url: "https://repo.corp.example/maven",
          authKind: "basic",
        }),
      ]);
      expect(JSON.stringify(state)).not.toContain("token");
      expect(setSecret).toHaveBeenCalledWith(registrySecretRef("r1"), "token", { requireEncryptedStorage: true });
      expect(broadcasts).toBe(1);
    });

    it("keeps the stored secret when an edit leaves it empty, and demands one for a new sign-in", async () => {
      await sandbox.saveRegistry(input(), "win-p1");
      await sandbox.saveRegistry(input({ secret: undefined, label: "Renamed" }), "win-p1");
      expect(secrets.get(registrySecretRef("r1"))).toBe("token");
      await expect(sandbox.saveRegistry(input({ id: "r2", secret: undefined }), "win-p1")).rejects.toThrow(
        /token or password/,
      );
    });

    it("refuses a URL the host would not send a credential to", async () => {
      for (const url of ["http://repo.corp.example", "https://u:p@repo.corp.example", "not a url"]) {
        await expect(sandbox.saveRegistry(input({ url }), "win-p1")).rejects.toThrow();
      }
      expect(state.settings.integrations.registry?.connections ?? []).toHaveLength(0);
    });

    it("keeps no secret for a registry that needs none", async () => {
      await sandbox.saveRegistry(input({ authKind: "none", secret: undefined, username: "" }), "win-p1");
      expect(secrets.has(registrySecretRef("r1"))).toBe(false);
    });

    it("does not let another profile edit, delete or test a registry", async () => {
      await sandbox.saveRegistry(input(), "win-p1");
      await expect(sandbox.saveRegistry(input({ label: "Hijacked" }), "win-p2")).rejects.toThrow(/another profile/);
      await expect(sandbox.deleteRegistry("r1", "win-p2")).rejects.toThrow(/another profile/);
      await expect(sandbox.testRegistry({ connectionId: "r1" }, "win-p2")).rejects.toThrow(/Unknown registry/);
      expect(state.settings.integrations.registry?.connections[0].label).toBe("Corp");
    });

    it("deletes the connection and its secret", async () => {
      await sandbox.saveRegistry(input(), "win-p1");
      await sandbox.deleteRegistry("r1", "win-p1");
      expect(state.settings.integrations.registry?.connections).toEqual([]);
      expect(secrets.has(registrySecretRef("r1"))).toBe(false);
    });

    it("tests a registry the way the gateway reads it: the stored sign-in, from the host, no redirects followed", async () => {
      await sandbox.saveRegistry(input(), "win-p1");
      expect(await sandbox.testRegistry({ connectionId: "r1", probePath: "/org/a.pom" }, "win-p1")).toMatchObject({
        ok: true,
        status: 200,
      });
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://repo.corp.example/maven/org/a.pom");
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Basic ${Buffer.from("svc:token").toString("base64")}`,
      );
      expect(init.redirect).toBe("manual");
      fetchImpl.mockResolvedValueOnce(new Response("no", { status: 401 }));
      expect(await sandbox.testRegistry({ connectionId: "r1" }, "win-p1")).toMatchObject({ ok: false, status: 401 });
      fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await sandbox.testRegistry({ connectionId: "r1" }, "win-p1")).toMatchObject({ ok: false, status: 0 });
    });
  });

  describe("destinations a sandbox waits on", () => {
    const sessionId = "w1:p1";

    async function startSession() {
      const workspace = state.workspaces[0];
      const panel = { id: "p1", command: "claude" };
      expect(
        await sandbox.hooks.prepare({
          state: state as never,
          workspace: workspace as never,
          panel: panel as never,
          sessionId,
        }),
      ).toBe(true);
      sandbox.hooks.wrap({
        state: state as never,
        workspace: workspace as never,
        panel: panel as never,
        sessionId,
        launcher: { file: "/bin/bash", args: [] },
        cwd: workspace.cwd,
        env: { PATH: "/usr/bin" },
      });
      return path.join(sandbox.service.listPending().length ? "" : "", "");
    }

    function raise(id: string, host: string, port = 443) {
      const files = sessionFiles();
      writeFileSync(files, `${JSON.stringify({ id, host, port, at: Date.now() })}\n`, { flag: "a" });
      sandbox.service.pollDenials();
    }
    function sessionFiles(): string {
      const base = (sandbox.service as unknown as { options: { dataDir: string } }).options.dataDir;
      return path.join(base, "sandbox", "sessions", "w1_p1", "denials.jsonl");
    }

    it("tells the desktop window about it and nobody else", async () => {
      await startSession();
      raise("d1", "example.org");
      expect(events).toEqual([
        {
          channel: SANDBOX_DENIED_CHANNEL,
          payload: expect.objectContaining({ host: "example.org", workspaceId: "w1" }),
        },
      ]);
    });

    it("allows for the workspace: remembers the destination and answers the waiting sandbox", async () => {
      await startSession();
      raise("d2", "api.example.org");
      const result = await sandbox.decide({ requestId: "d2", allow: true, remember: true });
      expect(result).toEqual({ ok: true, remembered: "api.example.org" });
      expect(state.workspaces[0].sandboxAllowedDomains).toEqual(["api.example.org"]);
      expect(events.at(-1)?.channel).toBe(SANDBOX_DENIED_SETTLED_CHANNEL);
      expect(broadcasts).toBe(1);
    });

    it("keeps a non-default port in what it remembers", async () => {
      await startSession();
      raise("d3", "api.example.org", 8443);
      expect((await sandbox.decide({ requestId: "d3", allow: true, remember: true })).remembered).toBe(
        "api.example.org:8443",
      );
    });

    it("allows once without touching the workspace's list, and denying remembers nothing", async () => {
      await startSession();
      raise("d4", "once.example.org");
      await sandbox.decide({ requestId: "d4", allow: true });
      raise("d5", "no.example.org");
      await sandbox.decide({ requestId: "d5", allow: false, remember: true });
      expect(state.workspaces[0].sandboxAllowedDomains ?? []).toEqual([]);
    });

    it("will not remember an IP address, and leaves the request waiting", async () => {
      await startSession();
      raise("d6", "10.0.0.7");
      await expect(sandbox.decide({ requestId: "d6", allow: true, remember: true })).rejects.toThrow(/named host/);
      expect(sandbox.listPending()).toHaveLength(1);
    });

    it("says a request has expired instead of pretending to answer it", async () => {
      await expect(sandbox.decide({ requestId: "missing", allow: true })).rejects.toThrow(/expired/);
    });

    it("remembers a refused destination afterwards, but answers nothing else for it", async () => {
      await startSession();
      raise("d7", "late.example.org");
      await sandbox.decide({ requestId: "d7", allow: false });
      await expect(sandbox.decide({ requestId: "d7", allow: true })).rejects.toThrow(/expired/);
      expect(state.workspaces[0].sandboxAllowedDomains ?? []).toEqual([]);
      expect(await sandbox.decide({ requestId: "d7", allow: true, remember: true })).toEqual({
        ok: true,
        remembered: "late.example.org",
        late: true,
      });
      expect(state.workspaces[0].sandboxAllowedDomains).toEqual(["late.example.org"]);
    });
  });

  describe("MCP bridges inside the sandbox", () => {
    it("leaves an ordinary tab's process description alone", () => {
      const base = { execPath: "/app/electron" };
      expect(sandbox.processInfoFor("not-a-sandbox-session", base)).toBe(base);
    });

    it("keeps the app's own executable as node on a native host, reads an asar, and forwards the proxy by name", async () => {
      const workspace = state.workspaces[0];
      await sandbox.hooks.prepare({
        state: state as never,
        workspace: workspace as never,
        panel: { id: "p1", command: "codex" } as never,
        sessionId: "w1:p1",
      });
      const appRoot = temp("app");
      mkdirSync(path.join(appRoot, "dist"), { recursive: true });
      writeFileSync(path.join(appRoot, "package.json"), "{}");
      const entry = path.join(appRoot, "dist", "bridge.js");
      writeFileSync(entry, "");
      const granted = vi.spyOn(sandbox.service, "addReadPaths");
      const info = sandbox.processInfoFor("w1:p1", { execPath: "/app/electron" });
      expect(info.sandbox?.nodePath).toBeNull();
      expect(info.sandbox?.forwardEnv).toEqual(SANDBOX_PROXY_ENV_NAMES);
      expect(info.sandbox?.mapPath(entry)).toBe(entry);
      // The build output, the dependencies and the package.json Node reads for the module type; never the whole package.
      expect(granted).toHaveBeenLastCalledWith("w1:p1", [
        path.join(appRoot, "dist"),
        path.join(appRoot, "node_modules"),
        path.join(appRoot, "package.json"),
      ]);
      expect(info.sandbox?.mapPath("/opt/app/resources/app.asar/dist/bridge.js")).toBe(
        "/opt/app/resources/app.asar/dist/bridge.js",
      );
      expect(info.execPath).toBe("/app/electron");
    });
  });
});
