import { describe, expect, test } from "vitest";
import { buildWorkspaceCards } from "./workspace-render.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";

describe("buildWorkspaceCards", () => {
  test("marks managed Azure review workspaces as child cards", () => {
    const [azureCard, reviewCard] = buildWorkspaceCards({
      workspaces: [
        {
          id: "azure-root",
          name: "Azure DevOps",
          kind: "azure",
          color: "#0078d4",
          icon: "AZ",
          cwd: "C:/reviews",
          panels: [{ id: "shell", title: "", command: "" }],
        } as unknown as WorkspaceState,
        {
          id: "review-1",
          name: "web-app PR #123",
          kind: "terminal",
          color: "#0078d4",
          icon: "AZ",
          panels: [{ id: "shell", title: "", command: "" }],
          review: {
            provider: "azure-devops",
            checkout: { mode: "managed-worktree", rootPath: "", cacheRepoPath: "" },
          },
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "azure-root",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(azureCard.summary).toContain("C:/reviews");
    expect(reviewCard.depth).toBe(1);
  });

  test("appends '#N' to a task workspace's display name and renders a relative-age chip", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-task",
          name: "mhub",
          kind: "task",
          color: "#7C4DFF",
          icon: "🤖",
          panels: [],
          task: {
            sequenceNumber: 3,
            createdAt: fiveMinutesAgo,
            description: "Fix the flaky watcher test in syncTreeDirWatchers — it times out on Windows.",
          },
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-task",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(card.name).toBe("mhub #3");
    expect(card.relativeAge).toBe("5m");
    // Description goes into the native title tooltip — confirm it lands there
    // so two agents on the same parent can be disambiguated on hover.
    expect(String(card.title)).toContain("Fix the flaky watcher test");
  });

  test("surfaces last activity from PR lastActivityAt and attention latestAt (most recent wins)", () => {
    const prActivity = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4d ago
    const alertActivity = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const [prCard, attentionCard] = buildWorkspaceCards({
      workspaces: [
        {
          id: "review-pr",
          name: "web-app PR #123",
          kind: "terminal",
          color: "#0078d4",
          icon: "AZ",
          panels: [{ id: "shell", title: "", command: "" }],
          review: {
            provider: "azure-devops",
            prKey: "pr-1",
            checkout: { mode: "managed-worktree", rootPath: "", cacheRepoPath: "" },
          },
        } as unknown as WorkspaceState,
        {
          id: "plain",
          name: "scratch",
          kind: "terminal",
          color: "#888",
          icon: "▶",
          panels: [{ id: "shell", title: "", command: "" }],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "review-pr",
      getGitSnapshot: () => null,
      // Review child also has a (stale) alert — the more recent PR activity must win.
      getWorkspaceAttention: (id) =>
        id === "plain"
          ? { count: 0, latestAt: alertActivity }
          : { count: 0, latestAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      getPrStatus: () => ({ status: "active", lastActivityAt: prActivity }),
    });

    expect(prCard.lastActivity).toBe("4d");
    expect(String(prCard.title)).toContain("Last activity:");
    // A workspace with no PR falls back to its session alert timestamp.
    expect(attentionCard.lastActivity).toBe("2h");
  });

  test("renders a task workspace without sequenceNumber / createdAt cleanly (backwards compat)", () => {
    // Tasks created before this feature have neither field; the card should
    // fall back to the plain name and produce no age chip rather than NaN /
    // 'Invalid Date'.
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-legacy-task",
          name: "legacy",
          kind: "task",
          color: "#7C4DFF",
          icon: "🤖",
          panels: [],
          task: { description: "" },
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-legacy-task",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(card.name).toBe("legacy");
    expect(card.relativeAge).toBe("");
  });

  test("builds docker workspace card with Docker summary", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "d1",
          name: "Docker",
          kind: "docker",
          color: "#0db7ed",
          icon: "D",
          panels: [],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "d1",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(card.summary).toBe("Docker");
    expect(card.active).toBe(true);
  });

  test("surfaces running agent activity for non-task workspaces", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-agent",
          name: "admin-cli",
          kind: "manual",
          color: "#f0a020",
          icon: "PR",
          panels: [{ id: "codex", title: "Codex", command: "codex" }],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-agent",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
      sessionActivities: {
        "ws-agent:codex": {
          workspaceId: "ws-agent",
          panelId: "codex",
          activity: "running",
          agentLike: true,
          hasUserInput: true,
        },
      },
    });

    expect(card.agentActivityState).toBe("running");
    expect(card.agentActivityLabel).toBe("Codex is working");
  });

  test("surfaces just-finished agent activity for non-task workspaces", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-agent",
          name: "admin-cli",
          kind: "manual",
          color: "#f0a020",
          icon: "PR",
          panels: [{ id: "codex", title: "Codex", command: "codex" }],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-agent",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
      sessionActivities: {
        "ws-agent:codex": {
          workspaceId: "ws-agent",
          panelId: "codex",
          activity: "done",
          agentLike: true,
          hasUserInput: true,
        },
      },
    });

    expect(card.agentActivityState).toBe("done");
    expect(card.agentActivityLabel).toBe("Codex finished");
  });

  test("aggregates multiple running agents in one workspace", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-agent",
          name: "admin-cli",
          kind: "manual",
          color: "#f0a020",
          icon: "PR",
          panels: [
            { id: "codex", title: "Codex", command: "codex" },
            { id: "claude", title: "Claude", command: "claude" },
            { id: "gemini", title: "Gemini", command: "gemini" },
          ],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-agent",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
      sessionActivities: {
        "ws-agent:codex": {
          workspaceId: "ws-agent",
          panelId: "codex",
          activity: "running",
          agentLike: true,
          hasUserInput: true,
        },
        "ws-agent:claude": {
          workspaceId: "ws-agent",
          panelId: "claude",
          activity: "running",
          agentLike: true,
          hasUserInput: true,
        },
        "ws-agent:gemini": {
          workspaceId: "ws-agent",
          panelId: "gemini",
          activity: "done",
          agentLike: true,
          hasUserInput: true,
          lastCommandFinishedAt: 2_000,
        },
      },
    });

    expect(card.agentActivityState).toBe("running");
    expect(card.agentActivityLabel).toBe("2 agents are working");
  });

  test("aggregates multiple finished agents in one workspace", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-agent",
          name: "admin-cli",
          kind: "manual",
          color: "#f0a020",
          icon: "PR",
          panels: [
            { id: "codex", title: "Codex", command: "codex" },
            { id: "claude", title: "Claude", command: "claude" },
          ],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-agent",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
      sessionActivities: {
        "ws-agent:codex": {
          workspaceId: "ws-agent",
          panelId: "codex",
          activity: "done",
          agentLike: true,
          hasUserInput: true,
          lastCommandFinishedAt: 1_000,
        },
        "ws-agent:claude": {
          workspaceId: "ws-agent",
          panelId: "claude",
          activity: "done",
          agentLike: true,
          hasUserInput: true,
          lastCommandFinishedAt: 2_000,
        },
      },
    });

    expect(card.agentActivityState).toBe("done");
    expect(card.agentActivityLabel).toBe("2 agents finished");
  });

  test("does not surface generic or passive session activity as agent work", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [
        {
          id: "ws-shell",
          name: "admin-cli",
          kind: "manual",
          color: "#f0a020",
          icon: "PR",
          panels: [{ id: "shell", title: "Shell", command: "pwsh" }],
        } as unknown as WorkspaceState,
      ],
      activeWorkspaceId: "ws-shell",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
      sessionActivities: {
        "ws-shell:shell": {
          workspaceId: "ws-shell",
          panelId: "shell",
          activity: "running",
          agentLike: false,
          hasUserInput: true,
        },
        "ws-shell:codex": {
          workspaceId: "ws-shell",
          panelId: "codex",
          activity: "running",
          agentLike: true,
          hasUserInput: false,
        },
      },
    });

    expect(card.agentActivityState).toBeNull();
    expect(card.agentActivityLabel).toBe("");
  });
});
