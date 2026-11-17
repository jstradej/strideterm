import { describe, expect, it, vi } from "vitest";
import { createDefaultState, normalizeWorkspace } from "../default-state.js";
import { AutomationDefinitions } from "../automations/automation-definitions.js";
import type { AutomationJournal } from "../automations/automation-journal.js";
import { createAutomationMcpApi } from "./automation-mcp-api.js";

describe("automation MCP scope", () => {
  it("exposes only children and metadata of the granted workspace and profile", async () => {
    const state = createDefaultState();
    state.workspaces = ["parent", "other"].map((id) =>
      normalizeWorkspace({
        id,
        name: id,
        kind: "manual",
        cwd: "/tmp",
        profileId: "default",
        internalMcpEnabled: true,
        panels: [],
      }),
    );
    const definitions = new AutomationDefinitions({
      store: {
        async mutate(change) {
          change(state);
        },
      },
      assertScope: () => {},
      changed: () => {},
    });
    const definition = {
      enabled: true,
      trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
      executor: { type: "agent", agent: { providerId: "codex", model: "", skipPermissions: false } },
      prompt: "work",
      location: "automation",
      policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
    };
    const own = await definitions.create("parent", "own", definition, { kind: "remote" });
    const foreign = await definitions.create("other", "foreign", definition, { kind: "remote" });
    const read = vi.fn(async () => ({ runs: [{ runId: "run", resultExcerpt: "untrusted" }] }));
    const runNow = vi.fn(async () => ({ runId: "run" }));
    const stopRun = vi.fn(async () => {});
    const update = vi.fn(async (_grant, _input, assertCurrent: () => void) => assertCurrent());
    const setEnabled = vi.fn(async (_grant, _input, assertCurrent: () => void) => assertCurrent());
    const remove = vi.fn(async () => {});
    const api = createAutomationMcpApi({
      getState: () => state,
      snapshot: () => ({
        paused: false,
        byWorkspaceId: {},
        recentRuns: [],
        connections: [
          { id: "own", label: "own", profileId: "default", source: "github" },
          { id: "foreign", label: "foreign", profileId: "foreign", source: "github" },
        ],
        queries: [],
      }),
      journal: { read } as unknown as AutomationJournal,
      runNow,
      stopRun,
      update,
      setEnabled,
      delete: remove,
    });
    const scope = { profileId: "default", workspaceId: "parent" };
    const grant = { ...scope, sessionId: "session", panelId: "panel", command: "claude", tasksEnabled: true };
    expect((await api.list(scope)).automations.map((item) => item.workspaceId)).toEqual([own]);
    expect((await api.catalog(scope)).connections.map((item) => item.id)).toEqual(["own"]);
    expect(await api.get(scope, own)).toMatchObject({
      runs: [{ resultExcerpt: "untrusted" }],
      resultNotice: expect.stringContaining("untrusted"),
    });
    await expect(api.get(scope, foreign)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(api.delete(grant, foreign, () => {})).rejects.toMatchObject({ code: "scope_denied" });
    expect(remove).not.toHaveBeenCalled();
    const updated = {
      workspaceId: foreign,
      expectedUpdatedAt: state.workspaces.find((item) => item.id === foreign)!.automation!.updatedAt,
      definition: definition as never,
    };
    await expect(api.update(grant, updated, () => {})).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      api.setEnabled(
        grant,
        { workspaceId: foreign, expectedUpdatedAt: updated.expectedUpdatedAt, enabled: false },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(update).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    await expect(
      api.update(grant, { ...updated, workspaceId: own }, () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    await expect(api.runNow(scope, { workspaceId: foreign, idempotencyKey: "key-1234" })).rejects.toMatchObject({
      code: "scope_denied",
    });
    await expect(api.stopRun(scope, { workspaceId: foreign, runId: "run" })).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(runNow).not.toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
    expect(await api.runNow(scope, { workspaceId: own, idempotencyKey: "key-1234" })).toEqual({ runId: "run" });
    expect(await api.stopRun(scope, { workspaceId: own, runId: "run" })).toEqual({ stopRequested: true });
    state.workspaces[0]!.internalMcpEnabled = false;
    await expect(api.list(scope)).rejects.toMatchObject({ code: "scope_denied" });
  });
});
