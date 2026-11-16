import { describe, expect, test } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { normalizeState, normalizeWorkspace } from "./default-state.js";
import { slimRemoteSettings } from "./remote-core.js";
import { sanitizeSettingsFromRemote } from "./remote-server.js";
import { normalizeRegistryConnections, validateRegistryInput } from "./sandbox/registry-connections.js";
import { buildNpmrc } from "./sandbox/registry-tool-config.js";

const registry = {
  id: "r1",
  profileId: "p1",
  label: "Corp",
  kind: "maven",
  url: "https://repo.corp.example/maven/",
  mode: "mirror",
  authKind: "basic",
  username: "svc",
  npmScope: "",
};

describe("workspace isolation state", () => {
  test("is off unless the workspace turned it on, and keeps only valid allowlist entries", () => {
    expect(normalizeWorkspace({ id: "a", name: "A", kind: "terminal" }).sandboxEnabled).toBe(false);
    const on = normalizeWorkspace({
      id: "a",
      name: "A",
      kind: "terminal",
      sandboxEnabled: true,
      sandboxAllowedDomains: ["Api.Example.com", "10.0.0.1", "*", "api.example.com"],
    });
    expect(on.sandboxEnabled).toBe(true);
    expect(on.sandboxAllowedDomains).toEqual(["api.example.com"]);
  });

  test("a task workspace carries it, unlike the grants a task never inherits", () => {
    const task = normalizeWorkspace({
      id: "t",
      name: "T",
      kind: "task",
      sandboxEnabled: true,
      internalMcpEnabled: true,
    });
    expect(task.sandboxEnabled).toBe(true);
    expect(task.internalMcpEnabled).toBe(false);
  });

  test("survives every re-normalisation, an opt-out included", () => {
    const state = normalizeState({
      workspaces: [{ id: "a", name: "A", kind: "terminal", cwd: "/x", sandboxEnabled: true, panels: [] }],
    });
    expect(state.workspaces[0].sandboxEnabled).toBe(true);
    state.workspaces[0].sandboxEnabled = false;
    expect(normalizeState(state).workspaces[0].sandboxEnabled).toBe(false);
  });

  test("a task's own isolation survives normalisation under a parent that is not isolated", () => {
    const state = normalizeState({
      workspaces: [
        { id: "p", name: "P", kind: "terminal", cwd: "/x", panels: [] },
        { id: "t", name: "T", kind: "task", cwd: "/x", sandboxEnabled: true, task: { parentWorkspaceId: "p" } },
      ],
    });
    expect(state.workspaces.find((workspace) => workspace.id === "t")!.sandboxEnabled).toBe(true);
  });

  test("a tab's isolated-shell choice is kept only when it is on", () => {
    const workspace = normalizeWorkspace({
      id: "a",
      name: "A",
      kind: "terminal",
      panels: [
        { id: "on", title: "On", command: "", sandboxShell: true },
        { id: "off", title: "Off", command: "", sandboxShell: false },
        { id: "junk", title: "Junk", command: "", sandboxShell: "yes" },
      ],
    });
    expect(workspace.panels.find((panel) => panel.id === "on")!.sandboxShell).toBe(true);
    expect(workspace.panels.find((panel) => panel.id === "off")).not.toHaveProperty("sandboxShell");
    expect(workspace.panels.find((panel) => panel.id === "junk")).not.toHaveProperty("sandboxShell");
  });
});

describe("the default for isolating new workspaces", () => {
  test("is off, and a stored choice survives every re-normalisation in both directions", () => {
    expect(normalizeState({}).settings.isolateNewWorkspaces).toBe(false);
    expect(normalizeState({ settings: { isolateNewWorkspaces: "yes" } }).settings.isolateNewWorkspaces).toBe(false);
    const on = normalizeState({ settings: { isolateNewWorkspaces: true } });
    expect(on.settings.isolateNewWorkspaces).toBe(true);
    expect(normalizeState(on).settings.isolateNewWorkspaces).toBe(true);
    on.settings.isolateNewWorkspaces = false;
    expect(normalizeState(on).settings.isolateNewWorkspaces).toBe(false);
  });

  test("a remote settings save cannot move it", () => {
    const settings: Record<string, unknown> = { isolateNewWorkspaces: true, theme: "dark" };
    expect(sanitizeSettingsFromRemote(settings)).toContain("isolateNewWorkspaces");
    expect(settings).toEqual({ theme: "dark" });
  });
});

describe("registry connections state", () => {
  test("a fresh state has none, and a persisted list is cleaned, not trusted", () => {
    expect(normalizeState({}).settings.integrations.registry).toEqual({ connections: [] });
    const cleaned = normalizeRegistryConnections([
      registry,
      { ...registry, id: "dup" },
      { ...registry, id: "r1" },
      { ...registry, id: "http", url: "http://repo.corp.example" },
      { ...registry, id: "creds", url: "https://u:p@repo.corp.example" },
      { ...registry, id: "bad-kind", kind: "cargo" },
      "junk",
    ]);
    expect(cleaned.map((item) => item.id)).toEqual(["r1", "dup"]);
    expect(cleaned[0].url).toBe("https://repo.corp.example/maven");
  });

  test("persists through the state normaliser", () => {
    const state = normalizeState({ settings: { integrations: { registry: { connections: [registry] } } } });
    expect(state.settings.integrations.registry.connections).toHaveLength(1);
  });

  test("a basic sign-in needs an account name, and the form refuses a URL the host would not send a secret to", () => {
    const input = { ...registry, secret: undefined };
    expect(() => validateRegistryInput({ ...input, username: " " }, "p1")).toThrow(/account name/);
    expect(() => validateRegistryInput({ ...input, url: "http://x.example" }, "p1")).toThrow(/https/);
    expect(validateRegistryInput(input, "p1").profileId).toBe("p1");
  });

  test("an additional npm registry must name its scope: without one it would generate no npm config at all", () => {
    const npm = { ...registry, kind: "npm", mode: "additional", authKind: "none", username: "", npmScope: "" };
    expect(() => validateRegistryInput(npm, "p1")).toThrow(/needs the scope/);
    expect(() => validateRegistryInput({ ...npm, npmScope: "acme" }, "p1")).toThrow(/@acme/);
    expect(() => validateRegistryInput({ ...npm, mode: "mirror", npmScope: "acme" }, "p1")).toThrow(/@acme/);
    const saved = validateRegistryInput({ ...npm, npmScope: "@acme" }, "p1");
    expect(buildNpmrc([{ connection: saved, url: "http://gateway/registry/cap/r1" }] as never)).toBe(
      "@acme:registry=http://gateway/registry/cap/r1/\n",
    );
    expect(validateRegistryInput({ ...npm, mode: "mirror" }, "p1").npmScope).toBe("");
  });

  test("an npm scope is kept only for npm and only in the @scope form", () => {
    const npm = { ...registry, kind: "npm", npmScope: "@acme" };
    expect(normalizeRegistryConnections([npm])[0].npmScope).toBe("@acme");
    expect(normalizeRegistryConnections([{ ...npm, npmScope: "acme" }])[0].npmScope).toBe("");
    expect(normalizeRegistryConnections([{ ...registry, npmScope: "@acme" }])[0].npmScope).toBe("");
  });
});

describe("remote clients cannot reach registries", () => {
  test("a remote settings save loses its registry subtree", () => {
    const settings: Record<string, unknown> = { integrations: { registry: { connections: [registry] }, telegram: {} } };
    expect(sanitizeSettingsFromRemote(settings)).toContain("integrations.registry");
    expect(settings.integrations).toEqual({ telegram: {} });
  });

  test("the settings a remote core sends have no registry connections", () => {
    const slim = slimRemoteSettings({ integrations: { registry: { connections: [registry] } } });
    expect((slim.integrations as { registry: unknown }).registry).toEqual({ connections: [] });
  });
});

describe("tasks and companions run in the sandbox of the workspace they came from", () => {
  const parent = {
    id: "parent",
    name: "Parent",
    kind: "terminal",
    cwd: "/work/app",
    profileId: "default",
    sandboxEnabled: true,
    sandboxAllowedDomains: ["api.example.com"],
    panels: [{ id: "agent", title: "Agent", command: "claude", startup: "default" }],
  };

  test("a task workspace inherits the switch and the allowlist", () => {
    const runner = new AgentTaskRunner();
    const task = runner.createTaskWorkspace({
      state: { workspaces: [parent] } as never,
      description: "do it",
      cwd: "/work/app-task",
      parentWorkspaceId: "parent",
    });
    expect(task.sandboxEnabled).toBe(true);
    expect(task.sandboxAllowedDomains).toEqual(["api.example.com"]);
    expect(task.sandboxAllowedDomains).not.toBe(parent.sandboxAllowedDomains);
  });

  test("a task of a workspace that is not isolated is not", () => {
    const runner = new AgentTaskRunner();
    const task = runner.createTaskWorkspace({
      state: { workspaces: [{ ...parent, sandboxEnabled: false }] } as never,
      description: "do it",
      cwd: "/work/app-task",
      parentWorkspaceId: "parent",
    });
    expect(task.sandboxEnabled).toBe(false);
    expect(
      runner.createTaskWorkspace({ state: {} as never, description: "x", cwd: "/x", parentWorkspaceId: "" })
        .sandboxEnabled,
    ).toBe(false);
  });

  test("a task can be created isolated under a workspace that is not, and never the other way round", () => {
    const runner = new AgentTaskRunner();
    const create = (parentIsolated: boolean, isolated?: boolean) =>
      runner.createTaskWorkspace({
        state: { workspaces: [{ ...parent, sandboxEnabled: parentIsolated }] } as never,
        description: "do it",
        cwd: "/work/app-task",
        parentWorkspaceId: "parent",
        isolated,
      }).sandboxEnabled;
    expect(create(false, true)).toBe(true);
    expect(create(false, false)).toBe(false);
    expect(create(true, false)).toBe(true);
    expect(create(true)).toBe(true);
  });

  test("a Companion inherits it from its Primary's workspace", () => {
    const runner = new AgentTaskRunner();
    const companion = runner.createCompanionTaskWorkspace({
      state: { workspaces: [parent] } as never,
      workerWorkspaceId: "parent",
      workerPanelId: "agent",
      companionRole: "reviewer",
      companionProvider: { providerId: "codex", model: "x" },
    });
    expect(companion.sandboxEnabled).toBe(true);
    expect(companion.sandboxAllowedDomains).toEqual(["api.example.com"]);
  });
});
