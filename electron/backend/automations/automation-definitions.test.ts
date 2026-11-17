import { describe, expect, it, vi } from "vitest";
import { createDefaultState, normalizeWorkspace } from "../default-state.js";
import { AutomationDefinitions } from "./automation-definitions.js";

function setup() {
  const state = createDefaultState();
  state.workspaces = [
    normalizeWorkspace({
      id: "parent",
      name: "Project",
      kind: "manual",
      cwd: "/tmp/project",
      profileId: "default",
      jiraMcpEnabled: true,
      sshMcpEnabled: false,
      sandboxEnabled: true,
      panels: [],
    }),
  ];
  const changed = vi.fn();
  const scope = vi.fn();
  const definitions = new AutomationDefinitions({
    store: {
      async mutate(change) {
        change(state);
      },
    },
    assertScope: scope,
    changed,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const input = {
    enabled: true,
    trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
    executor: { type: "agent", agent: { providerId: "codex", model: "", skipPermissions: true } },
    prompt: "do work",
    location: "automation",
    policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
  };
  return { state, definitions, input, changed, scope };
}
describe("automation definitions", () => {
  it("rejects past one-time schedules on creation, update and re-enable", async () => {
    const x = setup();
    const past = { ...x.input, trigger: { type: "schedule", kind: "once", at: "2025-12-31T23:59:00Z" } };
    await expect(x.definitions.create("parent", "Expired", past, { kind: "desktop" })).rejects.toThrow("future date");
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "desktop" });
    const definition = x.state.workspaces.find((item) => item.id === id)!.automation!;
    await expect(x.definitions.update(id, definition.updatedAt, past, { kind: "desktop" })).rejects.toThrow(
      "future date",
    );
    await x.definitions.setEnabled(id, false, definition.updatedAt);
    definition.trigger = { type: "schedule", kind: "once", at: "2025-12-31T23:59:00Z" };
    await expect(x.definitions.setEnabled(id, true, definition.updatedAt)).rejects.toThrow("future date");
  });
  it("creates a child with inherited restrictions and caps the agent caller's permissions", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Daily", x.input, { kind: "agent", sessionId: "s" });
    const workspace = x.state.workspaces.find((item) => item.id === id)!;
    expect(workspace).toMatchObject({
      kind: "automation",
      cwd: "/tmp/project",
      profileId: "default",
      jiraMcpEnabled: true,
      sshMcpEnabled: false,
      sandboxEnabled: true,
      internalMcpEnabled: false,
    });
    expect(workspace.automation).toMatchObject({
      parentWorkspaceId: "parent",
      createdBy: { kind: "agent", sessionId: "s" },
      executor: { agent: { skipPermissions: false } },
    });
    expect(workspace.panels[1]?.command).not.toContain("bypass");
    expect(x.scope).toHaveBeenCalledWith("parent");
    expect(x.changed).toHaveBeenCalledOnce();
  });
  it("rejects stale edits and prevents tools from exceeding the parent", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "remote" });
    const workspace = x.state.workspaces.find((item) => item.id === id)!;
    const stamp = workspace.automation!.updatedAt;
    await expect(x.definitions.update(id, stamp, x.input, { kind: "remote" }, { sshMcpEnabled: true })).rejects.toThrow(
      "Parent has not enabled SSH",
    );
    await x.definitions.update(
      id,
      stamp,
      { ...x.input, prompt: "updated" },
      { kind: "remote" },
      { jiraMcpEnabled: false },
    );
    expect(workspace.automation?.prompt).toBe("updated");
    expect(workspace.jiraMcpEnabled).toBe(false);
    await expect(x.definitions.update(id, stamp, x.input, { kind: "remote" })).rejects.toThrow("changed elsewhere");
  });
  it("allows exactly one of two concurrent edits based on the same version", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "desktop" });
    const version = x.state.workspaces.find((workspace) => workspace.id === id)!.automation!.updatedAt;
    const results = await Promise.allSettled([
      x.definitions.update(id, version, { ...x.input, prompt: "first" }, { kind: "desktop" }),
      x.definitions.update(id, version, { ...x.input, prompt: "second" }, { kind: "remote" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["first", "second"]).toContain(
      x.state.workspaces.find((workspace) => workspace.id === id)!.automation!.prompt,
    );
  });
  it("rejects a connection in a different profile", async () => {
    const x = setup();
    x.state.settings.integrations.github.connections.push({
      id: "foreign",
      label: "Foreign",
      enabled: true,
      profileId: "other",
    });
    const input = {
      ...x.input,
      trigger: { type: "event", source: "github", kinds: ["pr-new"], connectionId: "foreign" },
    };
    await expect(x.definitions.create("parent", "Job", input, { kind: "remote" })).rejects.toThrow(
      "not available in this profile",
    );
    expect(x.state.workspaces).toHaveLength(1);
  });
  it("enables and disables with an optimistic version check", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "desktop" });
    const definition = x.state.workspaces.find((item) => item.id === id)!.automation!;
    const firstVersion = definition.updatedAt;
    await x.definitions.setEnabled(id, false, firstVersion);
    expect(definition).toMatchObject({ enabled: false, enabledAt: null, disabledReason: "user" });
    await expect(x.definitions.setEnabled(id, true, firstVersion)).rejects.toThrow("changed elsewhere");
    await x.definitions.setEnabled(id, true, definition.updatedAt);
    expect(definition.enabled).toBe(true);
    expect(definition.enabledAt).toBe(definition.updatedAt);
    expect(definition.disabledReason).toBeUndefined();
  });
  it("applies reduced tool grants atomically during creation", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "remote" }, false, {
      jiraMcpEnabled: false,
    });
    expect(x.state.workspaces.find((workspace) => workspace.id === id)?.jiraMcpEnabled).toBe(false);
    await expect(
      x.definitions.create("parent", "Job", x.input, { kind: "remote" }, false, { sshMcpEnabled: true }),
    ).rejects.toThrow("Parent has not enabled SSH");
  });
  it("revokes Jira tools from an existing task when its automation loses them", async () => {
    const x = setup();
    const id = await x.definitions.create("parent", "Job", x.input, { kind: "desktop" });
    const automation = x.state.workspaces.find((workspace) => workspace.id === id)!;
    const task = normalizeWorkspace({
      id: "task",
      name: "Task",
      kind: "task",
      cwd: "/tmp/project",
      profileId: "default",
      jiraMcpEnabled: true,
      task: { parentWorkspaceId: id },
    });
    x.state.workspaces.push(task);
    await x.definitions.update(
      id,
      automation.automation!.updatedAt,
      x.input,
      { kind: "desktop" },
      { jiraMcpEnabled: false },
    );
    expect(task.jiraMcpEnabled).toBe(false);
  });
});
