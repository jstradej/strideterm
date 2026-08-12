/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * approve/vote and rebase handlers were try/finally with no catch, so a
 * rejected call silently reset the busy flag with zero user-visible feedback
 * — the button just stopped spinning as if the click did nothing. The
 * neighboring handlePush/handleForcePush handlers already caught errors (see
 * pushError); handleVote/handleRebase now go through notifications.runWithToast
 * to match that robustness.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const azureVote = vi.fn();
const azureRebaseReviewWorkspace = vi.fn();
const azurePushReviewWorkspace = vi.fn();
const getGitSnapshot = vi.fn(() => ({ aheadCount: 1, behindCount: 1 }));
// Rebase-on-target is driven by an ad-hoc compare against the PR's target
// branch (gitCompareBranch), not the top-level snapshot's behindCount — see
// ReviewSummaryTab.vue's targetComparison. Default to "behind" so the Rebase
// button is enabled unless a test overrides it.
const gitCompareBranch = vi.fn(async () => ({ ok: true, aheadCount: 0, behindCount: 1 }));

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    azureVote,
    azureRebaseReviewWorkspace,
    azurePushReviewWorkspace,
    getGitSnapshot,
    getApi: () => ({ gitCompareBranch }),
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
  azureRebaseReviewWorkspace.mockClear();
  azurePushReviewWorkspace.mockClear();
  gitCompareBranch.mockClear();
  gitCompareBranch.mockImplementation(async () => ({ ok: true, aheadCount: 0, behindCount: 1 }));
});

async function openAdvancedMenu(wrapper: ReturnType<typeof mountTab>) {
  const trigger = wrapper.findAll("button").find((b) => b.text().includes("More git actions"))!;
  await trigger.trigger("click");
  await flushPromises();
}

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

  test("handleRebase: rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    azureRebaseReviewWorkspace.mockRejectedValueOnce(new Error("conflict"));
    const wrapper = mountTab();
    await flushPromises(); // let the initial gitCompareBranch compare resolve
    await openAdvancedMenu(wrapper);
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

describe("ReviewSummaryTab — Fetch button removed, standalone Refresh no longer split out", () => {
  test("no standalone Fetch button renders in the Summary tab (Refresh now covers it)", () => {
    const wrapper = mountTab();
    expect(wrapper.findAll("button").some((b) => b.text() === "Fetch")).toBe(false);
  });
});

describe("ReviewSummaryTab — rebase-on-target uses the PR target compare, not source behindCount", () => {
  test("disables Rebase on target when HEAD is not behind the PR's target branch", async () => {
    gitCompareBranch.mockImplementation(async () => ({ ok: true, aheadCount: 0, behindCount: 0 }));
    const wrapper = mountTab();
    await flushPromises();
    await openAdvancedMenu(wrapper);

    expect(gitCompareBranch).toHaveBeenCalledWith({ workspaceId: "ws-1", baseBranch: "origin/main" });
    const rebaseBtn = wrapper.findAll("button").find((b) => b.text().includes("Rebase"))!;
    expect(rebaseBtn.attributes("disabled")).toBeDefined();
  });

  test("enables Rebase on target when HEAD is behind the PR's target branch, even with source behindCount=0", async () => {
    getGitSnapshot.mockReturnValueOnce({ aheadCount: 0, behindCount: 0 });
    gitCompareBranch.mockImplementation(async () => ({ ok: true, aheadCount: 0, behindCount: 2 }));
    const wrapper = mountTab();
    await flushPromises();
    await openAdvancedMenu(wrapper);

    const rebaseBtn = wrapper.findAll("button").find((b) => b.text().includes("Rebase"))!;
    expect(rebaseBtn.attributes("disabled")).toBeUndefined();
  });
});
