import { describe, expect, test } from "vitest";
import { getWorkspacePanelByViewId, getWorkspaceTabs } from "./selectors.js";

describe("workspace selectors", () => {
  test("returns an Azure inbox tab for azure workspaces", () => {
    const tabs = getWorkspaceTabs({
      workspace: {
        workspace: {
          id: "azure-1",
          kind: "azure",
          panels: [],
        },
        sessions: [],
      },
      payload: {
        azureDevops: {
          inbox: {
            needsMyReview: [{ id: 1 }],
            needsAttention: [],
          },
        },
      },
      hiddenViewIds: new Set(),
      statusTone: (status) => status,
      isContainerRunning: () => false,
    });

    expect(tabs).toEqual([
      expect.objectContaining({
        id: "azure:azure-1",
        type: "azure",
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
          panels: [
            { id: "shell", title: "Shell", command: "" },
          ],
        },
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
      },
      hiddenViewIds: new Set(),
      statusTone: () => "running",
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
    const result = getWorkspacePanelByViewId("review:review-1", {
      workspace: {
        id: "review-1",
        panels: [{ id: "shell", title: "Shell" }],
      },
      sessions: [],
    }, {
      isGitViewId: () => false,
      isDockerViewId: () => false,
      isAzureViewId: (value) => String(value).startsWith("azure:"),
      isReviewViewId: (value) => String(value).startsWith("review:"),
    });

    expect(result).toBeNull();
  });
});
