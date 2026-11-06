import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../shared/types/state.js";
import { createRuntimeAttentionManager } from "./runtime-attention.js";

function panel(id: string, startup = "auto", command = "claude") {
  return { id, title: id, command, startup };
}

function makeManager(initial: unknown, recovery: Set<string> = new Set()) {
  const holder = { state: initial as AppState };
  const ensureSession = vi.fn(async (_state: AppState, _sessionId: string) => null);
  const manager = createRuntimeAttentionManager({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    getState: () => holder.state,
    sessions: {
      ensureSession,
      resolveDefaultSessionId: (state: AppState, workspaceId: string) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        return ws?.activePanelId ? `${ws.id}:${ws.activePanelId}` : null;
      },
    },
    createSessionId: (w: string, p: string) => `${w}:${p}`,
    parseSessionId: (id: string) => {
      const [workspaceId, panelId] = id.split(":");
      return { workspaceId, panelId };
    },
    getNotificationConfig: () => ({}),
    createSessionSignal: (() => ({})) as never,
    adaptiveForget: vi.fn(),
    metricsRecordAlert: vi.fn(),
    APP_CONFIG: { runtime: { projectAlertLimit: 10 }, ui: { defaultPanelStartup: "auto" } },
    AGENT_NAME_RE: /x/,
    ATTENTION_VISIBILITY_GRACE_MS: 0,
    attentionContext: { visibleSessionIds: new Set(), recentlyVisibleUntil: new Map(), visibleByViewer: new Map() },
    broadcastState: vi.fn(),
    isKnownPluginProject: () => false,
    getRecoveryCandidateIds: () => recovery,
  });
  return { manager, holder, ensureSession };
}

function stateWith(panels: ReturnType<typeof panel>[], activePanelId: string, kind = "terminal") {
  return { workspaces: [{ id: "w", kind, panels, activePanelId }], activeWorkspaceId: "w" };
}

describe("ensureVisibleSession deferred spawning", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ensures the selected session synchronously and the rest one per timer turn", () => {
    const { manager, ensureSession } = makeManager(stateWith([panel("a"), panel("b"), panel("c")], "b"));
    expect(manager.ensureVisibleSession("w")).toBe("w:b");
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:b"]);
    vi.advanceTimersByTime(20);
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:b", "w:a"]);
    vi.advanceTimersByTime(20);
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:b", "w:a", "w:c"]);
  });

  it("does not double-queue a session on a repeated activation", () => {
    const { manager, ensureSession } = makeManager(stateWith([panel("a"), panel("b")], "a"));
    manager.ensureVisibleSession("w");
    manager.ensureVisibleSession("w");
    vi.runAllTimers();
    expect(ensureSession.mock.calls.filter((c) => c[1] === "w:b")).toHaveLength(1);
  });

  it("skips a panel removed before its turn", () => {
    const { manager, holder, ensureSession } = makeManager(stateWith([panel("a"), panel("b"), panel("c")], "a"));
    manager.ensureVisibleSession("w");
    holder.state = stateWith([panel("a"), panel("c")], "a") as unknown as AppState;
    vi.runAllTimers();
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:a", "w:c"]);
  });

  it("skips a workspace that became a recovery candidate", () => {
    const recovery = new Set<string>();
    const { manager, ensureSession } = makeManager(stateWith([panel("a"), panel("b")], "a"), recovery);
    manager.ensureVisibleSession("w");
    recovery.add("w");
    vi.runAllTimers();
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:a"]);
  });

  it("ignores manual and http panels and azure workspaces", () => {
    const a = makeManager(stateWith([panel("a"), panel("m", "manual"), panel("h", "auto", "https://x.test")], "a"));
    a.manager.ensureVisibleSession("w");
    vi.runAllTimers();
    expect(a.ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:a"]);
    const b = makeManager(stateWith([panel("a")], "a", "azure"));
    expect(b.manager.ensureVisibleSession("w")).toBeNull();
    vi.runAllTimers();
    expect(b.ensureSession).not.toHaveBeenCalled();
  });

  it("drops the queue and its timer on dispose", () => {
    const { manager, ensureSession } = makeManager(stateWith([panel("a"), panel("b")], "a"));
    manager.ensureVisibleSession("w");
    manager.disposeDeferredSpawns();
    vi.runAllTimers();
    expect(ensureSession.mock.calls.map((c) => c[1])).toEqual(["w:a"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
