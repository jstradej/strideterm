import { describe, expect, test } from "vitest";
import { buildWorkspaceCards, buildTabStripModel } from "./workspace-render.js";

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
          panels: [{ id: "shell" }],
        },
        {
          id: "review-1",
          name: "web-app PR #123",
          kind: "terminal",
          color: "#0078d4",
          icon: "AZ",
          panels: [{ id: "shell" }],
          review: {
            provider: "azure-devops",
            checkout: { mode: "managed-worktree" },
          },
        },
      ],
      activeWorkspaceId: "azure-root",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(azureCard.summary).toContain("C:/reviews");
    expect(reviewCard.isWorktree).toBe(true);
  });

  test("builds docker workspace card with Docker summary", () => {
    const [card] = buildWorkspaceCards({
      workspaces: [{ id: "d1", name: "Docker", kind: "docker", color: "#0db7ed", icon: "D", panels: [] }],
      activeWorkspaceId: "d1",
      getGitSnapshot: () => null,
      getWorkspaceAttention: () => null,
    });

    expect(card.summary).toBe("Docker");
    expect(card.active).toBe(true);
  });
});

describe("buildTabStripModel", () => {
  test("marks active tab and grouped tab", () => {
    const model = buildTabStripModel({
      tabs: [
        { id: "t1", title: "Shell", status: "running", tone: "ok", persistent: true, closable: true },
        { id: "t2", title: "Log", status: "idle", tone: "ok", persistent: false, closable: true },
      ],
      activeViewId: "t1",
      isInSplitGroup: (id) => id === "t2",
      getTabAttention: () => null,
    });

    expect(model[0].active).toBe(true);
    expect(model[0].grouped).toBe(false);
    expect(model[0].persistent).toBe(true);
    expect(model[1].active).toBe(false);
    expect(model[1].grouped).toBe(true);
  });

  test("sets attention fields from tabAttention", () => {
    const now = new Date().toISOString();
    const [tab] = buildTabStripModel({
      tabs: [{ id: "t1", title: "Shell", status: "", tone: "ok" }],
      activeViewId: "",
      isInSplitGroup: () => false,
      getTabAttention: () => ({ count: 1, alerts: [{ title: "Build failed" }], latestAt: now }),
    });

    expect(tab.attention).toBe(true);
    expect(tab.attentionTooltip).not.toBe("");
  });
});
