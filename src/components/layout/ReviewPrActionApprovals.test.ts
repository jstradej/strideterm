import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { computed, ref, shallowRef } from "vue";
import ReviewPrActionApprovals from "./ReviewPrActionApprovals.vue";
import {
  reviewPrActionProposalSchema,
  type ReviewPrActionProposal,
} from "../../../electron/shared/review-pr-actions.js";
import { createReviewPrActionApprovals } from "../../stores/review-pr-action-approvals.js";

const proposal: ReviewPrActionProposal = reviewPrActionProposalSchema.parse({
  proposalId: "proposal-1",
  profileId: "profile-a",
  workspaceId: "ws-a",
  provider: "github",
  prKey: "repo#42",
  action: "merge",
  options: { mergeMethod: "squash" },
  title: "Merge pull request #42",
  message: "Merge after checking the current status.",
  snapshot: {
    provider: "github",
    prKey: "repo#42",
    connectionId: "connection-1",
    repository: "owner/project",
    number: 42,
    url: "https://github.com/owner/project/pull/42",
    title: "Fix the release job",
    state: "open",
    isDraft: false,
    autoMerge: false,
    source: { repository: "owner/project", branch: "fix/release", sha: "a1b2c3" },
    target: { repository: "owner/project", branch: "main", sha: "d4e5f6" },
    checks: {
      state: "pending",
      total: 2,
      successful: 1,
      failed: 0,
      pending: 1,
      items: [
        { name: "unit tests", state: "success" },
        { name: "release check", state: "pending" },
      ],
    },
    mergeReadiness: { state: "blocked", reason: "1 required check is still pending." },
    review: { approvals: 1, changesRequested: 0, requiredApprovals: 2 },
    supportedActions: ["merge"],
  },
  expiresAt: "2999-10-22T12:00:00.000Z",
});

describe("ReviewPrActionApprovals", () => {
  it("shows the proposal details and waits for an explicit approval click", async () => {
    const approve = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(ReviewPrActionApprovals, {
      props: { proposals: [proposal], isBusy: () => false, approve, reject },
    });

    expect(wrapper.text()).toContain("GitHub · Approval required");
    expect(wrapper.text()).toContain("owner/project #42");
    expect(wrapper.text()).toContain("a1b2c3");
    expect(wrapper.text()).toContain("d4e5f6");
    expect(wrapper.text()).toContain("release check");
    expect(wrapper.text()).toContain("blocked · 1 required check is still pending.");
    expect(wrapper.text()).toContain("1 approvals / 2 required");
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();

    await wrapper.get("button:not(.button--ghost)").trigger("click");
    expect(approve).toHaveBeenCalledWith(proposal);
    expect(reject).not.toHaveBeenCalled();
  });

  it("sends rejection only after the user clicks Reject", async () => {
    const approve = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(ReviewPrActionApprovals, {
      props: { proposals: [proposal], isBusy: () => false, approve, reject },
    });

    await wrapper.get("button.button--ghost").trigger("click");
    expect(reject).toHaveBeenCalledWith(proposal);
    expect(approve).not.toHaveBeenCalled();
  });

  it("renders provider text as text and shows the pinned action and merge strategy", () => {
    const unsafe = reviewPrActionProposalSchema.parse({
      ...proposal,
      title: '<img src=x onerror="alert(1)">',
      message: '<script>alert("agent")</script>',
      snapshot: {
        ...proposal.snapshot,
        url: "java" + "script:alert(1)",
        checks: {
          ...proposal.snapshot.checks,
          items: [{ name: '<img src=x onerror="alert(2)">', state: "success" }],
        },
      },
    });
    const wrapper = mount(ReviewPrActionApprovals, {
      props: { proposals: [unsafe], isBusy: () => false, approve: vi.fn(), reject: vi.fn() },
    });

    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">');
    expect(wrapper.text()).toContain("Merge pull request · squash");
    expect(wrapper.text()).toContain("a1b2c3");
    expect(wrapper.text()).toContain("d4e5f6");
  });

  it("keeps the proposal visible and explains a failed transport decision", async () => {
    const wrapper = mount(ReviewPrActionApprovals, {
      props: {
        proposals: [proposal],
        isBusy: () => false,
        approve: vi.fn().mockRejectedValue(new Error("Provider recheck failed")),
        reject: vi.fn(),
      },
    });

    await wrapper.get("button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Provider recheck failed");
    expect(wrapper.text()).toContain("Fix the release job");
  });

  it("disables both decisions while a decision is in flight", () => {
    const wrapper = mount(ReviewPrActionApprovals, {
      props: { proposals: [proposal], isBusy: () => true, approve: vi.fn(), reject: vi.fn() },
    });
    expect(wrapper.findAll("button").every((button) => button.attributes("disabled") !== undefined)).toBe(true);
  });

  it("refuses a click from a stale visible card after the active profile changes", async () => {
    const activeProfileId = ref<string | null>("profile-a");
    const confirmReviewPrAction = vi.fn().mockResolvedValue({ status: "accepted" });
    const approvals = createReviewPrActionApprovals({
      payload: shallowRef<unknown>({ reviewPrActions: { pending: [proposal] } }),
      myActiveProfileId: computed(() => activeProfileId.value),
      getApi: () => ({ confirmReviewPrAction }) as never,
    });
    const wrapper = mount(ReviewPrActionApprovals, {
      props: {
        proposals: approvals.pendingProposals.value,
        isBusy: approvals.isBusy,
        approve: approvals.approve,
        reject: approvals.reject,
      },
    });

    activeProfileId.value = "profile-b";
    await wrapper.get("button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(confirmReviewPrAction).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("belongs to another profile");
  });
});
