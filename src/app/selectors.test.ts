import { describe, expect, test } from "vitest";
import {
  getVisibleTabs,
  getWorkspacePanelByViewId,
  getWorkspaceTabs,
  summarizeAttention,
  tabSessionId,
} from "./selectors.js";
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
