/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * approve/vote, fetch, and rebase handlers were try/finally with no catch,
 * so a rejected call silently reset the busy flag with zero user-visible
 * feedback — the button just stopped spinning as if the click did nothing.
 * The neighboring handlePush/handleForcePush handlers already caught errors
 * (see pushError); handleVote/handleFetch/handleRebase now go through
 * notifications.runWithToast to match that robustness.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const azureVote = vi.fn();
const azureFetchReviewWorkspace = vi.fn();
const azureRebaseReviewWorkspace = vi.fn();
const azurePushReviewWorkspace = vi.fn();
const getGitSnapshot = vi.fn(() => ({ aheadCount: 1, behindCount: 1 }));

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    azureVote,
    azureFetchReviewWorkspace,
    azureRebaseReviewWorkspace,
    azurePushReviewWorkspace,
    getGitSnapshot,
  }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({ openLazygit: vi.fn() }),
}));

import ReviewSummaryTab from "./ReviewSummaryTab.vue";
import { useNotificationStore } from "../../../stores/notifications.js";

const PULL_REQUEST = {
  id: 42,
  title: "Fix bug",
  sourceRefName: "refs/heads/feature/x",
  targetRefName: "refs/heads/main",
  mergeStatus: "succeeded",
};

function mountTab() {
  return mount(ReviewSummaryTab, {
    props: {
      detail: { role: "reviewer", author: { displayName: "Alice" } },
      pullRequest: PULL_REQUEST,
      reviewers: [{ displayName: "Bob", vote: 0, isRequired: true }],
      checks: {},
      changedFiles: [],
      prKey: "pr-1",
      workspaceId: "ws-1",
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  azureVote.mockClear();
  azureFetchReviewWorkspace.mockClear();
  azureRebaseReviewWorkspace.mockClear();
  azurePushReviewWorkspace.mockClear();
});

describe("ReviewSummaryTab — vote/fetch/rebase surface failures instead of silently succeeding", () => {
  test("handleVote (Approve): rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    azureVote.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mountTab();
    const approveBtn = wrapper.findAll("button").find((b) => b.text() === "Approve")!;
    await approveBtn.trigger("click");
    await flushPromises();

    expect(azureVote).toHaveBeenCalledWith("pr-1", "10");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Approve failed");
    // busy resets — button disabled state (bound to !!busyAction) clears
    expect(approveBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleVote (Reject): rejection is caught and surfaced as a toast with the Reject label", async () => {
    azureVote.mockRejectedValueOnce(new Error("locked"));
    const wrapper = mountTab();
    const rejectBtn = wrapper.findAll("button").find((b) => b.text() === "Reject")!;
    await rejectBtn.trigger("click");
    await flushPromises();

    expect(azureVote).toHaveBeenCalledWith("pr-1", "-10");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Reject failed");
  });

  test("handleFetch: rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    azureFetchReviewWorkspace.mockRejectedValueOnce(new Error("git fetch failed"));
    const wrapper = mountTab();
    const fetchBtn = wrapper.findAll("button").find((b) => b.text().includes("Fetch"))!;
    await fetchBtn.trigger("click");
    await flushPromises();

    expect(azureFetchReviewWorkspace).toHaveBeenCalledWith("ws-1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Fetch failed");
    expect(fetchBtn.text()).toBe("Fetch");
  });

  test("handleRebase: rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    azureRebaseReviewWorkspace.mockRejectedValueOnce(new Error("conflict"));
    const wrapper = mountTab();
    const rebaseBtn = wrapper.findAll("button").find((b) => b.text().includes("Rebase"))!;
    await rebaseBtn.trigger("click");
    await flushPromises();

    expect(azureRebaseReviewWorkspace).toHaveBeenCalledWith("ws-1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Rebase failed");
    expect(rebaseBtn.text()).toBe("Rebase on target");
  });
});
