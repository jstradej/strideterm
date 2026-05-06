import { describe, expect, test, vi } from "vitest";
import { shouldRenderActiveWorkspace } from "./runtime-bindings.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

function createPayload(overrides = {}): StatePayload {
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
  } as unknown as StatePayload;
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

  test("short-circuits without JSON.stringify when nothing the active workspace renders has changed", () => {
    // Reproduces a hot-path perf concern: shouldRenderActiveWorkspace runs on
    // every state broadcast (including high-frequency terminal-output payloads).
    // The previous implementation always materialised both render-state objects
    // and JSON.stringify'd them — milliseconds of work plus GC pressure on every
    // payload, even when nothing the active workspace cares about actually
    // changed (e.g. a Telegram poll updates an unrelated subtree).
    //
    // Build a payload with a non-trivial Azure inbox + review-bridge subtree so
    // a deep stringify would be expensive, then change *only* an unrelated field
    // (a Telegram poll counter) while keeping every reference the active
    // workspace cares about identical. The function must return false AND must
    // not deep-serialise the payload to reach that answer.
    const heavyPullRequests: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      heavyPullRequests[`ado:repo:${i}`] = {
        prKey: `ado:repo:${i}`,
        title: `Pull request ${i}`,
        // Simulate the deeply-nested fields that make JSON.stringify expensive
        comments: Array.from({ length: 40 }, (_, k) => ({
          id: k,
          body: `comment ${k} body content`,
          updatedAt: "2026-05-06T12:00:00Z",
        })),
      };
    }
    const sharedAzureDevops = {
      inbox: { needsMyReview: [], needsAttention: [] },
      pullRequests: heavyPullRequests,
    };
    const sharedAttention = { byWorkspace: {}, byProject: {} };
    const sharedGit = { workspaces: {}, projects: {} };
    const sharedWorkspace = {
      workspace: {
        id: "workspace-1",
        kind: "terminal" as const,
        name: "Backend",
        panels: [{ id: "shell", title: "Shell", command: "" }],
      },
      sessions: [{ sessionId: "workspace-1:shell", panelId: "shell", title: "Shell", status: "running" }],
    };

    const previous = {
      appState: {
        activeWorkspaceId: "workspace-1",
        workspaces: [sharedWorkspace.workspace],
      },
      workspace: sharedWorkspace,
      attention: sharedAttention,
      git: sharedGit,
      docker: {},
      azureDevops: sharedAzureDevops,
      // Unrelated subtree — every field below this should not influence the
      // render decision for a plain terminal workspace.
      telegram: { lastPollAt: "2026-05-06T12:00:00Z" },
    } as unknown as StatePayload;

    const next = {
      ...previous,
      // Only the unrelated field's reference changes.
      telegram: { lastPollAt: "2026-05-06T12:00:01Z" },
    } as unknown as StatePayload;

    const stringifySpy = vi.spyOn(JSON, "stringify");

    try {
      const result = shouldRenderActiveWorkspace(next, previous);
      expect(result).toBe(false);
      // The fix uses reference equality on the fields the active workspace
      // actually reads, so no JSON.stringify call is needed at all in this
      // path. The current implementation calls it twice and would fail this.
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
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
