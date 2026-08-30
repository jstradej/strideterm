import { describe, expect, test } from "vitest";
import {
  collectRunningAgents,
  collectSupervisedAgents,
  formatRunningAgentElapsed,
  getVisibleTabs,
  getWorkspacePanelByViewId,
  getWorkspaceTabs,
  resolveInputOriginWorkspaceId,
  runningAgentElapsedMs,
  summarizeAttention,
  tabSessionId,
} from "./selectors.js";
import { TASK_ACTIVE_STATES } from "../../electron/shared/task-states.js";
import type { StatePayload, WorkspaceState } from "../../electron/shared/types/state.js";

describe("workspace selectors", () => {
  test("returns an Azure inbox tab for azure workspaces", () => {
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: {
          id: "azure-1",
          kind: "azure",
          panels: [],
        } as unknown as WorkspaceState,
        sessions: [],
      },
      payload: {
        azureDevops: {
          connections: [{ id: "ado-conn-1" }],
          inbox: {
            needsMyReview: [{ id: 1, connectionId: "ado-conn-1" }],
            needsAttention: [],
          },
        },
      } as unknown as StatePayload,
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });

    expect(tabs).toEqual([
      expect.objectContaining({
        id: "azure:azure-1",
        type: "azure",
        title: "Azure DevOps",
        status: "1 reviews waiting",
        tone: "running",
      }),
    ]);
  });

  test("returns a GitHub inbox tab for github workspaces", () => {
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: {
          id: "github-1",
          kind: "github",
          panels: [],
        } as unknown as WorkspaceState,
        sessions: [],
      },
      payload: {
        github: {
          connections: [{ id: "gh-conn-1" }],
          inbox: {
            needsMyReview: [
              { id: 1, connectionId: "gh-conn-1" },
              { id: 2, connectionId: "gh-conn-1" },
            ],
            needsAttention: [{ id: 2, connectionId: "gh-conn-1" }],
          },
        },
      } as unknown as StatePayload,
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });

    expect(tabs).toEqual([
      expect.objectContaining({
        id: "github:github-1",
        type: "github",
        title: "GitHub",
        status: "2 reviews waiting",
        tone: "error",
      }),
    ]);
  });

  test("prepends a review tab for Azure review workspaces", () => {
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: {
          id: "review-1",
          kind: "terminal",
          review: {
            provider: "azure-devops",
            pullRequest: {
              title: "Fix login redirect",
            },
          },
          panels: [{ id: "shell", title: "Shell", command: "" }],
        } as unknown as WorkspaceState,
        sessions: [
          {
            sessionId: "review-1:shell",
            panelId: "shell",
            title: "Shell",
            status: "running",
          },
        ],
      },
      payload: {
        git: { workspaces: {} },
      } as unknown as StatePayload,
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });

    expect(tabs[0]).toMatchObject({
      id: "review:review-1",
      type: "review",
    });
    expect(tabs[1]).toMatchObject({
      id: "review-1:shell",
      type: "terminal",
    });
  });

  test("ignores virtual review tabs when resolving workspace panels", () => {
    const result = getWorkspacePanelByViewId(
      "review:review-1",
      {
        workspace: {
          id: "review-1",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        } as unknown as WorkspaceState,
        sessions: [],
      },
      {
        isGitViewId: () => false,
        isDockerViewId: () => false,
        isAzureViewId: (value) => String(value).startsWith("azure:"),
        isGitHubViewId: (value) => String(value).startsWith("github:"),
        isReviewViewId: (value) => String(value).startsWith("review:"),
      },
    );

    expect(result).toBeNull();
  });

  test("renders Windows Copilot judge tabs as headless judge panes", () => {
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: {
          id: "task-1",
          kind: "task",
          task: {
            workerPanelId: "worker",
            judgePanelId: "judge",
          },
          panels: [
            { id: "dash", title: "Dashboard", command: "__task-dashboard__" },
            { id: "worker", title: "Worker", command: "claude" },
            { id: "judge", title: "Judge", command: "copilot --allow-all-tools --model gpt-5.4-mini" },
          ],
        } as unknown as WorkspaceState,
        sessions: [
          { sessionId: "task-1:worker", panelId: "worker", title: "Worker", status: "running" },
          { sessionId: "task-1:judge", panelId: "judge", title: "Judge", status: "running" },
        ],
      },
      payload: {
        taskRunner: {
          "task-1": {
            judgePanelId: "judge",
            judgeExecutionMode: "headless-copilot",
            judgeProgrammaticRunning: true,
            state: "judge-evaluating",
          },
        },
      } as unknown as StatePayload,
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });

    expect(tabs.find((tab) => tab.id === "task-1:judge")).toMatchObject({
      type: "headless-judge",
      status: "headless judge",
      tone: "running",
    });
  });
});

describe("getVisibleTabs", () => {
  // Reproduces the user's complaint: on a phone-width viewport the task agent's
  // 3-pane split (Dashboard + Worker + Judge) didn't fit, forcing them to
  // manually unsplit every time. The fix is a viewport-aware "force solo"
  // override that hides the split visually while preserving the underlying
  // splitGroup state, so resizing back to desktop re-shows the full layout.
  const tabs = [
    { id: "task-1:dash", title: "Dashboard", status: "", tone: "idle" },
    { id: "task-1:worker", title: "Worker", status: "", tone: "running" },
    { id: "task-1:judge", title: "Judge", status: "", tone: "running" },
    { id: "task-1:files", title: "Files", status: "", tone: "idle" },
  ] as Parameters<typeof getVisibleTabs>[0]["tabs"];
  const splitGroup = { layout: "top-split", viewIds: ["task-1:dash", "task-1:worker", "task-1:judge"] };
  const isInSplitGroup: Parameters<typeof getVisibleTabs>[0]["isInSplitGroup"] = (viewId, group) =>
    viewId ? group.viewIds.includes(viewId) : false;

  test("desktop: returns every tab in the split group when active view is part of it", () => {
    const result = getVisibleTabs({ tabs, activeViewId: "task-1:worker", splitGroup, isInSplitGroup });
    expect(result.visibleTabs.map((t) => t.id)).toEqual(["task-1:dash", "task-1:worker", "task-1:judge"]);
    expect(result.splitGroup).not.toBeNull();
  });

  test("forceSoloLayout: returns only the active tab when the viewport asks for solo even though splitGroup is set", () => {
    const result = getVisibleTabs({
      tabs,
      activeViewId: "task-1:worker",
      splitGroup,
      isInSplitGroup,
      forceSoloLayout: true,
    });
    expect(result.visibleTabs.map((t) => t.id)).toEqual(["task-1:worker"]);
  });

  test("forceSoloLayout preserves the underlying splitGroup so resizing back restores the layout", () => {
    const result = getVisibleTabs({
      tabs,
      activeViewId: "task-1:worker",
      splitGroup,
      isInSplitGroup,
      forceSoloLayout: true,
    });
    // The returned splitGroup is preserved so the store does not have to
    // re-create it when the viewport widens again.
    expect(result.splitGroup).toEqual(splitGroup);
  });

  test("forceSoloLayout falls back to the first tab when activeViewId is invalid", () => {
    const result = getVisibleTabs({
      tabs,
      activeViewId: null,
      splitGroup,
      isInSplitGroup,
      forceSoloLayout: true,
    });
    expect(result.visibleTabs.map((t) => t.id)).toEqual(["task-1:dash"]);
  });

  test("forceSoloLayout=false (default) leaves desktop split rendering unchanged", () => {
    const result = getVisibleTabs({
      tabs,
      activeViewId: "task-1:worker",
      splitGroup,
      isInSplitGroup,
      forceSoloLayout: false,
    });
    expect(result.visibleTabs.map((t) => t.id)).toEqual(["task-1:dash", "task-1:worker", "task-1:judge"]);
  });
});

describe("summarizeAttention", () => {
  function makePayload(): StatePayload {
    return {
      appState: {
        workspaces: [
          { id: "ws-default", profileId: "default" },
          { id: "ws-b", profileId: "profile-b" },
        ],
      },
      attention: {
        byWorkspace: {
          "ws-default": {
            alerts: [{ kind: "completed", at: "2024-01-01T00:00:00Z" }],
          },
          "ws-b": {
            alerts: [
              { kind: "waiting", at: "2024-01-01T00:01:00Z" },
              { kind: "completed", at: "2024-01-01T00:02:00Z" },
            ],
          },
        },
      },
    } as unknown as StatePayload;
  }

  test("counts all alerts when no profileId is provided (backwards compat)", () => {
    const result = summarizeAttention(makePayload());
    expect(result.count).toBe(3);
    expect(result.waitingCount).toBe(1);
  });

  test("counts only alerts whose workspace lives in the given profile", () => {
    // The fix: a window in profile-b sees only its own profile's alerts in
    // the in-app badge / document title — not the global count that
    // includes profile-default's noise.
    const result = summarizeAttention(makePayload(), "profile-b");
    expect(result.count).toBe(2);
    expect(result.waitingCount).toBe(1);
  });

  test("returns zero when the profileId has no alerts", () => {
    const result = summarizeAttention(makePayload(), "profile-c");
    expect(result.count).toBe(0);
    expect(result.waitingCount).toBe(0);
  });
});

describe("Companion Primary relocation projection", () => {
  const SOURCE = {
    id: "ws-source",
    name: "Live conversation",
    kind: "terminal",
    profileId: "default",
    panels: [
      { id: "panel-primary", title: "Claude", command: "claude" },
      { id: "panel-other", title: "Shell", command: "bash" },
    ],
  };

  function taskWorkspace(state: string) {
    return {
      id: "ws-task",
      name: "Reviewer: Live conversation",
      kind: "task",
      profileId: "default",
      panels: [
        { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
        { id: "panel-judge", title: "Reviewer", command: "codex" },
      ],
      task: {
        mode: "attached",
        state,
        workerWorkspaceId: "ws-source",
        workerPanelId: "panel-primary",
        companionRole: "reviewer",
      },
    };
  }

  function payloadFor(state: string, extra: Record<string, unknown> = {}): StatePayload {
    return {
      appState: { workspaces: [SOURCE, taskWorkspace(state)] },
      ...extra,
    } as unknown as StatePayload;
  }

  function sourceTabs(state: string, extra: Record<string, unknown> = {}) {
    return getWorkspaceTabs({
      workspace: {
        workspace: SOURCE as unknown as WorkspaceState,
        sessions: [
          { sessionId: "ws-source:panel-primary", panelId: "panel-primary", title: "Claude", status: "running" },
          { sessionId: "ws-source:panel-other", panelId: "panel-other", title: "Shell", status: "running" },
        ],
      },
      payload: payloadFor(state, extra),
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });
  }

  function taskTabs(state: string, extra: Record<string, unknown> = {}) {
    return getWorkspaceTabs({
      workspace: {
        workspace: taskWorkspace(state) as unknown as WorkspaceState,
        sessions: [{ sessionId: "ws-task:panel-judge", panelId: "panel-judge", title: "Reviewer", status: "running" }],
      },
      payload: payloadFor(state, extra),
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });
  }

  test("hides the source tab and shows Dashboard / Primary / Companion in the task workspace", () => {
    expect(sourceTabs("running").map((t) => t.id)).toEqual(["ws-source:panel-other"]);
    expect(taskTabs("running").map((t) => t.title)).toEqual(["Dashboard", "Primary", "Reviewer"]);
  });

  test("the alias carries a different view id and the real session id", () => {
    const alias = taskTabs("running").find((t) => t.title === "Primary")!;
    expect(alias.id).toBe("attached-primary:ws-task");
    expect(alias.sessionId).toBe("ws-source:panel-primary");
    expect(alias.ownerWorkspaceId).toBe("ws-source");
    expect(alias.borrowed).toBe(true);
    expect(alias.type).toBe("terminal");
    // Hosted only — never closable, never draggable, never editable here.
    expect(alias.closable).toBe(false);
    expect(alias.persistent).toBe(false);
  });

  test("the alias status chip follows the source session's live activity", () => {
    const attention = { attention: { sessions: { "ws-source:panel-primary": { activity: "running" } } } };
    expect(taskTabs("running", attention).find((t) => t.title === "Primary")!.status).toBe("running");
    const done = { attention: { sessions: { "ws-source:panel-primary": { activity: "done", lastExitCode: 1 } } } };
    expect(taskTabs("running", done).find((t) => t.title === "Primary")!.status).toBe("✗ exit 1");
  });

  test("terminal states return the tab: no alias, source tab back in place", () => {
    for (const state of ["completed", "failed"]) {
      expect(sourceTabs(state).map((t) => t.id)).toEqual(["ws-source:panel-primary", "ws-source:panel-other"]);
      expect(taskTabs(state).map((t) => t.title)).toEqual(["Dashboard", "Reviewer"]);
    }
  });

  test("every non-terminal state keeps the tab hosted", () => {
    for (const state of ["idle", "capturing-context", "brief-ready", "awaiting-user", "paused", "judge-evaluating"]) {
      expect(sourceTabs(state).map((t) => t.id)).toEqual(["ws-source:panel-other"]);
      expect(taskTabs(state).map((t) => t.title)).toEqual(["Dashboard", "Primary", "Reviewer"]);
    }
  });

  test("primaryMissing never creates an alias", () => {
    const workspaces = [
      SOURCE,
      { ...taskWorkspace("running"), task: { ...taskWorkspace("running").task, primaryMissing: true } },
    ];
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: taskWorkspace("running") as unknown as WorkspaceState,
        sessions: [{ sessionId: "ws-task:panel-judge", panelId: "panel-judge", title: "Reviewer", status: "running" }],
      },
      payload: { appState: { workspaces } } as unknown as StatePayload,
      hiddenViewIds: new Set(),
      isContainerRunning: () => false,
    });
    expect(tabs.map((t) => t.title)).toEqual(["Dashboard", "Reviewer"]);
  });

  test("ordinary terminal tabs keep sessionId === id", () => {
    for (const tab of sourceTabs("completed")) {
      expect(tabSessionId(tab)).toBe(tab.id);
      expect(tab.borrowed).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// collectRunningAgents — the shared running-agent row model
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function ws(overrides: AnyRecord): WorkspaceState {
  return {
    id: "ws",
    name: "Workspace",
    kind: "terminal",
    cwd: "/tmp",
    panels: [],
    profileId: "default",
    ...overrides,
  } as unknown as WorkspaceState;
}

/** A standard (worker + judge) task workspace. `taskOverrides` patches timing. */
function standardTask(state: string, taskOverrides: AnyRecord = {}): WorkspaceState {
  return ws({
    id: "task-1",
    name: "Task One",
    kind: "task",
    panels: [
      { id: "worker", title: "Worker Claude" },
      { id: "judge", title: "Judge Codex" },
    ],
    task: {
      taskId: "t1",
      state,
      workerPanelId: "worker",
      judgePanelId: "judge",
      parentWorkspaceId: "parent-1",
      startedAt: 1_000_000,
      totalPausedMs: 0,
      pausedAt: null,
      finishedAt: null,
      ...taskOverrides,
    },
  });
}

/** An attached (Companion loop) task plus the source workspace it borrows. */
function attachedPair(state: string): WorkspaceState[] {
  return [
    ws({
      id: "src-1",
      name: "Source",
      panels: [{ id: "primary", title: "Primary Claude" }],
    }),
    ws({
      id: "task-att",
      name: "Companion",
      kind: "task",
      panels: [
        { id: "worker", title: "unused" },
        { id: "judge", title: "Companion" },
      ],
      task: {
        taskId: "t-att",
        state,
        mode: "attached",
        workerWorkspaceId: "src-1",
        workerPanelId: "primary",
        judgePanelId: "judge",
        companionRole: "reviewer",
        startedAt: 2_000_000,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
      },
    }),
  ];
}

function agentSession(overrides: AnyRecord = {}): AnyRecord {
  return {
    workspaceId: "ws-a",
    panelId: "claude",
    activity: "running",
    agentLike: true,
    hasUserInput: true,
    activityStartedAt: 5_000_000,
    ...overrides,
  };
}

describe("collectRunningAgents — which states count", () => {
  test("every state in TASK_ACTIVE_STATES yields exactly one row", () => {
    for (const state of TASK_ACTIVE_STATES) {
      const rows = collectRunningAgents({ workspaces: [standardTask(state)] });
      expect(
        rows.map((r) => r.state),
        `state ${state}`,
      ).toEqual([state]);
      expect(rows[0].source).toBe("task");
    }
  });

  test("no other task state produces a row — showering and capturing-context's neighbours included", () => {
    const inactive = [
      "idle",
      "paused",
      "done",
      "completed",
      "failed",
      "stopped",
      "brief-ready",
      "awaiting-user",
      "showering",
    ];
    for (const state of inactive) {
      expect(collectRunningAgents({ workspaces: [standardTask(state)] }), `state ${state}`).toEqual([]);
    }
  });

  test("the live runner snapshot wins over the persisted task state", () => {
    const workspaces = [standardTask("idle")];
    expect(collectRunningAgents({ workspaces })).toEqual([]);
    expect(
      collectRunningAgents({ workspaces, taskRunnerSnapshot: { "task-1": { state: "running" } } }).map((r) => r.state),
    ).toEqual(["running"]);
  });
});

describe("collectRunningAgents — identity and navigation target", () => {
  test("a standard task is one row keyed and targeted by the worker panel's session id", () => {
    const rows = collectRunningAgents({ workspaces: [standardTask("running")] });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("task-1:worker");
    expect(rows[0].viewId).toBe("task-1:worker");
    expect(rows[0].hostWorkspaceId).toBe("task-1");
    expect(rows[0].label).toBe("Worker Claude");
  });

  test("judge-evaluating stays one row — the judge session never adds a second", () => {
    const rows = collectRunningAgents({
      workspaces: [standardTask("judge-evaluating")],
      sessionActivities: {
        "task-1:judge": agentSession({ workspaceId: "task-1", panelId: "judge" }),
        "task-1:worker": agentSession({ workspaceId: "task-1", panelId: "worker" }),
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("task-1:worker");
    expect(rows[0].state).toBe("judge-evaluating");
  });

  test("an attached task in capturing-context is one row hosted by the TASK workspace", () => {
    const rows = collectRunningAgents({
      workspaces: attachedPair("capturing-context"),
      // The same session, also visible as a plain running agent session in the
      // SOURCE workspace — it must not be counted twice.
      sessionActivities: { "src-1:primary": agentSession({ workspaceId: "src-1", panelId: "primary" }) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("src-1:primary");
    expect(rows[0].hostWorkspaceId).toBe("task-att");
    expect(rows[0].viewId).toBe("attached-primary:task-att");
    expect(rows[0].workspaceName).toBe("Companion");
    expect(rows[0].source).toBe("task");
  });

  test("an attached task in running behaves identically", () => {
    const rows = collectRunningAgents({
      workspaces: attachedPair("running"),
      sessionActivities: { "src-1:primary": agentSession({ workspaceId: "src-1", panelId: "primary" }) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].hostWorkspaceId).toBe("task-att");
    expect(rows[0].viewId).toBe("attached-primary:task-att");
  });

  test("two parallel plain agent sessions in one workspace are two rows", () => {
    const rows = collectRunningAgents({
      workspaces: [ws({ id: "ws-a", name: "Alpha", panels: [{ id: "claude" }, { id: "codex" }] })],
      sessionActivities: {
        "ws-a:claude": agentSession({ panelId: "claude" }),
        "ws-a:codex": agentSession({ panelId: "codex", activityStartedAt: 5_500_000 }),
      },
    });
    expect(rows.map((r) => r.key).sort()).toEqual(["ws-a:claude", "ws-a:codex"]);
  });

  test("a session without user input, a finished session and a non-agent session are all ignored", () => {
    const rows = collectRunningAgents({
      workspaces: [ws({ id: "ws-a", name: "Alpha" })],
      sessionActivities: {
        "ws-a:no-input": agentSession({ panelId: "no-input", hasUserInput: false }),
        "ws-a:finished": agentSession({ panelId: "finished", activity: "done" }),
        "ws-a:shell": agentSession({ panelId: "shell", agentLike: false }),
      },
    });
    expect(rows).toEqual([]);
  });

  test("the criterion is kind-agnostic: review and quickfix worktrees count, another profile does not", () => {
    const rows = collectRunningAgents({
      // `workspaces` arrives already profile-scoped, so a foreign-profile
      // workspace simply is not in the list — and its session drops out.
      workspaces: [
        ws({
          id: "rev-1",
          name: "Review",
          review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "parent-1" },
        }),
        ws({ id: "qf-1", name: "Quickfix", quickfix: { parentWorkspaceId: "parent-1" } }),
      ],
      sessionActivities: {
        "rev-1:claude": agentSession({ workspaceId: "rev-1" }),
        "qf-1:claude": agentSession({ workspaceId: "qf-1" }),
        "other-profile-ws:claude": agentSession({ workspaceId: "other-profile-ws" }),
      },
    });
    expect(rows.map((r) => r.hostWorkspaceId).sort()).toEqual(["qf-1", "rev-1"]);
  });

  test("ancestry names the parent chain the sidebar would draw", () => {
    const rows = collectRunningAgents({
      workspaces: [
        ws({ id: "root", name: "Root" }),
        ws({ id: "mid", name: "Mid", quickfix: { parentWorkspaceId: "root" } }),
        ws({ id: "leaf", name: "Leaf", review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "mid" } }),
      ],
      sessionActivities: { "leaf:claude": agentSession({ workspaceId: "leaf" }) },
    });
    expect(rows[0].ancestry).toEqual(["Root", "Mid"]);
    expect(rows[0].workspaceName).toBe("Leaf");
  });

  // V5 review, §3 — the row carries STRUCTURED ancestry and its workspace's own
  // identity, so the RUNNING surface can draw the hierarchy the way the recent
  // shortcuts and ALL WORKSPACES do instead of gluing names into one line.
  test("carries structured ancestor identity and the host workspace's own icon and accent", () => {
    const rows = collectRunningAgents({
      workspaces: [
        ws({ id: "root", name: "Root", icon: "R", color: "#112233", kind: "azure" }),
        ws({ id: "mid", name: "Mid", icon: "M", color: "#223344", quickfix: { parentWorkspaceId: "root" } }),
        ws({
          id: "leaf",
          name: "Leaf",
          icon: "L",
          color: "#334455",
          review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "mid" },
        }),
      ],
      sessionActivities: { "leaf:claude": agentSession({ workspaceId: "leaf" }) },
    });

    expect(rows[0].workspaceIcon).toBe("L");
    expect(rows[0].workspaceColor).toBe("#334455");
    expect(rows[0].ancestors).toEqual([
      { id: "root", name: "Root", icon: "R", color: "#112233", kind: "azure" },
      { id: "mid", name: "Mid", icon: "M", color: "#223344", kind: "terminal" },
    ]);
    // The flat form the chip and the Agents tab render is derived from it, so
    // the two can never disagree about the chain.
    expect(rows[0].ancestry).toEqual(rows[0].ancestors.map((a) => a.name));
  });

  test("structured ancestry uses the one shared tree index: cycle-safe, profile-scoped", () => {
    const cyclic = collectRunningAgents({
      workspaces: [
        ws({ id: "a", name: "A", quickfix: { parentWorkspaceId: "b" } }),
        ws({ id: "b", name: "B", quickfix: { parentWorkspaceId: "a" } }),
      ],
      sessionActivities: { "a:claude": agentSession({ workspaceId: "a" }) },
    });
    expect(cyclic[0].ancestors).toEqual([]);

    const foreign = collectRunningAgents({
      workspaces: [
        ws({ id: "secret", name: "Secret", profileId: "p2" }),
        ws({ id: "mine", name: "Mine", quickfix: { parentWorkspaceId: "secret" } }),
      ],
      sessionActivities: { "mine:claude": agentSession({ workspaceId: "mine" }) },
    });
    expect(foreign[0].ancestors).toEqual([]);
  });
});

describe("collectRunningAgents — the time contract", () => {
  const DASHBOARD_NOW = 10_000_000;

  /** TaskDashboardPane.vue's updateElapsed, verbatim. */
  function dashboardElapsed(ts: { startedAt: number; totalPausedMs?: number; pausedAt?: number; finishedAt?: number }) {
    const paused = ts.totalPausedMs || 0;
    if (ts.finishedAt) return ts.finishedAt - ts.startedAt - paused;
    if (ts.pausedAt) return ts.pausedAt - ts.startedAt - paused;
    return DASHBOARD_NOW - ts.startedAt - paused;
  }

  test("a paused-and-resumed task subtracts totalPausedMs and matches the Dashboard", () => {
    const timing = { startedAt: 1_000_000, totalPausedMs: 250_000, pausedAt: null, finishedAt: null };
    const rows = collectRunningAgents({ workspaces: [standardTask("running", timing)] });
    expect(rows[0].totalPausedMs).toBe(250_000);
    expect(runningAgentElapsedMs(rows[0], DASHBOARD_NOW)).toBe(
      dashboardElapsed({ startedAt: 1_000_000, totalPausedMs: 250_000 }),
    );
  });

  test("the pausedAt and finishedAt branches match the Dashboard too", () => {
    const paused = { startedAt: 1_000_000, totalPausedMs: 10_000, pausedAt: 4_000_000, finishedAt: null };
    const pausedRow = collectRunningAgents({ workspaces: [standardTask("running", paused)] })[0];
    expect(runningAgentElapsedMs(pausedRow, DASHBOARD_NOW)).toBe(
      dashboardElapsed({ startedAt: 1_000_000, totalPausedMs: 10_000, pausedAt: 4_000_000 }),
    );

    const finished = { startedAt: 1_000_000, totalPausedMs: 10_000, pausedAt: 4_000_000, finishedAt: 6_000_000 };
    const finishedRow = collectRunningAgents({ workspaces: [standardTask("running", finished)] })[0];
    expect(runningAgentElapsedMs(finishedRow, DASHBOARD_NOW)).toBe(
      dashboardElapsed({ startedAt: 1_000_000, totalPausedMs: 10_000, pausedAt: 4_000_000, finishedAt: 6_000_000 }),
    );
  });

  test("a timestamp the runner cast to string normalises back to a number", () => {
    const asString = {
      startedAt: String(1_000_000),
      totalPausedMs: 0,
      pausedAt: null,
      finishedAt: null,
    } as unknown as AnyRecord;
    const rows = collectRunningAgents({ workspaces: [standardTask("running", asString)] });
    expect(rows[0].startedAtMs).toBe(1_000_000);
    expect(Number.isNaN(rows[0].startedAtMs)).toBe(false);
  });

  test("a plain session takes its start from activityStartedAt and zeroes the rest", () => {
    const rows = collectRunningAgents({
      workspaces: [ws({ id: "ws-a", name: "Alpha" })],
      sessionActivities: { "ws-a:claude": agentSession({ activityStartedAt: 7_000_000 }) },
    });
    expect(rows[0]).toMatchObject({ startedAtMs: 7_000_000, pausedAtMs: 0, finishedAtMs: 0, totalPausedMs: 0 });
    expect(runningAgentElapsedMs(rows[0], DASHBOARD_NOW)).toBe(DASHBOARD_NOW - 7_000_000);
  });
});

describe("collectRunningAgents — viewer-owned grid", () => {
  test("membership and the 1-based slot come from hostWorkspaceId, skipping empty slots", () => {
    const rows = collectRunningAgents({
      workspaces: [ws({ id: "ws-a", name: "Alpha" })],
      sessionActivities: { "ws-a:claude": agentSession() },
      workspaceGrid: { layout: "grid", cellWorkspaceIds: [null, "ws-a", null, null] },
    });
    expect(rows[0].inGrid).toBe(true);
    expect(rows[0].gridSlotIndex).toBe(2);
  });

  test("an attached task is matched against the TASK workspace, not the source", () => {
    const inTask = collectRunningAgents({
      workspaces: attachedPair("running"),
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["task-att", null] },
    });
    expect(inTask[0]).toMatchObject({ inGrid: true, gridSlotIndex: 1 });

    const inSource = collectRunningAgents({
      workspaces: attachedPair("running"),
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["src-1", null] },
    });
    expect(inSource[0].inGrid).toBe(false);
    expect(inSource[0].gridSlotIndex).toBeUndefined();
  });

  test("no grid means no membership and no slot", () => {
    const rows = collectRunningAgents({
      workspaces: [ws({ id: "ws-a", name: "Alpha" })],
      sessionActivities: { "ws-a:claude": agentSession() },
      workspaceGrid: null,
    });
    expect(rows[0].inGrid).toBe(false);
    expect(rows[0].gridSlotIndex).toBeUndefined();
  });

  test("two viewers with different grids get different slots over the same rest of the input", () => {
    const shared = {
      workspaces: [ws({ id: "ws-a", name: "Alpha" })],
      sessionActivities: { "ws-a:claude": agentSession() },
    };
    const viewerOne = collectRunningAgents({
      ...shared,
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-a", null] },
    });
    const viewerTwo = collectRunningAgents({
      ...shared,
      workspaceGrid: { layout: "grid", cellWorkspaceIds: [null, null, "ws-a", null] },
    });
    expect(viewerOne[0].gridSlotIndex).toBe(1);
    expect(viewerTwo[0].gridSlotIndex).toBe(3);
    expect(viewerOne[0].key).toBe(viewerTwo[0].key);
  });
});

describe("formatRunningAgentElapsed", () => {
  test("renders at minute granularity, which is what the shared clock ticks at", () => {
    expect(formatRunningAgentElapsed(0)).toBe("<1m");
    expect(formatRunningAgentElapsed(30_000)).toBe("<1m");
    expect(formatRunningAgentElapsed(5 * 60_000)).toBe("5m");
    expect(formatRunningAgentElapsed(10 * 60 * 60_000 + 7 * 60_000)).toBe("10h 07m");
  });
});

// V2 plan, Fáze 3 — an attached task presents the SOURCE workspace's Primary
// tab inside the TASK workspace, so typing there is work done in the task
// workspace. The renderer declares that origin on every terminal write; the
// backend validates it before stamping `lastWorkedAt`.
describe("resolveInputOriginWorkspaceId", () => {
  const SOURCE = {
    id: "ws-source",
    name: "Source",
    profileId: "default",
    panels: [{ id: "claude", title: "claude" }],
  };

  function attachedTask(state: string) {
    return {
      id: "ws-task",
      name: "Reviewer loop",
      kind: "task",
      profileId: "default",
      panels: [{ id: "panel-judge", title: "Companion" }],
      task: {
        mode: "attached",
        state,
        workerWorkspaceId: "ws-source",
        workerPanelId: "claude",
        judgePanelId: "panel-judge",
        companionRole: "reviewer",
      },
    };
  }

  test("credits the task workspace while its Primary is hosted there", () => {
    expect(resolveInputOriginWorkspaceId([SOURCE, attachedTask("running")], null, "ws-source:claude")).toBe("ws-task");
  });

  test("credits the source workspace once the Primary has gone home", () => {
    // `completed` is a RETURN state — the tab is back in its own workspace.
    expect(resolveInputOriginWorkspaceId([SOURCE, attachedTask("completed")], null, "ws-source:claude")).toBe(
      "ws-source",
    );
  });

  test("the live runner state wins over the persisted task state", () => {
    const workspaces = [SOURCE, attachedTask("completed")];
    expect(resolveInputOriginWorkspaceId(workspaces, { "ws-task": { state: "running" } }, "ws-source:claude")).toBe(
      "ws-task",
    );
  });

  test("an ordinary session credits its own workspace", () => {
    expect(resolveInputOriginWorkspaceId([SOURCE], null, "ws-source:claude")).toBe("ws-source");
  });

  test("a panel that is not the attached Primary credits its own workspace", () => {
    const workspaces = [
      {
        ...SOURCE,
        panels: [
          { id: "claude", title: "claude" },
          { id: "shell", title: "Shell" },
        ],
      },
      attachedTask("running"),
    ];
    expect(resolveInputOriginWorkspaceId(workspaces, null, "ws-source:shell")).toBe("ws-source");
  });

  test("a malformed session id resolves to nothing rather than guessing", () => {
    expect(resolveInputOriginWorkspaceId([SOURCE], null, "")).toBe("");
    expect(resolveInputOriginWorkspaceId([SOURCE], null, "no-separator")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collectSupervisedAgents — the task-only definition every RUNNING surface uses
//
// V3 review, Fáze 1. The sidebar section, the hero chip and the dock's Agents
// tab (list AND count) all read this one projection, so they cannot disagree,
// and a plain agent-like terminal session no longer makes rows appear and
// vanish under the pointer.
// ---------------------------------------------------------------------------

describe("collectSupervisedAgents — RUNNING membership", () => {
  test("a standard task in every active state yields exactly one row", () => {
    for (const state of TASK_ACTIVE_STATES) {
      const rows = collectSupervisedAgents({ workspaces: [standardTask(state)] });
      expect(rows.map((row) => ({ key: row.key, host: row.hostWorkspaceId, state: row.state }))).toEqual([
        { key: "task-1:worker", host: "task-1", state },
      ]);
    }
  });

  test("an attached/Companion task is one row hosted in the TASK workspace", () => {
    const rows = collectSupervisedAgents({ workspaces: attachedPair("running") });

    expect(rows).toHaveLength(1);
    expect(rows[0].hostWorkspaceId).toBe("task-att");
    expect(rows[0].key).toBe("src-1:primary");
    expect(rows[0].source).toBe("task");
  });

  test("an attached task does not double when its borrowed session is also live", () => {
    const rows = collectSupervisedAgents({
      workspaces: attachedPair("running"),
      taskRunnerSnapshot: { "task-att": { state: "running" } },
    });

    expect(rows).toHaveLength(1);
  });

  test("a worker → judge transition keeps the same key and the same position", () => {
    const workspaces = [standardTask("running"), ws({ id: "task-2", name: "Other" })];
    const before = collectSupervisedAgents({
      workspaces,
      taskRunnerSnapshot: { "task-1": { state: "running", startedAt: 1_000_000 } },
    });
    const after = collectSupervisedAgents({
      workspaces,
      taskRunnerSnapshot: { "task-1": { state: "judge-evaluating", startedAt: 1_000_000 } },
    });

    expect(before.map((row) => row.key)).toEqual(after.map((row) => row.key));
    expect(after[0].key).toBe("task-1:worker");
    expect(after[0].state).toBe("judge-evaluating");
  });

  test("a plain agentLike session with no task is not a RUNNING row and does not bump the count", () => {
    const workspaces = [ws({ id: "ws-a", name: "Alpha", panels: [{ id: "claude", title: "Claude" }] })];
    const sessionActivities = { "ws-a:claude": agentSession() };

    // The shared full model still sees it…
    expect(collectRunningAgents({ workspaces, sessionActivities })).toHaveLength(1);
    // …the supervised projection does not.
    expect(collectSupervisedAgents({ workspaces })).toEqual([]);
  });

  test("a plain session running INSIDE a task workspace does not add a second row", () => {
    const rows = collectSupervisedAgents({
      workspaces: [standardTask("running")],
      taskRunnerSnapshot: { "task-1": { state: "running" } },
    });

    expect(rows).toHaveLength(1);
  });

  test("paused, completed and failed tasks are not in RUNNING", () => {
    for (const state of ["paused", "completed", "failed", "stopped", "idle"]) {
      expect(collectSupervisedAgents({ workspaces: [standardTask(state)] })).toEqual([]);
    }
  });

  test("the grid slot number still comes from the caller's own grid", () => {
    const rows = collectSupervisedAgents({
      workspaces: [standardTask("running")],
      workspaceGrid: { layout: "cols", cellWorkspaceIds: [null, "task-1"] } as never,
    });

    expect(rows[0].inGrid).toBe(true);
    expect(rows[0].gridSlotIndex).toBe(2);
  });
});
