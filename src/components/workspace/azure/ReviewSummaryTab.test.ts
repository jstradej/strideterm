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
const rebaseReviewCheckout = vi.fn();
const pushReviewCheckout = vi.fn();
const getGitSnapshot = vi.fn(() => ({ aheadCount: 1, behindCount: 1 }));
// Rebase-on-target is driven by an ad-hoc compare against the PR's target
// branch (gitCompareBranch), not the top-level snapshot's behindCount — see
// ReviewSummaryTab.vue's targetComparison. Default to "behind" so the Rebase
// button is enabled unless a test overrides it.
const gitCompareBranch = vi.fn(async () => ({ ok: true, aheadCount: 0, behindCount: 1 }));
const getJiraIssue = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    azureVote,
    rebaseReviewCheckout,
    pushReviewCheckout,
    getGitSnapshot,
    getApi: () => ({ gitCompareBranch, getJiraIssue }),
  }),
}));
import ReviewSummaryTab from "./ReviewSummaryTab.vue";
import { useNotificationStore } from "../../../stores/notifications.js";
import { azureVoteSchema } from "../../../../electron/backend/ipc-schemas.js";

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
      jiraIssueRefs: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "123", issueKey: "ENG-1" },
          summary: "Fix input",
          status: "Open",
        },
      ],
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  azureVote.mockClear();
  rebaseReviewCheckout.mockReset();
  pushReviewCheckout.mockReset();
  gitCompareBranch.mockClear();
  getJiraIssue.mockReset();
  gitCompareBranch.mockImplementation(async () => ({ ok: true, aheadCount: 0, behindCount: 1 }));
});

describe("ReviewSummaryTab — explicit Jira review context", () => {
  test("loads details only when selected from the existing workspace link", async () => {
    getJiraIssue.mockResolvedValue({
      ref: { issueKey: "ENG-1" },
      summary: "Fresh issue detail",
      status: "In Progress",
      issueType: "Bug",
      projectKey: "ENG",
      updated: "today",
    });
    const wrapper = mountTab();
    expect(getJiraIssue).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("ENG-1 · Fix input");
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(getJiraIssue).toHaveBeenCalledWith({ connectionId: "jira-1", issueId: "123" });
    expect(wrapper.text()).toContain("Fresh issue detail");
  });

  test("renders the issue as a readable card with a markdown description, not a text dump", async () => {
    getJiraIssue.mockResolvedValue({
      ref: { issueKey: "ENG-1" },
      summary: "Fresh issue detail",
      status: "In Progress",
      issueType: "Bug",
      projectKey: "ENG",
      updated: "later",
      description: "plain",
      descriptionMarkdown: "Steps:\n\n- **first** step",
    });
    const wrapper = mountTab();
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find("pre").exists()).toBe(false);
    const card = wrapper.get(".review-jira-issue");
    expect(card.get(".review-jira-issue__key").text()).toBe("ENG-1");
    expect(card.get(".review-jira-issue__status").text()).toBe("In Progress");
    expect(card.get(".review-jira-issue__summary").text()).toBe("Fresh issue detail");
    expect(card.get(".review-jira-issue__description strong").text()).toBe("first");
  });

  test("shows detail permission errors in the review pane", async () => {
    getJiraIssue.mockRejectedValue(new Error("Issue permission denied"));
    const wrapper = mountTab();
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("Issue permission denied");
  });
});

async function openAdvancedMenu(wrapper: ReturnType<typeof mountTab>) {
  const trigger = wrapper.findAll("button").find((b) => b.text().includes("More git actions"))!;
  await trigger.trigger("click");
  await flushPromises();
}

// Regression: every vote went out as String(vote), and the main process's
// azureVoteSchema (vote: z.number()) refused it before any request to Azure
// DevOps — Approve had not worked from the desktop since the TS migration.
// The tests above only compared the component with itself; this one holds it
// to the schema the IPC boundary actually enforces.
describe("ReviewSummaryTab — vote payload matches the IPC contract", () => {
  test.each([
    ["Approve", 10],
    ["Approve with suggestions", 5],
    ["Wait", -5],
    ["Reject", -10],
    ["Clear vote", 0],
  ])("%s sends a payload azureVoteSchema accepts (vote %i)", async (label, expectedVote) => {
    azureVote.mockResolvedValueOnce(undefined);
    const wrapper = mountTab();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === label)!
      .trigger("click");
    await flushPromises();

    const [prKey, vote] = azureVote.mock.calls[0];
    expect(vote).toBe(expectedVote);
    expect(azureVoteSchema.safeParse({ prKey, vote }).success).toBe(true);
  });
});

describe("ReviewSummaryTab — vote/fetch/rebase surface failures instead of silently succeeding", () => {
  test("handleVote (Approve): rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    azureVote.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mountTab();
    const approveBtn = wrapper.findAll("button").find((b) => b.text() === "Approve")!;
    await approveBtn.trigger("click");
    await flushPromises();

    expect(azureVote).toHaveBeenCalledWith("pr-1", 10);
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

    expect(azureVote).toHaveBeenCalledWith("pr-1", -10);
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Reject failed");
  });

  test("handleRebase: rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    rebaseReviewCheckout.mockRejectedValueOnce(new Error("conflict"));
    const wrapper = mountTab();
    await flushPromises(); // let the initial gitCompareBranch compare resolve
    await openAdvancedMenu(wrapper);
    const rebaseBtn = wrapper.findAll("button").find((b) => b.text().includes("Rebase"))!;
    await rebaseBtn.trigger("click");
    await flushPromises();

    expect(rebaseReviewCheckout).toHaveBeenCalledWith("ws-1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Rebase failed");
    expect(rebaseBtn.text()).toBe("Rebase on target");
  });
});

describe("ReviewSummaryTab — review Git outcomes", () => {
  test("a blocked rebase is the action's own error, with the way out", async () => {
    rebaseReviewCheckout.mockResolvedValueOnce({
      status: "blocked",
      code: "dirty-tree",
      message: "Cannot rebase: 2 modified in the worktree.",
      guidance: "Commit, stash, or discard the changes first.",
    });
    const wrapper = mountTab();
    await flushPromises();
    await openAdvancedMenu(wrapper);
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Rebase"))!
      .trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions[0].events[0].title).toBe("Rebase failed");
    expect(notifications.sessions[0].events[0].body).toContain("Commit, stash, or discard the changes first.");
  });

  test("a rebase the user declined raises nothing", async () => {
    rebaseReviewCheckout.mockResolvedValueOnce({ status: "cancelled", message: "Cancelled — nothing was changed." });
    const wrapper = mountTab();
    await flushPromises();
    await openAdvancedMenu(wrapper);
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Rebase"))!
      .trigger("click");
    await flushPromises();

    const titles = useNotificationStore().sessions.flatMap((session) => session.events.map((event) => event.title));
    expect(titles).not.toContain("Rebase failed");
  });

  test("Push goes through the review checkout flow and shows a blocked reason inline", async () => {
    pushReviewCheckout.mockResolvedValueOnce({
      status: "blocked",
      code: "branch-mismatch",
      message: "This checkout is on develop, not on the pull request branch.",
      guidance: "Switch back to the PR branch.",
    });
    const wrapper = mountTab();
    await flushPromises();
    const pushBtn = wrapper.findAll("button").find((b) => b.text() === "Push branch");
    expect(pushBtn).toBeDefined();
    await pushBtn!.trigger("click");
    await flushPromises();

    expect(pushReviewCheckout).toHaveBeenCalledWith("ws-1", { force: false });
    expect(wrapper.text()).toContain("Switch back to the PR branch.");
  });

  test("Force push asks the review flow for a force push", async () => {
    pushReviewCheckout.mockResolvedValueOnce({ status: "pushed", message: "Force pushed." });
    const wrapper = mountTab();
    await flushPromises();
    await openAdvancedMenu(wrapper);
    const forceBtn = wrapper.findAll("button").find((b) => b.text().includes("Force push"));
    expect(forceBtn).toBeDefined();
    await forceBtn!.trigger("click");
    await flushPromises();

    expect(pushReviewCheckout).toHaveBeenCalledWith("ws-1", { force: true });
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
