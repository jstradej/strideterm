import { describe, expect, test, vi } from "vitest";
import { createReviewBridgeHandlers } from "./runtime-review-bridge-handlers.js";

// review-bridge/pull-request/sync moved into slotAwareRoute this round: it
// publishes queued draft comments to the PR provider (an externally visible side
// effect), so it must refuse a prKey outside the caller viewer's profile
// (#32/#58/#63). The guard is delegated to the runtime's assertPrInViewerProfile.
describe("syncReviewBridgePullRequest — cross-profile viewer guard", () => {
  function makeHandlers() {
    const syncPendingDrafts = vi.fn(async () => {});
    const refreshAzure = vi.fn(async () => {});
    const refreshGitHub = vi.fn(async () => {});
    // Stand-in for runtime.assertPrInViewerProfile: PR "azure:pr1" is in p1.
    const assertPrInViewerProfile = vi.fn((prKey: string, windowId: string | undefined) => {
      const callerProfile = windowId === "remote:sess-b" ? "p2" : windowId === "remote:sess-a" ? "p1" : null;
      if (!callerProfile) return;
      if (prKey === "azure:pr1" && callerProfile !== "p1") {
        throw new Error(`Cross-profile refused: pull request ${prKey} is not in profile ${callerProfile}.`);
      }
    });
    const handlers = createReviewBridgeHandlers({
      azure: { addPullRequestComment: vi.fn(async () => {}), findSummary: () => null },
      github: { addPullRequestComment: vi.fn(async () => {}), findSummary: () => null },
      reviewBridgeStore: { getPullRequestContext: () => ({ provider: "azure-devops" }), syncPendingDrafts },
      getPayload: () => ({}),
      broadcastState: vi.fn(),
      refreshAzure,
      refreshGitHub,
      refreshGit: vi.fn(async () => {}),
      assertWorkspaceInViewerProfile: vi.fn(),
      assertPrInViewerProfile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, syncPendingDrafts, assertPrInViewerProfile };
  }

  test("refuses to publish drafts for a PR outside the caller's profile", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await expect(handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" }, "remote:sess-b")).rejects.toThrow(
      /Cross-profile/,
    );
    // The guard runs BEFORE any provider publish.
    expect(syncPendingDrafts).not.toHaveBeenCalled();
  });

  test("allows sync for the caller's own profile", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" }, "remote:sess-a");
    expect(syncPendingDrafts).toHaveBeenCalledTimes(1);
  });

  test("desktop IPC (no viewer id) is unaffected", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" });
    expect(syncPendingDrafts).toHaveBeenCalledTimes(1);
  });
});
