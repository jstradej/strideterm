import { describe, expect, test } from "vitest";
import { shouldRenderActiveWorkspace } from "./runtime-bindings.js";

function createPayload(overrides = {}) {
  return {
    appState: {
      activeWorkspaceId: "workspace-1",
      workspaces: [
        {
          id: "workspace-1",
          kind: "terminal",
          name: "Backend",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
    },
    workspace: {
      workspace: {
        id: "workspace-1",
        kind: "terminal",
        name: "Backend",
        panels: [{ id: "shell", title: "Shell", command: "" }],
      },
      sessions: [{ sessionId: "workspace-1:shell", panelId: "shell", title: "Shell", status: "running" }],
    },
    attention: {
      byWorkspace: {},
      byProject: {},
    },
    git: {
      workspaces: {},
      projects: {},
    },
    docker: {},
    azureDevops: {
      inbox: {
        needsMyReview: [],
        needsAttention: [],
      },
      pullRequests: {},
    },
    ...overrides,
  };
}

describe("shouldRenderActiveWorkspace", () => {
  test("skips full render when only background Azure inbox data changes", () => {
    const previous = createPayload();
    const next = createPayload({
      azureDevops: {
        inbox: {
          needsMyReview: [{ prKey: "ado:repo:1" }],
          needsAttention: [{ prKey: "ado:repo:1" }],
        },
        pullRequests: {},
      },
    });

    expect(shouldRenderActiveWorkspace(next, previous)).toBe(false);
  });

  test("requires full render when the active review detail changes", () => {
    const previous = createPayload({
      appState: {
        activeWorkspaceId: "review-1",
        workspaces: [
          {
            id: "review-1",
            kind: "terminal",
            name: "web-app PR #123",
            panels: [{ id: "shell", title: "Shell", command: "" }],
            review: {
              provider: "azure-devops",
              prKey: "ado:repo:123",
            },
          },
        ],
      },
      workspace: {
        workspace: {
          id: "review-1",
          kind: "terminal",
          name: "web-app PR #123",
          panels: [{ id: "shell", title: "Shell", command: "" }],
          review: {
            provider: "azure-devops",
            prKey: "ado:repo:123",
          },
        },
        sessions: [{ sessionId: "review-1:shell", panelId: "shell", title: "Shell", status: "running" }],
      },
      azureDevops: {
        inbox: {
          needsMyReview: [],
          needsAttention: [],
        },
        pullRequests: {
          "ado:repo:123": {
            prKey: "ado:repo:123",
            title: "Initial title",
          },
        },
      },
    });
    const next = createPayload({
      ...previous,
      azureDevops: {
        ...previous.azureDevops,
        pullRequests: {
          "ado:repo:123": {
            prKey: "ado:repo:123",
            title: "Updated title",
          },
        },
      },
    });

    expect(shouldRenderActiveWorkspace(next, previous)).toBe(true);
  });
});
